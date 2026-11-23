import Foundation
import Observation

/// What a host cannot do yet (the phone's reader, PF1). Hosts and the phone
/// update at different times: a method an older host refuses as unknown is
/// remembered until the socket opens again, and the row that needs it is not
/// drawn. Never "Not built yet".
@MainActor @Observable
public final class HostCan {
    public private(set) var lacking: Set<String> = []

    public init() {}

    public func has(_ method: String) -> Bool { !lacking.contains(method) }

    /// Runs a call to `method`. A host that does not know the method answers nil, now and for the rest of
    /// the session without asking again; any other failure is thrown as it came.
    public func ask<T>(_ method: String, _ call: () async throws -> T) async throws -> T? {
        guard has(method) else { return nil }
        do {
            return try await call()
        } catch {
            guard Self.saysUnknown(error) else { throw error }
            lacking.insert(method)
            return nil
        }
    }

    /// The host refused `method` as unknown: it is not asked again until the socket opens anew.
    public func mark(_ method: String) { lacking.insert(method) }

    /// A new socket may be a newer host: everything is asked once more.
    public func connected() { lacking = [] }

    /// The host's refusal of a method its request schema does not list: the dispatch answers
    /// `bad request:` with zod's "No matching discriminator" on `method` (src/main/server/index.ts). A bad
    /// param of a method it knows names another path, and is a failure like any other.
    public static func saysUnknown(_ error: any Error) -> Bool {
        guard case TransportError.server(_, let message) = error else { return false }
        return saysUnknown(message)
    }

    static func saysUnknown(_ message: String) -> Bool {
        let text = message.lowercased()
        if text.contains("unknown method") { return true }
        guard text.hasPrefix("bad request") else { return false }
        return text.contains("no matching discriminator") || text.contains("invalid discriminator value")
    }
}
