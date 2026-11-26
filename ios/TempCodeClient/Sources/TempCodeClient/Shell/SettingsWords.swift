import Foundation

/// What the phone's Settings root and its Away screen say, as pure
/// functions so every word has a test (docs/IOS-DESIGN.md "Settings"; the
/// names are the Settings 2 glossary, the desktop's
/// src/renderer/src/lib/settings/map.ts).

/// Settings → Away: a computer's switches, in the desktop's row names.
public enum AwayWords {
    /// One switch's row: "Code threads", "Work threads", or an older
    /// computer's one switch for both.
    public static func title(_ kind: AwayKinds.Kind?) -> String {
        switch kind {
        case .code: "Code threads"
        case .work: "Work threads"
        case nil: "Code and Work threads"
        }
    }

    /// The root row's trailing word: On while any computer has any kind away.
    public static func summary(_ on: [Bool]) -> String {
        on.contains(true) ? "On" : "Off"
    }

    /// The screen's one footer: what Away does (the plan's section 3).
    public static let footer = "While on, a thread that would wait for you decides for itself."
}

/// How the root's Work row stands: shown once a computer has answered
/// `work.get` (on or off, it is where Work is turned on); waiting, in the
/// row's place, while a computer has yet to connect and none has answered;
/// gone when every computer is connected and none knows Work.
public enum WorkRowState: Sendable, Hashable {
    case shown
    case waiting
    case hidden

    /// - Parameter computers: each paired computer's `answered` (its Work
    ///   settings are held) and `settled` (its link is open, or has stopped
    ///   trying).
    public static func of(_ computers: [(answered: Bool, settled: Bool)]) -> WorkRowState {
        if computers.contains(where: \.answered) { return .shown }
        return computers.contains { !$0.settled } ? .waiting : .hidden
    }
}

/// The sign-in sheet's refusal under its field, in the glossary's words: the
/// host says "invalid or expired pairing code", the phone says what it was
/// and the way forward (the council's round 1).
public enum SignInWords {
    /// - Parameter link: the sheet was redeeming a sign-in link (else a key with an address).
    public static func refusal(_ error: EnvironmentStoreError, link: Bool) -> String {
        switch error {
        case .invalidPairingLink: return "That is not a sign-in link. Copy the whole link from the computer."
        case .invalidKey: return "That is not a key. Copy the whole key from the computer."
        case .notAClientKey: return "That key is for a bot. Make a key for this phone on the computer."
        case .api(.unauthorized):
            return link
                ? "That sign-in link is invalid or expired. Make a new link on the computer."
                : "The computer refused that key. Make a new one on the computer."
        case .api(let api): return sentence(api.message)
        case .keyStore: return "This phone could not keep the key. Try again."
        }
    }
}

/// The word beside Settings' Notifications switch: only what the switch's
/// own position does not say ("Registering…", "No relay", "Failed", "Not
/// allowed"); nothing for On and Off, which the switch already shows (the
/// council's round 2).
public enum NotificationWords {
    public static func beside(_ summary: String) -> String? {
        summary == "On" || summary == "Off" ? nil : summary
    }
}
