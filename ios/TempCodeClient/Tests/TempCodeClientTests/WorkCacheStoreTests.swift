#if canImport(SQLite3)
import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// `WorkCacheStore` on disk (runs on the Mac: SQLite): a write read back after the file is opened again, the
/// generation drop in the same write, each drop, and Today's rows through the ordered writer.
struct WorkCacheStoreTests {
    static func path() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "work-cache-\(UUID().uuidString)").appending(path: "work-cache.sqlite")
    }

    @Test func `a write is read back after the file opens again`() throws {
        let path = Self.path()
        defer { try? FileManager.default.removeItem(at: path.deletingLastPathComponent()) }
        let key = WorkCacheBookTests.key()
        do {
            let store = try WorkCacheStore(path: path)
            try store.put(.todayRows([WorkCacheBookTests.row("task:t1")], day: "2026-11-24"), at: key)
        }
        let reopened = try WorkCacheStore(path: path)
        guard case .todayOn(_, let rows)? = reopened.get(key) else { Issue.record("nothing read"); return }
        #expect(rows.map(\.key) == ["task:t1"])
        #expect(rows.allSatisfy { $0.acts.isEmpty })
        #expect(reopened.keys() == [key])
        // Out of backups.
        let values = try path.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func `a write drops the host's other generations, and a drop takes what it names`() throws {
        let store = try WorkCacheStore.inMemory()
        try store.put(.todayRows([], day: "2026-11-24"), at: WorkCacheBookTests.key())
        try store.put(.todayRows([], day: "2026-11-24"), at: WorkCacheBookTests.key("mac"))
        try store.put(.todayRows([], day: "2026-11-24"), at: WorkCacheBookTests.key(generation: 2))
        #expect(Set(store.keys()) == [WorkCacheBookTests.key("mac"), WorkCacheBookTests.key(generation: 2)])
        store.drop(.hostRemoved(host: "mac"))
        #expect(store.keys() == [WorkCacheBookTests.key(generation: 2)])
        store.drop(.signedOut(account: "k1"))
        #expect(store.keys().isEmpty)
    }

    @Test func `a value under another scope is refused`() throws {
        let store = try WorkCacheStore.inMemory()
        #expect(throws: CacheError.self) { try store.put(.digest([]), at: WorkCacheBookTests.key()) }
    }

    @MainActor @Test func `Today's rows go through the ordered writer and are read at once`() async throws {
        let cache = TodayDiskCache(store: try WorkCacheStore.inMemory())
        let key = WorkCacheBookTests.key()
        cache.keepToday([key: [WorkCacheBookTests.row("task:t1")]], day: "2026-11-24")
        await cache.drained()
        #expect(cache.todayRows([key], day: "2026-11-24").map(\.key) == ["task:t1"])
        cache.drop(.workOff(host: "box"))
        await cache.drained()
        #expect(cache.todayRows([key], day: "2026-11-24").isEmpty)
    }

    @MainActor @Test func `a store whose protection or backup exclusion is refused is a cache in memory`() throws {
        struct Refused: Error {}
        let path = FileManager.default.temporaryDirectory.appending(path: "work-cache-\(UUID().uuidString)", directoryHint: .isDirectory).appending(path: "work-cache.sqlite")
        #expect(throws: CacheError.self) { try WorkCacheStore(path: path, protect: { _ in throw Refused() }) }
        #expect(TodayDiskCache.opened(path: path, protect: { _ in throw Refused() }) is TodayBookCache)
        #expect(OutboxDiskCache.opened(path: path, protect: { _ in throw Refused() }) is OutboxBookCache)
        // Refused for the database file alone, after the folder passed: still no disk.
        #expect(TodayDiskCache.opened(path: path, protect: { if $0.pathExtension == "sqlite" { throw Refused() } }) is TodayBookCache)
        #expect(TodayDiskCache.opened(path: path, protect: { _ in }) is TodayDiskCache)
    }

    @Test func `a write the fence refuses reaches no disk`() throws {
        let store = try WorkCacheStore.inMemory()
        let key = WorkCacheBookTests.key("fenced-\(UUID().uuidString)")
        let stamp = WorkCacheFence.stamp(key.host)
        WorkCacheFence.close(key.host)
        WorkCacheFence.open(key.host)
        try store.put(.todayRows([WorkCacheBookTests.row("task:t1")], day: "2026-11-24"), at: key, stamp: stamp)
        #expect(store.get(key) == nil)
        try store.put(.todayRows([WorkCacheBookTests.row("task:t1")], day: "2026-11-24"), at: key, stamp: WorkCacheFence.stamp(key.host))
        #expect(store.get(key) != nil)
    }

    @MainActor @Test func `a write queued in one cache before a purge in another reaches no disk`() async throws {
        let store = try WorkCacheStore.inMemory()
        let today = TodayDiskCache(store: store)
        let outbox = OutboxDiskCache(store: store)
        let host = "race-\(UUID().uuidString)"
        let key = WorkCache.Key(host: host, account: "k1", keyGeneration: 1, scope: .outbox)
        // Queued, then the host is refused before the writer runs it.
        outbox.keepWaiting([], at: key)
        WorkCacheFence.close(host)
        store.drop(.capabilityLost(host: host))
        await outbox.drained()
        await today.drained()
        #expect(store.keys().filter { $0.host == host }.isEmpty)
        // A drop takes what its reason names in one statement.
        WorkCacheFence.open(host)
        try store.put(.outbox([]), at: key, stamp: WorkCacheFence.stamp(host))
        try store.put(.outbox([]), at: WorkCache.Key(host: host, account: "k1", keyGeneration: 2, scope: .outbox), stamp: WorkCacheFence.stamp(host))
        store.drop(.keyReplaced(host: host, generation: 2))
        #expect(store.keys().filter { $0.host == host }.map(\.keyGeneration) == [2])
    }

    // MARK: - a LifeOS sign-out on disk (council 8: Opus 4.2, Sol 3)

    private static func row(_ key: String, _ section: String, by: String?) -> TodayRow {
        var r = TodayRow(key: key, section: section, sector: "purdue", title: key)
        r.suppliedBy = by
        return r
    }

    @Test func `a LifeOS sign-out rewrites every host's Today rows on disk without that session's, and moves each rewritten host's fence`() throws {
        let store = try WorkCacheStore.inMemory()
        let mac = "mac-\(UUID().uuidString)", box = "box-\(UUID().uuidString)", pc = "pc-\(UUID().uuidString)"
        let macKey = WorkCache.Key(host: mac, account: "k", keyGeneration: 1, scope: .today)
        let boxKey = WorkCache.Key(host: box, account: "k", keyGeneration: 1, scope: .today)
        let pcKey = WorkCache.Key(host: pc, account: "k", keyGeneration: 1, scope: .today)
        let outbox = WorkCache.Key(host: mac, account: "k", keyGeneration: 1, scope: .outbox)
        try store.put(.todayRows([Self.row("mail:1", "waiting", by: box), Self.row("mail:2", "waiting", by: mac), Self.row("held:mac:1", "held", by: nil)], day: "d"), at: macKey)
        try store.put(.todayRows([Self.row("event:1", "meetings", by: nil), Self.row("held:box:1", "held", by: nil)], day: "d"), at: boxKey)
        try store.put(.todayRows([Self.row("task:9", "due", by: pc)], day: "d"), at: pcKey)
        try store.put(.outbox([]), at: outbox)
        let macStamp = WorkCacheFence.stamp(mac), pcStamp = WorkCacheFence.stamp(pc)
        #expect(store.drop(.lifeosSignedOut(host: box)))
        // Box's session's rows go wherever they were kept, and rows of no known supplier; the rest stays, keys and all.
        #expect(store.get(macKey)?.todayShown(on: "d").map(\.key) == ["mail:2", "held:mac:1"])
        #expect(store.get(boxKey)?.todayShown(on: "d").map(\.key) == ["held:box:1"])
        #expect(store.get(pcKey)?.todayShown(on: "d").map(\.key) == ["task:9"])
        #expect(store.get(outbox) != nil)
        // The Mac's key was rewritten: a write stamped before refuses; the PC's was not, so its fence stands.
        #expect(!WorkCacheFence.admits(mac, stamp: macStamp))
        #expect(WorkCacheFence.admits(pc, stamp: pcStamp))
    }

    @Test func `a Today write queued before a sign-out reaches no disk, even for a key that held none of the rows yet`() throws {
        let store = try WorkCacheStore.inMemory()
        let box = "box-\(UUID().uuidString)", mac = "mac-\(UUID().uuidString)"
        let macKey = WorkCache.Key(host: mac, account: "k", keyGeneration: 1, scope: .today)
        // Today queued box's wait for the Mac's key (empty on disk), and the writer is parked.
        let hostStamp = WorkCacheFence.stamp(mac), today = store.todayStamp()
        #expect(store.drop(.lifeosSignedOut(host: box)))
        // The writer runs after the sign-out: refused, though no row under the Mac's key moved its host's fence.
        try store.put(.todayRows([Self.row("mail:1", "waiting", by: box)], day: "d"), at: macKey, stamp: hostStamp, todayStamp: today)
        #expect(store.get(macKey) == nil)
        // A write made after it lands.
        try store.put(.todayRows([Self.row("held:mac:1", "held", by: nil)], day: "d"), at: macKey, stamp: WorkCacheFence.stamp(mac), todayStamp: store.todayStamp())
        #expect(store.get(macKey)?.todayShown(on: "d").map(\.key) == ["held:mac:1"])
    }

    @Test func `a purge the file refuses is kept, and runs again before the next write`() throws {
        let suite = "work-cache-store-purges-\(UUID().uuidString)"
        let purges = WorkCachePurges(defaults: { UserDefaults(suiteName: suite)! })
        let store = try WorkCacheStore.inMemory(purges: purges)
        let box = "box-\(UUID().uuidString)"
        let boxKey = WorkCache.Key(host: box, account: "k", keyGeneration: 1, scope: .today)
        try store.put(.todayRows([Self.row("event:1", "meetings", by: box)], day: "d"), at: boxKey)
        // SQLite refuses the read and the write (as a file under complete protection does while the phone is locked).
        try store.execForTests("ALTER TABLE kept RENAME TO away")
        #expect(!store.drop(.lifeosSignedOut(host: box)))
        #expect(purges.list() == [.lifeosSignedOut(host: box)])
        try store.execForTests("ALTER TABLE away RENAME TO kept")
        // Today's next write, stamped after the sign-out, runs it first and still lands: the retry does not move the
        // Today epoch a second time. Nothing stays kept.
        let mac = WorkCache.Key(host: "mac-\(UUID().uuidString)", account: "k", keyGeneration: 1, scope: .today)
        try store.put(.todayRows([Self.row("held:mac:1", "held", by: nil)], day: "d"), at: mac, stamp: WorkCacheFence.stamp(mac.host), todayStamp: store.todayStamp())
        #expect(store.get(boxKey)?.todayShown(on: "d").isEmpty == true)
        #expect(store.get(mac)?.todayShown(on: "d").map(\.key) == ["held:mac:1"])
        #expect(purges.list().isEmpty)
    }
}
#endif
