import Foundation
import TempCodeContract

/// The Outbox's waiting rows as the phone keeps them (`WorkCache.waiting`: the act's words, its place and its
/// time, never the payload), so a cold launch paints the list and its count before any socket answers. A kept
/// row opens a read view only: no press is drawn until the item is read fresh on this link.
@MainActor
public protocol OutboxRowsCache: AnyObject {
    /// The rows kept under a host's key, read at once (the first frame waits on nothing else).
    func waitingRows(_ key: WorkCache.Key) -> [WorkCache.WaitingRow]
    /// Writes one host's rows at its key, off the main actor, in order.
    func keepWaiting(_ rows: [WorkCache.WaitingRow], at key: WorkCache.Key)
    func drop(_ reason: WorkCacheDrop)
}

public extension WorkCache {
    /// A host's Outbox rows' key: the key's id as the account and when it was paired as its generation, as
    /// Today's rows are keyed (`TodayHostInput.key`), so a replaced key never reads the old one's rows.
    static func outboxKey(_ environment: PairedEnvironment) -> Key {
        Key(host: environment.id, account: environment.keyId, keyGeneration: Int(environment.addedAt), scope: .outbox)
    }

    /// The kept rows as the list draws them before its host answers: one band per place (the job, or Work Chats),
    /// bands by their oldest row, rows oldest first, as Waiting orders a band.
    static func keptBands(_ rows: [WaitingRow]) -> [KeptBand] {
        var bands: [String: [WaitingRow]] = [:]
        var order: [String] = []
        for row in rows.sorted(by: { ($0.at, $0.id) < ($1.at, $1.id) }) {
            let place = row.place ?? "Work"
            if bands[place] == nil { order.append(place) }
            bands[place, default: []].append(row)
        }
        return order.map { KeptBand(place: $0, rows: bands[$0] ?? []) }
    }

    /// One place's kept rows, as a band of the list.
    struct KeptBand: Hashable, Sendable, Identifiable {
        public var place: String
        public var rows: [WaitingRow]
        public var id: String { place }
    }
}

public extension WorkCacheBook {
    /// The Outbox rows kept under one key.
    func waiting(_ key: WorkCache.Key) -> [WorkCache.WaitingRow] {
        guard case .outbox(let rows)? = get(key) else { return [] }
        return rows
    }
}

/// The Outbox's kept rows in memory: tests, and a phone whose store could not open.
@MainActor
public final class OutboxBookCache: OutboxRowsCache {
    public private(set) var book = WorkCacheBook()
    /// Writes made, for a test that counts them.
    public private(set) var writes = 0

    public init(book: WorkCacheBook = WorkCacheBook()) {
        self.book = book
    }

    public func waitingRows(_ key: WorkCache.Key) -> [WorkCache.WaitingRow] { book.waiting(key) }

    public func keepWaiting(_ rows: [WorkCache.WaitingRow], at key: WorkCache.Key) {
        book.put(.outbox(rows), at: key)
        writes += 1
    }

    public func drop(_ reason: WorkCacheDrop) { book.drop(reason) }
}

/// What the Outbox keeps, host by host, and when it writes: on each answer of a host's list (the list itself, or
/// a push that changed an item), only when the rows differ from what is kept, and only while the host's list has
/// answered on this link (an unread list writes nothing over what was kept).
@MainActor
public final class OutboxKept {
    private let cache: OutboxRowsCache
    /// Each host's rows as last read or written, by key.
    private var known: [WorkCache.Key: [WorkCache.WaitingRow]] = [:]

    public init(cache: OutboxRowsCache) {
        self.cache = cache
    }

    /// The rows kept for a host, read from the cache once per key.
    public func rows(_ key: WorkCache.Key) -> [WorkCache.WaitingRow] {
        if let rows = known[key] { return rows }
        let rows = cache.waitingRows(key)
        known[key] = rows
        return rows
    }

    /// A host's list answered: its rows as they stand now are written when they changed.
    public func keep(_ rows: [WorkCache.WaitingRow], at key: WorkCache.Key) {
        guard self.rows(key) != rows else { return }
        known[key] = rows
        cache.keepWaiting(rows, at: key)
    }

    public func drop(_ reason: WorkCacheDrop) {
        for key in reason.drops(known.keys) { known[key] = nil }
        cache.drop(reason)
    }
}

#if canImport(SQLite3)
/// The Outbox's rows through the SQLite store (`WorkCacheStore`, the file Today's rows share): read at once,
/// written in order off the main actor.
@MainActor
public final class OutboxDiskCache: OutboxRowsCache {
    private let store: WorkCacheStore
    private let writer: OrderedWriter<WorkCacheStore>

    public init(store: WorkCacheStore) {
        self.store = store
        writer = OrderedWriter(cache: store)
    }

    /// The phone's own file; a store that cannot open, or whose protection or backup exclusion was refused, is a
    /// cache in memory (nothing kept across launches).
    public static func opened() -> OutboxRowsCache {
        WorkCacheStore.shared.map { OutboxDiskCache(store: $0) as OutboxRowsCache } ?? OutboxBookCache()
    }

    /// A file of its own (tests).
    public static func opened(path: URL, protect: (URL) throws -> Void) -> OutboxRowsCache {
        guard let store = try? WorkCacheStore(path: path, protect: protect) else { return OutboxBookCache() }
        return OutboxDiskCache(store: store)
    }

    public func waitingRows(_ key: WorkCache.Key) -> [WorkCache.WaitingRow] {
        guard case .outbox(let rows)? = store.get(key) else { return [] }
        return rows
    }

    public func keepWaiting(_ rows: [WorkCache.WaitingRow], at key: WorkCache.Key) {
        let stamp = WorkCacheFence.stamp(key.host)
        writer.write { store in try? store.put(.outbox(rows), at: key, stamp: stamp) }
    }

    public func drop(_ reason: WorkCacheDrop) {
        writer.write { store in store.drop(reason) }
    }

    /// Returns once every write queued before it is on disk.
    public func drained() async { await writer.drained() }
}
#endif
