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
@MainActor
public final class ShareUploader {
    /// The calls an upload makes, so a test needs no socket. `.socket(_:)` is the real one.
    public struct Send: Sendable {
        public var settings: @Sendable () async throws -> AttachmentSettings
        /// `work.files.upload`, answering the upload id.
        public var begin: @Sendable (Methods.WorkFilesUpload.Params) async throws -> String
        public var chunk: @Sendable (_ uploadId: String, _ index: Int, _ dataBase64: String) async throws -> Void
        public var commit: @Sendable (_ uploadId: String) async throws -> Void
        public var abort: @Sendable (_ uploadId: String) async -> Void

        public init(
            settings: @escaping @Sendable () async throws -> AttachmentSettings,
            begin: @escaping @Sendable (Methods.WorkFilesUpload.Params) async throws -> String,
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
        case refused(String)
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
        case .refused(let words):
            after.state = .refused
            after.words = words
        }
        try? inbox.mark(item.id, after.state, words: after.words)
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

    /// "<name> is larger than <host> takes (<limit>)."
    public static func tooLarge(name: String, host: String, limit: Int) -> String {
        "\(name) is larger than \(host) takes (\(ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)))."
    }

    // MARK: - the upload

    private func upload(_ item: ShareItem, progress: @escaping (Double) -> Void) async -> Outcome {
        let settings: AttachmentSettings
        do {
            settings = try await request.settings()
        } catch {
            return Self.outcome(of: error)
        }
        if item.size > settings.maxBytes { return .refused(Self.tooLarge(name: item.name, host: hostName, limit: settings.maxBytes)) }
        let step = AttachmentUpload.chunkBytes(answered: settings.chunkBytes)
        var begunAgain = false
        while true {
            let uploadId: String
            do {
                try Task.checkCancellation()
                let params = Methods.WorkFilesUpload.Params(workspaceId: item.workspaceId, at: item.folder.at, name: item.name, size: item.size, sha256: item.sha256, op: UUID().uuidString.lowercased())
                uploadId = try await request.begin(params)
            } catch {
                return Self.outcome(of: error)
            }
            do {
                try await chunks(item, uploadId: uploadId, step: step, progress: progress)
                try Task.checkCancellation()
                try await request.commit(uploadId)
                progress(1)
                return .done
            } catch {
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
        if let local = error as? LocalError { return .refused(local.words) }
        if error is CancellationError || isUnreachable(error) { return .queued }
        return .refused(ActionError.wrap(error).message)
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
