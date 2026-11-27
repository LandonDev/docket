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
        #expect(client.computersFailure == "The computer service did not answer")
        let host = ComputersState.Host(name: "box", linked: true, read: client.computersRead, failure: client.computersFailure)
        #expect(ComputersState.of([host]) == .failed)

        // Try Again: the answer clears the failure, and an empty answer is idle.
        try await read(client, fake, count: 2) { $0.answer(id: $1, result: Self.none) }
        #expect(client.computersFailure == nil)
        #expect(ComputersState.of([.init(name: "box", linked: true, read: client.computersRead, failure: client.computersFailure)]) == .idle(away: []))
    }

    @Test func `a failure is kept in Work's words, never the host's raw text`() async throws {
        let (client, fake) = try await open()
        try await read(client, fake) { $0.refuse(id: $1, error: "no answer in 30s") }
        #expect(client.computersFailure == "Box did not answer. Try again once it is connected.")
        #expect(ComputersState.failedLine("box", failure: client.computersFailure!) == "Computers did not load. Box did not answer. Try again once it is connected.")
        // A raw line with nothing of Work's says the host could not read it.
        try await read(client, fake, count: 2) { $0.refuse(id: $1, error: "bad thing at work.computer.read") }
        #expect(client.computersFailure == "Box could not read this.")
    }

    @Test func `a host without the call has none in use, not a failure`() async throws {
        let (client, fake) = try await open()
        try await read(client, fake) { $0.refuse(id: $1, error: "unknown method computer.sessions") }
        #expect(client.computersRead)
        #expect(client.computersFailure == nil)
    }

    @Test func `a cancelled call is no answer: neither read nor failed`() async throws {
        let (client, fake) = try await open()
        let run = Task { await client.readComputers() }
        _ = try #require(await request(fake, count: 1))
        run.cancel()
        await run.value
        #expect(!client.computersRead)
        #expect(client.computersFailure == nil)
    }

    @Test func `the failed line names the host once`() {
        #expect(ComputersState.failedLine("Mac", failure: "The computer service did not answer") == "Computers on Mac did not load. The computer service did not answer")
        #expect(ComputersState.failedLine("the box", failure: "The box could not read this.") == "Computers did not load. The box could not read this.")
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
