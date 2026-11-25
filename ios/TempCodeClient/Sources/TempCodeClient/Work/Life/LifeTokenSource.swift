import Foundation
import TempCodeContract

/// Keeps one workspace's token and asks the host for another when it is spent.
@MainActor
public final class LifeTokenSource {
    private let socket: TempCodeSocket
    private let sector: String?
    private let now: () -> Int
    private var token: LifeToken?
    /// Moves when the session this source served ends (`forget`, `end`): an answer asked for before it is dropped,
    /// never cached or handed on.
    private var generation = 0
    /// The session's host lost its access (`end`): no token is asked for or given again.
    private var ended = false

    public init(client: EnvironmentClient, sector: String?, now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        socket = client.socket
        self.sector = sector
        self.now = now
    }

    init(socket: TempCodeSocket, sector: String?, now: @escaping () -> Int) {
        self.socket = socket
        self.sector = sector
        self.now = now
    }

    /// The last token the host gave, without asking.
    public var cached: LifeToken? { token }

    public func token(force: Bool) async throws -> LifeToken {
        if ended { throw CancellationError() }
        if !force, let token, token.usable(now: now()) { return token }
        let asked = generation
        let answer = try await socket.request(Methods.WorkLifeosJwt.self, .init(sector: sector))
        // The session ended while the host answered: the token belongs to no session now.
        guard asked == generation, !ended else { throw CancellationError() }
        let fresh = try LifeToken.from(answer)
        token = fresh
        return fresh
    }

    /// The session ended (a LifeOS sign-out): the token goes, and an answer still out is dropped. A later session may ask
    /// again.
    public func forget() {
        token = nil
        generation &+= 1
    }

    /// The host's access went: the token goes, an answer still out is dropped, and nothing is asked again.
    public func end() {
        forget()
        ended = true
    }
}
