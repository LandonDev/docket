import Foundation

/// Touch ID, Face ID or the passcode before an outward press (plan "The hold
/// on the phone": Send, Approve, share, publish, Discard, Edit of a held
/// item). The rule alone: the app asks the system (`LAContext`,
/// `.deviceOwnerAuthentication`) when this says `ask` and tells it the answer.
///
/// It runs on one explicit foreground press and is bound to that press: the
/// host, the key, the act, the item and the revision he saw. A pass in this
/// foreground within the last minute is reused and asks nothing. A pass never
/// supplies a press or a capability, and it ends on lock, on the app leaving
/// the foreground and on a key change. A cancel or a failure sends nothing; a
/// failure cannot turn the setting off. With the setting on and no passcode
/// set on the phone, outward presses are unavailable and say why.
public struct PressGate: Sendable, Hashable {
    /// How long one pass covers, while the app stays in front.
    public static let reuseSeconds: Double = 60
    /// UserDefaults key of the one switch, "Require Touch ID to Send"; absent means on.
    public static let settingKey = "work.press.gate"

    /// The press an authentication is asked for. It may go only if it is still this press when the answer comes.
    public struct Press: Sendable, Hashable {
        /// The host's environment id.
        public var host: String
        /// The key the press goes out under: its id as the phone keeps it, so a replaced key is another key.
        public var key: String
        /// The wire method (`work.outbox.send`).
        public var action: String
        /// The item's canonical ref (`OutboxModel.key`), or a request's id.
        public var ref: String
        /// The revision he saw (`updatedAt`), or a request's receipts joined.
        public var rev: String

        public init(host: String, key: String, action: String, ref: String, rev: String) {
            self.host = host
            self.key = key
            self.action = action
            self.ref = ref
            self.rev = rev
        }
    }

    /// What the phone can check its owner by.
    public enum Device: Sendable, Hashable {
        /// A passcode is set (with or without Touch ID or Face ID).
        case ready
        case noPasscode
    }

    public enum Verdict: Sendable, Hashable {
        /// The press may go: the setting is off, or a pass in this foreground still covers it.
        case go
        /// Ask the system now, for this press.
        case ask(Press)
        /// The setting is on and the phone has no passcode: nothing outward may be pressed.
        case unavailable
        /// The system's sheet is already up for another press.
        case busy
    }

    /// When the last pass was given, in this foreground.
    public private(set) var passedAt: Double?
    /// The press the system's sheet is up for.
    public private(set) var asking: Press?

    public init() {}

    /// His press, before its five seconds start.
    public mutating func begin(_ press: Press, on: Bool, device: Device, now: Double) -> Verdict {
        guard on else { return .go }
        guard device == .ready else { return .unavailable }
        if asking != nil { return .busy }
        if let passedAt, now >= passedAt, now - passedAt < Self.reuseSeconds { return .go }
        asking = press
        return .ask(press)
    }

    /// The system answered. True: this press may go. A press that is no longer the one asked for
    /// (the item changed, the key was replaced, the gate was ended meanwhile) never goes on this answer.
    /// `live` is the press's host and key as they are now (nil: the host left the phone): another host, or
    /// another key on it, even one with the same capability, voids the pass and sends nothing.
    public mutating func answered(_ passed: Bool, for press: Press, now: Double, live: Press?) -> Bool {
        guard asking == press else { return false }
        asking = nil
        guard passed else { return false }
        guard Self.holds(press, live: live) else {
            end()
            return false
        }
        passedAt = now
        return true
    }

    /// The same, where nothing can have moved under the press (a test's single host).
    public mutating func answered(_ passed: Bool, for press: Press, now: Double) -> Bool {
        answered(passed, for: press, now: now, live: press)
    }

    /// The press he passed is still the one that would go: the same host under the same key. Checked after the
    /// system's answer and again at dispatch, so a check made for one host or key never sends on another.
    public static func holds(_ press: Press, live: Press?) -> Bool {
        guard let live else { return false }
        return live.host == press.host && live.key == press.key
    }

    /// The phone locked, the app left the foreground, or a key changed: the pass is over, and an
    /// answer still on its way counts for nothing.
    public mutating func end() {
        passedAt = nil
        asking = nil
    }

    /// The line where a press would be, with the setting on and no passcode set.
    public static let unavailableLine = "Set a passcode on this iPhone to send from here."
    /// The line after a cancel or a failed check: nothing went.
    public static let cancelledLine = "Nothing was sent."

    /// The switch's name, in the phone's own word for its sensor.
    public static func settingTitle(sensor: Sensor) -> String {
        "Require \(sensor.name) to Send"
    }

    public enum Sensor: Sendable, Hashable {
        case touchID, faceID, opticID, none

        public var name: String {
            switch self {
            case .touchID: "Touch ID"
            case .faceID: "Face ID"
            case .opticID: "Optic ID"
            case .none: "Passcode"
            }
        }
    }
}
