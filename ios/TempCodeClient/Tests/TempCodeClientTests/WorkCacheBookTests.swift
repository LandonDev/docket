import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The kept rows' rules with no disk (`WorkCacheBook`): what a write replaces and drops, what a read answers, and
/// what each drop takes. `WorkCacheStoreTests` holds the SQLite store to the same rules on the Mac.
struct WorkCacheBookTests {
    static func key(_ host: String = "box", account: String = "k1", generation: Int = 1, workspace: String? = nil, scope: WorkCache.Scope = .today) -> WorkCache.Key {
        WorkCache.Key(host: host, account: account, keyGeneration: generation, workspaceId: workspace, scope: scope)
    }

    static func row(_ key: String) -> TodayRow {
        var row = TodayRow(key: key, section: "due", sector: "purdue", title: "Confirm bus")
        row.acts = [TodayAct("Tomorrow", .tomorrow(sector: "purdue", taskId: "t1"))]
        return row
    }

    @Test func `Today's rows are kept with no verbs`() {
        var book = WorkCacheBook()
        book.put(.todayRows([Self.row("task:t1")], day: "2026-11-24"), at: Self.key())
        #expect(book.today([Self.key()], day: "2026-11-24").map(\.key) == ["task:t1"])
        #expect(book.today([Self.key()], day: "2026-11-24").allSatisfy { $0.acts.isEmpty })
    }

    @Test func `a write replaces its key and drops the host's other key generations`() {
        var book = WorkCacheBook()
        book.put(.todayRows([Self.row("task:a")], day: "2026-11-24"), at: Self.key())
        book.put(.digest([]), at: Self.key(scope: .digest))
        book.put(.todayRows([Self.row("task:z")], day: "2026-11-24"), at: Self.key("mac"))
        let dropped = book.put(.todayRows([Self.row("task:b")], day: "2026-11-24"), at: Self.key(generation: 2))
        #expect(dropped == [Self.key(), Self.key(scope: .digest)])
        #expect(book.today([Self.key(generation: 2)], day: "2026-11-24").map(\.key) == ["task:b"])
        #expect(book.today([Self.key("mac")], day: "2026-11-24").map(\.key) == ["task:z"])
    }

    @Test func `a read answers its own key alone, never another account's or generation's`() {
        var book = WorkCacheBook()
        book.put(.todayRows([Self.row("task:a")], day: "2026-11-24"), at: Self.key())
        #expect(book.today([Self.key(account: "k2")], day: "2026-11-24").isEmpty)
        #expect(book.today([Self.key(generation: 9)], day: "2026-11-24").isEmpty)
        #expect(book.get(Self.key(scope: .outbox)) == nil)
    }

    @Test func `each drop takes what it names`() {
        func filled() -> WorkCacheBook {
            var book = WorkCacheBook()
            book.put(.todayRows([], day: "2026-11-24"), at: Self.key())
            book.put(.outbox([]), at: Self.key(scope: .outbox))
            book.put(.todayRows([], day: "2026-11-24"), at: Self.key("mac", account: "k9"))
            book.put(.folder(.init(folder: "f1", names: ["a.pdf"])), at: Self.key("mac", account: "k9", workspace: "w", scope: .folder("f1")))
            return book
        }
        for reason in [WorkCacheDrop.workOff(host: "box"), .hostRemoved(host: "box"), .capabilityLost(host: "box")] {
            var book = filled()
            #expect(book.drop(reason) == [Self.key(), Self.key(scope: .outbox)])
            #expect(book.keys(host: "mac").count == 2)
        }
        var book = filled()
        #expect(book.drop(.signedOut(account: "k9")).count == 2)
        #expect(book.keys(host: "box").count == 2)
    }

    @Test func `a scope reads back from its stored words`() {
        for scope in [WorkCache.Scope.today, .outbox, .digest, .folder("a:b")] {
            #expect(WorkCache.Scope(text: scope.text) == scope)
        }
        #expect(WorkCache.Scope(text: "other") == nil)
    }

    @Test func `a value keeps its kind through its JSON`() throws {
        let value = WorkCacheValue.todayRows([Self.row("task:t1")], day: "2026-11-24")
        let back = try JSONDecoder().decode(WorkCacheValue.self, from: JSONEncoder().encode(value))
        #expect(back == value)
        #expect(back.scope == .today)
    }
}
