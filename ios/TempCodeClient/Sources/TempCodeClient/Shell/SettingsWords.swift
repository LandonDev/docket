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
