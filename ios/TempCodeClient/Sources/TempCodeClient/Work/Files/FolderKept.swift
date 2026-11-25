import Foundation
import TempCodeContract

/// Each Files folder's last page of names as the phone keeps them (`WorkCache.FolderPage`), so a folder opened
/// on a cold launch paints its rows before its host answers. Display rows only: a kept file row carries no ref,
/// so it opens nothing until the folder is read fresh; a kept folder row still pushes its list.
@MainActor
public protocol FolderRowsCache: AnyObject {
    func folderPage(_ key: WorkCache.Key) -> WorkCache.FolderPage?
    /// Writes one folder's page, off the main actor, in order.
    func keepFolder(_ page: WorkCache.FolderPage, at key: WorkCache.Key)
    func drop(_ reason: WorkCacheDrop)
}

public extension WorkCache {
    /// A folder's key: the host's key as Today's and the Outbox's rows are keyed (`outboxKey`), the workspace, and
    /// the folder's `refKey`.
    static func folderKey(_ environment: PairedEnvironment, workspaceId: String, folder: FolderRef) -> Key {
        Key(host: environment.id, account: environment.keyId, keyGeneration: Int(environment.addedAt), workspaceId: workspaceId, scope: .folder(FilesRules.key(folder)))
    }

    /// A page as kept: the first `limit` rows, each its display alone.
    static func folderPage(_ folder: FolderRef, _ entries: [FileEntry], limit: Int = 200) -> FolderPage {
        let rows = entries.prefix(limit).map { FolderRow(key: $0.key, name: $0.name, kind: $0.kind.rawValue, folder: $0.folder, changed: $0.changed) }
        return FolderPage(folder: FilesRules.key(folder), names: rows.map(\.name), rows: Array(rows))
    }

    /// The kept rows as entries the list draws: no ref, so a file row is not opened from them.
    static func entries(_ page: FolderPage) -> [FileEntry] {
        (page.rows ?? page.names.map { FolderRow(key: "kept:\($0)", name: $0, kind: "other") }).map { row in
            FileEntry(key: row.key, ref: nil, folder: row.folder, name: row.name, kind: FileEntry.Kind(rawValue: row.kind), changed: row.changed)
        }
    }
}

/// What the Files place keeps, folder by folder: written on each fresh first page whose rows differ from what is
/// kept, read once per folder.
@MainActor
public final class FolderKept {
    private let cache: FolderRowsCache
    private let environment: PairedEnvironment
    private var known: [WorkCache.Key: WorkCache.FolderPage] = [:]

    public init(cache: FolderRowsCache, environment: PairedEnvironment) {
        self.cache = cache
        self.environment = environment
    }

    /// The page kept for a folder of this host, as entries; nil when none is.
    public func page(_ host: String, _ workspaceId: String, _ folder: FolderRef) -> (entries: [FileEntry], page: WorkCache.FolderPage)? {
        guard host == environment.id else { return nil }
        let key = WorkCache.folderKey(environment, workspaceId: workspaceId, folder: folder)
        guard let page = known[key] ?? cache.folderPage(key) else { return nil }
        known[key] = page
        return (WorkCache.entries(page), page)
    }

    /// A folder's first page answered: kept when it differs from what was.
    public func keep(_ host: String, _ workspaceId: String, _ folder: FolderRef, _ entries: [FileEntry]) {
        guard host == environment.id else { return }
        let key = WorkCache.folderKey(environment, workspaceId: workspaceId, folder: folder)
        let page = WorkCache.folderPage(folder, entries)
        guard (known[key] ?? cache.folderPage(key)) != page else { return }
        known[key] = page
        cache.keepFolder(page, at: key)
    }

    public func drop(_ reason: WorkCacheDrop) {
        for key in reason.drops(known.keys) { known[key] = nil }
        cache.drop(reason)
    }
}

public extension WorkCacheBook {
    func folder(_ key: WorkCache.Key) -> WorkCache.FolderPage? {
        guard case .folder(let page)? = get(key) else { return nil }
        return page
    }
}

/// Kept folder pages in memory: tests, and a phone whose store could not open.
@MainActor
public final class FolderBookCache: FolderRowsCache {
    public private(set) var book = WorkCacheBook()
    /// Writes made, for a test that counts them.
    public private(set) var writes = 0

    public init(book: WorkCacheBook = WorkCacheBook()) {
        self.book = book
    }

    public func folderPage(_ key: WorkCache.Key) -> WorkCache.FolderPage? { book.folder(key) }

    public func keepFolder(_ page: WorkCache.FolderPage, at key: WorkCache.Key) {
        book.put(.folder(page), at: key)
        writes += 1
    }

    public func drop(_ reason: WorkCacheDrop) { book.drop(reason) }
}

#if canImport(SQLite3)
/// Folder pages through the SQLite store the Outbox's and Today's rows share: read at once, written in order off
/// the main actor.
@MainActor
public final class FolderDiskCache: FolderRowsCache {
    private let store: WorkCacheStore
    private let writer: OrderedWriter<WorkCacheStore>

    public init(store: WorkCacheStore) {
        self.store = store
        writer = OrderedWriter(cache: store)
    }

    /// The phone's own file, opened once a run; a store that cannot open is a cache in memory.
    public static let shared: FolderRowsCache = {
        // The one shared connection (`WorkCacheStore.shared`), so a purge and a write are one order.
        WorkCacheStore.shared.map { FolderDiskCache(store: $0) as FolderRowsCache } ?? FolderBookCache()
    }()

    public func folderPage(_ key: WorkCache.Key) -> WorkCache.FolderPage? {
        guard case .folder(let page)? = store.get(key) else { return nil }
        return page
    }

    public func keepFolder(_ page: WorkCache.FolderPage, at key: WorkCache.Key) {
        let stamp = WorkCacheFence.stamp(key.host)
        writer.write { store in try? store.put(.folder(page), at: key, stamp: stamp) }
    }

    public func drop(_ reason: WorkCacheDrop) {
        writer.write { store in store.drop(reason) }
    }
}
#endif
