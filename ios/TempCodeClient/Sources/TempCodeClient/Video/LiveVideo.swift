import Foundation
import Observation
import TempCodeContract

/// One live stream on the phone (docs/agents/live-video.md "The viewer"): `video.open` on the host the thread is on,
/// the stream's own socket beside the RPC socket, its frames through `VideoPlayerCore` into a display layer, and the
/// retry rule when it closes. It runs between `start` and `stop`: the view starts it while its picture is on screen and
/// the app is active, and stops it otherwise (`video.close`). The list's picture and its full screen play the same one:
/// `want` opens it again only when the full screen needs what the open it has cannot give (a turn of the phone, the
/// display taken, a stream he drives).
@MainActor @Observable
public final class LiveVideo {
    public enum Phase: Equatable, Sendable {
        case idle
        case opening
        case playing
        /// `video.open` said no: the reason, as the host gave it
        case refused(VideoOpenAnswer.Reason?)
        /// the stream is over: what shows in its place, and whether Retry is offered
        case over(VideoFace, retry: Bool)
    }

    /// What `video.open` said: a stream and its ticket, or why not.
    public enum Answer: Sendable {
        case opened(Opened)
        case refused(VideoOpenAnswer.Reason?)
    }

    /// What one `video.open` asks for.
    public struct Ask: Equatable, Sendable {
        public var threadId: String
        public var maxEdge: Int
        /// the box's one display, when another page holds it
        public var take = false
        /// a stream his input goes down, given only while he is the driver
        public var drive = false

        public init(threadId: String, maxEdge: Int, take: Bool = false, drive: Bool = false) {
            self.threadId = threadId
            self.maxEdge = maxEdge
            self.take = take
            self.drive = drive
        }
    }

    public struct Opened: Sendable {
        public let stream: String
        public let ticket: String
        public init(stream: String, ticket: String) {
            self.stream = stream
            self.ticket = ticket
        }
    }

    public private(set) var phase: Phase = .idle
    /// frames shown since `start`
    public private(set) var frames = 0
    /// the picture's size, from the last frame shown
    public private(set) var width = 0
    public private(set) var height = 0
    /// what the open that runs now asked for; nil before the first
    public private(set) var asked: Ask?
    public let threadId: String

    @ObservationIgnored private let open: (Ask) async throws -> Answer
    @ObservationIgnored private let close: (String) async -> Void
    @ObservationIgnored private let pasteText: (String, String) async throws -> Void
    @ObservationIgnored private let rpcURL: () -> URL
    @ObservationIgnored private let socket: VideoStreamSocketFactory
    @ObservationIgnored private let sleep: (Int) async -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var live: (any VideoStreamSocket)?
    @ObservationIgnored private var stream: String?
    @ObservationIgnored private var sink: (any VideoSampleSink)?
    /// the socket's one ordered sender, acks and his input alike, while a socket plays
    @ObservationIgnored private var outbound: AsyncStream<Data>.Continuation?
    /// the generation the last frame said: his input is numbered with it
    @ObservationIgnored private var generation: UInt32 = 0
    /// counts each socket's play, so an old one ending never takes the sender of the one after it
    @ObservationIgnored private var plays = 0

    /// `open` asks `video.open`; `close` sends `video.close`; `paste` sends `video.paste` (a stream and the text);
    /// `rpcURL` is the RPC socket's address.
    public init(
        threadId: String = "",
        open: @escaping (Ask) async throws -> Answer,
        close: @escaping (String) async -> Void,
        paste: @escaping (String, String) async throws -> Void = { _, _ in },
        rpcURL: @escaping () -> URL,
        socket: @escaping VideoStreamSocketFactory = URLSessionVideoSocket.factory,
        sleep: @escaping (Int) async -> Void = { ms in try? await Task.sleep(for: .milliseconds(ms)) }
    ) {
        self.threadId = threadId
        self.open = open
        self.close = close
        pasteText = paste
        self.rpcURL = rpcURL
        self.socket = socket
        self.sleep = sleep
    }

    /// A stream of `threadId`'s computer on the client's host. A relayed host's stream rides the carrier's socket, as
    /// its RPC does: the address comes from the connection the RPC rides.
    public convenience init(client: EnvironmentClient, threadId: String) {
        self.init(
            threadId: threadId,
            open: { [weak client] ask in
                guard let client else { throw CancellationError() }
                let params = Methods.VideoOpen.Params(threadId: ask.threadId, maxEdge: ask.maxEdge, take: ask.take ? true : nil, drive: ask.drive ? true : nil)
                let answer = try await client.request(Methods.VideoOpen.self, params)
                guard answer.ok, let stream = answer.stream, let ticket = answer.ticket else { return .refused(answer.reason) }
                return .opened(Opened(stream: stream, ticket: ticket))
            },
            close: { [weak client] stream in _ = try? await client?.request(Methods.VideoClose.self, .init(stream: stream)) },
            paste: { [weak client] stream, text in
                guard let client else { return }
                _ = try await client.request(Methods.VideoPaste.self, .init(stream: stream, text: text))
            },
            rpcURL: { [weak client] in client?.environment.socketURL ?? URL(string: "ws://localhost")! }
        )
    }

    public var isRunning: Bool { task != nil }

    /// Plays into `sink` at most `maxEdge` on the long edge, from a fresh `video.open`, until `stop` or the stream is over.
    public func start(sink: any VideoSampleSink, maxEdge: Int, take: Bool = false, drive: Bool = false) {
        guard task == nil else { return }
        frames = 0
        begin(Ask(threadId: asked?.threadId ?? threadId, maxEdge: maxEdge, take: take, drive: drive), sink: sink)
    }

    /// What a place that shows the stream needs now; the stream is opened again only when the open it has cannot give
    /// it (`reopens`). Handing back needs no new open: the host makes his stream a watch stream.
    public func want(_ ask: Ask) {
        if var asked, asked.drive, !ask.drive {
            asked.drive = false
            self.asked = asked
        }
        guard let sink, Self.reopens(asked: asked, want: ask, phase: phase) else { return }
        end()
        begin(ask, sink: sink)
    }

    /// Whether a place that wants `want` needs a new `video.open`, given what the one before asked and where it is now.
    /// Taking over always does: a watch stream is never made one that takes input. A stream refused or closed because
    /// the display shows another page does when the place asks to take it. One that plays does at another size (the
    /// phone turned) or for another thread (Take Over moved the page's row to its pane's thread).
    public static func reopens(asked: Ask?, want: Ask, phase: Phase) -> Bool {
        guard let asked else { return false }
        if want.drive, !asked.drive { return true }
        switch phase {
        case .refused(.busy?), .over(.picture, _):
            return want.take && !asked.take
        case .refused, .over:
            return false
        case .idle, .opening, .playing:
            return want.maxEdge != asked.maxEdge || want.threadId != asked.threadId
        }
    }

    /// One of his input records, on a stream he drives that shows frames; nothing goes before the first frame has
    /// said its generation.
    public func input(_ record: InputRecord) {
        guard asked?.drive == true, phase == .playing, generation != 0, let outbound else { return }
        outbound.yield(NSL1.encodeInput(record, generation: generation))
    }

    /// His text into the page he drives (`video.paste`).
    public func paste(_ text: String) async throws {
        guard asked?.drive == true, let stream, !text.isEmpty else { return }
        try await pasteText(stream, text)
    }

    private func begin(_ ask: Ask, sink: any VideoSampleSink) {
        asked = ask
        self.sink = sink
        task = Task { [weak self] in await self?.run(sink: sink) }
    }

    /// Closes the stream and its socket; the view left the screen, or the app went to the background.
    public func stop() {
        end()
        if case .over = phase {} else if case .refused = phase {} else { phase = .idle }
    }

    private func end() {
        outbound = nil
        task?.cancel()
        task = nil
        live?.cancel()
        live = nil
        if let stream {
            self.stream = nil
            Task { [close] in await close(stream) }
        }
    }

    private func run(sink: any VideoSampleSink) async {
        var tries = 0
        while !Task.isCancelled {
            phase = .opening
            let opened: Opened
            do {
                guard let ask = asked else { return }
                switch try await open(ask) {
                case .opened(let value): opened = value
                case .refused(let reason):
                    // a later open took this one's place while it was asked
                    if Task.isCancelled { return }
                    phase = .refused(reason)
                    task = nil
                    return
                }
            } catch {
                if Task.isCancelled { return }
                phase = .over(.stopped, retry: true)
                task = nil
                return
            }
            if Task.isCancelled {
                await close(opened.stream)
                return
            }
            guard let url = VideoRules.streamURL(rpc: rpcURL(), stream: opened.stream, ticket: opened.ticket) else {
                phase = .over(.stopped, retry: true)
                task = nil
                return
            }
            stream = opened.stream
            let (shown, code, fault) = await play(url: url, sink: sink)
            if Task.isCancelled { return }
            if let stream {
                self.stream = nil
                await close(stream)
            }
            // a frame shown since the last open starts the count again
            if shown > 0 { tries = 0 }
            switch VideoRules.afterClose(code: code, fault: fault, tries: tries) {
            case .again(let delayMs):
                tries += 1
                phase = .opening
                await sleep(delayMs)
            case .over(let face, let retry):
                phase = .over(face, retry: retry)
                task = nil
                return
            }
        }
    }

    /// One socket's life: frames in, acks out in the order they were made, the stall check every quarter second.
    /// Answers how many frames it showed, the socket's close code (0 for one that named none) and the player's fault.
    private func play(url: URL, sink: any VideoSampleSink) async -> (shown: Int, code: Int, fault: VideoFault?) {
        let socket = self.socket(url)
        live = socket
        let (acks, ackOut) = AsyncStream<Data>.makeStream()
        let sender = Task { for await ack in acks { try? await socket.send(ack) } }
        plays += 1
        let play = plays
        outbound = ackOut
        generation = 0
        let started = ContinuousClock.now
        let now = {
            let (seconds, attoseconds) = started.duration(to: .now).components
            return Double(seconds) * 1_000 + Double(attoseconds) / 1e15
        }
        let player = VideoPlayerCore(sink: sink, send: { ackOut.yield($0) }, now: now)
        let watch = Task { @MainActor [weak socket] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                if player.check() != nil { socket?.cancel() }
            }
        }
        defer {
            if plays == play { outbound = nil }
            watch.cancel()
            ackOut.finish()
            sender.cancel()
        }
        var fault: VideoFault?
        do {
            while !Task.isCancelled {
                let data = try await socket.receive()
                if let failed = player.receive(data) {
                    fault = failed
                    socket.cancel()
                    break
                }
                frames += 1
                generation = player.generation
                width = player.size?.width ?? width
                height = player.size?.height ?? height
                if phase != .playing { phase = .playing }
            }
        } catch {}
        if fault == nil, let stalled = player.fault { fault = stalled }
        if live === socket { live = nil }
        return (player.frames, fault == nil ? (socket.closeCode ?? 0) : 0, fault)
    }
}
