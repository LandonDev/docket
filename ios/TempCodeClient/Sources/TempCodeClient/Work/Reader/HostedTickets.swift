import Foundation

/// The hosted editor's tickets, asked early and used once (the phone's reader, PF2). A ticket opens `/w/open`
/// once within two minutes, so the request starts the moment he opens a document, while the page is still
/// being pushed, and the web view takes it when it is ready. A view the push builds twice asks once.
@MainActor
public final class HostedTickets {
    /// A ticket older than this is asked again: the host ends one at two minutes.
    public static let fresh: TimeInterval = 90

    private struct Held {
        var task: Task<String, any Error>
        var at: Date
    }

    private var held: [String: Held] = [:]
    private let now: () -> Date

    public init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// Starts the request for a file's ticket, unless one asked a moment ago still waits to be used.
    public func warm(_ key: String, ask: @escaping @MainActor () async throws -> String) {
        if let waiting = held[key], now().timeIntervalSince(waiting.at) < Self.fresh { return }
        held[key] = Held(task: Task { try await ask() }, at: now())
    }

    /// The ticket asked early, used once; else a new one. A request that failed is not kept: Try Again asks anew.
    public func take(_ key: String, ask: @escaping @MainActor () async throws -> String) async throws -> String {
        if let waiting = held.removeValue(forKey: key), now().timeIntervalSince(waiting.at) < Self.fresh {
            return try await waiting.task.value
        }
        return try await ask()
    }
}

/// What the owner's hosted page tells the phone it is open in (src/hosted/guest/phone.ts), through the web view's
/// message handler named `handler`.
public enum HostedNote: Equatable, Sendable {
    /// The page opened its file on its ticket.
    case opened
    /// The page's pass ended: a restart of the host forgets every pass, and the page cannot renew.
    case passEnded

    public static let handler = "tempcodeHosted"

    /// The message's body as WebKit hands it (`{kind}` as a dictionary); nil for anything else.
    public static func of(_ body: Any) -> HostedNote? {
        switch (body as? [String: Any])?["kind"] as? String {
        case "opened": .opened
        case "passEnded": .passEnded
        default: nil
        }
    }
}

/// Whether a hosted page whose pass ended opens again in place on a new ticket. Once in a row: a page that ends again
/// before it has opened shows its own words, so a host that keeps refusing is not asked for ever; a page that opened
/// may rejoin at the next end. A pass that ends while the screen is not forward waits for it to come forward, so no
/// ticket is spent where he cannot see it.
public struct HostedRejoin: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        /// Ask a new ticket and load it now.
        case rejoin
        /// Rejoin when the screen comes forward (`cameForward`).
        case wait
        /// Leave the page as it is.
        case stay
    }

    private var tried = false
    private var waiting = false

    public init() {}

    public mutating func heard(_ note: HostedNote, forward: Bool) -> Step {
        switch note {
        case .opened:
            tried = false
            waiting = false
            return .stay
        case .passEnded:
            guard !tried else { return .stay }
            guard forward else {
                waiting = true
                return .wait
            }
            tried = true
            return .rejoin
        }
    }

    /// The screen came forward: true when a page that ended meanwhile rejoins now.
    public mutating func cameForward() -> Bool {
        guard waiting, !tried else { return false }
        waiting = false
        tried = true
        return true
    }
}
