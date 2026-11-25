import Foundation

/// The rules of the foot's one outcome line (the app's `FleetToastCenter`): a failure waits for his tap, a plain line
/// leaves after four seconds.
public enum ToastSlot {
    /// Whether a new notice takes the slot. A plain one never takes it from a sticky one still up: a failure he has not
    /// read outranks a success, which is said where it belongs too (Mail's capsule, the Outbox's row).
    public static func takes(nextSticky: Bool, upSticky: Bool?) -> Bool {
        nextSticky || upSticky != true
    }

    /// A line from the owner's check that is no failure: his own cancel sent nothing, and it waits for no tap.
    public static func isPlain(_ line: String) -> Bool {
        line == PressGate.cancelledLine
    }
}
