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

}
