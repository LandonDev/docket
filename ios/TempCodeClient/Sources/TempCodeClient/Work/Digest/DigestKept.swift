import Foundation
import TempCodeContract

/// The Digest's days as the phone keeps them (plan TE_fWkYrofJc §5 "The cache": "the Digest's days"), so a cold
/// launch with its host away still shows what Work told him. A day with no rows draws nothing, so each kept day keeps
/// the rows it drew: the tell's words, its job, its time and its target, display data alone (`WorkCache.digest`).
/// Kept in the Work cache's own file, under its protection, keyed and dropped with every other kept row; drawn
/// read-only until the host answers (no day is marked seen from it, `DigestModel.seenCalls(_:live:)`).
@MainActor
public protocol DigestDaysCache: AnyObject {
    func digestDays(_ key: WorkCache.Key) -> DigestModel.Ledger?
    func keepDigest(_ ledger: DigestModel.Ledger, at key: WorkCache.Key)
    func drop(_ reason: WorkCacheDrop)
}

public extension WorkCache {
    /// How many days a launch keeps: the newest, the list's own reach of a fortnight.
    static let digestDaysKept = 14

    /// A host's Digest key, as the Outbox's (`outboxKey`): a replaced key never reads the old one's days.
    static func digestKey(_ environment: PairedEnvironment) -> Key {
        Key(host: environment.id, account: environment.keyId, keyGeneration: Int(environment.addedAt), scope: .digest)
    }

    /// The ledger as kept: the newest days and the rows each drew. Never the settings, and never a row of no day
    /// ("Since the digest", which is live until the next digest is made).
    static func digest(_ ledger: DigestModel.Ledger) -> DigestModel.Ledger {
        let days = Array(ledger.days.sorted { $0.day > $1.day }.prefix(digestDaysKept))
        let kept = Set(days.map(\.day))
        return DigestModel.Ledger(days: days, rows: ledger.rows.filter { $0.day.map(kept.contains) == true }, settings: nil)
    }
}

public extension WorkCacheBook {
    /// The Digest kept under one key.
    func digestDays(_ key: WorkCache.Key) -> DigestModel.Ledger? {
        switch get(key) {
        case .digestDays(let days, let rows)?: DigestModel.Ledger(days: days, rows: rows)
        default: nil
        }
    }
}

/// The Digest's kept days in memory: tests, and a phone whose store could not open.
@MainActor
public final class DigestBookCache: DigestDaysCache {
    public private(set) var book = WorkCacheBook()
    public private(set) var writes = 0

    public init(book: WorkCacheBook = WorkCacheBook()) {
        self.book = book
    }

    public func digestDays(_ key: WorkCache.Key) -> DigestModel.Ledger? { book.digestDays(key) }

    public func keepDigest(_ ledger: DigestModel.Ledger, at key: WorkCache.Key) {
        book.put(.digestDays(days: ledger.days, rows: ledger.rows), at: key)
        writes += 1
    }

    public func drop(_ reason: WorkCacheDrop) { book.drop(reason) }
}

/// One host's kept Digest: read once, written when an answer differs from what is kept.
@MainActor
public final class DigestKept {
    private let cache: DigestDaysCache
    private let key: WorkCache.Key
    private var known: DigestModel.Ledger??

    public init(cache: DigestDaysCache, key: WorkCache.Key) {
        self.cache = cache
        self.key = key
    }

    /// The days kept for this host, nil when none are.
    public var ledger: DigestModel.Ledger? {
        if let known { return known }
        let read = cache.digestDays(key)
        known = .some(read)
        return read
    }

    /// The host answered: what it drew is kept, when it changed.
    public func keep(_ ledger: DigestModel.Ledger) {
        let next = WorkCache.digest(ledger)
        guard self.ledger != next else { return }
        known = .some(next)
        cache.keepDigest(next, at: key)
    }

    /// Work went off on the host: its days go.
    public func drop() {
        known = .some(nil)
        cache.drop(.workOff(host: key.host))
    }
}

#if canImport(SQLite3)
/// The Digest's days through the Work cache's SQLite file (`WorkCacheStore`): read at once, written in order off the
/// main actor.
@MainActor
public final class DigestDiskCache: DigestDaysCache {
    private let store: WorkCacheStore
    private let writer: OrderedWriter<WorkCacheStore>

    public init(store: WorkCacheStore) {
        self.store = store
        writer = OrderedWriter(cache: store)
    }

    /// The phone's own file, opened once a run; a store that cannot open, or whose protection was refused, is a
    /// cache in memory.
    public static let shared: DigestDaysCache = {
        WorkCacheStore.shared.map { DigestDiskCache(store: $0) as DigestDaysCache } ?? DigestBookCache()
    }()

    public func digestDays(_ key: WorkCache.Key) -> DigestModel.Ledger? {
        guard case .digestDays(let days, let rows)? = store.get(key) else { return nil }
        return DigestModel.Ledger(days: days, rows: rows)
    }

    public func keepDigest(_ ledger: DigestModel.Ledger, at key: WorkCache.Key) {
        let stamp = WorkCacheFence.stamp(key.host)
        writer.write { store in try? store.put(.digestDays(days: ledger.days, rows: ledger.rows), at: key, stamp: stamp) }
    }

    public func drop(_ reason: WorkCacheDrop) {
        writer.write { store in store.drop(reason) }
    }
}
#endif
