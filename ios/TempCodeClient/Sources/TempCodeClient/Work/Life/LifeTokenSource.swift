import Foundation
import TempCodeContract

/// Keeps one workspace's token and asks the host for another when it is spent.
@MainActor
public final class LifeTokenSource {
    private let socket: TempCodeSocket
    private let sector: String?
    private let now: () -> Int
    private var token: LifeToken?

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
        if !force, let token, token.usable(now: now()) { return token }
        let answer = try await socket.request(Methods.WorkLifeosJwt.self, .init(sector: sector))
        let fresh = try LifeToken.from(answer)
        token = fresh
        return fresh
    }

    public func forget() { token = nil }
}
