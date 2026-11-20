import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Reads the test answers by hand, in any order.
@MainActor
private final class Gate {
    private var waiting: [CheckedContinuation<BrowserState, any Error>] = []
    var asked: Int { waiting.count + answered }
    private var answered = 0

    func read() async throws -> BrowserState {
        try await withCheckedThrowingContinuation { waiting.append($0) }
    }

    /// Answers the read asked `index`-th (0 first) with this driver.
    func answer(_ index: Int, _ driver: BrowserState.Driver) {
        waiting.remove(at: index).resume(returning: state(driver))
        answered += 1
    }

    var pending: Int { waiting.count }
}

/// A switch the read closure (an escaping closure) checks.
private final class Held<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

private func state(_ driver: BrowserState.Driver) -> BrowserState {
    BrowserState(sessionId: "s", driver: driver, needs: nil, site: nil, sources: [], since: 1)
}

@MainActor
@Suite struct BrowserStateModelTests {
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    @Test func `a read asked before Take Over answered never brings back the agent`() async throws {
        let gate = Gate()
        let model = BrowserStateModel(read: { try await gate.read() }, drive: { owner in state(owner ? .owner : .agent) }, describe: { "\($0)" })
        let early = Task { await model.read() }
        await settle()
        #expect(gate.pending == 1)
        try await model.drive(owner: true)
        #expect(model.state?.driver == .owner)
        // the old read lands now, saying what was true before he took over
        gate.answer(0, .agent)
        await early.value
        #expect(model.state?.driver == .owner)
    }

    @Test func `a read asked after Take Over answered is applied`() async throws {
        let gate = Gate()
        let model = BrowserStateModel(read: { try await gate.read() }, drive: { _ in state(.owner) }, describe: { "\($0)" })
        try await model.drive(owner: true)
        let later = Task { await model.read() }
        await settle()
        gate.answer(0, .agent)
        await later.value
        #expect(model.state?.driver == .agent)
    }

    @Test func `of two reads, the newer one asked wins whichever lands last`() async {
        let gate = Gate()
        let model = BrowserStateModel(read: { try await gate.read() }, drive: { _ in state(.owner) }, describe: { "\($0)" })
        let first = Task { await model.read() }
        await settle()
        let second = Task { await model.read() }
        await settle()
        #expect(model.reading == 2)
        gate.answer(1, .owner) // the second asked lands first
        await second.value
        gate.answer(0, .agent) // the first lands after it: dropped
        await first.value
        #expect(model.state?.driver == .owner)
        #expect(model.reading == 0)
    }

    @Test func `a re-read that fails keeps the state with a line, and the next reply clears it`() async throws {
        let gate = Gate()
        let failing = Held(false)
        let model = BrowserStateModel(
            read: {
                if failing.value { throw URLError(.notConnectedToInternet) }
                return try await gate.read()
            },
            drive: { _ in state(.owner) },
            describe: { _ in "offline" }
        )
        // the first read fails with nothing shown: the whole-view error, no line
        failing.value = true
        await model.read()
        #expect(model.error == "offline" && model.refreshError == nil && model.state == nil)
        failing.value = false
        let first = Task { await model.read() }
        await settle()
        gate.answer(0, .agent)
        await first.value
        #expect(model.state?.driver == .agent && model.error == nil)
        // a re-read fails: the state stays, with the line
        failing.value = true
        await model.read()
        #expect(model.state?.driver == .agent && model.refreshError == "offline")
        // the next applied reply clears it, a drive answer as well as a read
        try await model.drive(owner: true)
        #expect(model.state?.driver == .owner && model.refreshError == nil)
    }

    @Test func `the numbers rise and only a newer one applies`() {
        var replies = NewestReply()
        let a = replies.ask(), b = replies.ask()
        let newer = replies.apply(b), older = replies.apply(a)
        let c = replies.ask()
        let next = replies.apply(c)
        #expect(newer && !older && next)
    }
}
