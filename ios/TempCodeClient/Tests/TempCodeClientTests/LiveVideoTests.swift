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
    /// once the messages are out it stays open, as a still page's stream does, until it is cancelled
    private let hold: Bool
    private var sentAcks: [Data] = []
    private var cancelled = false
    let url: URL

    init(url: URL, messages: [Data], code: Int?, hold: Bool = false) {
        self.url = url
        queue = messages
        self.code = code
        self.hold = hold
    }

    var acks: [Data] { lock.withLock { sentAcks } }

    func send(_ data: Data) async throws { lock.withLock { sentAcks.append(data) } }

    func receive() async throws -> Data {
        await Task.yield()
        while hold, lock.withLock({ !cancelled && queue.isEmpty }) { try await Task.sleep(for: .milliseconds(5)) }
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

    @Test func `the full screen opens again only for a turn, the display, his wheel or the page's new thread`() {
        let list = LiveVideo.Ask(threadId: "t1", maxEdge: 1_088)
        var full = list
        full.take = true
        // a tap: the same stream, though the full screen asks to take the display
        #expect(!LiveVideo.reopens(asked: list, want: full, phase: .playing))
        // he turns the phone: the picture's new size
        var turned = full
        turned.maxEdge = 2_560
        #expect(LiveVideo.reopens(asked: list, want: turned, phase: .playing))
        // the display showed another page: the list's open did not take it, the full screen's does
        #expect(LiveVideo.reopens(asked: list, want: full, phase: .refused(.busy)))
        #expect(LiveVideo.reopens(asked: list, want: full, phase: .over(.picture, retry: false)))
        #expect(!LiveVideo.reopens(asked: full, want: full, phase: .refused(.busy)))
        #expect(!LiveVideo.reopens(asked: list, want: full, phase: .refused(.off)))
        #expect(!LiveVideo.reopens(asked: list, want: full, phase: .over(.stopped, retry: true)))
        // Take Over: a watch stream never takes input, so a drive stream is asked for, for the pane's thread
        var drive = full
        drive.drive = true
        drive.threadId = "pane"
        #expect(LiveVideo.reopens(asked: full, want: drive, phase: .playing))
        #expect(!LiveVideo.reopens(asked: drive, want: drive, phase: .playing))
        #expect(!LiveVideo.reopens(asked: nil, want: drive, phase: .idle))
    }

    @Test func `his input goes down the socket he drives, numbered with the frame's generation, and paste through video.paste`() async throws {
        let messages = try BoxStream.messages()
        let sockets = Held<[ScriptedSocket]>([])
        var asks: [LiveVideo.Ask] = []
        var pasted: [String] = []
        let video = LiveVideo(
            threadId: "t1",
            open: { ask in asks.append(ask); return .opened(.init(stream: "s\(asks.count)", ticket: "t")) },
            close: { _ in },
            paste: { stream, text in pasted.append("\(stream):\(text)") },
            rpcURL: { URL(string: "ws://h")! },
            socket: { url in
                let made = ScriptedSocket(url: url, messages: Array(messages.prefix(20)), code: nil, hold: true)
                sockets.value.append(made)
                return made
            }
        )
        let layer = Layer()
        video.start(sink: layer, maxEdge: 1_088)
        await until { video.frames > 3 }
        // a watch stream takes none of it
        video.input(.move(0.5, 0.5))
        try await video.paste("hello")
        #expect(pasted.isEmpty)
        let shown = video.frames
        video.want(.init(threadId: "pane", maxEdge: 1_088, take: true, drive: true))
        await until { sockets.value.count == 2 && video.phase == .playing }
        #expect(asks.map(\.drive) == [false, true])
        #expect(asks.last?.threadId == "pane" && asks.last?.take == true)
        // the picture is kept: the count goes on, so no spinner covers it
        #expect(video.frames >= shown)
        video.input(.move(0.5, 0.5))
        let socket = sockets.value[1]
        await until { socket.acks.contains { $0[5] == 3 } }
        let input = try #require(socket.acks.first { $0[5] == 3 })
        // the generation the box's recording starts at, then the record's own bytes
        #expect(input.count == 36 && input[8...11] == Data([0, 0, 0, 1]) && input[20] == 3)
        try await video.paste("hello")
        #expect(pasted == ["s2:hello"])
        // Hand Back: no new open, and nothing more goes down
        video.want(.init(threadId: "pane", maxEdge: 1_088, take: true))
        #expect(asks.count == 2)
        try await video.paste("again")
        #expect(pasted == ["s2:hello"])
        video.stop()
    }
}
