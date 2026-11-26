import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A connection that keeps each ask until the test answers it, in the order
/// the asks left (an unsubscribe is answered at once): the tests count asks
/// and never time them.
private actor HeldWire: SubscriptionWire {
    private(set) var methods: [String] = []
    private var params: [Data] = []
    private var waiting: [Int: CheckedContinuation<Data, any Error>] = [:]
    var isOpen: Bool { true }

    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        let index = methods.count
        methods.append(M.name)
        self.params.append(try JSONEncoder().encode(params))
        // A let-go is sent and forgotten: answered at once.
        if M.name == Methods.SessionUnsubscribe.name { return try JSONDecoder().decode(M.Output.self, from: Data("null".utf8)) }
        let data = try await withCheckedThrowingContinuation { waiting[index] = $0 }
        return try JSONDecoder().decode(M.Output.self, from: data)
    }

    func count(_ method: String) -> Int { methods.filter { $0 == method }.count }

    /// The ask at `index`, as the host reads it.
    func ask(_ index: Int) -> JSONValue? {
        guard index < params.count else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: params[index])
    }

    func answer(_ index: Int, _ page: EventsPage) { waiting.removeValue(forKey: index)?.resume(returning: try! JSONEncoder().encode(page)) }
    func answerNull(_ index: Int) { waiting.removeValue(forKey: index)?.resume(returning: Data("null".utf8)) }
    func fail(_ index: Int, _ error: any Error) { waiting.removeValue(forKey: index)?.resume(throwing: error) }
}

/// One transcript's owner: what it was handed, in order.
@MainActor
private final class Owner {
    var rows: [EventRow]
    /// Every persisted seq handed over since the last reset, in the order it came.
    var handed: [Int] = []
    var resets = 0
    var gone: String?
    var shown = false

    init(rows: [EventRow] = []) { self.rows = rows }

    var handlers: SubscriptionHandlers {
        SubscriptionHandlers(
            cursor: { [unowned self] in self.rows.last?.seq ?? 0 },
            cursorTs: { [unowned self] in self.rows.last?.ts },
            shown: { [unowned self] in self.shown },
            page: { [unowned self] page, _ in
                if page.reset {
                    self.rows = []
                    self.handed = []
                    self.resets += 1
                }
                for row in page.rows where row.ephemeral != true {
                    self.handed.append(row.seq)
                    self.rows.removeAll { $0.seq == row.seq }
                    self.rows.append(row)
                }
                self.rows.sort { $0.seq < $1.seq }
            },
            gone: { [unowned self] reason in self.gone = reason }
        )
    }
}

private func row(_ seq: Int) -> EventRow {
    EventRow(sessionId: "s1", seq: seq, ts: 1_700_000_000_000 + seq, event: .assistantText(AssistantTextEvent(text: "row \(seq)", delta: false, msgId: "m\(seq)", blockIndex: 0)))
}

private func page(_ seqs: some Sequence<Int>, reset: Bool = false, subscribed: Bool? = true) -> EventsPage {
    EventsPage(rows: seqs.map(row), moreBefore: false, moreAfter: false, reset: reset, subscribed: subscribed)
}

@MainActor
@Suite struct SubscriptionsTests {
    @Test func `an open is one ask that subscribes in the same request`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner()
        subs.add("s1", owner.handlers)
        let open = subs.resume("s1", tail: 300)
        #expect(await eventually { await wire.count("session.events") == 1 })
        #expect(await wire.ask(0) == .object(["sessionId": .string("s1"), "tail": .number(300), "subscribe": .bool(true)]))
        await wire.answer(0, page(1...3))
        _ = try await open.value
        #expect(owner.handed == [1, 2, 3])
        #expect(subs.isLive("s1"))
        #expect(await wire.methods == ["session.events"])
        // Live on this socket: the next resume reads and does not subscribe again.
        let next = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 2 })
        #expect(await wire.ask(1) == .object(["sessionId": .string("s1"), "afterSeq": .number(3), "afterTs": .number(1_700_000_000_003)]))
        await wire.answer(1, page(4...4, subscribed: nil))
        _ = try await next.value
        #expect(owner.handed == [1, 2, 3, 4])
        #expect(await wire.count("session.subscribe") == 0)
    }

    @Test func `a resume names the time of its cursor row and the thread on screen`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner(rows: (1...50).map(row))
        owner.shown = true
        subs.add("s1", owner.handlers)
        let resume = subs.resume("s1", tail: 300)
        #expect(await eventually { await wire.count("session.events") == 1 })
        #expect(await wire.ask(0) == .object(["sessionId": .string("s1"), "afterSeq": .number(50), "afterTs": .number(1_700_000_000_050), "subscribe": .bool(true), "shown": .bool(true)]))
        await wire.answer(0, page(51...52))
        _ = try await resume.value
        #expect(owner.handed == [51, 52])
    }

    @Test func `a host that does not say subscribed is subscribed after the page and the gap folds once`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner(rows: (1...5).map(row))
        subs.add("s1", owner.handlers)
        let resume = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 1 })
        await wire.answer(0, page(6...7, subscribed: nil))
        #expect(await eventually { await wire.count("session.subscribe") == 1 })
        #expect(!subs.isLive("s1"))
        // A row the host pushed once subscribed, which the gap page holds too.
        #expect(subs.hold("s1", rows: [row(8)]))
        await wire.answerNull(1)
        #expect(await eventually { await wire.count("session.events") == 2 })
        #expect(await wire.ask(2) == .object(["sessionId": .string("s1"), "afterSeq": .number(7), "afterTs": .number(1_700_000_000_007)]))
        await wire.answer(2, page(8...9, subscribed: nil))
        _ = try await resume.value
        #expect(owner.handed == [6, 7, 8, 9])
        #expect(subs.isLive("s1"))
        #expect(await wire.methods == ["session.events", "session.subscribe", "session.events"])
    }

    @Test func `a reset, a duplicate push and the rows after it fold once and in order`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner(rows: (1...20).map(row))
        subs.add("s1", owner.handlers)
        let resume = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 1 })
        // Pushed while the page is out: 905 is in the page as well, 906 is not, and 906 comes twice.
        #expect(subs.hold("s1", rows: [row(906), row(905), row(906)]))
        await wire.answer(0, page(900...905, reset: true))
        _ = try await resume.value
        #expect(owner.resets == 1)
        #expect(owner.handed == Array(900...906))
        #expect(owner.rows.map(\.seq) == Array(900...906))
        #expect(await wire.methods == ["session.events"])
    }

    @Test func `a lane that drops mid-ask folds nothing of the old socket, and the next socket's one ask folds once`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner(rows: (1...5).map(row))
        subs.add("s1", owner.handlers)
        let lost = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 1 })
        #expect(subs.hold("s1", rows: [row(6)]))
        subs.sessionChanged()
        // The old socket's answer lands after the drop: nobody folds it.
        await wire.answer(0, page(6...7))
        await #expect(throws: (any Error).self) { try await lost.value }
        #expect(owner.handed.isEmpty)
        #expect(!subs.isLive("s1"))
        let again = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 2 })
        #expect(await wire.ask(1) == .object(["sessionId": .string("s1"), "afterSeq": .number(5), "afterTs": .number(1_700_000_000_005), "subscribe": .bool(true)]))
        #expect(subs.hold("s1", rows: [row(7), row(8)]))
        await wire.answer(1, page(6...7))
        _ = try await again.value
        #expect(owner.handed == [6, 7, 8])
        // The old socket's subscription went with it: nothing to let go.
        #expect(await wire.count("session.unsubscribe") == 0)
    }

    @Test func `a lost answer lets the host's subscription go, and only an unknown id says the thread is gone`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner(rows: (1...5).map(row))
        subs.add("s1", owner.handlers)
        let lost = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 1 })
        await wire.fail(0, TransportError.notConnected)
        await #expect(throws: (any Error).self) { try await lost.value }
        #expect(await eventually { await wire.count("session.unsubscribe") == 1 })
        // A read the host could not make is not a thread gone.
        let failed = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 2 })
        await wire.fail(2, TransportError.server(method: "session.events", message: "replay failed"))
        await #expect(throws: (any Error).self) { try await failed.value }
        #expect(await eventually { await wire.count("session.unsubscribe") == 2 })
        #expect(owner.gone == nil)
        let refused = subs.resume("s1")
        #expect(await eventually { await wire.count("session.events") == 3 })
        await wire.fail(4, TransportError.server(method: "session.events", message: "unknown session: s1"))
        await #expect(throws: (any Error).self) { try await refused.value }
        #expect(owner.gone == "unknown session: s1")
        #expect(await eventually { await wire.count("session.unsubscribe") == 3 })
        // Each retry was the owner's: nothing was asked again on its own.
        #expect(await wire.count("session.events") == 3)
        #expect(owner.handed.isEmpty)
    }

    @Test func `an owner that leaves while its open is out lets the subscription go once`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owner = Owner()
        subs.add("s1", owner.handlers)
        let open = subs.resume("s1", tail: 300)
        #expect(await eventually { await wire.count("session.events") == 1 })
        subs.remove("s1")
        await wire.answer(0, page(1...3))
        await #expect(throws: (any Error).self) { try await open.value }
        #expect(await eventually { await wire.count("session.unsubscribe") == 1 })
        #expect(owner.handed.isEmpty)
        #expect(!subs.isLive("s1"))
    }

    @Test func `after a new session the thread on screen asks first`() async throws {
        let wire = HeldWire()
        let subs = Subscriptions(wire: wire)
        let owners = ["s1", "s2", "s3"].map { _ in Owner() }
        for (id, owner) in zip(["s1", "s2", "s3"], owners) { subs.add(id, owner.handlers) }
        let all = Task { await subs.resumeAll(tail: 300, first: "s3") }
        #expect(await eventually { await wire.count("session.events") == 3 })
        #expect(await wire.ask(0)?.objectValue?["sessionId"] == .string("s3"))
        for index in 0..<3 { await wire.answer(index, page(1...1)) }
        await all.value
        #expect(await wire.methods == ["session.events", "session.events", "session.events"])
        #expect(["s1", "s2", "s3"].allSatisfy(subs.isLive))
    }
}
