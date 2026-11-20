import CoreMedia
import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A stream's socket that plays scripted messages, then closes with a code (nil: a drop that named none).
private final class ScriptedSocket: VideoStreamSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [Data]
    private let code: Int?
    private var sentAcks: [Data] = []
    private var cancelled = false
    let url: URL

    init(url: URL, messages: [Data], code: Int?) {
        self.url = url
        queue = messages
        self.code = code
    }

    var acks: [Data] { lock.withLock { sentAcks } }

    func send(_ data: Data) async throws { lock.withLock { sentAcks.append(data) } }

    func receive() async throws -> Data {
        await Task.yield()
        let next: Data? = lock.withLock { cancelled || queue.isEmpty ? nil : queue.removeFirst() }
        guard let next else { throw URLError(.networkConnectionLost) }
        return next
    }

    func cancel() { lock.withLock { cancelled = true } }
    var closeCode: Int? { code }
}

/// A value the socket factory (a `@Sendable` closure) writes, read by the test.
private final class Held<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ value: T) { stored = value }
    var value: T {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private final class Layer: VideoSampleSink {
    var enqueued = 0
    func enqueue(_ sample: CMSampleBuffer) -> Bool { enqueued += 1; return true }
    func flush() {}
}

@MainActor
@Suite struct LiveVideoTests {
    private func until(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    @Test func `opens, plays the box's frames on the stream's own socket, acks each in order, and closes with video.close`() async throws {
        let messages = try BoxStream.messages()
        let sockets = Held<[ScriptedSocket]>([])
        var closed: [String] = []
        let video = LiveVideo(
            open: { _ in .opened(.init(stream: "s1", ticket: "tk")) },
            close: { closed.append($0) },
            rpcURL: { URL(string: "wss://box.example/ws?ticket=old&host=env_x")! },
            socket: { url in
                let socket = ScriptedSocket(url: url, messages: Array(messages.prefix(30)), code: 4100)
                sockets.value.append(socket)
                return socket
            }
        )
        let layer = Layer()
        video.start(sink: layer, maxEdge: 1280)
        await until { video.phase == .over(.stopped, retry: false) }
        #expect(video.phase == .over(.stopped, retry: false)) // the host ended it: ended never opens again
        #expect(video.frames == 30 && layer.enqueued == 30)
        #expect(video.width == 1280 && video.height == 800)
        #expect(sockets.value.count == 1)
        let socket = try #require(sockets.value.first)
        #expect(socket.url.absoluteString == "wss://box.example/video/s1?ticket=tk")
        await until { socket.acks.count == 30 }
        #expect(socket.acks.map { Int($0[14]) << 8 | Int($0[15]) } == Array(1...30))
        #expect(closed == ["s1"])
    }

    @Test func `a drop that named no reason opens again with a fresh video.open, and gives way after five`() async throws {
        let messages = try BoxStream.messages()
        let opens = Held(0)
        var waits: [Int] = []
        let video = LiveVideo(
            open: { _ in opens.value += 1; return .opened(.init(stream: "s\(opens.value)", ticket: "t")) },
            close: { _ in },
            rpcURL: { URL(string: "ws://127.0.0.1:4123")! },
            // the first socket shows frames, the rest drop at once
            socket: { url in ScriptedSocket(url: url, messages: opens.value == 1 ? Array(messages.prefix(3)) : [], code: nil) },
            sleep: { waits.append($0) }
        )
        video.start(sink: Layer(), maxEdge: 1280)
        await until { video.phase == .over(.picture, retry: false) }
        #expect(video.phase == .over(.picture, retry: false))
        // the first open showed frames, so its drop starts the count: five more opens, then the picture
        #expect(opens.value == 6)
        #expect(waits == [500, 1_000, 2_000, 4_000, 4_000])
    }

    @Test func `a refused open says why and opens nothing`() async {
        let made = Held(0)
        let video = LiveVideo(open: { _ in .refused(.off) }, close: { _ in }, rpcURL: { URL(string: "ws://h")! }, socket: { url in made.value += 1; return ScriptedSocket(url: url, messages: [], code: nil) })
        video.start(sink: Layer(), maxEdge: 1280)
        await until { video.phase == .refused(.off) }
        #expect(video.phase == .refused(.off))
        #expect(made.value == 0)
    }

    @Test func `stop closes the socket and sends video.close`() async throws {
        let messages = try BoxStream.messages()
        var closed: [String] = []
        let socket = Held<ScriptedSocket?>(nil)
        let video = LiveVideo(
            open: { _ in .opened(.init(stream: "s9", ticket: "t")) },
            close: { closed.append($0) },
            rpcURL: { URL(string: "ws://h")! },
            socket: { url in
                let made = ScriptedSocket(url: url, messages: messages, code: nil)
                socket.value = made
                return made
            }
        )
        video.start(sink: Layer(), maxEdge: 1280)
        await until { video.frames > 5 }
        video.stop()
        await until { closed == ["s9"] }
        #expect(closed == ["s9"])
        #expect(video.phase == .idle)
        #expect(socket.value != nil)
    }
}
