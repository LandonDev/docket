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
        /// Why the next page did not come: the rows stay, and the foot offers Try Again.
        public var moreFailed: String? = nil
        /// Painted from the names kept on the phone: shown, opened to read, until the host answers.
        public var cached = false
        /// Why the read over kept rows failed: one line above them.
        public var failed: String? = nil
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
    /// The folder slots whose next page is being asked for now: the foot's spinner, only while one runs.
    public private(set) var askingMore: Set<String> = []
    /// How far each copy of a file on another computer has got while it opens, by `FilesRules.openingTag` of
    /// the row's key (0 to 1): the `work.files` push's `opening`. Gone once the open answers.
    public private(set) var opening: [String: Double] = [:]
    /// Small pictures the host made, by `thumbKey` (the row's key and when it changed); a file with none is absent.
    public private(set) var thumbs: [String: Data] = [:]
    /// The computers each workspace may use that its host reaches for the phone (`work.files.across`).
    public private(set) var far: [String: WorkRead<[FarDesktop]>] = [:]

    /// A computer of his the workspace may use, as its host reached it: its name and its places, or why not.
    public struct FarDesktop: Equatable, Sendable, Identifiable {
        public let host: String
        public var name: String
        public var places: [FilePlace]
        /// The host's words when the computer did not answer.
        public var failed: String?
        public var id: String { host }
    }

    @ObservationIgnored private let wire: any FilesWire
    @ObservationIgnored private var folders: [String: (workspaceId: String, at: FolderRef)] = [:]
    /// Folder slots listed through a far computer (`work.files.across`), by slot.
    @ObservationIgnored private var farHosts: [String: String] = [:]
    /// Thumbnails asked for once this run, by `thumbKey`, so a file with none is not asked again.
    @ObservationIgnored private var asked: Set<String> = []
    /// Kept folder pages for the cold paint (`FolderKept`); nil keeps nothing.
    @ObservationIgnored public var kept: FolderKept?

    public init(wire: any FilesWire, environmentId: String, caps: FilesRules.Caps) {
        self.wire = wire
        self.environmentId = environmentId
        self.caps = caps
    }

    /// Moves when the host refuses the key (`revoked`): a read that left before answers into nothing.
    @ObservationIgnored private var generation = 0

    /// The host refused the key: every place, listing and far desktop read of it goes.
    func revoked() {
        generation += 1
        places = [:]
        listings = [:]
        far = [:]
        thumbs = [:]
        opening = [:]
        askingMore = []
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
        let asked = generation
        let read = await WorkRead.of { try await self.wire.request(Methods.WorkFilesPlaces.self, .init(workspaceId: workspaceId)).places }
        guard asked == generation else { return }
        if case .failed = read, places[workspaceId]?.value != nil { return }
        places[workspaceId] = read
    }

    /// A folder or lens from its first page. A folder that changed between pages answers `stale`: read it again
    /// from the top, once.
    public func list(_ workspaceId: String, _ folder: FolderRef, through far: String? = nil) async {
        let slot = Self.slot(workspaceId, folder)
        folders[slot] = (workspaceId, folder)
        if let far { farHosts[slot] = far }
        if listings[slot] == nil {
            // The cold paint: the names kept from the last read, until this one answers.
            if let page = kept?.page(environmentId, workspaceId, folder) { listings[slot] = .loaded(Listing(entries: page.entries, next: nil, trail: [], asOf: nil, cached: true)) } else { listings[slot] = .reading }
        }
        let asked = generation
        var read = await WorkRead.of { try await self.page(workspaceId, folder, cursor: nil) }
        if case .loaded(let page) = read, page.stale { read = await WorkRead.of { try await self.page(workspaceId, folder, cursor: nil) } }
        // The host refused the key while this was out: the answer lands nowhere.
        guard asked == generation else { return }
        switch read {
        case .loaded(let page):
            listings[slot] = .loaded(Listing(entries: page.listing.entries, next: page.listing.next, trail: page.listing.trail?.map(\.name) ?? [], asOf: page.listing.asOf))
            kept?.keep(environmentId, workspaceId, folder, page.listing.entries)
        case .failed(let message):
            // A kept page stays under the failure's line; with nothing shown the failure is the screen.
            if var shown = listings[slot]?.value, shown.cached { shown.failed = FilesRules.sentence(message); listings[slot] = .loaded(shown) } else if listings[slot]?.value == nil { listings[slot] = .failed(message) }
        case .reading: break
        }
    }

    /// Whether the next page of a folder is being asked for now.
    public func loadingMore(_ workspaceId: String, _ folder: FolderRef) -> Bool { askingMore.contains(Self.slot(workspaceId, folder)) }

    /// The next page of a folder shown, appended; a folder that changed since lists again from the top. A page
    /// that fails keeps the rows and its cursor and says why (`moreFailed`), for the foot's Try Again; one ask at
    /// a time per folder.
    public func more(_ workspaceId: String, _ folder: FolderRef) async {
        let slot = Self.slot(workspaceId, folder)
        guard let shown = listings[slot]?.value, let cursor = shown.next, !askingMore.contains(slot) else { return }
        askingMore.insert(slot)
        defer { askingMore.remove(slot) }
        let page: Page
        do {
            page = try await self.page(workspaceId, folder, cursor: cursor)
        } catch {
            guard var now = listings[slot]?.value, now.next == cursor else { return }
            now.moreFailed = FilesRules.sentence(ActionError.wrap(error).message)
            listings[slot] = .loaded(now)
            return
        }
        if page.stale { return await list(workspaceId, folder, through: farHosts[slot]) }
        // A newer read may have replaced the list meanwhile: append only to the one this cursor came from.
        guard var now = listings[slot]?.value, now.next == cursor else { return }
        now.entries += page.listing.entries.filter { row in !now.entries.contains { $0.key == row.key } }
        now.next = page.listing.next
        now.moreFailed = nil
        listings[slot] = .loaded(now)
    }

    private struct Page: Sendable {
        let listing: FilesListing
        var stale: Bool { listing.stale == true }
    }

    private func page(_ workspaceId: String, _ folder: FolderRef, cursor: String?) async throws -> Page {
        if let far = farHosts[Self.slot(workspaceId, folder)] {
            var params: [String: JSONValue] = ["at": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(folder))]
            if let cursor { params["cursor"] = .string(cursor) }
            return Page(listing: try await across(workspaceId, host: far, .workFilesList, params, as: FilesListing.self))
        }
        return Page(listing: try await wire.request(Methods.WorkFilesList.self, .init(workspaceId: workspaceId, at: folder, cursor: cursor)))
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
        let tag = FilesRules.openingTag(entry.key)
        defer { opening[tag] = nil }
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

    /// A shared Office file's web address and its app, for Open in Word; nil where the host has none or did not
    /// answer, which leaves the facts as they are.
    public func officeAddress(_ workspaceId: String, _ entry: FileEntry) async -> (app: FilesRules.OfficeApp, address: String)? {
        guard let ref = entry.ref else { return nil }
        guard let answer = try? await wire.request(Methods.WorkOfficeLiveAddress.self, .init(workspaceId: workspaceId, ref: ref)),
              let address = answer.address, let app = answer.app.flatMap({ FilesRules.OfficeApp(rawValue: $0.rawValue) }) else { return nil }
        return (app, address)
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
    /// `asked`: his yes to "Delete for everyone?"; `forGood`: to a delete on a drive with no bin.
    public func trash(_ workspaceId: String, _ entries: [FileEntry], in folder: FolderRef, asked: Bool = false, forGood: Bool = false) async throws -> [String] {
        let refs = try entries.map { entry -> Methods.WorkFilesTrash.Params.Ref in try fileRef(entry) }
        let done = try await wire.request(Methods.WorkFilesTrash.self, .init(workspaceId: workspaceId, refs: refs, op: FilesRules.op(), asked: asked ? true : nil, forGood: forGood ? true : nil))
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

    // MARK: - moves, copies, Go to, saved searches, thumbnails

    /// Moves things into `to`; inside one place a rename, across places a copy, a check, then the source to
    /// Trash (the host's). `asked`: his yes to the one question a shared place asks (`FilesRules.question`).
    public func move(_ workspaceId: String, _ entries: [FileEntry], to: FolderRef, from folder: FolderRef, asked: Bool) async throws {
        let refs = try entries.map { entry -> Methods.WorkFilesMove.Params.Ref in try fileRef(entry) }
        let done = try await wire.request(Methods.WorkFilesMove.self, .init(workspaceId: workspaceId, refs: refs, to: to, op: FilesRules.op(), asked: asked ? true : nil))
        try refused(done)
        await relist(workspaceId, [folder, to])
    }

    /// Copies things into `to`; the same question first where others can open it.
    public func copy(_ workspaceId: String, _ entries: [FileEntry], to: FolderRef, from folder: FolderRef, asked: Bool) async throws {
        let refs = try entries.map { entry -> Methods.WorkFilesCopy.Params.Ref in try fileRef(entry) }
        let done = try await wire.request(Methods.WorkFilesCopy.self, .init(workspaceId: workspaceId, refs: refs, to: to, op: FilesRules.op(), asked: asked ? true : nil))
        try refused(done)
        await relist(workspaceId, [folder, to])
    }

    /// Lists again each folder of these that is shown.
    private func relist(_ workspaceId: String, _ folders: [FolderRef]) async {
        for folder in folders where listings[Self.slot(workspaceId, folder)] != nil { await list(workspaceId, folder) }
    }

    /// Go to's rows for what he typed: names this host has seen, recents first (twenty at most, from its table).
    public func names(_ workspaceId: String, _ text: String) async throws -> [FileEntry] {
        try await wire.request(Methods.WorkFilesNames.self, .init(workspaceId: workspaceId, text: text)).entries
    }

    /// The searches he saved on his computer: read here, made there.
    public func searches(_ workspaceId: String) async throws -> [SavedFileSearch] {
        try await wire.request(Methods.WorkFilesSearches.self, .init(workspaceId: workspaceId)).searches
    }

    /// A saved search run: its words and its filter, the filter carried over as the wire names it.
    public func search(_ workspaceId: String, _ saved: SavedFileSearch) async throws -> [FileEntry] {
        let filter = try saved.filter.map { try JSONDecoder().decode(Methods.WorkFilesSearch.Params.Filter.self, from: JSONEncoder().encode($0)) }
        return try await wire.request(Methods.WorkFilesSearch.self, .init(workspaceId: workspaceId, query: saved.query, filter: filter)).entries
    }

    /// The key a thumbnail is kept by: a row's key and when it changed, so a saved file draws again.
    public static func thumbKey(_ entry: FileEntry) -> String { "\(entry.key)@\(Int(entry.changed ?? 0))" }

    /// Asks the host for the pictures of the rows that have none yet (forty an ask), at one of the grid's sizes.
    /// A row the host has no picture of stays absent and draws its kind's glyph; a failed ask draws glyphs too.
    public func loadThumbs(_ workspaceId: String, _ entries: [FileEntry], size: Int) async {
        let wanted = entries.filter { FilesRules.hasThumb($0) && thumbs[Self.thumbKey($0)] == nil && !asked.contains(Self.thumbKey($0)) }
        for chunk in stride(from: 0, to: wanted.count, by: 40).map({ Array(wanted[$0..<min($0 + 40, wanted.count)]) }) {
            chunk.forEach { asked.insert(Self.thumbKey($0)) }
            guard let answer = try? await wire.request(Methods.WorkFilesThumbs.self, .init(workspaceId: workspaceId, refs: chunk.compactMap(\.ref), size: .number(Double(size)))) else { continue }
            for (entry, picture) in zip(chunk.filter { $0.ref != nil }, answer.thumbs) {
                if let picture, let data = Data(base64Encoded: picture) { thumbs[Self.thumbKey(entry)] = data }
            }
        }
    }

    // MARK: - a computer reached through the workspace's host

    /// The computers the workspace may use other than its own host, each asked through it for its places
    /// (`work.files.across`): one that does not answer keeps its name and the host's words.
    public func loadFar(_ workspaceId: String) async {
        let asked = generation
        let read = await WorkRead.of { () -> [FarDesktop] in
            let ids = try await self.wire.request(Methods.WorkWorkspaceGet.self, .init(workspaceId: workspaceId)).mayUseDesktop.filter { $0 != self.environmentId }
            var found: [FarDesktop] = []
            for id in ids {
                do {
                    let answer = try await self.across(workspaceId, host: id, .workFilesPlaces, [:], as: FarPlaces.self)
                    found.append(FarDesktop(host: id, name: answer.name ?? id, places: answer.places))
                } catch {
                    found.append(FarDesktop(host: id, name: self.far[workspaceId]?.value?.first { $0.host == id }?.name ?? id, places: [], failed: FilesRules.sentence(ActionError.wrap(error).message)))
                }
            }
            return found
        }
        guard asked == generation else { return }
        if case .failed = read, far[workspaceId]?.value != nil { return }
        far[workspaceId] = read
    }

    /// What a far computer answers, as the place list reads it: its name as the host names it, and its places.
    struct FarPlaces: Decodable, Sendable {
        let name: String?
        let places: [FilePlace]
    }

    /// One ask of a far computer through the workspace's host, its answer read as `T`.
    func across<T: Decodable & Sendable>(_ workspaceId: String, host: String, _ method: Methods.WorkFilesAcross.Params.Method, _ params: [String: JSONValue], as: T.Type) async throws -> T {
        var all = params
        all["workspaceId"] = .string(workspaceId)
        let answer = try await wire.request(Methods.WorkFilesAcross.self, .init(workspaceId: workspaceId, host: host, method: method, params: all))
        return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(answer))
    }

    /// The far computer a folder slot is listed through, when it is one.
    public func farHost(_ workspaceId: String, _ folder: FolderRef) -> String? { farHosts[Self.slot(workspaceId, folder)] }

    // MARK: - pushes

    func apply(_ push: ServerPush) {
        guard case .workFiles(let value) = push else { return }
        if let open = value.opening, open.total > 0 { opening[open.of] = min(1, open.done / open.total) }
        if value.places == true, places[value.workspaceId] != nil { Task { await self.loadPlaces(value.workspaceId) } }
        // No push crosses from a far computer: its places are asked again with the workspace's own.
        if value.places == true, far[value.workspaceId] != nil { Task { await self.loadFar(value.workspaceId) } }
        guard let at = value.at else { return }
        for (slot, folder) in folders where folder.workspaceId == value.workspaceId && FilesRules.key(folder.at) == at {
            guard listings[slot] != nil else { continue }
            Task { await self.list(folder.workspaceId, folder.at, through: self.farHosts[slot]) }
        }
    }

    /// A folder screen left: its rows are not kept current any longer.
    public func forget(_ workspaceId: String, _ folder: FolderRef) {
        let slot = Self.slot(workspaceId, folder)
        folders[slot] = nil
        farHosts[slot] = nil
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
extension Methods.WorkFilesMove.Params.Ref: FileRefCase {}
extension Methods.WorkFilesCopy.Params.Ref: FileRefCase {}

extension FileEntry {
    /// The same row with its star set.
    func starred(_ on: Bool) -> FileEntry {
        FileEntry(key: key, ref: ref, folder: folder, name: name, kind: kind, size: size, changed: changed, by: by, local: local, shared: shared, state: state, where: `where`, project: project, madeBy: madeBy, fresh: fresh, starred: on)
    }
}
