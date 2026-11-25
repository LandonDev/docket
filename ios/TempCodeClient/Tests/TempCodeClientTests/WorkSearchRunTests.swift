import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The Work scope's runner (Work/Search/WorkSearchRun.swift): the two speeds, a new key cancelling what is out,
/// a host that never answers; who is asked; and where each kind of hit opens.
@MainActor @Suite struct WorkSearchRunTests {
    private static func hit(_ kind: String, _ key: String, workspaceId: String? = "w1", open: String) throws -> WorkSearchHit {
        let json = #"{"key":"\#(key)","kind":"\#(kind)","title":"Budget","workspaceId":\#(workspaceId.map { "\"\($0)\"" } ?? "null"),"open":\#(open)}"#
        return try JSONDecoder().decode(WorkSearchHit.self, from: Data(json.utf8))
    }

    private static func answer(_ kind: String, _ keys: [String], pending: [String] = []) throws -> WorkSearchAnswer {
        let hits = try keys.map { try hit(kind, $0, open: #"{"to":"view","view":"tasks"}"#) }
        return WorkSearchAnswer(groups: [.init(source: "s.\(kind)", kind: kind, label: kind, hits: hits, more: false)], pending: pending.map { .init(source: $0, kind: "mail") }, quiet: [], searched: 1)
    }

    /// An ask that waits for the test to answer it.
    @MainActor private final class Asks {
        var calls: [(host: String, params: Methods.WorkSearchQuery.Params, answer: CheckedContinuation<WorkSearchAnswer, any Error>)] = []

        func ask(_ host: String, _ params: Methods.WorkSearchQuery.Params) async throws -> WorkSearchAnswer {
            try await withCheckedThrowingContinuation { calls.append((host, params, $0)) }
        }

        func settle() async {
            for _ in 0..<20 { await Task.yield() }
        }
    }

    /// The network wait passes at once; a host's own wait for an ask lasts `askWait`.
    private static func sleeps(askWait: Duration = .seconds(3600)) -> @Sendable (Duration) async throws -> Void {
        { duration in if duration == WorkSearch.askWait { try await Task.sleep(for: askWait) } }
    }

    private static let box = WorkSearchModel.Host(id: "box", name: "The box", home: true)
    private static let mac = WorkSearchModel.Host(id: "mac", name: "MacBook", home: false)

    @Test func `the fast answer first, then each source the host named`() async throws {
        let asks = Asks()
        let run = WorkSearchRun(sleep: Self.sleeps())
        run.search("budget", hosts: [Self.box, Self.mac], ask: asks.ask)
        await asks.settle()
        #expect(asks.calls.map(\.host) == ["box", "mac"])
        #expect(asks.calls[0].params.tier == "instant")
        #expect(asks.calls[0].params.own == nil)
        #expect(asks.calls[1].params.own == true)
        asks.calls[0].answer.resume(returning: try Self.answer("person", ["p1"], pending: ["lifeos.mail"]))
        await asks.settle()
        #expect(run.rows.contains { $0.id == "hit:p1" })
        #expect(run.model.busy)
        // the pending source, asked on its own
        #expect(asks.calls.count == 3)
        #expect(asks.calls[2].params.sources == ["lifeos.mail"])
        #expect(asks.calls[2].params.tier == nil)
        asks.calls[2].answer.resume(returning: try Self.answer("mail", ["m1"]))
        asks.calls[1].answer.resume(returning: try Self.answer("person", ["p1", "p2"]))
        await asks.settle()
        #expect(run.rows.compactMap { if case .hit(let id, _, _) = $0 { id } else { nil } } == ["hit:p1", "hit:p2", "hit:m1"])
        #expect(!run.model.busy)
    }

    @Test func `a new key cancels what is out, and its answers are dropped`() async throws {
        let asks = Asks()
        let run = WorkSearchRun(sleep: Self.sleeps())
        run.search("bud", hosts: [Self.box], ask: asks.ask)
        await asks.settle()
        run.search("budget", hosts: [Self.box], ask: asks.ask)
        await asks.settle()
        #expect(asks.calls.count == 2)
        #expect(asks.calls[1].params.text == "budget")
        asks.calls[0].answer.resume(returning: try Self.answer("person", ["stale"]))
        asks.calls[1].answer.resume(returning: try Self.answer("person", ["fresh"]))
        await asks.settle()
        #expect(run.rows.contains { $0.id == "hit:fresh" })
        #expect(!run.rows.contains { $0.id == "hit:stale" })
    }

    @Test func `a host that never answers is its quiet line`() async throws {
        // The Mac's ask never answers; its wait runs out after 200 ms.
        let run = WorkSearchRun(sleep: Self.sleeps(askWait: .milliseconds(200)))
        run.search("budget", hosts: [Self.box, Self.mac], ask: { host, _ in
            if host == "mac" { try await Task.sleep(for: .seconds(3600)) }
            return try Self.answer("person", ["p1"])
        })
        for _ in 0..<100 where run.model.busy { try await Task.sleep(for: .milliseconds(20)) }
        #expect(run.rows.contains { $0.id == "quiet:host:mac" })
        #expect(run.rows.contains { $0.id == "hit:p1" })
    }

    @Test func `one letter asks no source`() async throws {
        let asks = Asks()
        let run = WorkSearchRun(sleep: Self.sleeps())
        run.search("b", hosts: [Self.box], ask: asks.ask)
        await asks.settle()
        asks.calls[0].answer.resume(returning: try Self.answer("person", ["p1"], pending: ["lifeos.mail"]))
        await asks.settle()
        #expect(asks.calls.count == 1)
        #expect(!run.model.busy)
    }

    @Test func `who is asked`() {
        let inputs: [WorkSearchHosts.Input] = [
            .init(id: "mac", name: "MacBook", platform: "darwin", workOn: true, open: true, may: true),
            .init(id: "box", name: "The box", platform: "linux", workOn: true, open: true, may: true),
            .init(id: "pc", name: "Purdue laptop", platform: "win32", workOn: true, open: false, may: true),
            .init(id: "old", name: "Old Mac", platform: "darwin", workOn: false, open: true, may: true),
            .init(id: "read", name: "Read only", platform: "darwin", workOn: true, open: true, may: false),
        ]
        let (hosts, offline) = WorkSearchHosts.hosts(inputs)
        #expect(hosts.map(\.id) == ["box", "mac"])
        #expect(hosts.map(\.home) == [true, false])
        #expect(offline == ["Purdue laptop"])
        // The box offline: the first connected host asks LifeOS.
        let without = WorkSearchHosts.hosts(inputs.map { var i = $0; if i.id == "box" { i.open = false }; return i })
        #expect(without.hosts.map(\.id) == ["mac"])
        #expect(without.hosts.first?.home == true)
        #expect(WorkSearchHosts.offered(inputs))
        #expect(!WorkSearchHosts.offered([inputs[3], inputs[4]]))
    }

    @Test func `where each kind opens`() throws {
        func target(_ kind: String, _ open: String, workspaceId: String? = "w1", key: String = "k") throws -> WorkSearchTarget? {
            WorkSearchTarget.of(try Self.hit(kind, key, workspaceId: workspaceId, open: open), environmentId: "box")
        }
        #expect(try target("person", #"{"to":"view","view":"people","with":{"person":"p9"}}"#) == .route(.person(environmentId: "box", workspaceId: "w1", personId: "p9")))
        #expect(try target("message", #"{"to":"view","view":"messages","with":{"chat":"c1","message":"m1"}}"#) == .route(.chat(environmentId: "box", workspaceId: "w1", chatId: "c1")))
        #expect(try target("event", #"{"to":"view","view":"agenda","with":{"event":"e1"}}"#) == .route(.prep(environmentId: "box", workspaceId: "w1", eventId: "e1")))
        #expect(try target("task", #"{"to":"view","view":"tasks","with":{"task":"t1"}}"#) == .route(.workView(environmentId: "box", workspaceId: "w1", view: "tasks")))
        #expect(try target("mail", #"{"to":"view","view":"mail","with":{"mail":"x"}}"#) == .route(.workView(environmentId: "box", workspaceId: "w1", view: "mail")))
        #expect(try target("thread", #"{"to":"thread","sessionId":"s1","seq":4}"#, workspaceId: nil) == .route(.thread(environmentId: "box", sessionId: "s1", seq: 4)))
        #expect(try target("held", #"{"to":"chip","chip":{"kind":"held","label":"Send","ref":{"at":"work","pillar":"outbox","id":"h1"}}}"#) == .route(.outboxItem(environmentId: "box", ref: "host:h1")))
        #expect(try target("card", #"{"to":"chip","chip":{"kind":"card","label":"PUR-1","ref":{"at":"lifeos","table":"tasks","id":"t2"}}}"#) == .route(.workView(environmentId: "box", workspaceId: "w1", view: "tasks")))
        let file = try target("file", #"{"to":"file","ref":{"at":"file","host":"box","path":"/w/Budget.xlsx"},"name":"Budget.xlsx"}"#, key: "file:abc")
        #expect(file == .file(environmentId: "box", workspaceId: "w1", ref: .object(["at": .string("file"), "host": .string("box"), "path": .string("/w/Budget.xlsx")]), name: "Budget.xlsx", key: "abc"))
        // A job's Money opens its page; no phone place: shown, not a button.
        #expect(try target("money", #"{"to":"view","view":"money","with":{"row":"r1"}}"#) == .route(.workView(environmentId: "box", workspaceId: "w1", view: "money")))
        #expect(try target("routine", #"{"to":"chip","chip":{"kind":"routine","label":"Daily","ref":{"at":"work","pillar":"routines","id":"r1"}}}"#) == nil)
        // A view of no job opens the place of every job, where the phone has one.
        #expect(try target("person", #"{"to":"view","view":"people","with":{"person":"p9"}}"#, workspaceId: nil) == .route(.place(.people)))
        #expect(try target("money", #"{"to":"view","view":"money"}"#, workspaceId: nil) == nil)
        #expect(try target("odd", #"{"to":"later","x":1}"#) == nil)
    }
}
