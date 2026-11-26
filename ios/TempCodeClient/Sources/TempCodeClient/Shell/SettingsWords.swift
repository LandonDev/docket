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

    /// One computer's Away as Settings shows it, on its page and in the root's count. Its switches only once this
    /// link's `away.get` answered: a held answer from before a drop or a failed read is not shown as his setting (the
    /// council's round 4).
    public enum Section: Sendable, Hashable {
        /// The answer: whether any kind is away.
        case switches(on: Bool)
        /// The read is out: bones.
        case waiting
        /// The computer said it does not know Away.
        case unsupported
        /// The read failed, with its words: the page's line and Retry.
        case failed(String)
        /// The computer is out of reach or refuses this key.
        case unreachable

        /// Its switches stand: this link's read answered.
        public var answered: Bool {
            if case .switches = self { return true }
            return false
        }
    }

    /// - Parameters:
    ///   - away: whether any kind is away in the answer the phone holds; nil when it holds none.
    ///   - read: how this link's `away.get` stands (`WorkHost.awayRead`).
    ///   - transport: the link.
    public static func section(away: Bool?, read: AwayRead, transport: TransportState) -> Section {
        switch transport {
        case .offline, .unauthorized: return .unreachable
        case .open, .connecting, .reconnecting, .suspended: break
        }
        switch read {
        case .waiting: return .waiting
        case .unsupported: return .unsupported
        case .failed(let words): return .failed(words)
        case .answered: return away.map { .switches(on: $0) } ?? .waiting
        }
    }

    /// The root row's trailing word, or nil for its bones while a read is out and none is away. "On" while any
    /// computer is away; "Off" once every computer answered Off; "Off, 4 not read" when some could not be read (never
    /// "Off on 1 of 5", which reads as on for the rest); "Not read" when every read settled and none answered, so
    /// the bones end.
    public static func summary(_ computers: [Section]) -> String? {
        if computers.contains(.switches(on: true)) { return "On" }
        if computers.contains(.waiting) { return nil }
        let off = computers.count { $0 == .switches(on: false) }
        if off == 0 { return "Not read" }
        let unread = computers.count - off
        return unread == 0 ? "Off" : "Off, \(unread) not read"
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
    /// Where a sign-in link or a key is made, said as the press, not a page: Add… under "Who can sign in", which is
    /// on the box's own page and, on a Mac, in Sharing (the council's rounds 5 and 6). Every hint and refusal that
    /// sends him there says it in these words.
    public static let route = "Add… under Who can sign in (on a Mac, in Sharing)"
    public static let linkHint = "In Docket's Settings, press \(route), then paste the link here."
    public static let keyHint = "In Docket's Settings, make a key with \(route), then enter it here with the computer's address."
    /// The footer under a computer whose key was refused: the same press, then this sheet again.
    public static let refusedKeyHint = "In Docket's Settings, press \(route), then sign in again."

    /// - Parameter link: the sheet was redeeming a sign-in link (else a key with an address).
    public static func refusal(_ error: EnvironmentStoreError, link: Bool) -> String {
        switch error {
        case .invalidPairingLink: return "That is not a sign-in link. Copy the whole link from the computer."
        case .invalidKey: return "That is not a key. Copy the whole key from the computer."
        case .notAClientKey: return "That key is for a bot. Make a key for this phone on the computer."
        case .api(.unauthorized):
            return link
                ? "That sign-in link is invalid or expired. Make a new one with \(route)."
                : "The computer refused that key. Make a new one with \(route)."
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
