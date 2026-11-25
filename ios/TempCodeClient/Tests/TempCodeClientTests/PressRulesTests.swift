import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The rules in front of an outward press on the phone: the owner's check
/// (`PressGate`) and the record a press leaves until its answer is known
/// (`PendingPress`). docs/agents/ios-client.md "Outward presses on the phone".
@Suite struct PressRulesTests {
    private let send = PressGate.Press(host: "box", key: "k1", action: "work.outbox.send", ref: "host:h1", rev: "7")

    // MARK: - the gate

    @Test func `with the setting on, a press asks first and goes only on a pass`() {
        var gate = PressGate()
        let got1 = gate.begin(send, on: true, device: .ready, now: 100)
        #expect(got1 == .ask(send))
        let got2 = gate.answered(true, for: send, now: 101)
        #expect(got2)
        #expect(gate.passedAt == 101)
    }

    @Test func `a pass made for one host or key never sends on another`() {
        var gate = PressGate()
        _ = gate.begin(send, on: true, device: .ready, now: 100)
        // While the system asked, the sheet learned another host serves the file.
        var redirected = send
        redirected.host = "mac"
        let pass1 = gate.answered(true, for: send, now: 101, live: redirected)
        #expect(!pass1)
        #expect(gate.passedAt == nil)
        // The same host under a replaced key, the same capability.
        _ = gate.begin(send, on: true, device: .ready, now: 102)
        var rekeyed = send
        rekeyed.key = "k2"
        let pass2 = gate.answered(true, for: send, now: 103, live: rekeyed)
        #expect(!pass2)
        // The host left the phone.
        _ = gate.begin(send, on: true, device: .ready, now: 104)
        let pass3 = gate.answered(true, for: send, now: 105, live: nil)
        #expect(!pass3)
        _ = gate.begin(send, on: true, device: .ready, now: 106)
        let pass4 = gate.answered(true, for: send, now: 107, live: send)
        #expect(pass4)
        #expect(PressGate.holds(send, live: send) && !PressGate.holds(send, live: rekeyed))
    }

    @Test func `a cancel or a failure sends nothing and leaves no pass`() {
        var gate = PressGate()
        _ = gate.begin(send, on: true, device: .ready, now: 100)
        let got3 = gate.answered(false, for: send, now: 101)
        #expect(!got3)
        #expect(gate.passedAt == nil)
        // The next press asks again: a failure never turns the check off.
        let got4 = gate.begin(send, on: true, device: .ready, now: 102)
        #expect(got4 == .ask(send))
    }

    @Test func `one pass covers a minute of presses and no longer`() {
        var gate = PressGate()
        _ = gate.begin(send, on: true, device: .ready, now: 100)
        _ = gate.answered(true, for: send, now: 100)
        var next = send
        next.ref = "host:h2"
        let got5 = gate.begin(next, on: true, device: .ready, now: 159.9)
        #expect(got5 == .go)
        let got6 = gate.begin(next, on: true, device: .ready, now: 160)
        #expect(got6 == .ask(next))
    }

    @Test func `the pass ends on lock, on leaving the foreground and on a key change`() {
        var gate = PressGate()
        _ = gate.begin(send, on: true, device: .ready, now: 100)
        _ = gate.answered(true, for: send, now: 100)
        gate.end()
        let got7 = gate.begin(send, on: true, device: .ready, now: 101)
        #expect(got7 == .ask(send))
        // An answer that arrives after the gate ended counts for nothing.
        gate.end()
        let got8 = gate.answered(true, for: send, now: 102)
        #expect(!got8)
        #expect(gate.passedAt == nil)
    }

    @Test func `a pass is for the press it was asked for: another item, revision, host, key or act does not go on it`() {
        for change in [\PressGate.Press.ref, \.rev, \.host, \.key, \.action] {
            var gate = PressGate()
            _ = gate.begin(send, on: true, device: .ready, now: 100)
            var other = send
            other[keyPath: change] = "other"
            let got9 = gate.answered(true, for: other, now: 101)
            #expect(!got9)
        }
    }

    @Test func `while the system asks for one press, a second is not started`() {
        var gate = PressGate()
        _ = gate.begin(send, on: true, device: .ready, now: 100)
        var other = send
        other.ref = "host:h2"
        let got10 = gate.begin(other, on: true, device: .ready, now: 100.5)
        #expect(got10 == .busy)
    }

    @Test func `with the setting on and no passcode nothing outward is pressed, and with it off a press goes`() {
        var gate = PressGate()
        let got11 = gate.begin(send, on: true, device: .noPasscode, now: 100)
        #expect(got11 == .unavailable)
        let got12 = gate.begin(send, on: false, device: .noPasscode, now: 100)
        #expect(got12 == .go)
        let got13 = gate.begin(send, on: false, device: .ready, now: 100)
        #expect(got13 == .go)
        #expect(gate.passedAt == nil)
        #expect(PressGate.settingTitle(sensor: .touchID) == "Require Touch ID to Send")
        #expect(PressGate.settingTitle(sensor: .faceID) == "Require Face ID to Send")
    }

    // MARK: - a press on its way

    private func press(_ ref: String = "host:h1", host: String = "box", kind: PendingPress.Kind = .outboxSend, rev: String? = "7", at: Double = 100) -> PendingPress {
        PendingPress(host: host, kind: kind, ref: ref, rev: rev, at: at)
    }

    private func item(_ state: String, updatedAt: Int = 7, unknown: Bool = false, error: String? = nil) throws -> OutboxItem {
        var json: [String: Any] = ["ref": ["at": "host", "id": "h1"], "kind": "mail.send", "summary": "Send to Dana", "verb": "Send", "state": state, "createdAt": 1, "why": "rule", "updatedAt": updatedAt]
        if unknown { json["outcomeUnknown"] = true }
        if let error { json["error"] = error }
        return try JSONDecoder().decode(OutboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func `with no link a press is refused at once and nothing is recorded`() {
        var out = PendingPresses()
        let got14 = out.leaving(press(), linked: false)
        #expect(!got14)
        #expect(out.presses.isEmpty)
        #expect(PendingPresses.notConnected("Mac") == "Not connected to Mac")
    }

    @Test func `a double tap leaves once`() {
        var out = PendingPresses()
        let got15 = out.leaving(press(), linked: true)
        #expect(got15)
        let got16 = out.leaving(press(at: 100.2), linked: true)
        #expect(!got16)
        #expect(out.presses.count == 1)
        // The same item on another host, or another act on it, is its own press.
        let got17 = out.leaving(press(host: "mac"), linked: true)
        #expect(got17)
        let got18 = out.leaving(press(kind: .outboxDiscard), linked: true)
        #expect(got18)
    }

    @Test func `an answer clears the record; fifteen seconds without one is unknown, never failed`() {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        let id = press().id
        #expect(out.state(of: id, now: 110, linked: true) == .sending)
        #expect(out.state(of: id, now: 115, linked: true) == .checking)
        // The link dropping makes it unknown at once.
        #expect(out.state(of: id, now: 101, linked: false) == .checking)
        #expect(out.toCheck(host: "box", now: 110).isEmpty)
        #expect(out.toCheck(host: "box", now: 115).map(\.id) == [id])
        out.answered(id)
        #expect(out.state(of: id, now: 116, linked: true) == nil)
        #expect(PressState.checking.line == "Checking…")
    }

    @Test func `a lost answer is read back: sent is done, and the record goes`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        let got19 = out.resolve(press().id, truth: .outbox(try item("sent"), kind: .outboxSend))
        #expect(got19 == .done)
        #expect(out.presses.isEmpty)
    }

    @Test func `read back while the host is still sending, nothing is known and the press stays out`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        #expect(PressTruth.outbox(try item("sending"), kind: .outboxSend) == nil)
        let got20 = out.resolve(press().id, truth: nil)
        #expect(got20 == .checking)
        #expect(out.presses.count == 1)
    }

    @Test func `read back as he saw it, the press never arrived: it waits, and a new press is his to make`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        let got21 = out.resolve(press().id, truth: .outbox(try item("held", updatedAt: 7), kind: .outboxSend))
        #expect(got21 == .stillWaiting)
        #expect(out.presses.isEmpty)
        let got22 = out.leaving(press(at: 200), linked: true)
        #expect(got22)
    }

    @Test func `two devices: another one edited or sent it`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        // Edited elsewhere: it changed since he pressed, and is read again.
        let got23 = out.resolve(press().id, truth: .outbox(try item("held", updatedAt: 9), kind: .outboxSend))
        #expect(got23 == .changed)
        // Sent elsewhere while this phone's Discard was out: nothing is left to discard.
        _ = out.leaving(press(kind: .outboxDiscard), linked: true)
        let got24 = out.resolve(press(kind: .outboxDiscard).id, truth: .outbox(try item("sent"), kind: .outboxDiscard))
        #expect(got24 == .gone)
        // Discarded elsewhere while this phone's Send was out.
        _ = out.leaving(press(), linked: true)
        let got25 = out.resolve(press().id, truth: .outbox(try item("discarded"), kind: .outboxSend))
        #expect(got25 == .gone)
        // The row left the Outbox altogether.
        _ = out.leaving(press(), linked: true)
        let got26 = out.resolve(press().id, truth: .outbox(nil, kind: .outboxSend))
        #expect(got26 == .gone)
        _ = out.leaving(press(kind: .outboxDiscard), linked: true)
        let got27 = out.resolve(press(kind: .outboxDiscard).id, truth: .outbox(nil, kind: .outboxDiscard))
        #expect(got27 == .done)
    }

    @Test func `the host cannot say whether it went: May have gone, and only his own Send Again on that one item says again`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(), linked: true)
        let state = out.resolve(press().id, truth: .outbox(try item("failed", unknown: true, error: "timed out"), kind: .outboxSend))
        #expect(state == .mayHaveGone)
        #expect(state.line == "May have gone")
        #expect(PendingPresses.again(outcomeUnknown: true, hisPress: true, items: 1, request: false))
        #expect(!PendingPresses.again(outcomeUnknown: true, hisPress: false, items: 1, request: false))
        #expect(!PendingPresses.again(outcomeUnknown: true, hisPress: true, items: 3, request: false))
        #expect(!PendingPresses.again(outcomeUnknown: true, hisPress: true, items: 1, request: true))
        #expect(!PendingPresses.again(outcomeUnknown: false, hisPress: true, items: 1, request: false))
        // A plain failure is the host's words.
        _ = out.leaving(press(), linked: true)
        let got28 = out.resolve(press().id, truth: .outbox(try item("failed", error: "550 no such user"), kind: .outboxSend))
        #expect(got28 == .failed("550 no such user"))
        #expect(PressState.failed("550 no such user").line == "Not sent: 550 no such user")
    }

    @Test func `a relaunch: what was out is read back from disk as unknown, and nothing is sent from the record`() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pending-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("presses.json")
        var out = PendingPresses()
        _ = out.leaving(press(at: 100), linked: true)
        try out.save(to: file)

        let back = PendingPresses.load(from: file, now: 103)
        #expect(back.presses == out.presses)
        // Three seconds old, but from before this launch: no request is in flight for it.
        #expect(back.state(of: press().id, now: 103, linked: true) == .checking)
        #expect(back.toCheck(host: "box", now: 103).map(\.id) == [press().id])
        // The file holds what to read back by, and no payload.
        let text = try String(contentsOf: file, encoding: .utf8)
        #expect(text.contains("host:h1"))
        #expect(!text.contains("launchedAt"))
        // No file, or a broken one, is nothing pending.
        #expect(PendingPresses.load(from: folder.appendingPathComponent("none.json"), now: 1).presses.isEmpty)
        try Data("junk".utf8).write(to: file)
        #expect(PendingPresses.load(from: file, now: 1).presses.isEmpty)
    }

    @Test func `several hosts partly done: each host's press is read back on its own link`() throws {
        var out = PendingPresses()
        _ = out.leaving(press(host: "box"), linked: true)
        _ = out.leaving(press(host: "mac"), linked: true)
        out.answered(press(host: "box").id)
        #expect(out.toCheck(host: "box", now: 200).isEmpty)
        #expect(out.toCheck(host: "mac", now: 200).map(\.host) == ["mac"])
        #expect(out.state(of: press(host: "mac").id, now: 200, linked: false) == .checking)
        let got29 = out.resolve(press(host: "mac").id, truth: .outbox(try item("sent"), kind: .outboxSend))
        #expect(got29 == .done)
        #expect(out.presses.isEmpty)
    }

    @Test func `a guest link reads back by its attempt key and blocks a second submit while unknown`() {
        var out = PendingPresses()
        var link = press("guest:docs:d1", kind: .guestLink, rev: nil)
        link.attempt = "phone-g1"
        _ = out.leaving(link, linked: true)
        #expect(PendingPress.Kind.guestLink.readsBack)
        #expect(!PendingPress.Kind.guestLink.readsItem)
        #expect(out.toCheck(host: "box", now: 500).map(\.attempt) == ["phone-g1"])
        #expect(out.state(of: link.id, now: 500, linked: true) == .checking)
        let again = out.leaving(link, linked: true)
        #expect(!again)
    }

    @Test func `a chat reply reads back by its attempt key, not by an Outbox item`() {
        var out = PendingPresses()
        var reply = press("chat:w1:c1", kind: .chatReply, rev: nil)
        reply.attempt = "phone-a1"
        _ = out.leaving(reply, linked: true)
        #expect(PendingPress.Kind.chatReply.readsBack)
        #expect(!PendingPress.Kind.chatReply.readsItem)
        #expect(out.toCheck(host: "box", now: 500).map(\.attempt) == ["phone-a1"])
        // Its record keeps the key across a relaunch.
        let back = try? JSONDecoder().decode(PendingPresses.self, from: JSONEncoder().encode(out))
        #expect(back?.presses.first?.attempt == "phone-a1")
        let again = out.leaving(reply, linked: true)
        #expect(!again)
    }

    @Test func `a group's first press after one member was paired again reuses no pass`() {
        let known = ["mac": "k1|approve|f0", "box": "b1|approve|f0"]
        // The Mac's carrier paired again: its key is new, though no press under "mac,box" came before.
        let group = PressGate.Press(host: "mac,box", key: "k2|approve|f0;b1|approve|f0", action: "work.outbox.decide", ref: "g", rev: "1")
        let after = PressGate.keys(after: group, known: known)
        #expect(after.changed)
        #expect(after.keys["mac"] == "k2|approve|f0")
        // The same keys again: the pass stands.
        #expect(!PressGate.keys(after: group, known: after.keys).changed)
        // One host, unchanged; and a press whose hosts and keys do not pair up is read as a change.
        #expect(!PressGate.keys(after: .init(host: "box", key: "b1|approve|f0", action: "a", ref: "r", rev: "1"), known: known).changed)
        #expect(PressGate.keys(after: .init(host: "mac,box", key: "k1|approve|f0", action: "a", ref: "r", rev: "1"), known: known).changed)
    }
}
