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

    /// One computer as the root's Away row counts it: its answer, a read still out, or nothing to go on (out of
    /// reach, refused, a release from before Away).
    public enum Computer: Sendable, Hashable {
        case on
        case off
        case waiting
        case unread
    }

    /// - Parameters:
    ///   - away: whether any kind is away, once the computer has answered; nil before.
    ///   - read: how its `away.get` stands (`WorkHost.awayRead`).
    ///   - transport: its link. A computer out of reach counts as unread even with an answer held: Off is a
    ///     setting the phone must have from it (the council's round 3).
    public static func computer(away: Bool?, read: AwayRead, transport: TransportState) -> Computer {
        switch transport {
        case .offline, .unauthorized: return .unread
        case .open, .connecting, .reconnecting, .suspended: break
        }
        if let away { return away ? .on : .off }
        return read == .waiting ? .waiting : .unread
    }

    /// The root row's trailing word. On while any computer is away; nil (the row's bones) while a read is out and
    /// none is away; Off only when every computer answered Off; "Off on 2 of 3" when some could not be read; nil
    /// again when none could, so nothing stands in for an answer that did not come.
    public static func summary(_ computers: [Computer]) -> String? {
        if computers.contains(.on) { return "On" }
        if computers.contains(.waiting) { return nil }
        let off = computers.count { $0 == .off }
        if off == 0 { return nil }
        return off == computers.count ? "Off" : "Off on \(off) of \(computers.count)"
    }

    /// The screen's one footer: what Away does (the plan's section 3).
    public static let footer = "While on, a thread that would wait for you decides for itself."
}

/// How a computer's `away.get` stands, for Settings' Away rows (`WorkHost.awayRead`): waiting from the connect
/// until it answers; `unsupported` only when the computer said it does not know the method (a release from before
/// Away); `failed` with the words of any other failure. A read still out is never taken for an old release.
public enum AwayRead: Sendable, Hashable {
    case waiting
    case answered
    case unsupported
    case failed(String)
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
