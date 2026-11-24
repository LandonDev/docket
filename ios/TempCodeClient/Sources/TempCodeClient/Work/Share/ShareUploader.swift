import Foundation
import TempCodeContract

extension ShareFolder {
    /// The folder as `work.files.upload` and `work.files.list` name it.
    public var at: FolderRef {
        if let host, let path { return .file(.init(host: host, path: path)) }
        return .place(.init(id: "folder"))
    }

    /// A folder the host listed in the workspace's own folder; nil for any other kind of place.
    public init?(_ ref: FolderRef, name: String) {
        switch ref {
        case .file(let folder): self.init(name: name, host: folder.host, path: folder.path)
        case .place(let place) where place.id == "folder": self.init(name: name, host: nil, path: nil)
        default: return nil
        }
    }
}

/// Sends what `ShareInbox` holds to one host: `attachment.settings` first, so a file the host will not
/// take is said before a byte moves; `work.files.upload` to begin; the bytes from disk in the host's chunk
/// size, one chunk in memory at a time, each `attachment.chunk` awaited before the next; then
/// `attachment.commit`. The extension runs it right after Save, the app at launch and on foreground.
///
/// Each begin carries the op `<item id>-<attempts>`. The host answers the same upload id for the same op, so a
/// begin whose answer was lost is sent again as it was and starts no second save. Once the host answers an
/// op, the item counts it spent and the next begin sends a fresh one: after an upload the host forgot, after a
/// lost connection mid-upload, after a refusal. A commit whose answer was lost is asked again on its upload id
/// before anything else (`ShareItem.committing`): the host answers it as it did the first time, so the file is
/// not saved twice; only an upload the host no longer knows begins again.
@MainActor
public final class ShareUploader {
    /// The calls an upload makes, so a test needs no socket. `.socket(_:)` is the real one.
    public struct Send: Sendable {
        public var settings: @Sendable () async throws -> AttachmentSettings
        /// `work.files.upload`, answering the upload id, and whether that op's file has already landed.
        public var begin: @Sendable (Methods.WorkFilesUpload.Params) async throws -> Begun
        public var chunk: @Sendable (_ uploadId: String, _ index: Int, _ dataBase64: String) async throws -> Void
        public var commit: @Sendable (_ uploadId: String) async throws -> Void
        public var abort: @Sendable (_ uploadId: String) async -> Void

        public init(
            settings: @escaping @Sendable () async throws -> AttachmentSettings,
            begin: @escaping @Sendable (Methods.WorkFilesUpload.Params) async throws -> Begun,
            chunk: @escaping @Sendable (_ uploadId: String, _ index: Int, _ dataBase64: String) async throws -> Void,
            commit: @escaping @Sendable (_ uploadId: String) async throws -> Void,
            abort: @escaping @Sendable (_ uploadId: String) async -> Void
        ) {
            self.settings = settings
            self.begin = begin
            self.chunk = chunk
            self.commit = commit
            self.abort = abort
        }
    }

    /// A begin's answer: the id the bytes go on, and `landed` once a commit on that op made the file (the host keeps it
    /// on the op, across a restart), when there is nothing more to send.
    public struct Begun: Equatable, Sendable {
        public var uploadId: String
        public var landed: Bool
        public init(uploadId: String, landed: Bool = false) {
            self.uploadId = uploadId
            self.landed = landed
        }

        public init(_ answer: Methods.WorkFilesUpload.Output) {
            self.init(uploadId: answer.uploadId, landed: answer.landed == true)
        }
    }

    /// What went wrong on the phone's side, in the words the item keeps.
    enum LocalError: Error {
        case gone, changed

        var words: String {
            switch self {
            case .gone: "The file is no longer on this phone."
            case .changed: "The file changed on this phone after it was shared."
            }
        }
    }

    private enum Outcome {
        case done
        case queued
        /// `final`: no retry can change it.
        case refused(String, final: Bool)
    }

    public let inbox: ShareInbox
    public let hostId: String
    /// As the phone labels the host, for the words of a file it will not take.
    public let hostName: String
    private let request: Send

    public init(inbox: ShareInbox, hostId: String, hostName: String, request: Send) {
        self.inbox = inbox
        self.hostId = hostId
        self.hostName = hostName
        self.request = request
    }

    /// Sends one item and answers it as it is after: `done` when the host has it (its bytes gone from the
    /// phone), `refused` with the host's words, or `queued` when the host could not be reached or the task
    /// was cancelled (an upload begun is aborted). An item another process is sending comes back as it is.
    /// `progress` is told the fraction sent after every chunk.
    public func send(_ item: ShareItem, progress: @escaping (Double) -> Void = { _ in }) async -> ShareItem {
        guard let claimed = inbox.claim(item.id) else { return inbox.item(item.id) ?? item }
        var after = claimed
        switch await upload(claimed, progress: progress) {
        case .done: after.state = .done
        case .queued: after.state = .queued
        case .refused(let words, let isFinal):
            after.state = .refused
            after.words = words
            after.isFinal = isFinal ? true : nil
        }
        try? inbox.mark(item.id, after.state, words: after.words, isFinal: after.isFinal == true)
        return inbox.item(item.id) ?? after
    }

    /// Sends this host's queued items, oldest first, and answers each as it is after. Stops at the first
    /// that stays queued: the host is out of reach, or the drain was cancelled.
    @discardableResult
    public func drain(progress: @escaping (ShareItem, Double) -> Void = { _, _ in }) async -> [ShareItem] {
        var sent: [ShareItem] = []
        for item in inbox.items() where item.hostId == hostId && item.state == .queued {
            if Task.isCancelled { break }
            let after = await send(item) { progress(item, $0) }
            sent.append(after)
            if after.state == .queued { break }
        }
        return sent
    }

    /// "<host> takes files up to 200 MB." The row above already names the file.
    public static func tooLarge(host: String, limit: Int) -> String {
        "\(host) takes files up to \(wholeBinary(limit))."
    }

    /// A count of bytes in units of 1024, rounded down to a whole number so a limit is never overstated:
    /// 200 MB, 1 GB, 512 bytes.
    static func wholeBinary(_ bytes: Int) -> String {
        var value = max(0, bytes)
        for unit in ["bytes", "KB", "MB", "GB"] {
            if value < 1024 { return "\(value) \(unit)" }
            value /= 1024
        }
        return "\(value) TB"
    }

    /// The op of an item's begin, the same until the host answers it.
    static func op(_ item: ShareItem, attempts: Int) -> String {
        "\(item.id)-\(attempts)"
    }

    // MARK: - the upload

    private func upload(_ item: ShareItem, progress: @escaping (Double) -> Void) async -> Outcome {
        let settings: AttachmentSettings
        do {
            settings = try await request.settings()
        } catch {
            return Self.outcome(of: error)
        }
        if item.size > settings.maxBytes { return .refused(Self.tooLarge(host: hostName, limit: settings.maxBytes), final: true) }
        if let pending = item.committing {
            // `committing` stays on the manifest until Done is written with it cleared, in one write (`ShareInbox.mark`).
            do {
                try await request.commit(pending)
                progress(1)
                return .done
            } catch {
                if error is CancellationError || Self.isUnreachable(error) { return .queued }
                if !Self.isExpired(error) {
                    try? inbox.committing(item.id, uploadId: nil)
                    return Self.outcome(of: error)
                }
            }
            // The host no longer knows the upload (it restarted, or a day went by): the begin's op says whether its
            // file landed. Sent again unchanged, the host answers from the op's row.
            do {
                let op = Self.op(item, attempts: max(0, (item.attempts ?? 1) - 1))
                let again = try await request.begin(Methods.WorkFilesUpload.Params(workspaceId: item.workspaceId, at: item.folder.at, name: item.name, size: item.size, sha256: item.sha256, op: op))
                if again.landed {
                    progress(1)
                    return .done
                }
            } catch {
                if error is CancellationError || Self.isUnreachable(error) { return .queued }
            }
            // Nothing landed under it: begin anew below.
            try? inbox.committing(item.id, uploadId: nil)
        }
        let step = AttachmentUpload.chunkBytes(answered: settings.chunkBytes)
        var attempts = item.attempts ?? 0
        var begunAgain = false
        while true {
            let uploadId: String
            do {
                try Task.checkCancellation()
                let params = Methods.WorkFilesUpload.Params(workspaceId: item.workspaceId, at: item.folder.at, name: item.name, size: item.size, sha256: item.sha256, op: Self.op(item, attempts: attempts))
                let begun = try await request.begin(params)
                if begun.landed {
                    progress(1)
                    return .done
                }
                uploadId = begun.uploadId
            } catch {
                // Unanswered: the next try sends the same op. Refused: the host keeps that answer for the op.
                if !(error is CancellationError || Self.isUnreachable(error)) { try? inbox.spent(item.id, attempts: attempts + 1) }
                return Self.outcome(of: error)
            }
            attempts += 1
            try? inbox.spent(item.id, attempts: attempts)
            do {
                try await chunks(item, uploadId: uploadId, step: step, progress: progress)
                try Task.checkCancellation()
                try? inbox.committing(item.id, uploadId: uploadId)
                try await request.commit(uploadId)
                progress(1)
                return .done
            } catch {
                // Answered: the commit is no longer on its way. Unanswered, it is asked again at the next send.
                if !(error is CancellationError || Self.isUnreachable(error)) { try? inbox.committing(item.id, uploadId: nil) }
                // The host forgot the upload (idle past its time): begin once more, from the first byte.
                if Self.isExpired(error) && !begunAgain {
                    begunAgain = true
                    continue
                }
                if !Self.isUnreachable(error) {
                    // Its own task, so a cancelled send still asks the host to drop the partial file.
                    let abort = request.abort
                    await Task { await abort(uploadId) }.value
                }
                return Self.outcome(of: error)
            }
        }
    }

    private func chunks(_ item: ShareItem, uploadId: String, step: Int, progress: (Double) -> Void) async throws {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: inbox.payload(item))
        } catch {
            throw LocalError.gone
        }
        defer { try? handle.close() }
        for range in AttachmentUpload.ranges(size: item.size, chunkBytes: step) {
            try Task.checkCancellation()
            let bytes = try handle.read(upToCount: range.length) ?? Data()
            guard bytes.count == range.length else { throw LocalError.changed }
            try await request.chunk(uploadId, range.index, bytes.base64EncodedString())
            inbox.touch(item.id)
            progress(item.size == 0 ? 1 : Double(range.offset + range.length) / Double(item.size))
        }
    }

    private static func outcome(of error: any Error) -> Outcome {
        if let local = error as? LocalError { return .refused(local.words, final: true) }
        if error is CancellationError || isUnreachable(error) { return .queued }
        return .refused(ActionError.wrap(error).message, final: false)
    }

    private static func isUnreachable(_ error: any Error) -> Bool {
        guard let transport = error as? TransportError else { return false }
        switch transport {
        case .notConnected, .closed, .cancelled: return true
        case .server, .decoding: return false
        }
    }

    /// attachmentUploads.ts: "unknown upload (expired, aborted or never begun)".
    private static func isExpired(_ error: any Error) -> Bool {
        guard case .server(_, let message)? = error as? TransportError else { return false }
        return message.hasPrefix("unknown upload")
    }
}
