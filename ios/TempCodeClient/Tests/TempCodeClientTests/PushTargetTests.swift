import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite("PushTarget")
struct PushTargetTests {
    @Test func readsTheHubPayloadAndTheActivityURL() {
        let payload: [AnyHashable: Any] = ["aps": ["alert": ["title": "t"]], "tc": ["event": "needs_you", "hostId": "box", "environmentId": "env_box", "threadId": "s1", "seq": 42, "ts": 1]]
        #expect(PushTarget(userInfo: payload) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 42))
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1", "seq": "7"]]) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 7))
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1"]])?.seq == nil)
        // A held act's notice opens its item in the Outbox (milestone 46).
        let held: [AnyHashable: Any] = ["tc": ["environmentId": "env_box", "threadId": "s1", "held": ["at": "lifeos", "table": "outbox", "id": "ob_1"]]]
        #expect(PushTarget(userInfo: held)?.held == "lifeos:outbox:ob_1")
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1", "held": ["at": "host", "id": "h2"]]])?.held == "host:h2")
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "threadId": "s1", "held": ["at": "mars", "id": "x"]]])?.held == nil)
        // A host-down notice names no thread: nothing to open.
        #expect(PushTarget(userInfo: ["tc": ["event": "host_down", "hostId": "box", "environmentId": "env_box"]]) == nil)
        #expect(PushTarget(userInfo: [:]) == nil)
        #expect(PushTarget(url: URL(string: "tempcode://thread/env_box/s1?seq=12")!) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 12))
        #expect(PushTarget(url: URL(string: "tempcode://thread/env_box/s1")!) == PushTarget(environmentId: "env_box", sessionId: "s1", seq: nil))
        #expect(PushTarget(url: URL(string: "tempcode://settings")!) == nil)
        #expect(PushTarget(url: URL(string: "https://box.example/thread/env/s1")!) == nil)
    }

    // MARK: - a notice of Work's (`tc.work`, docs/agents/work-digest.md "The phone")

    /// The box's own APNs payload for a notice of Work's: no thread, `tc.work`, the host it came from.
    private func work(_ work: [String: Any], environmentId: String? = "env_box", event: String = "needs_you") -> [AnyHashable: Any] {
        var tc: [String: Any] = ["event": event, "hostId": "box", "seq": 0, "kind": event == "needs_you" ? "waiting" : "finished", "work": work, "ts": 2_000]
        if let environmentId { tc["environmentId"] = environmentId }
        return ["aps": ["alert": ["title": "Purdue", "body": "Budget review starts at 2:00 PM"], "thread-id": "tc.work"], "tc": tc]
    }

    @Test func `the day's digest opens the Digest`() throws {
        let target = try #require(PushTarget(userInfo: work(["key": "digest:2026-11-24", "digest": "2026-11-24"], event: "finished")))
        #expect(target.work)
        #expect(target.sessionId.isEmpty)
        #expect(target.route == .digest)
        // A notice of Work's that names no host still opens the Digest.
        #expect(PushTarget(userInfo: work(["key": "digest:2026-11-24", "digest": "2026-11-24"], environmentId: nil))?.route == .digest)
    }

    @Test func `a tell that opens a thread opens it on the notice's host`() throws {
        let target = try #require(PushTarget(userInfo: work(["key": "now", "tell": "routines.failed:s9", "open": ["thread": "s9"]])))
        #expect(target.route == .thread(environmentId: "env_box", sessionId: "s9", seq: nil))
        #expect(target.work)
    }

    @Test func `a tell that opens a held item opens it over the Outbox, even when it names the thread that made it`() throws {
        let lifeos = try #require(PushTarget(userInfo: work(["key": "now", "tell": "held:ob_1", "by": 9_000, "open": ["held": ["at": "lifeos", "table": "outbox", "id": "ob_1"]]])))
        #expect(lifeos.route == .outboxItem(environmentId: "env_box", ref: "lifeos:outbox:ob_1"))
        let made = try #require(PushTarget(userInfo: work(["key": "now", "tell": "held:h2", "open": ["held": ["at": "host", "id": "h2"], "thread": "s1"]])))
        #expect(made.route == .outboxItem(environmentId: "env_box", ref: "host:h2"))
        // A held ref this build does not know is not a thread to open: the Digest.
        #expect(PushTarget(userInfo: work(["key": "now", "tell": "held:x", "open": ["held": ["at": "mars", "id": "x"], "thread": "s1"]])).map(\.route) == .digest)
    }

    @Test(arguments: ["mail", "tasks", "agenda", "projects", "routines"])
    func `a tell that opens a view the phone draws opens that view`(view: String) throws {
        let target = try #require(PushTarget(userInfo: work(["key": "now", "tell": "t1", "open": ["view": view, "workspaceId": "w1", "at": "ev1"]])))
        #expect(target.route == .workView(environmentId: "env_box", workspaceId: "w1", view: view))
    }

    @Test func `a tell the phone has no route for opens the Digest`() {
        let opens: [[String: Any]] = [
            ["view": "clashes", "workspaceId": "w1"],
            ["place": "review"],
            ["settings": "connections"],
            ["view": "mail"]
        ]
        for open in opens {
            #expect(PushTarget(userInfo: work(["key": "now", "tell": "t1", "open": open]))?.route == .digest)
        }
        // No `open` at all, and a host that is not named: the Digest.
        #expect(PushTarget(userInfo: work(["key": "now", "tell": "t1"]))?.route == .digest)
        #expect(PushTarget(userInfo: work(["key": "now", "tell": "t1", "open": ["thread": "s9"]], environmentId: nil))?.route == .digest)
    }

    @Test func `a thread's notice with no tc.work is as it was`() {
        let thread: [AnyHashable: Any] = ["tc": ["event": "needs_you", "environmentId": "env_box", "threadId": "s1", "seq": 3]]
        let target = PushTarget(userInfo: thread)
        #expect(target == PushTarget(environmentId: "env_box", sessionId: "s1", seq: 3))
        #expect(target?.work == false)
        #expect(target?.route == .thread(environmentId: "env_box", sessionId: "s1", seq: 3))
        let held: [AnyHashable: Any] = ["tc": ["environmentId": "env_box", "threadId": "s1", "held": ["at": "host", "id": "h2"]]]
        #expect(PushTarget(userInfo: held)?.route == .outboxItem(environmentId: "env_box", ref: "host:h2"))
    }
}
