/// The LifeOS writes TempCode never makes itself (docs/agents/ios-client.md
/// "Outward presses on the phone"). LifeKitUI's screens write to LifeOS
/// through the `Writes` TempCode builds for them; a mutation that sends as
/// him goes past TempCode's hold, so it is refused there and never leaves
/// the phone. A held mail goes through `LifeActions.hold` to the host's
/// `work.mail.send`; a reply to a task's source has no host method yet, so
/// it does not go at all.
public enum LifeWriteFence {
    /// Mutations that send as him: mail (a Send, and Retry of a failed one, which LifeOS sends again at once), and a
    /// reply to a task's Slack or Messages source. A failed mail is sent again from its composer, through the hold.
    public static let outward: Set<String> = ["compose:send", "compose:retry", "replies:send", "replies:retry"]

    public struct Refusal: Error, Equatable, CustomStringConvertible {
        public let path: String
        public var description: String { "Not sent: send this from LifeOS" }
    }

    /// Throws for a mutation TempCode must not make; `replies:undo` only stops a reply, so it passes.
    public static func check(_ path: String) throws(Refusal) {
        if outward.contains(path) { throw Refusal(path: path) }
    }
}
