import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's record of outward presses (Work/Outbox/PressLedger.swift) and the Send that carries a grant
/// (Work/Outbox/HeldPress.swift): plan "Never twice, never silently" and "The hold on the phone".
@Suite @MainActor struct PressLedgerTests {
    /// What a hook was asked, kept by reference.
    final class Box: @unchecked Sendable { var keys: [String?] = [] }

    /// A clock the test moves.
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Double
        init(_ value: Double) { self.value = value }
        var now: Double { lock.withLock { value } }
        func set(_ next: Double) { lock.withLock { value = next } }
    }

    private static func item(_ id: String, state: String = "held", at: Int = 10, outcomeUnknown: Bool? = nil) -> OutboxItem {
        let unknown = outcomeUnknown.map { #","outcomeUnknown":\#($0)"# } ?? ""
        let json = #"{"ref":{"at":"host","id":"\#(id)"},"kind":"addon.call","workspaceId":"w1","sessionId":"s1","sector":"purdue","summary":"Send to events booking","verb":"Send","account":null,"state":"\#(state)","payload":{"arguments":{"to":"events@purdue.edu"}},"createdAt":\#(at),"decidedBy":null,"decidedAt":null,"n":1,"why":"rule","grantId":null,"error":null,"result":null,"routineRunId":null,"updatedAt":\#(at)\#(unknown)}"#
        return try! JSONDecoder().decode(OutboxItem.self, from: Data(json.utf8))
    }

    private static func folder() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("press-ledger-\(UUID().uuidString)")
        return url.appendingPathComponent(PressLedger.fileName)
    }

    /// A ledger whose fifteen seconds never end unless the test ends them.
    private static func ledger(_ file: URL?, clock: Clock, unknown: AsyncStream<Void>? = nil) -> PressLedger {
        PressLedger(file: file, now: { clock.now }, wait: { _ in
            if let unknown { for await _ in unknown { return } } else { try? await Task.sleep(for: .seconds(3600)) }
        })
    }

    private static func onDisk(_ file: URL) -> [PendingPress] {
        PendingPresses.load(from: file, now: 0).presses
    }

    /// A send that the socket loses after it left.
    private static let lost = TransportError.cancelled

    private func until(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<2000 {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    @Test func `a press is written down before it leaves, and the host's answer clears it`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        let sent = Self.item("a", state: "sent")
        let out = try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) {
            // The record is on disk while the request is out.
            #expect(Self.onDisk(file).map(\.ref) == ["host:a"])
            #expect(ledger.state(host: "mac", ref: "host:a") == .sending)
            return sent
        }
        #expect(out == sent)
        #expect(ledger.pending.presses.isEmpty)
        #expect(Self.onDisk(file).isEmpty)
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
    }

    @Test func `a refusal in the host's words is an answer: nothing stays pending`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        await #expect(throws: TransportError.server(method: "work.outbox.send", message: "it changed since you saw it")) {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) { () async throws -> OutboxItem in
                throw TransportError.server(method: "work.outbox.send", message: "it changed since you saw it")
            }
        }
        #expect(ledger.pending.presses.isEmpty)
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
    }

    @Test func `with no link a press is refused at once, says so, and writes nothing`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        let asked = Clock(0)
        do {
            _ = try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: false) {
                asked.set(1)
                return Self.item("a")
            }
            Issue.record("a press with no link went")
        } catch {
            #expect(ActionError.wrap(error).message == "Not connected to Mac")
        }
        #expect(asked.now == 0)
        #expect(ledger.pending.presses.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func `a double tap sends once: the second press meets the first still out`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        let (answer, answering) = AsyncStream<OutboxItem>.makeStream()
        let calls = Clock(0)
        let first = Task {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) {
                calls.set(calls.now + 1)
                for await item in answer { return item }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "host:a") == .sending })
        #expect(ledger.busy(host: "mac", ref: "host:a"))
        do {
            _ = try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) {
                calls.set(calls.now + 1)
                return Self.item("a", state: "sent")
            }
            Issue.record("the second tap went")
        } catch {
            #expect(ActionError.wrap(error).message == "Sending…")
        }
        answering.yield(Self.item("a", state: "sent"))
        _ = try await first.value
        #expect(calls.now == 1)
        #expect(!ledger.busy(host: "mac", ref: "host:a"))
    }

    @Test func `a lost answer is Checking, never failed, and the next link reads it back as sent`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "host:a")) {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) { () async throws -> OutboxItem in
                throw Self.lost
            }
        }
        #expect(ledger.state(host: "mac", ref: "host:a") == .checking)
        #expect(ledger.state(host: "mac", ref: "host:a")?.line == "Checking…")
        #expect(Self.onDisk(file).count == 1)
        var read: [String] = []
        await ledger.check(host: "mac") { press in
            read.append(press.ref)
            return Self.item("a", state: "sent")
        }
        #expect(read == ["host:a"])
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
        #expect(ledger.pending.presses.isEmpty)
        #expect(Self.onDisk(file).isEmpty)
    }

    @Test func `fifteen seconds with no answer is Checking, and an answer that comes late clears it`() async throws {
        let (unknown, ending) = AsyncStream<Void>.makeStream()
        let ledger = Self.ledger(Self.folder(), clock: Clock(100), unknown: unknown)
        let (answer, answering) = AsyncStream<OutboxItem>.makeStream()
        let press = Task {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) {
                for await item in answer { return item }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "host:a") == .sending })
        ending.yield()
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "host:a")) { try await press.value }
        #expect(ledger.state(host: "mac", ref: "host:a") == .checking)
        // Still out on its socket: the next link does not read it while the request waits.
        var read = 0
        await ledger.check(host: "mac") { _ in read += 1; return nil }
        #expect(read == 0)
        answering.yield(Self.item("a", state: "sent"))
        #expect(await until { !ledger.busy(host: "mac", ref: "host:a") })
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
    }

    @Test func `a relaunch reads the file back: each press is Checking until its host is read`() async throws {
        let file = Self.folder()
        let clock = Clock(100)
        let before = Self.ledger(file, clock: clock)
        for ref in ["host:a", "host:b"] {
            _ = try? await before.run(.outboxSend, host: "mac", hostName: "Mac", ref: ref, rev: "10", linked: true) { () async throws -> OutboxItem in
                throw Self.lost
            }
        }
        clock.set(200)
        let after = Self.ledger(file, clock: clock)
        #expect(after.pending.presses.count == 2)
        #expect(after.state(host: "mac", ref: "host:a") == .checking)
        await after.check(host: "mac") { press in
            // One never reached the host and waits as he saw it; the other may have gone.
            press.ref == "host:a" ? Self.item("a", at: 10) : Self.item("b", state: "failed", at: 12, outcomeUnknown: true)
        }
        #expect(after.state(host: "mac", ref: "host:a") == nil)
        #expect(after.state(host: "mac", ref: "host:b") == .mayHaveGone)
        #expect(after.state(host: "mac", ref: "host:b")?.line == "May have gone")
        #expect(Self.onDisk(file).isEmpty)
    }

    @Test func `two hosts: the one that answered is settled, the other stays Checking`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        for host in ["mac", "box"] {
            _ = try? await ledger.run(.outboxSend, host: host, hostName: host, ref: "host:a", rev: "10", linked: true) { () async throws -> OutboxItem in
                throw Self.lost
            }
        }
        await ledger.check(host: "mac") { _ in Self.item("a", state: "sent") }
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
        #expect(ledger.state(host: "box", ref: "host:a") == .checking)
        #expect(Self.onDisk(file).map(\.host) == ["box"])
        // A read the box cannot answer yet leaves it as it was.
        await ledger.check(host: "box") { _ in throw Self.lost }
        #expect(ledger.state(host: "box", ref: "host:a") == .checking)
        #expect(Self.onDisk(file).count == 1)
    }

    @Test func `what the read says: changed, no longer waits, a discard done, an edit that moved the item done`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        let presses: [(PendingPress.Kind, String)] = [(.outboxSend, "host:a"), (.outboxSend, "host:b"), (.outboxDiscard, "host:c"), (.outboxEdit, "host:d")]
        for (kind, ref) in presses {
            _ = try? await ledger.run(kind, host: "mac", hostName: "Mac", ref: ref, rev: "10", linked: true) { () async throws -> OutboxItem in
                throw Self.lost
            }
        }
        await ledger.check(host: "mac") { press in
            switch press.ref {
            case "host:a": return Self.item("a", at: 11)
            case "host:d": return Self.item("d", at: 11)
            default: throw TransportError.server(method: "work.outbox.get", message: "no such held item on this host")
            }
        }
        #expect(ledger.state(host: "mac", ref: "host:a")?.line == "Changed")
        #expect(ledger.state(host: "mac", ref: "host:b")?.line == "No longer waits")
        #expect(ledger.state(host: "mac", ref: "host:c") == nil)
        #expect(ledger.state(host: "mac", ref: "host:d") == nil)
        #expect(ledger.pending.presses.isEmpty)
        // His next press clears the old words.
        ledger.clear(host: "mac", ref: "host:a")
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
    }

    // MARK: - fix round 2: answers that are not the host's, late answers, a locked launch

    @Test func `the box's linkDown for a relayed Mac is not the host's answer: Checking, the attempt kept`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "chat:w1:c1")) {
            try await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-a", linked: true) { () async throws -> String in
                throw TransportError.server(method: "work.messages.send", message: "linkDown: the Mac is unreachable since 09:14")
            }
        }
        #expect(ledger.state(host: "mac", ref: "chat:w1:c1") == .checking)
        #expect(Self.onDisk(file).map(\.attempt) == ["phone-a"])
        // A second press meets the first still out: nothing leaves under a new key.
        var sent = 0
        await #expect(throws: ActionError.self) {
            try await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-b", linked: true) { () async throws -> String in
                sent += 1
                return "out-1"
            }
        }
        #expect(sent == 0)
        // The box's "unavailable" never forwarded the press: that is an answer, and nothing stays pending.
        await #expect(throws: TransportError.self) {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:z", rev: "1", linked: true) { () async throws -> OutboxItem in
                throw TransportError.server(method: "work.outbox.send", message: "unavailable: the Mac is asleep")
            }
        }
        #expect(!ledger.busy(host: "mac", ref: "host:z"))
    }

    @Test func `a yes the phone cannot read stays Checking; a request it could not encode never left`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "chat:w1:c1")) {
            try await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-a", linked: true) { () async throws -> String in
                throw TransportError.decoding(method: "work.messages.send", detail: "keyNotFound id")
            }
        }
        #expect(ledger.busy(host: "mac", ref: "chat:w1:c1"))
        await #expect(throws: ActionError.self) {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "1", linked: true) { () async throws -> OutboxItem in
                throw ActionError.refused(message: "work.outbox.send: could not encode the request", forbidden: false)
            }
        }
        #expect(!ledger.busy(host: "mac", ref: "host:a"))
    }

    @Test func `an answer after fifteen seconds reaches the press's hearer by its attempt`() async throws {
        let (unknown, ending) = AsyncStream<Void>.makeStream()
        let ledger = Self.ledger(Self.folder(), clock: Clock(100), unknown: unknown)
        var heard: [(String?, PressState)] = []
        ledger.listen(.chatReply) { press, state in heard.append((press.attempt, state)) }
        let (answer, answering) = AsyncStream<String>.makeStream()
        let press = Task {
            try await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-a", linked: true) {
                for await id in answer { return id }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "chat:w1:c1") == .sending })
        ending.yield()
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "chat:w1:c1")) { try await press.value }
        #expect(heard.isEmpty)
        // Sixteen seconds in, LifeOS took it: the desk hears it by the attempt, and the record goes.
        answering.yield("out-1")
        #expect(await until { !heard.isEmpty })
        #expect(heard.first?.0 == "phone-a")
        #expect(heard.first?.1 == .done)
        #expect(!ledger.busy(host: "mac", ref: "chat:w1:c1"))
    }

    @Test func `a late refusal says the host's words on the item and to its hearer`() async throws {
        let (unknown, ending) = AsyncStream<Void>.makeStream()
        let ledger = Self.ledger(Self.folder(), clock: Clock(100), unknown: unknown)
        var heard: [PressState] = []
        ledger.listen(.guestLink) { _, state in heard.append(state) }
        let (answer, answering) = AsyncStream<Bool>.makeStream()
        let press = Task {
            try await ledger.run(.guestLink, host: "mac", hostName: "Mac", ref: "guest:docs:d1", rev: nil, attempt: "phone-g", linked: true) { () async throws -> String in
                for await _ in answer { throw TransportError.server(method: "work.guests.create", message: "this document is shared too widely") }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "guest:docs:d1") == .sending })
        ending.yield()
        _ = try? await press.value
        answering.yield(true)
        #expect(await until { !heard.isEmpty })
        #expect(heard == [.failed("this document is shared too widely")])
        #expect(ledger.state(host: "mac", ref: "guest:docs:d1")?.line == "Not sent: this document is shared too widely")
    }

    @Test func `a read-back tells the kind's hearer`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        var heard: [PressState] = []
        ledger.listen(.chatReply) { _, state in heard.append(state) }
        _ = try? await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-a", linked: true) { () async throws -> String in
            throw Self.lost
        }
        await ledger.check(host: "mac", where: { $0 == .chatReply }) { _ in .done }
        #expect(heard == [.done])
    }

    @Test func `a pushed item settles a lost press on it now, not at the next link`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        _ = try? await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) { () async throws -> OutboxItem in
            throw Self.lost
        }
        // Still sending on the host: nothing known yet.
        #expect(ledger.heard(host: "mac", item: Self.item("a", state: "sending")) == .checking)
        #expect(ledger.busy(host: "mac", ref: "host:a"))
        // Another host's item of the same ref is not this press's.
        #expect(ledger.heard(host: "box", item: Self.item("a", state: "failed")) == nil)
        #expect(ledger.heard(host: "mac", item: Self.item("a", state: "failed")) == .failed(""))
        #expect(!ledger.busy(host: "mac", ref: "host:a"))
        #expect(ledger.state(host: "mac", ref: "host:a")?.line == "Not sent")
    }

    @Test func `a launch that cannot read the file writes nothing over it and sends nothing until it reads`() async throws {
        let file = Self.folder()
        let clock = Clock(100)
        let before = Self.ledger(file, clock: clock)
        _ = try? await before.run(.chatReply, host: "mac", hostName: "Mac", ref: "chat:w1:c1", rev: nil, attempt: "phone-a", linked: true) { () async throws -> String in
            throw Self.lost
        }
        let kept = try Data(contentsOf: file)
        // The phone is locked at a launch a notice's action made: the file is there and will not read.
        let aside = file.deletingLastPathComponent().appendingPathComponent("aside.json")
        try FileManager.default.moveItem(at: file, to: aside)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let locked = Self.ledger(file, clock: clock)
        #expect(locked.pending.presses.isEmpty)
        var sent = 0
        await #expect(throws: ActionError.refused(message: PressLedger.unreadLine, forbidden: false)) {
            try await locked.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:b", rev: "1", linked: true) { () async throws -> OutboxItem in
                sent += 1
                return Self.item("b", state: "sent")
            }
        }
        #expect(sent == 0)
        #expect(await locked.check(host: "mac", where: { _ in true }) { _ in .done }.isEmpty)
        // Unlocked: the file reads, and the press it holds is Checking again.
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: aside, to: file)
        #expect(locked.readIfUnread())
        #expect(locked.busy(host: "mac", ref: "chat:w1:c1"))
        #expect(locked.state(host: "mac", ref: "chat:w1:c1") == .checking)
        #expect(try Data(contentsOf: file) == kept)
    }

    @Test func `request, Send Later and Send Now read back by their own handles`() {
        let press = PendingPress(host: "mac", kind: .outboxDecide, ref: PendingPress.requestRef("q"), rev: "r-a", at: 1)
        #expect(PendingPress.request(ofRef: press.ref) == "q")
        #expect(!PendingPress.Kind.outboxDecide.readsItem && PendingPress.Kind.outboxDecide.readsBack)
        #expect(PendingPress.Kind.outboxLater.readsItem && PendingPress.Kind.outboxSendNow.readsItem)
        #expect(!PendingPress.Kind.mailSend.readsItem && !PendingPress.Kind.chatRetry.readsItem)
        // A mail's draft is the same thing as the Outbox's item for it: one press at a time on it.
        #expect(OutboxModel.ref(PendingPress.mailRef("d1")).map(OutboxModel.key) == PendingPress.mailRef("d1"))
        let later = PendingPress(host: "mac", kind: .outboxLater, ref: "host:a", rev: "10", at: 1)
        #expect(PressLedger.truth(Self.item("a", state: "scheduled", at: 11), for: later) == .done)
        #expect(PressLedger.truth(Self.item("a", state: "held", at: 10), for: later) == .waiting(rev: "10"))
    }

    @Test func `a lost Retry stays Checking until LifeOS's own row says what became of it`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        let ref = ChatPress.retryRef(workspaceId: "w1", chatId: "c1", outboxId: "o1")
        _ = try? await ledger.run(.chatRetry, host: "mac", hostName: "Mac", ref: ref, rev: nil, linked: true) { () async throws -> Bool in
            throw Self.lost
        }
        #expect(ledger.state(host: "mac", ref: ref) == .checking)
        // A link's read-back of item kinds leaves it alone: it has no item.
        await ledger.check(host: "mac") { _ in nil }
        #expect(ledger.busy(host: "mac", ref: ref))
        // LifeOS's row still failed once the host is back: it never took it, and Retry is his again.
        #expect(ledger.settle(host: "mac", ref: ref, truth: PressTruth.retry(.failed)) == .stillWaiting)
        #expect(!ledger.busy(host: "mac", ref: ref))
        #expect(ledger.settle(host: "mac", ref: ref, truth: .done) == nil)
    }

    @Test func `a lost mail Send is read back by its draft's status`() {
        #expect(PressTruth.mail(status: "draft") == .waiting(rev: nil))
        #expect(PressTruth.mail(status: "queued") == .done)
        #expect(PressTruth.mail(status: "sent") == .done)
        #expect(PressTruth.mail(status: "failed") == .failed(""))
        #expect(PressTruth.mail(status: nil) == .gone)
        #expect(PendingPress.draft(ofRef: PendingPress.mailRef("d1")) == "d1")
        #expect(PendingPress.draft(ofRef: "host:a") == nil)
    }

    @Test func `a lost request is read back by the request: answered is done, open is his to send again`() {
        let request = { (state: String) in
            try! JSONDecoder().decode(OutboxRequest.self, from: Data(#"{"id":"q","n":1,"sessionId":"t1","workspaceId":"w1","sector":"purdue","quote":"send them","head":"Send 2 mails","state":"\#(state)","createdAt":1,"expiresAt":2,"rows":[]}"#.utf8))
        }
        #expect(PressTruth.request(request("answered"), rev: "r") == .done)
        // Claimed with its items still going: nothing known yet, the press stays Checking.
        let running = try! JSONDecoder().decode(OutboxRequest.self, from: Data(#"{"id":"q","n":1,"sessionId":"t1","workspaceId":"w1","sector":"purdue","quote":"send them","head":"Send 2 mails","state":"answered","createdAt":1,"expiresAt":2,"rows":[],"running":true}"#.utf8))
        #expect(PressTruth.request(running, rev: "r") == nil)
        #expect(PressTruth.request(request("open"), rev: "r") == .waiting(rev: "r"))
        #expect(PressTruth.request(request("declined"), rev: "r") == .gone)
        #expect(PressTruth.request(nil, rev: "r") == .gone)
        var presses = PendingPresses()
        _ = presses.leaving(PendingPress(host: "mac", kind: .outboxDecide, ref: PendingPress.requestRef("q"), rev: "r", at: 1), linked: true)
        #expect(presses.resolve("mac|work.outbox.decide|request:q", truth: PressTruth.request(request("open"), rev: "r")) == .stillWaiting)
    }

    @Test func `Send Now on a send the hold timed is read back by its time`() {
        let item = { (state: String, at: Int?) in
            try! JSONDecoder().decode(OutboxItem.self, from: Data(#"{"ref":{"at":"host","id":"a"},"kind":"addon.call","workspaceId":"w1","sessionId":"s1","sector":"purdue","summary":"x","verb":"Send","account":null,"state":"\#(state)","payload":{},"createdAt":1,"decidedBy":null,"decidedAt":null,"n":1,"why":"rule","grantId":null,"error":null,"result":null,"routineRunId":null,"updatedAt":1\#(at.map { ",\"scheduledFor\":\($0)" } ?? "")}"#.utf8))
        }
        let press = PendingPress(host: "mac", kind: .outboxSendNow, ref: "host:a", rev: "500", at: 1)
        #expect(PressLedger.truth(item("scheduled", 500), for: press) == .waiting(rev: "500"))
        #expect(PressLedger.truth(item("scheduled", 600), for: press) == .waiting(rev: "600"))
        #expect(PressLedger.truth(item("sent", 500), for: press) == .done)
        #expect(PressLedger.truth(item("sending", 500), for: press) == nil)
        #expect(PressLedger.truth(item("held", nil), for: press) == .gone)
    }

    // MARK: - fix round 3

    @Test func `a relayed frame the box gave up on, and a mail LifeOS may have taken, stay Checking`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        for (ref, words) in [("chat:w1:c1", "linkDown: the Mac did not answer relay.frame within 30 s"), ("lifeos:outbox:d1", "outcome unknown: LifeOS did not say whether it took this mail (lost). Look in Sent before sending it again.")] {
            await #expect(throws: PressLedger.Unknown(host: "mac", ref: ref)) {
                try await ledger.run(.chatReply, host: "mac", hostName: "Mac", ref: ref, rev: nil, linked: true) { () async throws -> String in
                    throw TransportError.server(method: "x", message: words)
                }
            }
            #expect(ledger.busy(host: "mac", ref: ref))
        }
    }

    @Test func `a group's answer after fifteen seconds tells each item what the host did with it`() async throws {
        let (unknown, ending) = AsyncStream<Void>.makeStream()
        let ledger = Self.ledger(Self.folder(), clock: Clock(100), unknown: unknown)
        var heard: [String: PressState] = [:]
        ledger.listen(.outboxSend) { press, state in heard[press.ref] = state }
        let (answer, answering) = AsyncStream<[String: PressState]>.makeStream()
        let press = Task {
            try await ledger.runMany(.outboxSend, host: "mac", hostName: "Mac", items: [("host:a", "1"), ("host:b", "1")], linked: true, outcome: { $0 }) {
                for await split in answer { return split }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "host:a") == .sending })
        ending.yield()
        _ = try? await press.value
        answering.yield(["host:a": .done, "host:b": .failed("it changed since you saw it")])
        #expect(await until { heard.count == 2 })
        #expect(heard["host:a"] == .done)
        #expect(heard["host:b"] == .failed("it changed since you saw it"))
        #expect(ledger.state(host: "mac", ref: "host:b")?.line == "Not sent: it changed since you saw it")
    }

    @Test func `a group's answer is read per item: done, refused in its words, may have gone`() {
        let answer = Methods.WorkOutboxDecide.Output(results: [
            DecisionResult(ref: .host(.init(id: "a")), ok: true),
            DecisionResult(ref: .host(.init(id: "b")), ok: false, error: "it changed since you saw it"),
            DecisionResult(ref: .host(.init(id: "c")), ok: false, item: Self.item("c", state: "failed", outcomeUnknown: true)),
        ])
        #expect(DecisionResult.states(answer) == ["host:a": .done, "host:b": .failed("it changed since you saw it"), "host:c": .mayHaveGone])
    }

    @Test func `the host's own "it may have gone" is that, in time or late: never a refusal`() {
        let late = PressLedger.state(of: Result<Int, any Error>.failure(TransportError.server(method: "work.messages.send", message: "It may have gone: LifeOS did not answer")))
        #expect(late == .mayHaveGone)
        #expect(PressLedger.state(of: Result<Int, any Error>.failure(TransportError.server(method: "x", message: "no"))) == .failed("no"))
    }

    @Test func `a press settled twice tells its screen once`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        var heard: [PressState] = []
        ledger.listen(.outboxSend) { _, state in heard.append(state) }
        _ = try? await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true) { () async throws -> OutboxItem in throw Self.lost }
        // A read starts, a push settles it meanwhile, then the read answers.
        await ledger.check(host: "mac") { _ in
            ledger.heard(host: "mac", item: Self.item("a", state: "failed"))
            return Self.item("a", state: "sent")
        }
        #expect(heard == [.failed("")])
    }

    @Test func `a lost mail Send of a thread's draft is settled by the Outbox's item`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        let ref = PendingPress.mailRef("d1")
        _ = try? await ledger.run(.mailSend, host: "mac", hostName: "Mac", ref: ref, rev: nil, linked: true) { () async throws -> Int in throw Self.lost }
        let item = try JSONDecoder().decode(OutboxItem.self, from: Data(#"{"ref":{"at":"lifeos","table":"outbox","id":"d1"},"kind":"mail.send","workspaceId":"w1","sessionId":"s1","sector":"purdue","summary":"Send to Dana","verb":"Send","account":null,"state":"held","createdAt":1,"decidedBy":null,"decidedAt":null,"n":1,"why":"rule","grantId":null,"error":null,"result":null,"routineRunId":null,"updatedAt":5}"#.utf8))
        // Still held: the host never sent it; the press is free and nothing says Changed.
        #expect(ledger.heard(host: "mac", item: item) == .stillWaiting)
        #expect(!ledger.busy(host: "mac", ref: ref))
    }

    @Test func `an attempt key carries when it was made, for the host to know an expired one`() {
        let key = PendingPress.newAttempt(now: 1_795_464_000.5)
        #expect(key.hasPrefix("phone-1795464000500-"))
        #expect(key.count <= 64)
    }

    @Test func `a record of a kind this build does not know is dropped alone, never the file`() throws {
        let json = #"{"presses":[{"host":"mac","kind":"work.later.kind","ref":"x","at":1},{"host":"mac","kind":"work.outbox.send","ref":"host:a","rev":"10","at":2}]}"#
        let read = try JSONDecoder().decode(PendingPresses.self, from: Data(json.utf8))
        #expect(read.presses.map(\.ref) == ["host:a"])
    }

    @Test func `the record's last word stops a press that has not left: nothing goes, nothing stays`() async throws {
        let file = Self.folder()
        let ledger = Self.ledger(file, clock: Clock(100))
        let asked = Box()
        ledger.mayLeave = { _, key, _ in asked.keys.append(key); return "Not sent: TempCode left the screen" }
        var sent = 0
        await #expect(throws: ActionError.refused(message: "Not sent: TempCode left the screen", forbidden: false)) {
            try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true, key: "k1") { () async throws -> OutboxItem in
                sent += 1
                return Self.item("a", state: "sent")
            }
        }
        #expect(sent == 0)
        #expect(asked.keys == ["k1"])
        #expect(!ledger.busy(host: "mac", ref: "host:a"))
        #expect(Self.onDisk(file).isEmpty)
        await #expect(throws: ActionError.self) {
            try await ledger.runMany(.outboxSend, host: "mac", hostName: "Mac", items: [("host:b", "1")], linked: true, key: "k1") { () async throws -> Int in
                sent += 1
                return 1
            }
        }
        #expect(sent == 0 && !ledger.busy(host: "mac", ref: "host:b"))
    }

    @Test func `a request still running when its press answers stays Checking`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "request:q")) {
            try await ledger.run(.outboxDecide, host: "mac", hostName: "Mac", ref: "request:q", rev: "r", linked: true) { () async throws -> Int in
                throw PressLedger.NotYetKnown()
            }
        }
        #expect(ledger.busy(host: "mac", ref: "request:q"))
    }

    @Test func `a request's end settles its press while its first request is still parked, and nothing after changes it`() async throws {
        let (unknown, ending) = AsyncStream<Void>.makeStream()
        let ledger = Self.ledger(Self.folder(), clock: Clock(100), unknown: unknown)
        let (answer, answering) = AsyncStream<Bool>.makeStream()
        let press = Task {
            try await ledger.run(.outboxDecide, host: "mac", hostName: "Mac", ref: "request:q", rev: "r", linked: true) { () async throws -> Int in
                for await _ in answer { throw PressLedger.NotYetKnown() }
                throw CancellationError()
            }
        }
        #expect(await until { ledger.state(host: "mac", ref: "request:q") == .sending })
        ending.yield()
        _ = try? await press.value
        // Its last push arrives while the request is still parked on its socket: an end settles it.
        #expect(ledger.settle(host: "mac", ref: "request:q", truth: .done) == nil)
        #expect(ledger.settle(host: "mac", ref: "request:q", truth: .done, final: true) == .done)
        #expect(!ledger.busy(host: "mac", ref: "request:q"))
        // The parked request then answers "running": the end stands.
        answering.yield(true)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!ledger.busy(host: "mac", ref: "request:q"))
        #expect(ledger.state(host: "mac", ref: "request:q") == nil)
    }

    @Test func `the record's check is asked as the socket releases the frame, and a press taken back meanwhile never goes`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        ledger.mayLeave = { _, _, _ in nil }
        let seen = Box()
        _ = try await ledger.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:a", rev: "10", linked: true, key: "k1") { () async throws -> OutboxItem in
            // What the socket would ask as it releases this frame.
            seen.keys.append(Transport.release.map { $0() } ?? "no check")
            return Self.item("a", state: "sent")
        }
        #expect(seen.keys == [nil])
        let refusing = Self.ledger(Self.folder(), clock: Clock(100))
        refusing.mayLeave = { _, _, method in method == .outboxSend ? nil : "Not sent" }
        let late = Box()
        _ = try? await refusing.run(.outboxSend, host: "mac", hostName: "Mac", ref: "host:b", rev: "10", linked: true, key: "k1") { () async throws -> OutboxItem in
            refusing.mayLeave = { _, _, _ in "Not sent: TempCode left the screen" }
            late.keys.append(Transport.release.map { $0() } ?? "no check")
            return Self.item("b", state: "sent")
        }
        #expect(late.keys == ["Not sent: TempCode left the screen"])
    }

    @Test func `a press outside the record (a grant, Reopen) is checked before it starts and as its frame is released`() async throws {
        let ledger = Self.ledger(Self.folder(), clock: Clock(100))
        let asked = Box()
        ledger.mayLeave = { _, key, method in asked.keys.append("\(key ?? "-") \(method.rawValue)"); return nil }
        let seen = Box()
        let out = try await ledger.guarded(host: "mac", key: "k1", method: .formsReopen) { () async throws -> Int in
            seen.keys.append(Transport.release.map { $0() } ?? "no check")
            return 7
        }
        #expect(out == 7 && seen.keys == [nil])
        #expect(asked.keys == ["k1 work.forms.close?open=true", "k1 work.forms.close?open=true"])
        ledger.mayLeave = { _, _, _ in "Not sent: TempCode left the screen" }
        var ran = false
        await #expect(throws: ActionError.refused(message: "Not sent: TempCode left the screen", forbidden: false)) {
            try await ledger.guarded(host: "mac", key: "k1", method: .clashesAnswer) { () async throws -> Int in ran = true; return 1 }
        }
        #expect(!ran)
    }

    @Test func `a grant whose answer was lost says so; the send never leaves`() async throws {
        let press = HeldPress(entry: OutboxModel.Entry(environmentId: "mac", item: Self.item("a")), grant: Self.grant)
        var sent = false
        await #expect(throws: HeldPress.GrantLost()) {
            try await press.dispatch(grant: { _ in throw TransportError.cancelled }, send: { _, _ in sent = true })
        }
        #expect(!sent)
        // Before the grant too: a press whose app left asks for no grant.
        var granted = false
        await #expect(throws: HeldPress.NotStarted(why: .leftScreen)) {
            try await press.dispatch(grant: { _ in granted = true }, ready: { .leftScreen }, send: { _, _ in sent = true })
        }
        #expect(!granted && !sent)
    }

    // MARK: - the Send that waits (HeldPress)

    private static let grant = HeldPress.Grant(matcher: .object(["to": .string("events@purdue.edu")]), label: "Mail to events@purdue.edu")

    @Test func `again only on his own Send Again of one item that may have gone`() {
        let unknown = OutboxModel.Entry(environmentId: "mac", item: Self.item("a", state: "failed", outcomeUnknown: true))
        let failed = OutboxModel.Entry(environmentId: "mac", item: Self.item("a", state: "failed"))
        #expect(HeldPress(entry: unknown).again)
        #expect(!HeldPress(entry: failed).again)
        #expect(!HeldPress(entry: unknown, from: .group(3)).again)
        #expect(!HeldPress(entry: unknown, from: .request).again)
    }

    @Test func `a grant rides only one held item's own Send`() {
        let held = OutboxModel.Entry(environmentId: "mac", item: Self.item("a"))
        let failed = OutboxModel.Entry(environmentId: "mac", item: Self.item("a", state: "failed"))
        #expect(HeldPress(entry: held, grant: Self.grant).grant == Self.grant)
        #expect(HeldPress(entry: held, grant: Self.grant, from: .group(2)).grant == nil)
        #expect(HeldPress(entry: held, grant: Self.grant, from: .request).grant == nil)
        #expect(HeldPress(entry: failed, grant: Self.grant).grant == nil)
    }

    @Test func `at dispatch the grant is asked first, then the send; a refused grant sends nothing`() async throws {
        let press = HeldPress(entry: OutboxModel.Entry(environmentId: "mac", item: Self.item("a")), grant: Self.grant)
        var steps: [String] = []
        try await press.dispatch(grant: { steps.append("grant \($0.label)") }, send: { act, again in steps.append("send \(act) again=\(again)") })
        #expect(steps == ["grant Mail to events@purdue.edu", "send send again=false"])

        steps = []
        do {
            try await press.dispatch(
                grant: { _ in throw TransportError.server(method: "work.outbox.grant", message: "a grant needs admin") },
                send: { _, _ in steps.append("send") }
            )
            Issue.record("the send went after a refused grant")
        } catch let refused as HeldPress.GrantRefused {
            #expect(refused.words == "a grant needs admin")
            #expect(refused.line == "Not sent: no grant made: a grant needs admin")
        }
        #expect(steps.isEmpty)
    }

    @Test func `a send whose app left, or whose key changed, while its grant was out never leaves`() async throws {
        let press = HeldPress(entry: OutboxModel.Entry(environmentId: "mac", item: Self.item("a")), grant: Self.grant)
        var steps: [String] = []
        var calls = 0
        await #expect(throws: HeldPress.NotStarted(why: .leftScreen, granted: true)) {
            try await press.dispatch(grant: { _ in steps.append("grant") }, ready: { calls += 1; return calls > 1 ? .leftScreen : nil }, send: { _, _ in steps.append("send") })
        }
        #expect(steps == ["grant"])
        #expect(SendWait<HeldPress>.mayStart(foreground: false, linked: true, maySend: true, key: "k1", liveKey: "k1") == .leftScreen)
        #expect(SendWait<HeldPress>.mayStart(foreground: true, linked: false, maySend: true, key: "k1", liveKey: "k1") == .linkLost)
        #expect(SendWait<HeldPress>.mayStart(foreground: true, linked: true, maySend: true, key: "k1", liveKey: "k2") == .keyLost)
        #expect(SendWait<HeldPress>.mayStart(foreground: true, linked: true, maySend: true, key: "k1", liveKey: "k1") == nil)
    }

    @Test func `Send later and Send now ride the same wait, with no grant and no again`() throws {
        let entry = OutboxModel.Entry(environmentId: "mac", item: Self.item("a"))
        let later = HeldPress(entry: entry, act: .later(at: 1_795_600_000_000), grant: Self.grant)
        #expect(later.grant == nil)
        #expect(!later.again)
        #expect(later.notDone == "Not scheduled")
        #expect(HeldPress(entry: entry, act: .sendNow, grant: Self.grant).grant == nil)
        #expect(HeldPress(entry: entry).notDone == "Not sent")
        #expect(HeldPress(entry: entry).line == OutboxModel.pendingLine(entry.item))
    }

    @Test func `Undo inside the five seconds takes back the send and its grant: nothing is dispatched`() {
        typealias Wait = SendWait<HeldPress>
        let entry = OutboxModel.Entry(environmentId: "mac", item: Self.item("a"))
        var wait = Wait()
        wait.press(Wait.Press(id: entry.id, host: "mac", hostName: "Mac", rev: 10, line: "Sending…", payload: HeldPress(entry: entry, grant: Self.grant)), now: 0)
        #expect(wait.counting?.payload.grant == Self.grant)
        let undone = wait.undo(now: 1)
        #expect(undone?.payload.grant == Self.grant)
        #expect(wait.due(now: 10, check: .init(linked: true, maySend: true, rev: 10)) == nil)
        #expect(wait.inFlight == nil)
    }
}
