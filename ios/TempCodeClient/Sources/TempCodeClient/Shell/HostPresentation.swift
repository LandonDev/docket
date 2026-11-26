import Foundation
import TempCodeContract

/// What the Settings, Computers and computer-detail screens say about a computer, as
/// pure functions of the client's models, so the app target holds only the
/// SwiftUI and every word here has a test. Value code throughout; only
/// `forgetHost` touches the registry and runs on the main actor.

/// A computer's state in one word or short phrase: the Computers row's
/// second line. The detail's status row says the whole sentence
/// (`ConnectionSentence`).
public enum ConnectionWord {
    public static func text(for status: EnvironmentStatus) -> String {
        switch status.transport {
        case .open: "Connected"
        case .connecting: status.attempts > 0 ? "Not answering" : "Connecting…"
        // A suspended socket is the app's own rest in the background: it reconnects as the app comes forward.
        case .reconnecting, .suspended: "Reconnecting…"
        case .offline:
            switch status.halt {
            case .identityChanged?: "Another computer"
            case .contractMismatch?: "Needs an update"
            case nil: "Offline"
            }
        case .unauthorized: "Refuses this key"
        }
    }
}

/// A computer's connection as one sentence, in the desktop's words
/// (src/renderer/src/lib/connection/degraded.ts `linkWords`): "Reconnecting
/// to the box in 5 s", "The box no longer accepts this key", "The box is
/// offline", the name raised at a sentence's start. `now` keeps the countdown honest. The host's own error text
/// never shows: the phone says what it knows, not what the socket printed.
public enum ConnectionSentence {
    public static func text(name: String, status: EnvironmentStatus, now: Date) -> String {
        let start = nameAtStart(name)
        let inLine = nameInLine(name)
        let wait = status.nextRetryAt.map { max(0, Int(($0 / 1000 - now.timeIntervalSince1970).rounded())) } ?? 0
        switch status.transport {
        case .open:
            return "Connected"
        case .connecting:
            return status.attempts > 0 && wait > 0 ? "\(start) did not answer; retrying in \(wait) s" : "Connecting to \(inLine)…"
        case .reconnecting:
            return wait > 0 ? "Reconnecting to \(inLine) in \(wait) s" : "Reconnecting to \(inLine)…"
        case .suspended:
            return "Reconnecting to \(inLine)…"
        case .offline:
            switch status.halt {
            case .identityChanged?: return "\(start) is not the host this computer paired with"
            case .contractMismatch(let app, let host)?: return host > app ? "\(start) is newer than this app" : "\(start) is older than this app"
            case nil: return "\(start) is offline"
            }
        case .unauthorized:
            return "\(start) no longer accepts this key"
        }
    }

    /// Whether the sentence counts down, so its view ticks each second.
    public static func ticks(_ status: EnvironmentStatus) -> Bool {
        (status.transport == .reconnecting || status.transport == .connecting) && status.nextRetryAt != nil
    }
}

/// A computer's link with no name in it, for a row that already names the computer (Home's host card): the
/// desktop's `linkFact` (src/renderer/src/lib/connection/degraded.ts), "Reconnecting…", "Offline", "No longer
/// accepts this key". `ConnectionSentence` stays the one sentence where nothing else names it.
public enum ConnectionFact {
    public static func text(for status: EnvironmentStatus) -> String {
        switch status.transport {
        case .open: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting, .suspended: "Reconnecting…"
        case .offline:
            switch status.halt {
            case .identityChanged?: "Not the host this computer paired with"
            case .contractMismatch?: "Needs an update"
            case nil: "Offline"
            }
        case .unauthorized: "No longer accepts this key"
        }
    }
}

/// A computer's name inside a sentence, as the desktop says it (src/renderer/src/lib/hostWords.ts `nameInLine`):
/// "The box" reads "the box", "This Mac" reads "this Mac"; a name of its own ("Studio Mac") stays as it is.
public func nameInLine(_ name: String) -> String {
    let lowered = name.dropFirst(4).first.map(\.isLowercase) == true && name.hasPrefix("The ")
    return lowered || name.hasPrefix("This ") ? "t" + name.dropFirst() : name
}

/// A computer's name opening a sentence: its first letter raised ("box" starts a line as "Box").
public func nameAtStart(_ name: String) -> String {
    guard let first = name.first else { return name }
    return first.uppercased() + name.dropFirst()
}

/// One tone rule for every dot that means "a host's link", the desktop's
/// `hostTone` (src/renderer/src/lib/threadMove.ts): five tones, then the
/// relay's three over an open lane for a host the box relays (Home's and the
/// Hosts list's dot). The app gives each its colour (Hosts/HostDot.swift).
public enum HostTone: Sendable, Equatable {
    /// Open and fresh.
    case fresh
    /// Open, not yet re-listed.
    case stale
    /// Connecting, reconnecting, suspended.
    case busy
    /// Offline.
    case away
    /// The key was refused.
    case refused
    /// Relayed and open: its screen is locked.
    case locked
    /// Relayed and open: it sleeps.
    case asleep
    /// Relayed and open: the box cannot reach it.
    case unreachable

    public init(_ status: EnvironmentStatus) {
        switch status.transport {
        case .open: self = status.fresh ? .fresh : .stale
        case .connecting, .reconnecting, .suspended: self = .busy
        case .offline: self = .away
        case .unauthorized: self = .refused
        }
    }

    /// The link's own tone, overridden by the relay's state only while the lane to the box is open.
    public init(_ status: EnvironmentStatus, relay: RelayState?) {
        guard status.transport == .open, let relay else { self.init(status); return }
        switch relay {
        case .locked: self = .locked
        case .asleep: self = .asleep
        case .unreachable: self = .unreachable
        case .available: self.init(status)
        }
    }
}

/// `env_Ab3k…9xQz`: the id's prefix, its first four and last four characters.
/// Long enough to tell two hosts apart, short enough for a row's trailing edge.
/// An id whose body is ten characters or fewer is left whole.
public func abbreviatedEnvironmentId(_ id: String) -> String {
    let prefix = "env_"
    let body = id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
    guard body.count > 10 else { return id }
    return "\(id.hasPrefix(prefix) ? prefix : "")\(body.prefix(4))…\(body.suffix(4))"
}

/// A sentence from the package's lowercase fragments ("that is not a pairing
/// link"): trimmed, capitalised, with a full stop unless it already ends one
/// way or another. Empty stays empty.
public func sentence(_ fragment: String) -> String {
    let trimmed = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.first else { return trimmed }
    let capitalised = first.uppercased() + trimmed.dropFirst()
    return capitalised.last.map { ".!?".contains($0) } == true ? capitalised : capitalised + "."
}

/// The one action that helps a computer in a given state, and the sentence
/// under it that says what to do. A new sign-in when the key or the
/// computer's identity is wrong, a retry when it is out of reach, nothing
/// while it is connected, on its first attempt, suspended, or needs an
/// update this app cannot do. The status row above already says the state,
/// so the footer never says it again.
public enum HostFix: Sendable, Hashable {
    case retry
    case pairAgain

    public var title: String {
        switch self {
        case .retry: "Retry Now"
        case .pairAgain: "Sign In Again"
        }
    }

    /// - Parameter environment: a relayed host has no fix of its own: the box
    ///   retries the link and the lane retries itself.
    public static func fix(for status: EnvironmentStatus, environment: PairedEnvironment? = nil) -> HostFix? {
        if environment?.isRelayed == true { return nil }
        return switch status.transport {
        case .unauthorized: .pairAgain
        case .reconnecting: .retry
        case .offline:
            switch status.halt {
            case .identityChanged?: .pairAgain
            case .contractMismatch?: nil
            case nil: .retry
            }
        case .connecting: status.attempts > 0 ? .retry : nil
        case .open, .suspended: nil
        }
    }

    /// The footer under the status row: what the phone does on its own, or
    /// what is his to do. Nothing when connected or while it reconnects.
    public static func explanation(for status: EnvironmentStatus) -> String? {
        switch status.transport {
        case .open, .suspended: nil
        case .connecting, .reconnecting: status.attempts > 0 ? "The phone keeps trying on its own." : nil
        case .offline:
            switch status.halt {
            case .identityChanged?: "Sign in again to trust it."
            case .contractMismatch(let app, let host)?: host > app ? "Update this app to talk to it." : "Update it to talk to this app."
            case nil: "The phone tries again when the network returns."
            }
        case .unauthorized: SignInWords.refusedKeyHint
        }
    }

    /// Destructive only when the state waits on the person: the key was
    /// refused, the address answers as another host, or the contract needs
    /// an update. Offline and unreachable are the phone's to fix, so they
    /// stay secondary.
    public static func waitsOnUser(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .unauthorized: true
        case .offline: status.halt != nil
        case .connecting, .reconnecting, .open, .suspended: false
        }
    }
}

/// The host's version row in the detail: `1.0.273 (5edeb5d)`, the way
/// Apple's About rows put a build after its version, or the
/// version alone when the hello carried no commit. `release` repeats the
/// version and `platform` is the deploy line's, so neither is shown.
public enum HostBuildLine {
    public static func text(_ build: BuildFacts) -> String {
        text(version: build.version, sha: build.sha)
    }

    /// The same line from the fields alone (a relayed host's presence carries its build under another type).
    public static func text(version: String, sha: String?) -> String {
        guard let sha, !sha.isEmpty else { return version }
        return "\(version) (\(sha.prefix(7)))"
    }
}

/// The detail's Notifications row: what this one host holds of the phone's
/// push registration, from the registrar's switch, its last failure for the
/// host and the host's own status.
public enum HostPushWord {
    public static func text(enabled: Bool, failure: String?, status: PushStatus?) -> String {
        guard enabled else { return "Off" }
        if failure != nil { return "Failed" }
        guard let status, status.registered else { return "Not registered" }
        switch status.relay {
        case .ok: return "On"
        case .none: return "No relay"
        case .failed: return "Failed"
        case .unknown: return "Registered"
        }
    }
}

/// What a key may do on its computer, as the desktop's "It may" says it
/// (src/renderer/src/surfaces/settings/computers/addWords.ts
/// `allowChoices`): four levels, each the one before and more, so a key
/// holds exactly one.
public enum KeyRights: Int, CaseIterable, Sendable, Hashable {
    case look
    case run
    case approve
    case manage

    /// The level a key's capabilities come to (`mayWords` on the desktop).
    public static func of(_ caps: [Capability]) -> KeyRights {
        if caps.contains(.admin) { return .manage }
        if caps.contains(.approve) { return .approve }
        if caps.contains(.operate) { return .run }
        return .look
    }

    /// `computer` is the computer's name, as the last level says it.
    public func title(computer: String) -> String {
        switch self {
        case .look: "Look only"
        case .run: "Run threads"
        case .approve: "Run threads and approve"
        case .manage: "Manage \(nameInLine(computer))"
        }
    }

    public func detail(computer: String) -> String {
        switch self {
        case .look: "Read threads and files"
        case .run: "Start, steer and stop threads"
        case .approve: "Also answer when a thread asks before a risky step"
        case .manage: "Everything above, and add devices and change every setting on \(nameInLine(computer))"
        }
    }
}

/// The two capabilities a key may hold beside its level, never implied by
/// it: setting other computers up, and being a computer set up that way.
public extension Capability {
    /// `give` and `device` on a key that holds them, never `pending`.
    static func extras(holding caps: [Capability]) -> [Capability] {
        [Capability.give, .device].filter(caps.contains)
    }

    var title: String {
        switch self {
        case .read: "Look only"
        case .operate: "Run threads"
        case .approve: "Approve"
        case .admin: "Manage"
        case .give: "Set up other computers"
        case .device: "Set up from another computer"
        case .pending: "Waiting to be allowed"
        case .unknown(let raw): raw.capitalized
        }
    }

    /// One line on what the capability lets the phone do.
    var detail: String {
        switch self {
        case .read: "Read threads and files"
        case .operate: "Start, steer and stop threads"
        case .approve: "Answer when a thread asks before a risky step"
        case .admin: "Add devices and change every setting"
        case .give: "Give accounts to computers and set them up"
        case .device: "Its accounts came from the computer that set it up"
        case .pending: "Set up, until the giver allows it"
        case .unknown: "Not known to this app"
        }
    }
}

/// The Forget dialog's message for a carrier: what this phone drops and what
/// the computer keeps (the plan's section 5), then the computers relayed
/// through it that go with it, by name ("Studio Mac goes with it.", "Studio
/// Mac and Office Mac go with it.").
public func forgetCopy(carrier: String, relayed: [String]) -> String {
    let inLine = nameInLine(carrier)
    let base = "This phone drops its key and stops getting \(inLine)’s notifications. Its threads stay there, and \(inLine) still lets this phone in until the key is removed there."
    guard !relayed.isEmpty else { return base }
    let names: String
    if relayed.count == 1 {
        names = relayed[0]
    } else {
        names = relayed.dropLast().joined(separator: ", ") + " and " + relayed[relayed.count - 1]
    }
    return "\(base) \(names) \(relayed.count == 1 ? "goes" : "go") with it."
}

/// Forgetting a computer: drop its push registration there while the socket is
/// open (best effort, no retry: the key stays valid on the host, so a
/// registration left behind would keep sending notices for an environment
/// the phone no longer knows), then remove the key here. The removal stops
/// the socket, forgets the registrar's state and clears the cache. A host
/// relayed through this one goes with it (`ClientRegistry.remove`).
@MainActor
public func forgetHost(_ id: String, registry: ClientRegistry) async {
    if registry.push.enabled, let client = registry.client(id), await client.socket.isOpen {
        _ = try? await client.request(Methods.RemotePushUnregister.self, .init())
    }
    await registry.remove(id)
}
