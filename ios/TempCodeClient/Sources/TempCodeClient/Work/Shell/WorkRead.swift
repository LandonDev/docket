import Foundation

/// One read on a Work screen that has already drawn: still out, its answer,
/// or why it failed. A failure is never drawn as empty ("None" where the
/// read never came back); the screen shows the reason with Retry.
public enum WorkRead<Value: Sendable>: Sendable {
    case reading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    public var failure: String? {
        if case .failed(let message) = self { return message }
        return nil
    }

    /// The read's answer, or its error in the words a screen shows.
    public static func of(_ read: () async throws -> Value) async -> WorkRead<Value> {
        do { return .loaded(try await read()) } catch { return .failed(ActionError.wrap(error).message) }
    }
}

extension WorkRead: Equatable where Value: Equatable {}

public enum GuestLinksRead {
    /// Only the host that serves LifeOS's documents keeps guest links; the
    /// others answer `served elsewhere: <env>`, which means no section, not a
    /// failed read.
    public static func servedElsewhere(_ message: String) -> Bool {
        message.contains("served elsewhere")
    }
}
