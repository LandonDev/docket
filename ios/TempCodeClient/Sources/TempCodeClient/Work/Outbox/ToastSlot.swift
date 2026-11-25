import Foundation

/// The rules of the foot's one outcome line (the app's `FleetToastCenter`): a failure waits for his tap, a plain line
/// leaves after four seconds.
public enum ToastSlot {
    /// What becomes of a new notice.
    public enum Fate: Sendable, Hashable {
        /// It takes the slot now.
        case show
        /// A failure he has not read is up: it waits behind it and shows once he taps the failure away.
        case queue
        /// It is not shown: a success that answers no press of his (Mail's late "Scheduled"), under an unread failure.
        case drop
    }

    /// The one rule: a success never erases a failure he has not read. A new failure takes the slot. A success that
    /// answers his own press ("Copied", "Running …", "Paused 14") waits behind the failure; one that answers no press
    /// of his is said where it belongs (Mail's capsule, the Outbox's row) and not here. Every notice is still spoken to
    /// VoiceOver as it comes, whatever its fate.
    public static func fate(nextSticky: Bool, own: Bool, upSticky: Bool?) -> Fate {
        if nextSticky || upSticky != true { return .show }
        return own ? .queue : .drop
    }

    /// A line from the owner's check that is no failure: his own cancel sent nothing, and it waits for no tap.
    public static func isPlain(_ line: String) -> Bool {
        line == PressGate.cancelledLine
    }
}
