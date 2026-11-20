import Foundation
import Observation
import TempCodeContract

/// One live stream on the phone (docs/agents/live-video.md "The viewer"): `video.open` on the host the thread is on,
/// the stream's own socket beside the RPC socket, its frames through `VideoPlayerCore` into a display layer, and the
/// retry rule when it closes. It runs between `start` and `stop`: the view starts it while its picture is on screen and
/// the app is active, and stops it otherwise (`video.close`).
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

    @ObservationIgnored private let open: (Int) async throws -> Answer
    @ObservationIgnored private let close: (String) async -> Void
    @ObservationIgnored private let rpcURL: () -> URL
    @ObservationIgnored private let socket: VideoStreamSocketFactory
    @ObservationIgnored private let sleep: (Int) async -> Void
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var live: (any VideoStreamSocket)?
    @ObservationIgnored private var stream: String?

    /// `open` asks `video.open` at a long edge; `close` sends `video.close`; `rpcURL` is the RPC socket's address.
    public init(
        open: @escaping (Int) async throws -> Answer,
        close: @escaping (String) async -> Void,
        rpcURL: @escaping () -> URL,
        socket: @escaping VideoStreamSocketFactory = URLSessionVideoSocket.factory,
        sleep: @escaping (Int) async -> Void = { ms in try? await Task.sleep(for: .milliseconds(ms)) }
    ) {
        self.open = open
        self.close = close
        self.rpcURL = rpcURL
        self.socket = socket
        self.sleep = sleep
    }

    /// A stream of `threadId`'s computer on the client's host. A relayed host's stream rides the carrier's socket, as
    /// its RPC does: the address comes from the connection the RPC rides.
    public convenience init(client: EnvironmentClient, threadId: String) {
        self.init(
            open: { [weak client] edge in
                guard let client else { throw CancellationError() }
                let answer = try await client.request(Methods.VideoOpen.self, .init(threadId: threadId, maxEdge: edge))
                guard answer.ok, let stream = answer.stream, let ticket = answer.ticket else { return .refused(answer.reason) }
                return .opened(Opened(stream: stream, ticket: ticket))
            },
            close: { [weak client] stream in _ = try? await client?.request(Methods.VideoClose.self, .init(stream: stream)) },
            rpcURL: { [weak client] in client?.environment.socketURL ?? URL(string: "ws://localhost")! }
        )
    }

    public var isRunning: Bool { task != nil }

    /// Plays into `sink` at most `maxEdge` on the long edge, from a fresh `video.open`, until `stop` or the stream is over.
    public func start(sink: any VideoSampleSink, maxEdge: Int) {
        guard task == nil else { return }
        frames = 0
        task = Task { [weak self] in await self?.run(sink: sink, maxEdge: maxEdge) }
    }

    /// Closes the stream and its socket; the view left the screen, or the app went to the background.
    public func stop() {
        task?.cancel()
        task = nil
        live?.cancel()
        live = nil
        if let stream {
            self.stream = nil
            Task { [close] in await close(stream) }
        }
        if case .over = phase {} else if case .refused = phase {} else { phase = .idle }
    }

    private func run(sink: any VideoSampleSink, maxEdge: Int) async {
        var tries = 0
        while !Task.isCancelled {
            phase = .opening
            let opened: Opened
            do {
                switch try await open(maxEdge) {
                case .opened(let value): opened = value
                case .refused(let reason):
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
