import Foundation

/// A LifeOS session that cannot read, by its true state, in one rule for every place that reads it (Today, Mail, Tasks,
/// Agenda, the `@` list, Work search): the desktop's lifeosDown.ts and lifeosWords.ts (docs/DESIGN.md "Loading and empty
/// states"). The words name the computer the session reads through; Try Again only where asking again can help (LifeOS
/// or the host was silent); a sign-in that is missing, refused or waiting is mended on a computer, never by asking again.
public extension TodayDown {
    /// The down state a host names for its session ("signed-out", "refused", …), as a refused token or its status says
    /// it; nil while it connects or reads. The host's own silence, or a state this build does not know, is unanswered.
    static func of(state: String?) -> TodayDown? {
        switch state {
        case "connecting"?, "connected"?: nil
        case "signed-out"?, "signedOut"?: .signedOut
        case "pairing"?: .pairing
        case "refused"?: .refused
        case "off"?: .off
        case "unreachable"?: .unreachable
        default: .unanswered
        }
    }

    /// What it says, its computer named ("Not signed in to LifeOS on the box"); with no computer known, the desktop's
    /// host-less forms.
    func words(host: String?) -> String {
        guard let host else {
            return switch self {
            case .signedOut: "Not signed in to LifeOS"
            case .unreachable, .unanswered: "LifeOS did not answer"
            case .refused: "LifeOS refused the sign-in"
            case .pairing: "The LifeOS sign-in waits for your approval"
            case .off: "Work is off"
            case .withheld: "This iPhone’s key can’t read LifeOS"
            case .locked: "Your Mac is locked"
            }
        }
        let at = WorkSearch.nameInLine(host)
        return switch self {
        case .signedOut: "Not signed in to LifeOS on \(at)"
        case .unreachable: "LifeOS did not answer \(at)"
        case .unanswered: "\(LifeosWords.atHead(host)) did not answer"
        case .refused: "LifeOS refused \(at)’s sign-in"
        case .pairing: "The LifeOS sign-in on \(at) waits for your approval"
        case .off: "Work is off on \(at)"
        case .withheld: "This iPhone’s key can’t read LifeOS through \(at)"
        case .locked: "\(LifeosWords.atHead(host)) is locked"
        }
    }

    /// Silence, LifeOS's or the host's: the one state another try can mend.
    var isSilence: Bool { self == .unreachable || self == .unanswered }

    /// A sign-in that is missing, refused or waits for his approval: mended in Connections on a computer that manages
    /// the host (the desktop's Sign in and Show the code), never by asking again.
    var wantsSignIn: Bool { self == .signedOut || self == .refused || self == .pairing }
}

/// The LifeOS words that are not a down state.
public enum LifeosWords {
    /// A session on its way, a wait with no press: "LifeOS is still connecting on the box".
    public static func connecting(host: String?) -> String {
        host.map { "LifeOS is still connecting on \(WorkSearch.nameInLine($0))" } ?? "LifeOS is still connecting"
    }

    /// Where a sign-in is mended when this key may not open it there: "Sign in from a computer that manages the box"
    /// (the desktop's `signInElsewhere`).
    public static func signInElsewhere(host: String) -> String {
        "Sign in from a computer that manages \(WorkSearch.nameInLine(host))"
    }

    /// A host's name at the head of a line: "The box", "This Mac", "MacBook".
    public static func atHead(_ name: String) -> String {
        name.prefix(1).uppercased() + name.dropFirst()
    }
}
