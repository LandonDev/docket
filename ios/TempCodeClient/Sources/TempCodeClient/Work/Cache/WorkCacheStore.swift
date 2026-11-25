#if canImport(SQLite3)
import Foundation
import Synchronization

/// `WorkCache`'s disk half (plan TE_fWkYrofJc §5 "The cache"): one small SQLite file, `work-cache.sqlite` in its own
/// folder, holding only the values `WorkCacheValue` allows under their `WorkCache.Key`. The folder, the database
/// and its WAL sidecars are under complete file protection (unreadable while the phone is locked) and out of
/// backups; a store whose folder or files cannot be put under both does not open, and the phone keeps its rows in
/// memory for that launch (`TodayDiskCache.opened`). The rules are `WorkCacheBook`'s: a write drops the host's other key generations, a drop takes what
/// `WorkCacheDrop` names. Reads are synchronous, so Today's first frame has its rows; writes go through an
/// `OrderedWriter`, off the main actor, in the order they were made.
public final class WorkCacheStore: Sendable {
    private let db: Mutex<Database>
    /// Purges that failed on the file (a read or write SQLite refused, as while the phone is locked): kept in the
    /// defaults until one runs, so a launch never seeds rows a purge meant to take.
    private let purges: WorkCachePurges
    /// A purge is kept and waits for the next write, or the next purge, to run again.
    private let retry = Atomic<Bool>(false)
    /// Today's own epoch, over every host, moved by a LifeOS sign-out's drop: a Today row is kept under the host its
    /// press opens on, which need not be the host whose LifeOS read it, so no host's fence alone refuses it.
    private let todayEpoch = Atomic<Int>(0)

    /// Taken when a Today write is queued (`put`'s `todayStamp`).
    public func todayStamp() -> Int {
        todayEpoch.load(ordering: .sequentiallyConsistent)
    }

    /// The phone's one connection to the file, shared by Today's, the Outbox's, the Digest's and the folders'
    /// caches: one lock serializes every write's fence check and commit with every purge, so a write the fence let
    /// through either lands before a purge (which then takes it) or is refused after it. Nil when the file would not
    /// open or be protected; each cache then keeps its rows in memory for the run.
    public static let shared: WorkCacheStore? = {
        guard let store = try? WorkCacheStore(path: defaultPath()) else { return nil }
        // What a run with no file purged, or a purge the file refused, runs first, before any cache writes.
        store.retryPending()
        return store
    }()

    /// Something of a host went (its key refused, Work off, the host removed, its key paired again): the fence moves
    /// (closed for a refused or removed host), then every row the reason names goes in one statement on the shared
    /// connection, now. A write queued before this, in any of the four caches, is refused by its stamp.
    public static func purge(_ reason: WorkCacheDrop, close: Bool) {
        if let host = reason.host {
            if close { WorkCacheFence.close(host) } else { WorkCacheFence.purge(host) }
        }
        if let shared {
            shared.retryPending()
            shared.drop(reason)
        } else {
            WorkCachePurges().add(reason)
        }
    }

    /// Opens the file at `path`, its folder and every file of it first put under `protect` (complete protection and
    /// no backup, `WorkCacheStore.protect`). A failure of either throws, so nothing is written unprotected.
    public convenience init(path: URL, protect: (URL) throws -> Void = WorkCacheStore.protect) throws(CacheError) {
        let folder = path.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do { try protect(folder) } catch { throw CacheError.encoding("not protected: \(error)") }
        try self.init(databasePath: path.path(percentEncoded: false))
        // The WAL and SHM files exist once the journal mode is set: each is protected before the first write.
        for suffix in ["", "-wal", "-shm"] {
            let file = URL(fileURLWithPath: path.path(percentEncoded: false) + suffix)
            guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { continue }
            do { try protect(file) } catch { throw CacheError.encoding("not protected: \(error)") }
        }
    }

    init(databasePath: String, purges: WorkCachePurges = WorkCachePurges()) throws(CacheError) {
        self.purges = purges
        let db = try Database(path: databasePath)
        try db.exec("PRAGMA journal_mode = WAL")
        try db.exec("PRAGMA synchronous = NORMAL")
        try db.exec("""
        CREATE TABLE IF NOT EXISTS kept (host TEXT NOT NULL, account TEXT NOT NULL, generation INTEGER NOT NULL, workspace TEXT NOT NULL, scope TEXT NOT NULL, json BLOB NOT NULL, PRIMARY KEY (host, account, generation, workspace, scope));
        """)
        self.db = Mutex(db)
    }

    public static func inMemory(purges: WorkCachePurges = WorkCachePurges()) throws(CacheError) -> WorkCacheStore {
        try WorkCacheStore(databasePath: ":memory:", purges: purges)
    }

    /// Runs the kept purges again, in order; one the file still refuses stays kept.
    public func retryPending() {
        retry.store(false, ordering: .relaxed)
        for reason in purges.take() { drop(reason) }
    }

    #if DEBUG
    /// Tests: a statement run on the file as it is, to make SQLite refuse a purge and then take it again.
    func execForTests(_ sql: String) throws(CacheError) {
        try db.withLock { (db) throws(CacheError) in try db.exec(sql) }
    }
    #endif

    public static func defaultPath() -> URL {
        EnvironmentStore.defaultDirectory().appending(path: "WorkCache", directoryHint: .isDirectory).appending(path: "work-cache.sqlite")
    }

    /// Complete protection and no backup, on the folder (the sidecars SQLite makes later take its class) and on
    /// each file that is there; either one refused throws.
    public static func protect(_ url: URL) throws {
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path(percentEncoded: false))
        #endif
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var marked = url
        try marked.setResourceValues(values)
    }

    private static func binds(_ key: WorkCache.Key) -> [Database.Value] {
        [.text(key.host), .text(key.account), .int(key.keyGeneration), .text(key.workspaceId ?? ""), .text(key.scope.text)]
    }

    public func get(_ key: WorkCache.Key) -> WorkCacheValue? {
        db.withLock { db -> WorkCacheValue? in
            var out: WorkCacheValue?
            try? db.query("SELECT json FROM kept WHERE host = ? AND account = ? AND generation = ? AND workspace = ? AND scope = ?", Self.binds(key)) { row in
                out = try? JSONDecoder().decode(WorkCacheValue.self, from: row.blob(0))
            }
            return out
        }
    }

    public func keys() -> [WorkCache.Key] {
        db.withLock { db -> [WorkCache.Key] in
            var out: [WorkCache.Key] = []
            try? db.query("SELECT host, account, generation, workspace, scope FROM kept") { row in
                guard let scope = WorkCache.Scope(text: row.text(4)) else { return }
                let workspace = row.text(3)
                out.append(WorkCache.Key(host: row.text(0), account: row.text(1), keyGeneration: row.int(2), workspaceId: workspace.isEmpty ? nil : workspace, scope: scope))
            }
            return out
        }
    }

    /// Writes `value` at `key`, and drops the host's rows of any other key generation, in one transaction. A host the
    /// fence holds closed, a write queued before its last close (`stamp`, `WorkCacheFence`), or a Today write queued
    /// before the last LifeOS sign-out (`todayStamp`), writes nothing. A purge the file refused runs first.
    public func put(_ value: WorkCacheValue, at key: WorkCache.Key, stamp: Int? = nil, todayStamp: Int? = nil) throws(CacheError) {
        guard value.scope == key.scope else { throw CacheError.encoding("a value is kept under its own scope") }
        let json: Data
        do { json = try JSONEncoder().encode(value) } catch { throw CacheError.encoding(String(describing: error)) }
        if retry.load(ordering: .relaxed) { retryPending() }
        try db.withLock { (db) throws(CacheError) in
            // Under the lock a purge takes too: the check and the commit are one step against it.
            guard WorkCacheFence.admits(key.host, stamp: stamp), todayStamp.map({ $0 == self.todayStamp() }) ?? true else { return }
            try db.transaction { () throws(CacheError) in
                try db.run("DELETE FROM kept WHERE host = ? AND generation != ?", [.text(key.host), .int(key.keyGeneration)])
                try db.run("INSERT OR REPLACE INTO kept (host, account, generation, workspace, scope, json) VALUES (?, ?, ?, ?, ?, ?)", Self.binds(key) + [.blob(json)])
            }
        }
    }

    /// Drops every key `reason` names, in one statement under the lock (`WorkCacheDrop.drops` is its rule). One the
    /// file refuses is kept (`purges`) and runs again before the next write or purge, and at the next open; false
    /// then.
    @discardableResult
    public func drop(_ reason: WorkCacheDrop) -> Bool {
        let done: Bool
        switch reason {
        case .lifeosSignedOut(let host):
            done = dropLifeos(suppliedBy: host)
        case .keyReplaced(let host, let generation):
            done = run("DELETE FROM kept WHERE host = ? AND generation != ?", [.text(host), .int(generation)])
        case .capabilityLost(let host), .workOff(let host), .hostRemoved(let host):
            done = run("DELETE FROM kept WHERE host = ?", [.text(host)])
        case .signedOut(let account):
            done = run("DELETE FROM kept WHERE account = ?", [.text(account)])
        }
        if !done {
            purges.add(reason)
            retry.store(true, ordering: .relaxed)
        }
        return done
    }

    private func run(_ sql: String, _ binds: [Database.Value]) -> Bool {
        db.withLock { db in
            do { try db.run(sql, binds) } catch { return false }
            return true
        }
    }

    /// A host's LifeOS signed out: the rows its session read go out of every host's Today rows (a row is kept under
    /// the host its press opens on, which need not be the reader), and LifeOS rows with no known supplier with them.
    /// Today's own fence moves first, under the same lock, so every Today write queued before this is refused,
    /// whichever host's key it names and whether or not that key holds any of the rows yet; each host rewritten has
    /// its fence moved too.
    private func dropLifeos(suppliedBy host: String) -> Bool {
        db.withLock { db -> Bool in
            todayEpoch.add(1, ordering: .sequentiallyConsistent)
            var rewrites: [(binds: [Database.Value], json: Data, host: String)] = []
            do {
                try db.query("SELECT host, account, generation, workspace, scope, json FROM kept WHERE scope = ?", [.text(WorkCache.Scope.today.text)]) { row in
                    guard let value = try? JSONDecoder().decode(WorkCacheValue.self, from: row.blob(5)) else { return }
                    let next: WorkCacheValue
                    switch value {
                    case .todayOn(let day, let rows):
                        let left = WorkCache.withoutLifeos(rows, suppliedBy: host)
                        guard left.count != rows.count else { return }
                        next = .todayOn(day: day, rows: left)
                    case .today(let rows):
                        let left = WorkCache.withoutLifeos(rows, suppliedBy: host)
                        guard left.count != rows.count else { return }
                        next = .today(left)
                    default:
                        return
                }
                guard let json = try? JSONEncoder().encode(next) else { return }
                let binds: [Database.Value] = [.text(row.text(0)), .text(row.text(1)), .int(row.int(2)), .text(row.text(3)), .text(row.text(4))]
                rewrites.append((binds, json, row.text(0)))
                }
                try db.transaction { () throws(CacheError) in
                    for one in rewrites {
                        WorkCacheFence.purge(one.host)
                        try db.run("UPDATE kept SET json = ? WHERE host = ? AND account = ? AND generation = ? AND workspace = ? AND scope = ?", [.blob(one.json)] + one.binds)
                    }
                }
            } catch {
                return false
            }
            return true
        }
    }
}

/// Today's rows through the SQLite store: read at once, written in order off the main actor.
@MainActor
public final class TodayDiskCache: TodayRowsCache {
    private let store: WorkCacheStore
    private let writer: OrderedWriter<WorkCacheStore>

    public init(store: WorkCacheStore) {
        self.store = store
        writer = OrderedWriter(cache: store)
    }

    /// The phone's own file, on the one shared connection (`WorkCacheStore.shared`); a store that cannot open, or whose
    /// protection or backup exclusion was refused, is a cache in memory (nothing kept across launches).
    public static func opened() -> TodayRowsCache {
        WorkCacheStore.shared.map { TodayDiskCache(store: $0) as TodayRowsCache } ?? TodayBookCache()
    }

    /// A file of its own (tests).
    public static func opened(path: URL, protect: (URL) throws -> Void) -> TodayRowsCache {
        guard let store = try? WorkCacheStore(path: path, protect: protect) else { return TodayBookCache() }
        return TodayDiskCache(store: store)
    }

    public func todayRows(_ keys: [WorkCache.Key], day: String) -> [TodayRow] {
        keys.flatMap { store.get($0)?.todayShown(on: day) ?? [] }
    }

    public func keepToday(_ rows: [WorkCache.Key: [TodayRow]], day: String) {
        let stamps = Dictionary(rows.keys.map { ($0.host, WorkCacheFence.stamp($0.host)) }, uniquingKeysWith: { a, _ in a })
        let today = store.todayStamp()
        writer.write { store in
            for (key, list) in rows { try? store.put(.todayRows(list, day: day), at: key, stamp: stamps[key.host], todayStamp: today) }
        }
    }

    public func drop(_ reason: WorkCacheDrop) {
        writer.write { store in store.drop(reason) }
    }

    /// Returns once every write queued before it is on disk.
    public func drained() async { await writer.drained() }
}
#endif
