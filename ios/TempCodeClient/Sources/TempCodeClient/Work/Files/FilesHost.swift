import Foundation
import Observation
import TempCodeContract

/// What `FilesHost` asks of the connection: one request. The socket is it (FilesWire+Socket.swift); a test
/// hands in a stand-in that answers each method.
public protocol FilesWire: Sendable {
    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output
}

/// A file to upload: its name, size and digest, and its bytes read a range at a time (FilesUpload.swift makes
/// one from picked bytes or a picked file).
public struct UploadSource: Sendable {
    public let name: String
    public let size: Int
    public let sha256: String
    public let read: @Sendable (_ offset: Int, _ length: Int) throws -> Data

    public init(name: String, size: Int, sha256: String, read: @escaping @Sendable (_ offset: Int, _ length: Int) throws -> Data) {
        self.name = name
        self.size = size
        self.sha256 = sha256
        self.read = read
    }
}

/// The Files place of one host's Work workspaces on the phone (the files pillar's F9, docs/agents/work-files.md
/// "The phone"): each workspace's places, each folder or lens shown and its pages, the uploads under way, and
/// every press, which goes to the host and lands back as what the host answered. The `work.files` push
/// reads again what it names: a folder (`at`), or the places.
@MainActor @Observable
public final class FilesHost {
    /// One folder or lens as listed so far: its rows in the host's order, the next page's cursor, the trail.
    public struct Listing: Equatable, Sendable {
        public var entries: [FileEntry]
        public var next: String?
        public var trail: [String]
        /// When what is shown was read, for a list kept from before (a machine asleep).
        public var asOf: Double?
    }

    /// An upload under way into a folder, as its row draws it.
    public struct Upload: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public var sent: Int
        public let size: Int
        public var failed: String?

        public var fraction: Double { size == 0 ? 1 : Double(sent) / Double(size) }
    }

    public let environmentId: String
    public let caps: FilesRules.Caps
    /// Each workspace's places, as `work.files.places` answered.
    public private(set) var places: [String: WorkRead<[FilePlace]>] = [:]
    /// Each folder or lens shown, by `slot(workspaceId, folder)`.
    public private(set) var listings: [String: WorkRead<Listing>] = [:]
    /// Uploads per folder slot, newest last; a finished one leaves, a failed one stays with its reason.
    public private(set) var uploads: [String: [Upload]] = [:]

    @ObservationIgnored private let wire: any FilesWire
    @ObservationIgnored private var folders: [String: (workspaceId: String, at: FolderRef)] = [:]

    public init(wire: any FilesWire, environmentId: String, caps: FilesRules.Caps) {
        self.wire = wire
        self.environmentId = environmentId
        self.caps = caps
    }

    public static func slot(_ workspaceId: String, _ folder: FolderRef) -> String { "\(workspaceId)|\(FilesRules.key(folder))" }

    public func listing(_ workspaceId: String, _ folder: FolderRef) -> WorkRead<Listing>? { listings[Self.slot(workspaceId, folder)] }

    /// Every row of the workspace the phone has listed, once each: what a search on the Files screen filters
    /// until the host's own search answers.
    public func known(_ workspaceId: String) -> [FileEntry] {
        var seen = Set<String>()
        return listings.keys.sorted().filter { $0.hasPrefix("\(workspaceId)|") }.flatMap { listings[$0]?.value?.entries ?? [] }.filter { seen.insert($0.key).inserted }
    }

    // MARK: - reads

    /// The workspace's places. A read that fails while places are shown keeps them; only a first read shows its failure.
    public func loadPlaces(_ workspaceId: String) async {
        let read = await WorkRead.of { try await self.wire.request(Methods.WorkFilesPlaces.self, .init(workspaceId: workspaceId)).places }
        if case .failed = read, places[workspaceId]?.value != nil { return }
        places[workspaceId] = read
    }

    /// A folder or lens from its first page. A folder that changed between pages answers `stale`: read it again
    /// from the top, once.
    public func list(_ workspaceId: String, _ folder: FolderRef) async {
        let slot = Self.slot(workspaceId, folder)
        folders[slot] = (workspaceId, folder)
        if listings[slot] == nil { listings[slot] = .reading }
        var read = await WorkRead.of { try await self.page(workspaceId, folder, cursor: nil) }
        if case .loaded(let page) = read, page.stale { read = await WorkRead.of { try await self.page(workspaceId, folder, cursor: nil) } }
        switch read {
        case .loaded(let page): listings[slot] = .loaded(Listing(entries: page.listing.entries, next: page.listing.next, trail: page.listing.trail?.map(\.name) ?? [], asOf: page.listing.asOf))
        case .failed(let message): if listings[slot]?.value == nil { listings[slot] = .failed(message) }
        case .reading: break
        }
    }

    /// The next page of a folder shown, appended; a folder that changed since lists again from the top.
    public func more(_ workspaceId: String, _ folder: FolderRef) async {
        let slot = Self.slot(workspaceId, folder)
        guard let shown = listings[slot]?.value, let cursor = shown.next else { return }
        guard let page = try? await page(workspaceId, folder, cursor: cursor) else { return }
        if page.stale { return await list(workspaceId, folder) }
        // A newer read may have replaced the list meanwhile: append only to the one this cursor came from.
        guard var now = listings[slot]?.value, now.next == cursor else { return }
        now.entries += page.listing.entries.filter { row in !now.entries.contains { $0.key == row.key } }
        now.next = page.listing.next
        listings[slot] = .loaded(now)
    }

    private struct Page: Sendable {
        let listing: FilesListing
        var stale: Bool { listing.stale == true }
    }

    private func page(_ workspaceId: String, _ folder: FolderRef, cursor: String?) async throws -> Page {
        Page(listing: try await wire.request(Methods.WorkFilesList.self, .init(workspaceId: workspaceId, at: folder, cursor: cursor)))
    }

    /// The host's search over every place it has (F4). Until the host answers one, the screen filters the
    /// folder's own rows (`FilesRules.filter`) and shows those.
    public func search(_ workspaceId: String, _ query: String) async throws -> [FileEntry] {
        try await wire.request(Methods.WorkFilesSearch.self, .init(workspaceId: workspaceId, query: query)).entries
    }

    /// A page of the file as a picture, made on its host (F3); `none` says why there is none.
    public func preview(_ workspaceId: String, _ ref: CanvasSource, page: Int, width: Int) async throws -> FilePreview {
        try await wire.request(Methods.WorkFilesPreview.self, .init(workspaceId: workspaceId, ref: ref, page: page, width: width))
    }

    // MARK: - opening

    /// Seats the file in the workspace's Files pane and answers the item to draw; where a thread already shows
    /// it, that thread's item. He opened it, so it is recent too (the host marks it).
    public func open(_ workspaceId: String, _ entry: FileEntry) async throws -> CanvasItem {
        guard let ref = entry.ref else { throw ActionError.refused(message: "A folder opens as a list.", forbidden: false) }
        let opened = try await wire.request(Methods.WorkFilesOpen.self, .init(workspaceId: workspaceId, ref: ref, name: entry.name, key: entry.key))
        if let item = opened.item { return item }
        if let held = opened.held {
            let items = try await wire.request(Methods.WorkCanvasList.self, .init(sessionId: held.sessionId)).items
            if let item = items.first(where: { $0.id == held.itemId }) { return item }
        }
        throw ActionError.refused(message: "\(entry.name) did not open.", forbidden: false)
    }

    /// He looked at it: recent, and no longer new from a thread. Quiet: a key that may not mark asks nothing.
    public func seen(_ workspaceId: String, _ entry: FileEntry) async {
        guard caps.operate, let ref = entry.ref else { return }
        _ = try? await wire.request(Methods.WorkFilesSeen.self, .init(workspaceId: workspaceId, ref: ref, name: entry.name))
    }

    /// Reads a workspace-folder file into a temp file of its name for Quick Look (`OriginalFiles`). The caller
    /// removes it when the preview closes; a failed or cancelled read leaves none.
    public func original(_ workspaceId: String, _ entry: FileEntry, base: URL = FileManager.default.temporaryDirectory) async throws -> URL {
        guard let ref = entry.ref else { throw ActionError.refused(message: "A folder has no original.", forbidden: false) }
        let file = try OriginalFiles.place(for: entry.name, base: base)
        do {
            try await OriginalFiles.read(size: Int(entry.size ?? 0), to: file) { offset, length, version in
                try await self.wire.request(Methods.WorkFilesRead.self, .init(workspaceId: workspaceId, ref: ref, offset: offset, length: length, version: version))
            }
            return file
        } catch {
            OriginalFiles.remove(file)
            if let failure = error as? OriginalFiles.Failure { throw ActionError.refused(message: failure.description, forbidden: false) }
            throw error
        }
    }

    // MARK: - changes

    public func star(_ workspaceId: String, _ entry: FileEntry, on: Bool) async throws {
        let ref: Methods.WorkFilesStar.Params.Ref = try fileRef(entry)
        let answer = try await wire.request(Methods.WorkFilesStar.self, .init(workspaceId: workspaceId, ref: ref, name: entry.name, on: on))
        patch(entry.key) { $0 = $0.starred(answer.starred) }
    }

    /// Renames a file or folder; answers it as it is now.
    @discardableResult
    public func rename(_ workspaceId: String, _ entry: FileEntry, to name: String, in folder: FolderRef) async throws -> FileEntry? {
        let done = try await wire.request(Methods.WorkFilesRename.self, .init(workspaceId: workspaceId, ref: try fileRef(entry), name: name, op: FilesRules.op()))
        try refused(done)
        await list(workspaceId, folder)
        return done.entries.first
    }

    /// Makes a document, sheet or folder in `folder` (a lens: the workspace's folder); answers what was made.
    @discardableResult
    public func make(_ workspaceId: String, in folder: FolderRef, kind: Methods.WorkFilesMake.Params.Kind, name: String?) async throws -> FileEntry? {
        let done = try await wire.request(Methods.WorkFilesMake.self, .init(workspaceId: workspaceId, at: folder, kind: kind, name: name, op: FilesRules.op()))
        try refused(done)
        await list(workspaceId, folder)
        return done.entries.first
    }

    /// Moves things to Trash; answers the Trash rows Put back takes.
    public func trash(_ workspaceId: String, _ entries: [FileEntry], in folder: FolderRef) async throws -> [String] {
        let refs = try entries.map { entry -> Methods.WorkFilesTrash.Params.Ref in try fileRef(entry) }
        let done = try await wire.request(Methods.WorkFilesTrash.self, .init(workspaceId: workspaceId, refs: refs, op: FilesRules.op()))
        try refused(done)
        let gone = Set(entries.map(\.key))
        let slot = Self.slot(workspaceId, folder)
        if var shown = listings[slot]?.value {
            shown.entries.removeAll { gone.contains($0.key) }
            listings[slot] = .loaded(shown)
        }
        return done.trashed ?? []
    }

    /// Puts Trash rows back where they were (Undo after a delete).
    public func restore(_ workspaceId: String, _ ids: [String], in folder: FolderRef) async throws {
        let done = try await wire.request(Methods.WorkFilesRestore.self, .init(workspaceId: workspaceId, ids: ids, op: FilesRules.op()))
        try refused(done)
        await list(workspaceId, folder)
    }

    /// Uploads a file into `folder` (`work.files.upload`, then `attachment.chunk` in order and `commit`), its
    /// progress on `uploads` for the folder's row. A failure aborts the upload on the host and keeps the row
    /// with its reason until `dismissUpload`.
    public func upload(_ workspaceId: String, into folder: FolderRef, _ source: UploadSource) async throws {
        let slot = Self.slot(workspaceId, folder)
        let row = Upload(id: UUID().uuidString, name: source.name, sent: 0, size: source.size)
        uploads[slot, default: []].append(row)
        let begun: String
        do {
            begun = try await wire.request(Methods.WorkFilesUpload.self, .init(workspaceId: workspaceId, at: folder, name: source.name, size: source.size, sha256: source.sha256, op: FilesRules.op())).uploadId
        } catch {
            setUpload(slot, row.id) { $0.failed = ActionError.wrap(error).message }
            throw error
        }
        do {
            for range in AttachmentUpload.ranges(size: source.size, chunkBytes: AttachmentUpload.maxChunkBytes) {
                try Task.checkCancellation()
                let bytes = try source.read(range.offset, range.length)
                _ = try await wire.request(Methods.AttachmentChunk.self, .init(uploadId: begun, index: range.index, dataBase64: bytes.base64EncodedString()))
                setUpload(slot, row.id) { $0.sent = range.offset + range.length }
            }
            try Task.checkCancellation()
            _ = try await wire.request(Methods.AttachmentCommit.self, .init(uploadId: begun))
            uploads[slot]?.removeAll { $0.id == row.id }
            await list(workspaceId, folder)
        } catch {
            let wire = self.wire
            Task { _ = try? await wire.request(Methods.AttachmentAbort.self, .init(uploadId: begun)) }
            setUpload(slot, row.id) { $0.failed = ActionError.wrap(error).message }
            throw error
        }
    }

    public func dismissUpload(_ workspaceId: String, _ folder: FolderRef, id: String) {
        uploads[Self.slot(workspaceId, folder)]?.removeAll { $0.id == id }
    }

    private func setUpload(_ slot: String, _ id: String, _ change: (inout Upload) -> Void) {
        guard let index = uploads[slot]?.firstIndex(where: { $0.id == id }) else { return }
        change(&uploads[slot]![index])
    }

    /// The host's sentence for what it would not do, as it is.
    private func refused(_ done: FileDone) throws {
        guard let first = done.refused.first else { return }
        throw ActionError.refused(message: first.text, forbidden: false)
    }

    private func fileRef<R: FileRefCase>(_ entry: FileEntry) throws -> R {
        if let ref = entry.ref { return R.canvasSource(ref) }
        if let folder = entry.folder { return R.folderRef(folder) }
        throw ActionError.refused(message: "\(entry.name) is out of reach.", forbidden: false)
    }

    private func patch(_ key: String, _ change: (inout FileEntry) -> Void) {
        for (slot, read) in listings {
            guard var shown = read.value, let index = shown.entries.firstIndex(where: { $0.key == key }) else { continue }
            change(&shown.entries[index])
            listings[slot] = .loaded(shown)
        }
    }

    // MARK: - pushes

    func apply(_ push: ServerPush) {
        guard case .workFiles(let value) = push else { return }
        if value.places == true, places[value.workspaceId] != nil { Task { await self.loadPlaces(value.workspaceId) } }
        guard let at = value.at else { return }
        for (slot, folder) in folders where folder.workspaceId == value.workspaceId && FilesRules.key(folder.at) == at {
            guard listings[slot] != nil else { continue }
            Task { await self.list(folder.workspaceId, folder.at) }
        }
    }

    /// A folder screen left: its rows are not kept current any longer.
    public func forget(_ workspaceId: String, _ folder: FolderRef) {
        let slot = Self.slot(workspaceId, folder)
        folders[slot] = nil
        listings[slot] = nil
    }
}

/// The two ways a verb that takes either names a thing (`FileRef`): the generated params enums share them.
protocol FileRefCase {
    static func canvasSource(_ ref: CanvasSource) -> Self
    static func folderRef(_ folder: FolderRef) -> Self
}

extension Methods.WorkFilesStar.Params.Ref: FileRefCase {}
extension Methods.WorkFilesRename.Params.Ref: FileRefCase {}
extension Methods.WorkFilesTrash.Params.Ref: FileRefCase {}

extension FileEntry {
    /// The same row with its star set.
    func starred(_ on: Bool) -> FileEntry {
        FileEntry(key: key, ref: ref, folder: folder, name: name, kind: kind, size: size, changed: changed, by: by, local: local, shared: shared, state: state, where: `where`, project: project, madeBy: madeBy, fresh: fresh, starred: on)
    }
}
