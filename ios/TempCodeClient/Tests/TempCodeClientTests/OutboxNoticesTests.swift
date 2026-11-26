import Testing
@testable import TempCodeClient

@Suite struct OutboxNoticesTests {
    @Test func `a group's result waits behind a countdown and goes only once it was seen`() {
        var notices = OutboxNotices()
        // Group A answered with a refusal for one row while a second Send counts: the result is kept.
        notices.result("Sent 1, 1 not sent")
        let a = notices.shown(wait: nil)
        #expect(a?.text == "Sent 1, 1 not sent")
        // The second Send's own result comes after: it waits behind A, never over it.
        notices.result("Sent 1")
        #expect(notices.shown(wait: nil)?.id == a?.id)
        // A clock for another line spends nothing.
        let spent = notices.seen("wait:x")
        #expect(!spent)
        #expect(notices.shown(wait: nil)?.id == a?.id)
        // A shown its whole time: it goes, and the second shows.
        notices.seen(a!.id)
        #expect(notices.shown(wait: nil)?.text == "Sent 1")
        // A new press's start clears only its own kind, the refusal before a wait; results stay.
        notices.refuse("Not connected to Mac")
        notices.refuse(nil)
        #expect(notices.shown(wait: nil)?.text == "Sent 1")
        // An empty sum is no result.
        notices.result("")
        #expect(notices.results.count == 1)
    }

    @Test func `two cancels that land together are both kept, each its own and about its own items`() {
        var notices = OutboxNotices()
        // Box and Mac both lost while their Sends wait: two cancels before any capsule draws.
        notices.result("Not sent: the link to Box was lost", refs: ["box:a"])
        notices.result("Not sent: the link to Mac was lost", refs: ["mac:b"])
        let first = notices.shown(wait: nil)
        #expect(first?.text == "Not sent: the link to Box was lost")
        #expect(notices.line(for: "mac:b")?.text == "Not sent: the link to Mac was lost")
        #expect(notices.line(for: "box:a")?.text == "Not sent: the link to Box was lost")
        notices.seen(first!.id)
        #expect(notices.shown(wait: nil)?.text == "Not sent: the link to Mac was lost")
        #expect(notices.line(for: "box:a") == nil)
    }

    @Test func `a new press of an item drops its old cancel line, and a line about another item stays`() {
        var notices = OutboxNotices()
        notices.result("Not sent: Docket left the screen", refs: ["mac:a"])
        notices.result("Not sent: the link to Box was lost", refs: ["box:b"])
        // He sends A again: its cancel never comes back after the new countdown.
        notices.forget(refs: ["mac:a"])
        #expect(notices.line(for: "mac:a") == nil)
        #expect(notices.shown(wait: nil)?.text == "Not sent: the link to Box was lost")
        // A group press naming B among others drops B's line too.
        notices.forget(refs: ["group-1", "box:b", "mac:c"])
        #expect(notices.shown(wait: nil) == nil)
    }
}
