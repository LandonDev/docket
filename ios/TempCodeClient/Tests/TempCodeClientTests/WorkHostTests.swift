import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A client on fake sockets, its socket opened with a hello, for `client.work`
/// (Work/Shell/WorkHost.swift, milestone 46).
@MainActor
private final class WorkRig {
    let clock = ManualClock(now: 1_000_000, random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let client: EnvironmentClient
    var work: WorkHost { client.work }

    /// `knownOn`: the switch an earlier launch read on this host. `id`: the host's id, its own for a test that counts what
    /// a static hook heard of it.
    init(knownOn: Bool? = nil, id: String = "env_test") throws {
        try keys.set("tc_K1.secret", for: id)
        UserDefaults.standard.removeObject(forKey: "work.away.reviewed.\(id)")
        UserDefaults.standard.set(knownOn, forKey: "work.on.\(id)")
        let environment = PairedEnvironment(id: id, name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .approve], keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    func open() async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(environmentId: client.environment.id, caps: ["read", "approve"])
        _ = await until { await self.client.socket.isOpen }
        await answerShell(fake)
        return fake
    }

    /// The open handler lists the shell before Work asks anything (EnvironmentClient's `.opened`).
    private func answerShell(_ fake: FakeWebSocket) async {
        var answered: Set<String> = []
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline, answered.count < 4 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list", "project.list": fake.answer(id: sent.id, result: "[]")
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g0")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [], cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func until(_ predicate: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    func request(_ fake: FakeWebSocket, _ method: String) async -> String? {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            if let found = fake.sentRequests.first(where: { $0.method == method }) { return found.id }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }
}

private func item(_ id: String, state: String = "held", at: Int = 10) -> String {
    #"{"ref":{"at":"host","id":"\#(id)"},"kind":"addon.call","workspaceId":"w1","sessionId":"s1","sector":"purdue","summary":"Send to events booking","verb":"Send","account":null,"state":"\#(state)","payload":{"arguments":{"to":"events@purdue.edu"}},"createdAt":\#(at),"decidedBy":null,"decidedAt":null,"n":1,"why":"rule","grantId":null,"error":null,"result":null,"routineRunId":null,"updatedAt":\#(at)}"#
}

private func away(_ enabled: Bool, at: Int, since: Int, decided: Int = 0) -> String {
    let threads = decided > 0 ? #"[{"sessionId":"s1","count":\#(decided)}]"# : "[]"
    return #"{"state":{"enabled":\#(enabled),"at":\#(at),"by":"phone"},"decided":{"since":\#(since),"threads":\#(threads)}}"#
}

@Suite(.serialized) @MainActor struct WorkHostTests {
    @Test func `the switch, the waiting list and a push that decides an item`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let work = try #require(await rig.request(fake, "work.get"))
        fake.answer(id: work, result: #"{"enabled":true}"#)
        // The open reads the switch and Away before the Outbox.
        fake.answer(id: try #require(await rig.request(fake, "away.get")), result: away(false, at: 1_000, since: 0))
        let list = try #require(await rig.request(fake, "work.outbox.list"))
        fake.answer(id: list, result: #"{"items":[\#(item("a", at: 10)),\#(item("b", at: 20)),\#(item("c", state: "sent"))],"waiting":2}"#)
        #expect(await rig.until { rig.work.listed })
        #expect(rig.work.isOn)
        #expect(rig.work.items.map { OutboxModel.key($0.ref) } == ["host:b", "host:a"])
        #expect(rig.work.waiting == 2)
        fake.deliver(#"{"push":"work.outbox","waiting":1,"unreviewed":0,"item":\#(item("b", state: "sent", at: 20))}"#)
        #expect(await rig.until { rig.work.items.count == 1 })
        #expect(rig.work.waiting == 1)
        // The decided item leaves Waiting but stays heard, for a detail open on it (what LifeOS says of a sent mail).
        #expect(rig.work.heard["host:b"]?.state == .sent)
        fake.deliver(#"{"push":"work","settings":{"enabled":false}}"#)
        #expect(await rig.until { !rig.work.isOn })
        #expect(rig.work.items.isEmpty)
        #expect(rig.work.heard.isEmpty)
        #expect(rig.work.waiting == 0)
    }

    @Test func `Work going off and the key refused each end the host's access once`() async throws {
        AccessLostLog.install()
        let host = "env_access_\(UUID().uuidString.prefix(8))"
        let rig = try WorkRig(id: host)
        let fake = await rig.open()
        fake.answer(id: try #require(await rig.request(fake, "work.get")), result: #"{"enabled":true}"#)
        fake.answer(id: try #require(await rig.request(fake, "away.get")), result: away(false, at: 1_000, since: 0))
        fake.answer(id: try #require(await rig.request(fake, "work.outbox.list")), result: #"{"items":[],"waiting":0}"#)
        #expect(await rig.until { rig.work.listed })
        #expect(AccessLostLog.count(host) == 0)
        // Work goes off on the host: its LifeOS sessions end.
        fake.deliver(#"{"push":"work","settings":{"enabled":false}}"#)
        #expect(await rig.until { !rig.work.isOn })
        #expect(AccessLostLog.count(host) == 1)
        // The host refuses the key: once, however often it is heard.
        rig.work.refused()
        rig.work.refused()
        #expect(AccessLostLog.count(host) == 2)
    }

    @Test func `a day seen that its host did not take is said again when Work comes back on`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        fake.answer(id: try #require(await rig.request(fake, "work.get")), result: #"{"enabled":true}"#)
        fake.answer(id: try #require(await rig.request(fake, "away.get")), result: away(false, at: 1_000, since: 0))
        fake.answer(id: try #require(await rig.request(fake, "work.outbox.list")), result: #"{"items":[],"waiting":0}"#)
        #expect(await rig.until { rig.work.listed })
        // He opens the day; the host does not take the mark.
        let seen = Task { await rig.work.digest.seen("2026-11-24") }
        fake.refuse(id: try #require(await rig.request(fake, "work.digest.seen")), error: "the link dropped")
        await seen.value
        // Work goes off on a desktop, then on again: the mark is said again.
        fake.deliver(#"{"push":"work","settings":{"enabled":false}}"#)
        #expect(await rig.until { !rig.work.isOn })
        fake.deliver(#"{"push":"work","settings":{"enabled":true}}"#)
        #expect(await rig.until { fake.sentRequests.filter { $0.method == "work.digest.seen" }.count == 2 })
    }

    @Test func `a thread has open items while its canvas lists one, read without observing`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        #expect(!rig.work.canvas.hasOpenItems("s1"))
        fake.deliver(#"{"push":"work.canvas","sessionId":"s1","items":[{"id":"i1","sessionId":"s1","workspaceId":"w1","kind":"pdf","title":"Floor plan","source":{"at":"file","host":"env_box","path":"/w/plan.pdf"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}]}"#)
        #expect(await rig.until { rig.work.canvas.hasOpenItems("s1") })
        #expect(!rig.work.canvas.hasOpenItems("s2"))
        // The last item closed: the thread has none again.
        fake.deliver(#"{"push":"work.canvas","sessionId":"s1","items":[]}"#)
        #expect(await rig.until { !rig.work.canvas.hasOpenItems("s1") })
    }

    @Test func `M1 pushes move the counters of their own host and workspace`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        fake.deliver(#"{"push":"work.messages","workspaceId":"w1","unread":2}"#)
        fake.deliver(#"{"push":"work.messages","workspaceId":"w2","unread":4,"drafts":1}"#)
        fake.deliver(#"{"push":"work.messages","workspaceId":"w1","unread":0}"#)
        fake.deliver(#"{"push":"work.money","workspaceId":"w2","toConfirm":1}"#)
        fake.deliver(#"{"push":"work.prep","workspaceId":"w1","eventId":"e1","rev":4}"#)
        fake.deliver(#"{"push":"work.clashes"}"#)
        fake.deliver(#"{"push":"work.review","from":1000,"madeAt":2000,"seen":true}"#)
        fake.deliver(#"{"push":"work.msforms","workspaceId":"w2","formId":"f1","view":null}"#)
        fake.deliver(#"{"push":"work.outbox.request","request":{"id":"r1","n":1,"sessionId":"s1","workspaceId":"w1","sector":"purdue","quote":"send the draft","head":"Send 1 item","state":"open","createdAt":1000,"expiresAt":2000,"answeredBy":null,"answeredAt":null,"rows":[]}}"#)
        #expect(await rig.until { rig.work.outboxRequestsRev == 1 })
        #expect(rig.work.messagesRev == ["w1": 2, "w2": 1])
        #expect(rig.work.moneyRev == ["w2": 1])
        #expect(rig.work.prepRev == ["w1": 1])
        #expect(rig.work.clashesRev == 1)
        #expect(rig.work.reviewRev == 1)
        #expect(rig.work.msformsRev == ["w2": 1])
    }

    @Test func `task Done and mail Nudge use the host verbs for the named workspace`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let done = Task { try await rig.work.completeTask("task1", workspaceId: "w1") }
        let doneId = try #require(await rig.request(fake, "work.tasks.done"))
        #expect(fake.sentRequests.first { $0.id == doneId }?.params == .object(["workspaceId": .string("w1"), "taskId": .string("task1")]))
        fake.answer(id: doneId, result: #"{"threadId":null,"nextId":"task2"}"#)
        #expect(try await done.value.nextId == "task2")
        let nudge = Task { try await rig.work.nudge("mail1", workspaceId: "w1") }
        let nudgeId = try #require(await rig.request(fake, "work.mail.nudge"))
        #expect(fake.sentRequests.first { $0.id == nudgeId }?.params == .object(["workspaceId": .string("w1"), "threadId": .string("mail1")]))
        fake.answer(id: nudgeId, result: #"{"sessionId":"s1"}"#)
        #expect(try await nudge.value == "s1")
    }

    @Test func `a host that does not answer keeps the switch it had, from the last launch`() async throws {
        let rig = try WorkRig(knownOn: true)
        #expect(rig.work.isOn)
        let fake = await rig.open()
        let work = try #require(await rig.request(fake, "work.get"))
        fake.refuse(id: work, error: "unavailable: the Mac is asleep")
        let away = try #require(await rig.request(fake, "away.get"))
        fake.refuse(id: away, error: "unavailable: the Mac is asleep")
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.work.isOn)
        UserDefaults.standard.removeObject(forKey: "work.on.env_test")
    }

    @Test func `Away going off is an end to review, and the open's older answer never hides it`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let work = try #require(await rig.request(fake, "work.get"))
        let stale = try #require(await rig.request(fake, "away.get"))
        fake.answer(id: work, result: #"{"enabled":false}"#)
        // The flip arrives before the open's own answer.
        fake.deliver(#"{"push":"away",\#(away(true, at: 2_000, since: 2_000).dropFirst())"#)
        fake.deliver(#"{"push":"away",\#(away(false, at: 3_000, since: 2_000, decided: 4).dropFirst())"#)
        #expect(await rig.until { rig.work.awayEnd != nil })
        fake.answer(id: stale, result: away(false, at: 1_000, since: 500))
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.work.away?.state.at == 3_000)
        let end = try #require(rig.work.awayEnd)
        #expect(end.since == 2_000)
        #expect(end.until == 3_000)
        #expect(end.decided.threads.first?.count == 4)
        rig.work.reviewedAway()
        #expect(rig.work.awayEnd == nil)
        #expect(UserDefaults.standard.object(forKey: "work.away.reviewed.env_test") as? Int == 3_000)
    }

    @Test func `an end the phone pressed is kept when its answer lands before the stretch's tally`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let work = try #require(await rig.request(fake, "work.get"))
        fake.answer(id: work, result: #"{"enabled":false}"#)
        let first = try #require(await rig.request(fake, "away.get"))
        // A host never away: its tally starts at 0.
        fake.answer(id: first, result: away(false, at: 0, since: 0))
        #expect(await rig.until { rig.work.away != nil })
        // On, then off, the answers landing before any push.
        fake.deliver(#"{"push":"away",\#(away(true, at: 2_000, since: 0).dropFirst())"#)
        fake.deliver(#"{"push":"away",\#(away(false, at: 3_000, since: 0).dropFirst())"#)
        #expect(await rig.until { rig.work.awayEnd != nil })
        #expect(rig.work.awayEnd?.since == 2_000)
        // The host's push then brings the stretch's tally for the same end.
        fake.deliver(#"{"push":"away",\#(away(false, at: 3_000, since: 2_000, decided: 2).dropFirst())"#)
        #expect(await rig.until { rig.work.awayEnd?.decided.threads.first?.count == 2 })
        #expect(rig.work.awayEnd?.until == 3_000)
    }

    @Test func `every phone press on one item binds the revision its screen read`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let shown = try JSONDecoder().decode(OutboxItem.self, from: Data(item("a", at: 42).utf8))
        let discarded = Task { try await rig.work.discard(shown, reason: "  Wrong date  ") }
        let discard = try #require(await rig.request(fake, "work.outbox.discard"))
        let params = try #require(fake.sentRequests.first { $0.id == discard }?.params)
        #expect(params == .object(["ref": .object(["at": .string("host"), "id": .string("a")]), "reason": .string("Wrong date"), "via": .string("phone"), "rev": .number(42)]))
        fake.answer(id: discard, result: item("a", state: "discarded", at: 43))
        #expect(try await discarded.value.state == .discarded)
        for (method, press) in [("work.outbox.send", { try await rig.work.send(shown, again: false) }), ("work.outbox.cancelSend", { try await rig.work.cancelSend(shown) }), ("work.outbox.sendNow", { try await rig.work.sendNow(shown) })] as [(String, () async throws -> OutboxItem)] {
            let pressed = Task { try await press() }
            let id = try #require(await rig.request(fake, method))
            guard case .object(let sent)? = fake.sentRequests.first(where: { $0.id == id })?.params else { Issue.record("\(method) sent no params"); continue }
            #expect(sent["rev"] == .number(42), "\(method)")
            fake.answer(id: id, result: item("a", at: 44))
            _ = try await pressed.value
        }
    }

    @Test func `a held item's Send is recorded until the host answers, and carries again only when the press says so`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        #expect(await rig.until { rig.work.linked })
        let json = item("m1b-u", state: "failed", at: 30).replacingOccurrences(of: #""updatedAt":30"#, with: #""updatedAt":30,"outcomeUnknown":true"#)
        let unknown = try JSONDecoder().decode(OutboxItem.self, from: Data(json.utf8))
        func again(_ id: String) -> JSONValue? {
            guard case .object(let params)? = fake.sentRequests.first(where: { $0.id == id })?.params else { return nil }
            return params["again"]
        }
        // The phone never decides `again` itself, even for an item the host says may have gone.
        let plain = Task { try await rig.work.send(unknown, again: false) }
        let first = try #require(await rig.request(fake, "work.outbox.send"))
        #expect(again(first) == nil || again(first) == .null)
        #expect(rig.work.presses.busy(host: "env_test", ref: "host:m1b-u"))
        fake.refuse(id: first, error: "it may have gone: check first")
        await #expect(throws: (any Error).self) { try await plain.value }
        #expect(!rig.work.presses.busy(host: "env_test", ref: "host:m1b-u"))
        // His own Send Again.
        let pressed = Task { try await rig.work.send(unknown, again: true) }
        #expect(await rig.until { fake.sentRequests.filter { $0.method == "work.outbox.send" }.count == 2 })
        let second = try #require(fake.sentRequests.last { $0.method == "work.outbox.send" }?.id)
        #expect(again(second) == .bool(true))
        fake.answer(id: second, result: item("m1b-u", state: "sent", at: 31))
        _ = try await pressed.value
        #expect(!rig.work.presses.busy(host: "env_test", ref: "host:m1b-u"))
    }

    @Test func `a voice note reads the capture state, then files with its key and Unsorted as null`() async throws {
        let rig = try WorkRig()
        let fake = await rig.open()
        let state = Task { try await rig.work.captureState() }
        let read = try #require(await rig.request(fake, "work.capture.state"))
        fake.answer(id: read, result: #"{"host":"h1","last":"purdue","homes":["purdue"],"connected":true}"#)
        #expect(try await state.value.last == "purdue")
        let filed = Task { try await rig.work.capture(text: "Call Sam", sector: nil, start: true, key: "k-0001") }
        let file = try #require(await rig.request(fake, "work.capture.file"))
        let params = try #require(fake.sentRequests.first { $0.id == file }?.params)
        #expect(params == .object(["key": .string("k-0001"), "text": .string("Call Sam"), "sector": .null, "start": .bool(true)]))
        fake.answer(id: file, result: #"{"taskId":"t1","kept":[],"threadId":"s1"}"#)
        #expect(try await filed.value.threadId == "s1")
        #expect(rig.work.hostId == "env_test")
    }
}
