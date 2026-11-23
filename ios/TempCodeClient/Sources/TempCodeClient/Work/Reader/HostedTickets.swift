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
