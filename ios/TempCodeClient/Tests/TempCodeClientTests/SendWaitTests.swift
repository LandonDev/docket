import Testing
@testable import TempCodeClient

@Suite struct SendWaitTests {
    typealias Wait = SendWait<String>

    static func press(_ id: String, host: String = "box", rev: Double = 1) -> Wait.Press {
        Wait.Press(id: id, host: host, hostName: host == "box" ? "The box" : "Mac", rev: rev, line: "Sending \(id)…", payload: id)
    }

    static let fine = Wait.Check(linked: true, maySend: true, rev: 1)

    @Test func `one send goes after five seconds and not before`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 100)
        #expect(wait.counting?.id == "a")
        #expect(wait.deadline == 105)
        #expect(wait.due(now: 104.9, check: Self.fine) == nil)
        #expect(wait.counting?.id == "a")
        #expect(wait.due(now: 105, check: Self.fine)?.id == "a")
        #expect(wait.inFlight?.id == "a")
        #expect(wait.holds("a"))
        wait.landed("a", now: 106)
        #expect(!wait.holds("a"))
        #expect(wait.notice == nil)
    }

    @Test func `undo inside the wait sends nothing`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        #expect(wait.undo(now: 3)?.id == "a")
        #expect(wait.due(now: 10, check: Self.fine) == nil)
        #expect(wait.inFlight == nil)
        #expect(!wait.holds("a"))
        #expect(wait.notice == nil)
    }

    @Test func `a second send waits its own turn and never hurries the first`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("b"), now: 2)
        // The first keeps its own five seconds; the second only queues.
        #expect(wait.counting?.id == "a")
        #expect(wait.deadline == 5)
        #expect(wait.queued.map(\.id) == ["b"])
        #expect(wait.holds("b"))
        #expect(wait.due(now: 2, check: Self.fine) == nil)
        #expect(wait.due(now: 5, check: Self.fine)?.id == "a")
        // Never two in flight: b starts counting only when a's answer lands.
        #expect(wait.counting == nil)
        #expect(wait.due(now: 20, check: Self.fine) == nil)
        wait.landed("a", now: 7)
        #expect(wait.counting?.id == "b")
        #expect(wait.deadline == 12)
        #expect(wait.due(now: 11, check: Self.fine) == nil)
        #expect(wait.due(now: 12, check: Self.fine)?.id == "b")
    }

    @Test func `undo of the first starts the second's own five seconds`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("b"), now: 1)
        wait.undo(now: 3)
        #expect(wait.counting?.id == "b")
        #expect(wait.deadline == 8)
    }

    @Test func `the same press twice is taken once`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("a"), now: 1)
        #expect(wait.queued.isEmpty)
        #expect(wait.deadline == 5)
    }

    @Test func `leaving the screen cancels everything waiting and says so`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("b"), now: 1)
        wait.leftScreen()
        #expect(wait.counting == nil)
        #expect(wait.queued.isEmpty)
        #expect(!wait.holds("a") && !wait.holds("b"))
        #expect(wait.due(now: 10, check: Self.fine) == nil)
        #expect(wait.notice?.why == .leftScreen)
        #expect(wait.notice?.line == "2 not sent: TempCode left the screen")
    }

    @Test func `leaving the screen leaves a press already in flight alone`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        _ = wait.due(now: 5, check: Self.fine)
        wait.leftScreen()
        #expect(wait.inFlight?.id == "a")
        #expect(wait.notice == nil)
    }

    @Test func `the link dropping cancels that host's presses and reports it`() {
        var wait = Wait()
        wait.press(Self.press("a", host: "mac"), now: 0)
        wait.press(Self.press("b", host: "box"), now: 1)
        wait.linkLost(host: "mac", now: 2)
        #expect(!wait.holds("a"))
        #expect(wait.notice?.line == "Not sent: lost the link to Mac")
        // The other host's press now counts its own five seconds.
        #expect(wait.counting?.id == "b")
        #expect(wait.deadline == 7)
    }

    @Test func `no link at the end of the wait cancels and reports`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        #expect(wait.due(now: 5, check: .init(linked: false, maySend: true, rev: 1)) == nil)
        #expect(!wait.holds("a"))
        #expect(wait.notice?.why == .linkLost)
        #expect(wait.notice?.line == "Not sent: lost the link to The box")
    }

    @Test func `a key that lost approve sends nothing`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: false, rev: 1)) == nil)
        #expect(wait.notice?.line == "Not sent: this iPhone’s key can’t send on The box")
        var changed = Wait()
        changed.press(Self.press("a"), now: 0)
        changed.press(Self.press("b"), now: 0)
        changed.keyLost(host: "box", now: 1)
        #expect(changed.counting == nil && changed.queued.isEmpty)
        #expect(changed.notice?.why == .keyLost)
    }

    @Test func `an item changed or decided since the press is not sent`() {
        var wait = Wait()
        wait.press(Self.press("a", rev: 1), now: 0)
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: true, rev: 2)) == nil)
        #expect(wait.notice?.why == .changed)
        wait.press(Self.press("b"), now: 6)
        #expect(wait.notice == nil)
        #expect(wait.due(now: 11, check: .init(linked: true, maySend: true, rev: nil)) == nil)
        #expect(wait.notice?.line == "Not sent: it no longer waits")
    }

    @Test func `another key on the host when the seconds end sends nothing, even with the same capability`() {
        var wait = Wait()
        var press = Self.press("a")
        press.key = "k1|approve"
        wait.press(press, now: 0)
        // The client was replaced under a new pairing that may still send: the key is not the one he pressed under.
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: true, rev: 1, key: "k2|approve")) == nil)
        #expect(wait.notice?.why == .keyLost)
        var same = Wait()
        same.press(press, now: 0)
        #expect(same.due(now: 5, check: .init(linked: true, maySend: true, rev: 1, key: "k1|approve"))?.id == "a")
    }

    @Test func `Undo shows where it can be seen: the item keeps it when the Duo's sidebar is hidden`() {
        #expect(SendUndoPlace.of(split: false, sidebarVisible: false) == .list)
        #expect(SendUndoPlace.of(split: true, sidebarVisible: true) == .list)
        #expect(SendUndoPlace.of(split: true, sidebarVisible: false) == .item)
        // A sidebar that shows Today, not the Outbox, wears no capsule: the item keeps it.
        #expect(SendUndoPlace.of(split: true, sidebarVisible: true, outboxBeside: false) == .item)
    }

    @Test func `a press approved before the app left and came back is not sent on its return, though the key is the same`() {
        #expect(Wait.keyWhy(frozen: "k1|approve|f3", live: "k1|approve|f3") == nil)
        #expect(Wait.keyWhy(frozen: "k1|approve|f3", live: "k1|approve|f4") == .leftScreen)
        #expect(Wait.keyWhy(frozen: "k1|approve|f3", live: "k2|approve|f3") == .keyLost)
        #expect(Wait.keyWhy(frozen: "k1|approve|f3", live: nil) == .keyLost)
        #expect(Wait.keyWhy(frozen: nil, live: "k1|approve|f4") == nil)
        // A group's next host, after a background and return while the first host answered.
        #expect(Wait.mayStart(foreground: true, linked: true, maySend: true, key: "k1|approve|f3", liveKey: "k1|approve|f4") == .leftScreen)
        var wait = Wait()
        var press = Self.press("a")
        press.key = "k1|approve|f3"
        wait.press(press, now: 0)
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: true, rev: 1, key: "k1|approve|f4")) == nil)
        #expect(wait.notice?.line == "Not sent: TempCode left the screen")
    }

    @Test func `a composer Send's capsule Undo takes back its own press, counting or still in line, and says nothing`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("b"), now: 1)
        // Nothing goes before the five seconds.
        #expect(wait.due(now: 4.9, check: .init(linked: true, maySend: true, rev: 1)) == nil)
        // The second's capsule: it leaves the line, the first still counts.
        #expect(wait.undo("b", now: 2)?.id == "b")
        #expect(wait.counting?.id == "a")
        #expect(wait.queued.isEmpty)
        #expect(wait.notice == nil)
        // The first's: nothing is left to send.
        #expect(wait.undo("a", now: 3)?.id == "a")
        #expect(wait.due(now: 10, check: .init(linked: true, maySend: true, rev: 1)) == nil)
        #expect(wait.undo("a", now: 11) == nil)
        // One already in flight is not taken back.
        var gone = Wait()
        gone.press(Self.press("c"), now: 0)
        #expect(gone.due(now: 5, check: .init(linked: true, maySend: true, rev: 1))?.id == "c")
        #expect(gone.undo("c", now: 6) == nil)
        #expect(gone.holds("c"))
    }

    @Test func `a second Mail draft queued behind the first gets its own Undo when its countdown starts`() {
        var wait = Wait()
        var offered: String?
        wait.press(Self.press("a"), now: 0)
        offered = wait.toOffer(after: offered)?.id
        #expect(offered == "a")
        // The second queues: the first's capsule is already up, so nothing new, and the second has none yet.
        wait.press(Self.press("b"), now: 1)
        #expect(wait.toOffer(after: offered) == nil)
        // A composer's words over the first's capsule: shown again (the offer is forgotten).
        #expect(wait.toOffer(after: nil)?.id == "a")
        // The first goes and its RPC is parked: no countdown, nothing to offer.
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: true, rev: 1))?.id == "a")
        #expect(wait.toOffer(after: offered) == nil)
        // It lands: the second counts its own five seconds and its Undo goes up.
        wait.landed("a", now: 7)
        #expect(wait.counting?.id == "b")
        offered = wait.toOffer(after: offered)?.id
        #expect(offered == "b")
        // Undo after the second's countdown started: it sends nothing.
        #expect(wait.due(now: 11.9, check: .init(linked: true, maySend: true, rev: 1)) == nil)
        #expect(wait.undo("b", now: 11)?.id == "b")
        #expect(wait.due(now: 20, check: .init(linked: true, maySend: true, rev: 1)) == nil)
        #expect(!wait.holds("b"))
    }

    @Test func `a late Undo says what became of the press, never nothing`() {
        var wait = Wait()
        wait.press(Self.press("a"), now: 0)
        wait.press(Self.press("b"), now: 1)
        // Still waiting: Undo takes it back, nothing to say.
        #expect(wait.lateUndo("a", ended: nil) == nil)
        #expect(wait.lateUndo("b", ended: nil) == nil)
        #expect(wait.due(now: 5, check: .init(linked: true, maySend: true, rev: 1))?.id == "a")
        #expect(wait.lateUndo("a", ended: nil) == "Already on its way")
        wait.landed("a", now: 6)
        #expect(wait.lateUndo("a", ended: .sent) == "Already sent")
        #expect(wait.lateUndo("a", ended: .unknown) == "Checking whether it went")
        // Cancelled by the background: nothing went, and the late Undo says so.
        wait.leftScreen()
        #expect(wait.lateUndo("b", ended: .notSent) == "It was not sent")
        #expect(wait.lateUndo("c", ended: nil) == "Too late to undo")
    }
}
