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

    /// `knownOn`: the switch an earlier launch read on this host.
    init(knownOn: Bool? = nil) throws {
        try keys.set("tc_K1.secret", for: "env_test")
        UserDefaults.standard.removeObject(forKey: "work.away.reviewed.env_test")
        UserDefaults.standard.set(knownOn, forKey: "work.on.env_test")
        let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .approve], keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    func open() async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: ["read", "approve"])
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
        fake.deliver(#"{"push":"work","settings":{"enabled":false}}"#)
        #expect(await rig.until { !rig.work.isOn })
        #expect(rig.work.items.isEmpty)
        #expect(rig.work.waiting == 0)
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
}
