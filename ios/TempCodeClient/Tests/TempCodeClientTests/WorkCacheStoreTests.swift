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
}
#endif
