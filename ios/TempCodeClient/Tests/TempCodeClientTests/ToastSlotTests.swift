import Testing
@testable import TempCodeClient

@Suite struct ToastSlotTests {
    @Test func `a plain success never takes the slot from a failure he has not read`() {
        // A sticky "Not sent: …" is up; a plain "Scheduled" comes: the failure stands.
        #expect(!ToastSlot.takes(nextSticky: false, upSticky: true))
        // A newer failure replaces it, as before.
        #expect(ToastSlot.takes(nextSticky: true, upSticky: true))
        // Nothing up, or a plain line up: anything takes the slot.
        #expect(ToastSlot.takes(nextSticky: false, upSticky: nil))
        #expect(ToastSlot.takes(nextSticky: false, upSticky: false))
    }

    @Test func `his own cancel of the check is said plainly, not as a failure`() {
        #expect(ToastSlot.isPlain(PressGate.cancelledLine))
        #expect(!ToastSlot.isPlain(PressGate.unavailableLine))
        #expect(!ToastSlot.isPlain("Not sent: the host refused it"))
    }
}
