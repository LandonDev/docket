import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The open's `computer.sessions` read (`EnvironmentClient.readComputers`): a read that fails is kept as the host's
/// failure, never the empty answer Computers would call "No Computer in Use"; a key that may not read them has none.
@MainActor
@Suite struct ComputersReadTests {
    private static let none = #"{"service":{"state":"off","reason":null,"pid":null,"epoch":null,"until":null,"restarts":0,"permissions":null},"sessions":[]}"#

    /// A client on a fake socket, opened with a hello. The open's own read waits behind the shell's lists, which the
    /// fake never answers, so each test asks `readComputers` itself.
    private func open() async throws -> (EnvironmentClient, FakeWebSocket) {
        let clock = ManualClock(now: 1_000_000, random: [0])
        let sockets = FakeSocketFactory()
        let keys = InMemoryKeyStore()
        try keys.set("tc_K1.secret", for: "env_test")
        let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: ["read"])
        #expect(await waitAsync { await client.socket.isOpen })
        return (client, fake)
    }

    /// Reads the computers once, its `computer.sessions` answered by `reply`.
    private func read(_ client: EnvironmentClient, _ fake: FakeWebSocket, count: Int = 1, _ reply: (FakeWebSocket, String) -> Void) async throws {
        let run = Task { await client.readComputers() }
        let id = try #require(await request(fake, count: count))
        reply(fake, id)
        await run.value
    }

    private func request(_ fake: FakeWebSocket, count: Int) async -> String? {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            let sent = fake.sentRequests.filter { $0.method == "computer.sessions" }
            if sent.count >= count { return sent[count - 1].id }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }

    private func waitAsync(_ predicate: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    @Test func `a failed read is kept as the host's failure until a read lands`() async throws {
        let (client, fake) = try await open()
        try await read(client, fake) { $0.refuse(id: $1, error: "the computer service did not answer") }
        #expect(client.computersRead)
        #expect(client.computersFailure == "the computer service did not answer")
        let host = ComputersState.Host(name: "box", linked: true, read: client.computersRead, failure: client.computersFailure)
        #expect(ComputersState.of([host]) == .failed)

        // Try Again: the answer clears the failure, and an empty answer is idle.
        try await read(client, fake, count: 2) { $0.answer(id: $1, result: Self.none) }
        #expect(client.computersFailure == nil)
        #expect(ComputersState.of([.init(name: "box", linked: true, read: client.computersRead, failure: client.computersFailure)]) == .idle(away: []))
    }

    @Test func `a key that may not read them has none in use, not a failure`() async throws {
        let (client, fake) = try await open()
        try await read(client, fake) { $0.refuse(id: $1, error: "forbidden: computer.sessions needs computer") }
        #expect(client.computersRead)
        #expect(client.computersFailure == nil)
        #expect(client.computerRows.isEmpty)
    }

    @Test func `a push of the rows clears a failed read`() async throws {
        let (client, fake) = try await open()
        try await read(client, fake) { $0.refuse(id: $1, error: "the computer service did not answer") }
        #expect(client.computersFailure != nil)
        fake.deliver(#"{"push":"computer",\#(Self.none.dropFirst())"#)
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while client.computersFailure != nil, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(1)) }
        #expect(client.computersFailure == nil)
    }
}
