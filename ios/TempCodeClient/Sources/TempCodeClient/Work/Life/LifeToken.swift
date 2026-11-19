import Foundation
import TempCodeContract

/// The JWT a Work workspace's LifeOS screens use (milestone 47): the host
/// signs it (`work.lifeos.jwt`), narrowed to the workspace's sector, so the
/// phone never signs in to LifeOS itself. One answer is used until five
/// minutes before it runs out, or until LifeOS refuses it.
public struct LifeToken: Equatable, Sendable {
    public var jwt: String
    public var deployment: URL
    /// ms since 1970
    public var expiresAt: Int

    public static let margin = 5 * 60 * 1000

    public func usable(now: Int) -> Bool { expiresAt - now > Self.margin }

    public enum Refusal: Error, Equatable {
        /// The host is not signed in to LifeOS, or cannot reach it: the state's name.
        case host(String)
        case malformed
    }

    /// The host's answer, or why there is none.
    public static func from(_ answer: Methods.WorkLifeosJwt.Output) throws -> LifeToken {
        guard answer.ok else { throw Refusal.host(answer.state ?? "signedOut") }
        guard let jwt = answer.jwt, let url = answer.url.flatMap(URL.init(string:)), let expiresAt = answer.expiresAt else { throw Refusal.malformed }
        return LifeToken(jwt: jwt, deployment: url, expiresAt: expiresAt)
    }
}
