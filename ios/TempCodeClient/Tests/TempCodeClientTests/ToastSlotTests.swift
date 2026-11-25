import Testing
@testable import TempCodeClient

@Suite struct ToastSlotTests {
    @Test func `a success never erases an unread failure, and his own press's success waits behind it`() {
        // A sticky "Not sent: …" is up; Mail's late "Scheduled" answers no press of his: the failure stands alone.
        #expect(ToastSlot.fate(nextSticky: false, own: false, upSticky: true) == .drop)
        // "Copied" answers his own press: it waits behind the failure, never lost.
        #expect(ToastSlot.fate(nextSticky: false, own: true, upSticky: true) == .queue)
        // A newer failure replaces the old one.
        #expect(ToastSlot.fate(nextSticky: true, own: false, upSticky: true) == .show)
        // Nothing up, or a plain line up: anything shows.
        #expect(ToastSlot.fate(nextSticky: false, own: false, upSticky: nil) == .show)
        #expect(ToastSlot.fate(nextSticky: false, own: true, upSticky: false) == .show)
    }

    @Test func `his own cancel of the check is said plainly, not as a failure`() {
        #expect(ToastSlot.isPlain(PressGate.cancelledLine))
        #expect(!ToastSlot.isPlain(PressGate.unavailableLine))
        #expect(!ToastSlot.isPlain("Not sent: the host refused it"))
    }
}
