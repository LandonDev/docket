import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// One video stream (docs/computer-protocol.md §30): the shell's side of one encoder. It paces the
/// capture's pictures to the stream's fps, keeps screen-relay's flow (frames sent and not acked, the
/// pause, the bitrate, the three seconds without an ack), sends a still picture again to sharpen it, and
/// writes each access unit to the bytes pipe as one record. Capture calls it on the window's queue, the
/// pipe's reader with acks, the shell's video clock with ticks; the lock orders them.
final class VideoStream: VideoOutput, @unchecked Sendable {
    let id: Int
    let session: String
    let windowID: UInt32
    let mode: VideoMode
    /// the window's capture this stream joined: its end and its hold are this one's, never a newer one's
    let entry: WindowVideoEntry

    private let lock = NSLock()
    private var flow = FlowControl()
    private var pacer: FramePacer
    private var still: StillWindow
    private var generation: UInt32 = 0
    /// pictures admitted and not yet encoded or dropped: they hold places in the flow's window
    private var reserved = 0
    private var bitrate: Int
    private var over = false
    private var toldTimeout = false
    /// no frame goes out until a keyframe: at the start, in a new generation, after a frame the flow refused
    private var needKey = true
    private var broken = false
    /// the picture's size now: the start size, then each sent frame's; a click maps into it
    private var picture = PixelSize(width: 0, height: 0)
    // `budget`'s probe at the flow's edge (`probeAtTheEdge`)
    private var edgeSince: UInt64 = 0
    private var edgeAcked: UInt64 = 0
    private var edgeDrops = 0
    private var edgeTarget: UInt64 = 0
    private var lastTarget: UInt64 = 0
    private var lastCutUs: UInt64 = 0
    private(set) var encoder: (any VideoEncoder)?
    private let write: @Sendable (Data) -> Void
    private let fail: @Sendable (String) -> Void
    /// the trace's line, when tracing: each second's encode times of the frames sent (the host's proof reads them)
    private let report: (@Sendable (String) -> Void)?
    private var encodes: [UInt64] = []
    private var reportedAt: UInt64 = 0

    /// `write` puts a record on the bytes pipe; `fail` ends the stream with `error`.
    init(id: Int, session: String, windowID: UInt32, entry: WindowVideoEntry, spec: VideoEncoderSpec, write: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void, report: (@Sendable (String) -> Void)? = nil) {
        self.id = id
        self.report = report
        self.session = session
        self.windowID = windowID
        self.entry = entry
        self.mode = spec.mode
        self.write = write
        self.fail = fail
        bitrate = spec.bitrate
        pacer = FramePacer(fps: spec.fps)
        still = StillWindow(fps: spec.fps)
        flow.configure(
            UInt64(ComputerDefaults.VideoStream.minBitrate), UInt64(spec.bitrate), UInt64(ComputerDefaults.VideoStream.maxBitrate), fps: spec.fps
        )
    }

    func attach(_ encoder: any VideoEncoder) {
        lock.withLock {
            self.encoder = encoder
            picture = encoder.startSize
        }
    }

    var pictureSize: PixelSize { lock.withLock { picture } }

    /// The stream is over: nothing more is admitted or written. True the first time.
    @discardableResult
    func end() -> Bool {
        lock.withLock {
            defer { over = true }
            return !over
        }
    }

    // MARK: VideoOutput

    func admit(captureMicros: UInt64, again: Bool) -> Bool {
        lock.withLock {
            guard !over else { return false }
            if !again {
                still.picture(atUs: captureMicros)
                guard pacer.take(captureMicros) else { return false }
            }
            let now = monotonicMicros()
            guard !flow.paused(now), flow.frames.count + reserved < flow.window else { return false }
            if again { still.repeated() }
            reserved += 1
            return true
        }
    }

    func encoded(_ unit: EncodedVideo) {
        let record: Data? = lock.withLock {
            reserved = max(0, reserved - 1)
            guard !over else { return nil }
            if unit.generation != generation {
                // a new encoder starts its sequence at 1: the flow starts again, keeping the bitrate it learned
                generation = unit.generation
                let rate = flow.targetBitrate
                flow.reset()
                flow.targetBitrate = rate
                edgeAcked = 0
                needKey = true
            }
            // a frame that leans on one never sent waits for the next keyframe
            if needKey && !unit.keyframe {
                encoder?.keyframe()
                return nil
            }
            let now = monotonicMicros()
            let sequence = flow.lastEncoded &+ 1
            guard flow.enqueue(sequence, unit.accessUnit.count, unit.captureMicros, now) else {
                needKey = true
                encoder?.keyframe()
                return nil
            }
            needKey = false
            picture = unit.size
            if report != nil { encodes.append(unit.encodeMicros) }
            flow.sent(sequence, now)
            let frame = VideoFrame(
                generation: generation, sequence: sequence, keyframe: unit.keyframe, width: unit.size.width, height: unit.size.height,
                captureMicros: unit.captureMicros, accessUnit: unit.accessUnit
            )
            return try? VideoRecord.frame(stream: UInt32(id), frame)
        }
        // the window's queue calls one at a time, so records leave in the order they were encoded
        if let record { write(record) }
    }

    func dropped() {
        lock.withLock {
            reserved = max(0, reserved - 1)
            edgeDrops += 1
        }
    }

    func failed(_ why: String) {
        lock.withLock { broken = true }
        fail(why)
    }

    /// The encoder failed for good, perhaps before the stream was in the table.
    var hasFailed: Bool { lock.withLock { broken } }

    // MARK: Acks and the clock

    /// An ack from the host: of this generation, for the oldest frame out. An ack for a later frame
    /// credits every frame before it too, so a viewer that skipped one does not stall the stream.
    func ack(_ record: VideoRecord) {
        lock.withLock {
            guard !over, record.generation == generation else { return }
            let now = monotonicMicros()
            let wait = record.ackWaitMicros
            while let oldest = flow.frames.first, oldest.sent, oldest.sequence < record.sequence {
                guard flow.ack(oldest.sequence, now, wait) else { break }
            }
            flow.ack(record.sequence, now, wait)
        }
    }

    enum Tick: Equatable { case running, timedOut }

    /// The video clock: the flow's own update, the bitrate it asks for, the still window and the timeout.
    func tick(now: UInt64 = monotonicMicros()) -> Tick {
        let (result, newRate, sharpen, encoder, line) = lock.withLock { () -> (Tick, Int?, Bool, (any VideoEncoder)?, String?) in
            guard !over else { return (.running, nil, false, nil, nil) }
            var line: String?
            if report != nil, now >= reportedAt + 1_000_000 {
                if reportedAt != 0 { line = "video \(id) encode us: " + encodes.map(String.init).joined(separator: " ") }
                encodes.removeAll(keepingCapacity: true)
                reportedAt = now
            }
            if flow.timedOut(now) {
                defer { toldTimeout = true }
                return (toldTimeout ? .running : .timedOut, nil, false, nil, line)
            }
            flow.update(now)
            var newRate: Int?
            if mode == .budget {
                probeAtTheEdge(now)
                let wanted = Int(min(max(flow.frameBitrate(), UInt64(ComputerDefaults.VideoStream.minBitrate)), UInt64(ComputerDefaults.VideoStream.maxBitrate)))
                if wanted != bitrate {
                    bitrate = wanted
                    newRate = wanted
                }
            }
            return (.running, newRate, still.due(atUs: now), self.encoder, line)
        }
        if let line { report?(line) }
        if let newRate { encoder?.setBitrate(newRate) }
        if sharpen { encoder?.encodeLast() }
        return result
    }

    /// Not in screen-relay, under the lock: `budget`'s bitrate rising while the encoder drops frames.
    ///
    /// The flow raises its bitrate only from a sample of steady demand, and it starts the sample again
    /// whenever two sent frames are more than three frame intervals apart (`ack`'s gap test, meant for a
    /// source that went idle). screen-relay's x264 never drops a frame, so for it a gap is idleness. Our
    /// encoder in `budget` holds the bitrate with low-latency rate control, which drops most frames of a
    /// busy window: the gaps are the cap at work, not idleness, and the flow never probes. So the stream
    /// keeps the flow exactly as it is and applies the flow's own probe beside it, with the flow's numbers:
    /// a second in which the encoder dropped pictures the flow had admitted (the demand the flow cannot
    /// see), at least 8 acks came, the flow's network pressure is clear, the flow did not rise itself, and
    /// it made no cut in the last 2 s, raises `targetBitrate` by a tenth, up to the flow's maximum. Cuts
    /// stay the flow's own.
    private func probeAtTheEdge(_ now: UInt64) {
        if flow.targetBitrate < lastTarget { lastCutUs = now }
        defer { lastTarget = flow.targetBitrate }
        if edgeSince == 0 {
            edgeSince = now
            edgeTarget = flow.targetBitrate
            return
        }
        guard now >= edgeSince + 1_000_000 else { return }
        let acked = flow.acknowledged >= edgeAcked ? flow.acknowledged - edgeAcked : flow.acknowledged
        let drops = edgeDrops, rose = flow.targetBitrate > edgeTarget
        edgeSince = now
        edgeAcked = flow.acknowledged
        edgeDrops = 0
        edgeTarget = flow.targetBitrate
        guard drops > 0, acked >= 8, !rose, flow.networkPressure(now) == .clear, now >= lastCutUs + 2_000_000 else { return }
        flow.targetBitrate = min(flow.maxBitrate, flow.targetBitrate + flow.targetBitrate / 10)
        edgeTarget = flow.targetBitrate
    }

    /// What the stream has done, for the proof and a debug log.
    var counts: (sent: UInt64, acked: UInt64, bitrate: Int) {
        lock.withLock { (flow.encoded, flow.acknowledged, bitrate) }
    }
}

/// One window's capture and the streams on it. `holds` counts its streams and the starts that wait for it:
/// the last to let go stops the capture.
final class WindowVideoEntry: @unchecked Sendable {
    let windowID: UInt32
    let start: Task<any WindowVideo, any Error>
    var holds = 0
    var watching = false

    init(windowID: UInt32, start: Task<any WindowVideo, any Error>) {
        self.windowID = windowID
        self.start = start
    }
}

extension ComputerService {
    func registerVideo(pipe: VideoPipe) {
        pipe.start(
            onRecord: { [weak self] record in
                guard record.type == NSL1.ackType, let stream = self?.lock.withLock({ self?.videos[Int(record.stream)] }) else { return }
                stream.ack(record)
            },
            onLost: { [weak self] why in
                guard let self else { return }
                log(.warn, "video: \(why); every video stream ends")
                let all = lock.withLock { Array(videos.keys) }
                for id in all { Task { await self.endVideo(id, reason: .error(why), tell: true) } }
            }
        )
        router.on("capture.video.start") { [self] (p: Methods.CaptureVideoStart.Params, ctx) in try await startVideo(p, pipe: pipe, ctx) }
        router.on("capture.video.stop") { [self] (p: Methods.CaptureVideoStop.Params, _) -> Empty in
            await endVideo(p.stream, reason: nil, tell: false)
            return Empty()
        }
    }

    /// A video stream on the window: its own encoder on the window's one capture.
    private func startVideo(_ p: Methods.CaptureVideoStart.Params, pipe: VideoPipe, _ ctx: RequestContext) async throws -> Methods.CaptureVideoStart.Output {
        let target = try await resolveTarget(session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, ctx: ctx)
        try await captureGuard(target)
        guard !pipe.isLost else { throw ComputerError(kind: .captureFailed, message: "The bytes pipe for video is closed; restart the service.") }
        guard let lease = await slots.slot(target.pid).acquire(.shared, timeout: nil) else { throw Router.cancelledError }
        defer { lease.release() }

        let defaults = ComputerDefaults.VideoStream.self
        let fps = min(max(p.fps ?? defaults.defaultFps, defaults.minFps), defaults.maxFps)
        let edge = min(max(p.maxEdge, defaults.minMaxEdge), p.mode == .budget ? defaults.linkMaxEdge : defaults.maxMaxEdge)
        let bitrate = p.mode == .quality ? defaults.qualityBitrate : min(max(p.bitrate ?? defaults.startBitrate, defaults.minBitrate), defaults.maxBitrate)
        let entry = try await holdWindowVideo(target.windowID, fps: fps, maxEdge: edge)
        let video: any WindowVideo
        do {
            video = try await entry.start.value
        } catch {
            await releaseWindowVideo(entry)
            throw error
        }
        let spec = VideoEncoderSpec(maxEdge: edge, fps: fps, mode: p.mode, bitrate: bitrate, size: VideoGeometry.picture(video.pixels, maxEdge: edge))
        let id = lock.withLock { () -> Int in
            nextVideo += 1
            return nextVideo
        }
        let trace = self.trace
        var report: (@Sendable (String) -> Void)?
        if trace.enabled { report = { @Sendable line in trace.note(line) } }
        let stream = VideoStream(
            id: id, session: target.session, windowID: target.windowID, entry: entry, spec: spec,
            write: { pipe.write($0) },
            fail: { [weak self] why in Task { await self?.endVideo(id, reason: .error(why), tell: true) } },
            report: report
        )
        let encoder: any VideoEncoder
        do {
            encoder = try video.addEncoder(spec, output: stream)
        } catch {
            await releaseWindowVideo(entry)
            throw ComputerService.failure(error, or: .captureFailed)
        }
        stream.attach(encoder)
        // a close that came while the stream started fences it out, and so does the capture's own end
        enum Kept { case kept(ClickCarry.Click?), closed, ended }
        let now = env.system.now()
        let kept = lock.withLock { () -> Kept in
            guard book.isOpen(target.session) && !ctx.cancel.isSet else { return .closed }
            // the capture may have ended before its watcher took the entry out
            guard windowVideos[target.windowID] === entry, !video.isOver, !stream.hasFailed else { return .ended }
            videos[id] = stream
            // a click still carried on the window is taken in the same turn of the lock (P2), as for a preview
            return .kept(clicks.pending(session: target.session, windowID: target.windowID, now: now))
        }
        if case .kept(let carried?) = kept {
            ctx.afterAnswer { [self] in sendClick(carried, onVideo: stream) }
        }
        if case .kept = kept {} else {
            stream.end()
            video.removeEncoder(encoder)
            await releaseWindowVideo(entry)
            if case .ended = kept { throw ComputerError(kind: .windowNotFound, message: "The window's capture ended while the stream started.") }
            throw Router.cancelledError
        }
        startVideoClock()
        return Methods.CaptureVideoStart.Output(stream: id, width: encoder.startSize.width, height: encoder.startSize.height)
    }

    /// The window's capture, started by the first stream and shared by the rest; one more hold on it.
    private func holdWindowVideo(_ windowID: UInt32, fps: Int, maxEdge: Int) async throws -> WindowVideoEntry {
        let capture = self.capture
        let (entry, fresh) = lock.withLock { () -> (WindowVideoEntry, Bool) in
            if let running = windowVideos[windowID] {
                running.holds += 1
                return (running, false)
            }
            let entry = WindowVideoEntry(windowID: windowID, start: Task { try await capture.startVideo(windowID: windowID, fps: fps, maxEdge: maxEdge) })
            entry.holds = 1
            windowVideos[windowID] = entry
            return (entry, true)
        }
        if fresh {
            Task { [weak self] in
                guard let video = try? await entry.start.value else {
                    self?.lock.withLock { if self?.windowVideos[windowID] === entry { self?.windowVideos[windowID] = nil } }
                    return
                }
                let reason = await video.ended()
                await self?.windowVideoEnded(entry, reason: reason)
            }
        }
        return entry
    }

    /// One hold let go; the last stops the window's capture.
    private func releaseWindowVideo(_ entry: WindowVideoEntry) async {
        let last = lock.withLock { () -> Bool in
            entry.holds -= 1
            guard entry.holds <= 0 else { return false }
            if windowVideos[entry.windowID] === entry { windowVideos[entry.windowID] = nil }
            return true
        }
        if last, let video = try? await entry.start.value { await video.stop() }
    }

    /// The window's capture ended on its own: every stream on it ends with its reason.
    private func windowVideoEnded(_ entry: WindowVideoEntry, reason: StreamEndReason) async {
        let ids = lock.withLock { () -> [Int] in
            if windowVideos[entry.windowID] === entry { windowVideos[entry.windowID] = nil }
            return videos.values.filter { $0.entry === entry }.map(\.id)
        }
        for id in ids { await endVideo(id, reason: reason, tell: true, capturing: false) }
    }

    /// Ends one stream: its encoder goes, its hold on the capture goes, and `capture/videoEnded` is sent
    /// when `tell` (an end of its own). `capturing` false: the capture is over already.
    func endVideo(_ id: Int, reason: StreamEndReason?, tell: Bool, capturing: Bool = true) async {
        guard let stream = lock.withLock({ videos.removeValue(forKey: id) }), stream.end() else { return }
        if capturing {
            let entry = stream.entry
            if let video = try? await entry.start.value, let encoder = stream.encoder { video.removeEncoder(encoder) }
            await releaseWindowVideo(entry)
        }
        if tell, let reason {
            notify("capture/videoEnded", CaptureVideoEndedNotification.Params(stream: id, reason: .init(rawValue: reason.wire.rawValue)))
        }
    }

    /// Every stream of the session, or every stream, ended without a notice.
    func endVideos(session: String?) async {
        let ids = lock.withLock { videos.values.filter { session == nil || $0.session == session }.map(\.id) }
        for id in ids { await endVideo(id, reason: nil, tell: false) }
    }

    /// The clock every stream's flow runs on (`FlowControl.sampleIntervalUs`); it stops with the last stream.
    private func startVideoClock() {
        let clock: DispatchSourceTimer? = lock.withLock {
            guard videoClock == nil else { return nil }
            let clock = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tc-computer.video.clock"))
            videoClock = clock
            return clock
        }
        guard let clock else { return }
        let every = Int(FlowControl.sampleIntervalUs)
        clock.schedule(deadline: .now() + .microseconds(every), repeating: .microseconds(every))
        clock.setEventHandler { [weak self] in self?.videoTick() }
        clock.resume()
    }

    private func videoTick() {
        let streams = lock.withLock { () -> [VideoStream] in
            if videos.isEmpty, let clock = videoClock {
                clock.cancel()
                videoClock = nil
            }
            return Array(videos.values)
        }
        let now = monotonicMicros()
        for stream in streams where stream.tick(now: now) == .timedOut {
            Task { await endVideo(stream.id, reason: .error("no ack for \(FlowControl.timeoutUs / 1_000_000) s"), tell: true) }
        }
    }
}
