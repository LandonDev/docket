import Foundation

/// The socket of one live stream (docs/agents/live-video.md "The socket"): `/video/<stream>?ticket=…` on the host the
/// RPC socket is on (`VideoRules.streamURL`), subprotocol `nsl1`, binary messages in and acks out. Nothing else rides
/// it. `URLSessionVideoSocket` is the real one; the tests hand in a scripted fake.
public protocol VideoStreamSocket: AnyObject, Sendable {
    func send(_ data: Data) async throws
    /// The next binary message; throws when the socket is gone.
    func receive() async throws -> Data
    func cancel()
    /// The close code the host sent, once it has; nil for a drop that named none.
    var closeCode: Int? { get }
}

public typealias VideoStreamSocketFactory = @Sendable (URL) -> any VideoStreamSocket

public final class URLSessionVideoSocket: VideoStreamSocket {
    private let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession = URLSessionWebSocket.defaultSession) {
        task = session.webSocketTask(with: url, protocols: [NSL1.subprotocol])
        task.maximumMessageSize = NSL1.maxMessageBytes
        task.resume()
    }

    public static let factory: VideoStreamSocketFactory = { url in URLSessionVideoSocket(url: url) }

    public func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    public func receive() async throws -> Data {
        switch try await task.receive() {
        case .data(let data): return data
        // the wire is binary only: a text message is a broken stream
        case .string: throw NSL1.Malformed(description: "a text message on a stream's socket")
        @unknown default: throw NSL1.Malformed(description: "an unknown message on a stream's socket")
        }
    }

    public func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    public var closeCode: Int? {
        task.closeCode == .invalid ? nil : task.closeCode.rawValue
    }
}
