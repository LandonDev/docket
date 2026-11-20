#if canImport(ScreenCaptureKit)

import AppKit
import Capture
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation
import IOKit
import os

// Scenes 20 and 21: live video (docs/computer-protocol.md §30) of an inert window through the real
// ScreenCaptureKit capture and VideoToolbox encoder. Each runs only after five minutes with no input,
// the screen unlocked and the display awake, and stops the moment input returns.

/// The person's input, as the window server sees it.
enum InputGate {
    static func idleSeconds() -> Double {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else { return 0 }
        return Double(value.uint64Value) / 1e9
    }

    static func locked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        return (session["CGSSessionScreenIsLocked"] as? Bool) ?? ((session["CGSSessionScreenIsLocked"] as? Int) == 1)
    }

    static func asleep() -> Bool { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }

    /// Why a scene that shows a window may not run now; nil when it may.
    static func refusal(idle: Double = 300) -> String? {
        if locked() { return "locked" }
        if asleep() { return "the display is asleep" }
        let seconds = idleSeconds()
        return seconds >= idle ? nil : String(format: "input %.0f s ago, under %.0f s", seconds, idle)
    }
}

/// An inert borderless window of 1280 × 800 points that redraws everything on every display refresh: the
/// spike's busy scene (the hue, a moving bar, 34 lines of new text, a counter).
@MainActor final class VideoSceneWindow: NSObject {
    static let size = CGSize(width: 1_280, height: 800)
    let window: InertWindow
    private let root = CALayer(), bar = CALayer(), text = CATextLayer(), counter = CATextLayer()
    private var link: CADisplayLink?
    private var frame = 0
    private var seed: UInt32 = 12_345

    init(screen: NSScreen) {
        let visible = screen.visibleFrame
        window = InertWindow(contentRect: CGRect(x: visible.minX + 40, y: visible.maxY - Self.size.height - 40, width: Self.size.width, height: Self.size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.colorSpace = .sRGB
        super.init()
        let view = NSView(frame: CGRect(origin: .zero, size: Self.size))
        view.wantsLayer = true
        window.contentView = view
        let scale = screen.backingScaleFactor
        root.frame = view.bounds
        root.backgroundColor = NSColor(calibratedWhite: 0.12, alpha: 1).cgColor
        view.layer!.addSublayer(root)
        let mono = NSFont.monospacedSystemFont(ofSize: 15, weight: .regular)
        text.frame = CGRect(x: 40, y: 80, width: Self.size.width - 80, height: Self.size.height - 160)
        text.font = mono
        text.fontSize = 15
        text.contentsScale = scale
        text.foregroundColor = NSColor.white.cgColor
        root.addSublayer(text)
        bar.frame = CGRect(x: 0, y: 0, width: 120, height: Self.size.height)
        bar.backgroundColor = NSColor.systemOrange.withAlphaComponent(0.8).cgColor
        root.addSublayer(bar)
        counter.frame = CGRect(x: 40, y: 20, width: 200, height: 40)
        counter.font = mono
        counter.fontSize = 28
        counter.contentsScale = scale
        counter.backgroundColor = NSColor.black.cgColor
        counter.foregroundColor = NSColor.systemGreen.cgColor
        root.addSublayer(counter)
    }

    var windowID: UInt32 { UInt32(window.windowNumber) }

    /// Shown behind every other window: never key, never activated.
    func show() {
        window.orderBack(nil)
        draw()
    }

    func close() {
        still()
        window.orderOut(nil)
        window.close()
    }

    /// Every refresh draws a new frame until `still`.
    func animate() {
        guard link == nil, let view = window.contentView else { return }
        let link = view.displayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 240, preferred: 240)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func still() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) { draw() }

    private func draw() {
        frame += 1
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        counter.string = String(format: "%07d", frame)
        bar.position.x = CGFloat((frame * 9) % Int(Self.size.width))
        root.backgroundColor = NSColor(calibratedHue: CGFloat(frame % 360) / 360, saturation: 0.35, brightness: 0.25, alpha: 1).cgColor
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789 {}()=;.,ABCDEFGHIJ")
        var lines = ""
        for line in 0..<34 {
            lines += String(format: "%02d %08d ", line, frame)
            for _ in 0..<120 {
                seed = seed &* 1_664_525 &+ 1_013_904_223
                lines.append(chars[Int(seed >> 24) % chars.count])
            }
            lines += "\n"
        }
        text.string = lines
        CATransaction.commit()
    }
}

/// The service's side of one stream (ComputerService's `VideoStream`) with a viewer on the same Mac that
/// acks each frame 2 ms after it is written: the pacing, the flow, the still window, and the records,
/// read back for the checks.
final class ProofViewer: VideoOutput, @unchecked Sendable {
    struct Seen {
        let record: VideoRecord
        let atMicros: UInt64
        let encodeMicros: UInt64
        let bytes: Int
        let again: Bool
    }

    private let lock = NSLock()
    private var flow = FlowControl()
    private var pacer: FramePacer
    private var still: StillWindow
    private var generation: UInt32 = 0
    private var reserved = 0
    private var pending: [Bool] = []
    private var seen: [Seen] = []
    private var offered = 0
    private var failures: [String] = []
    private let followFlow: Bool
    private let acks = DispatchQueue(label: "tc.proof.viewer")
    weak var encoder: (any VideoEncoder)?

    /// `followFlow`: the bitrate follows the flow, as `budget` does in the service; false holds it (the trial).
    init(fps: Int, bitrate: Int, followFlow: Bool) {
        pacer = FramePacer(fps: fps)
        still = StillWindow(fps: fps)
        self.followFlow = followFlow
        flow.configure(1_000_000, UInt64(bitrate), 20_000_000, fps: fps)
    }

    var frames: [Seen] { lock.withLock { seen } }
    var pictures: Int { lock.withLock { offered } }
    var failed: [String] { lock.withLock { failures } }

    func admit(captureMicros: UInt64, again: Bool) -> Bool {
        lock.withLock {
            if !again {
                offered += 1
                still.picture(atUs: captureMicros)
                guard pacer.take(captureMicros) else { return false }
            }
            let now = monotonicMicros()
            guard !flow.paused(now), flow.frames.count + reserved < flow.window else { return false }
            if again { still.repeated() }
            reserved += 1
            pending.append(again)
            return true
        }
    }

    func encoded(_ unit: EncodedVideo) {
        let ack: (UInt32, UInt32)? = lock.withLock {
            reserved = max(0, reserved - 1)
            let again = pending.isEmpty ? false : pending.removeFirst()
            if unit.generation != generation {
                generation = unit.generation
                flow.reset()
            }
            let now = monotonicMicros()
            let sequence = flow.lastEncoded &+ 1
            guard flow.enqueue(sequence, unit.accessUnit.count, unit.captureMicros, now) else { return nil }
            flow.sent(sequence, now)
            let frame = VideoFrame(generation: generation, sequence: sequence, keyframe: unit.keyframe, width: unit.size.width, height: unit.size.height, captureMicros: unit.captureMicros, accessUnit: unit.accessUnit)
            var reader = VideoRecordReader()
            guard let bytes = try? VideoRecord.frame(stream: 1, frame), let record = (try? reader.push(bytes))?.first else { return nil }
            seen.append(Seen(record: record, atMicros: now, encodeMicros: unit.encodeMicros, bytes: unit.accessUnit.count, again: again))
            return (generation, sequence)
        }
        guard let ack else { return }
        acks.asyncAfter(deadline: .now() + .milliseconds(2)) { [self] in
            lock.withLock { _ = generation == ack.0 ? flow.ack(ack.1, monotonicMicros(), 1_000) : false }
        }
    }

    func dropped() {
        lock.withLock {
            reserved = max(0, reserved - 1)
            if !pending.isEmpty { pending.removeFirst() }
        }
    }

    func failed(_ why: String) { lock.withLock { failures.append(why) } }

    /// The service's 10 ms clock: the flow's update, its bitrate, the still window.
    func tick() {
        let (rate, sharpen) = lock.withLock { () -> (Int?, Bool) in
            let now = monotonicMicros()
            flow.update(now)
            return (followFlow ? Int(flow.frameBitrate()) : nil, still.due(atUs: now))
        }
        if let rate { encoder?.setBitrate(rate) }
        if sharpen { encoder?.encodeLast() }
    }
}

/// What one run measured.
struct VideoRun {
    let mode: VideoMode
    let rate: VideoRate
    let bitrate: Int
    let size: PixelSize
    let frames: [ProofViewer.Seen]
    let pictures: Int
    let seconds: Double
    let failures: [String]

    /// The frames in the measured window (after the warm-up).
    func measured(from: UInt64) -> [ProofViewer.Seen] { frames.filter { $0.atMicros >= from } }

    static func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
    }
}

extension Proof {
    /// A stream of `window` for `warmup + seconds`, through `capture`'s real capture and encoder.
    func videoRun(_ window: UInt32, capture: ScreenCaptureKitCapture, mode: VideoMode, bitrate: Int, maxEdge: Int, warmup: Double, seconds: Double, followFlow: Bool, during: (@MainActor () async -> Void)? = nil) async throws -> (VideoRun, measuredFrom: UInt64) {
        let fps = ComputerDefaults.VideoStream.defaultFps
        let video = try await capture.startVideo(windowID: window, fps: fps, maxEdge: maxEdge)
        let size = VideoGeometry.picture(video.pixels, maxEdge: maxEdge)
        let viewer = ProofViewer(fps: fps, bitrate: bitrate, followFlow: followFlow)
        let encoder = try video.addEncoder(VideoEncoderSpec(maxEdge: maxEdge, fps: fps, mode: mode, bitrate: bitrate, size: size), output: viewer)
        viewer.encoder = encoder
        let clock = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tc.proof.video.clock"))
        clock.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10))
        clock.setEventHandler { viewer.tick() }
        clock.resume()
        await pause(Int(warmup * 1_000))
        let from = monotonicMicros()
        if let during { await during() } else { await pause(Int(seconds * 1_000)) }
        clock.cancel()
        video.removeEncoder(encoder)
        await video.stop()
        let rate = capture.videoRate(mode)
        return (VideoRun(mode: mode, rate: rate, bitrate: bitrate, size: size, frames: viewer.frames, pictures: viewer.pictures, seconds: seconds, failures: viewer.failed), from)
    }

    /// The numbers of one run's measured window: fps, encode p50 / p95 ms, Mbit/s.
    func videoFigures(_ run: VideoRun, from: UInt64) -> (fps: Double, p50: Double, p95: Double, mbps: Double, capture: Double) {
        let window = run.measured(from: from)
        let encodes = window.map { Double($0.encodeMicros) / 1_000 }
        let bytes = window.reduce(0) { $0 + $1.bytes }
        return (Double(window.count) / run.seconds, VideoRun.percentile(encodes, 0.5), VideoRun.percentile(encodes, 0.95), Double(bytes) * 8 / run.seconds / 1e6, Double(run.pictures) / run.seconds)
    }

    /// A window for the video scenes, or the reason it may not open now.
    func videoWindow(_ scene: String) async -> VideoSceneWindow? {
        if let refusal = InputGate.refusal() {
            report.skip(scene, "idle gate", "not run: \(refusal)")
            return nil
        }
        let window = VideoSceneWindow(screen: Screens.primary)
        window.show()
        window.animate()
        await pause(500)
        return window
    }

    /// Stops the run the moment the person touches the Mac: the window closes and the process ends.
    func watchInput(closing window: VideoSceneWindow) -> Task<Void, Never> {
        Task { @MainActor in
            var last = InputGate.idleSeconds()
            while !Task.isCancelled {
                await pause(200)
                let now = InputGate.idleSeconds()
                if now + 0.5 < last || InputGate.locked() {
                    window.close()
                    report.check("video", "input gate", false, "input returned: the window closed and the run stopped", finding: true)
                    try? report.write()
                    exit(3)
                }
                last = now
            }
        }
    }

    // MARK: 20. A video stream in each mode

    func scene20() async throws {
        guard let window = await videoWindow("20") else { return }
        let watch = watchInput(closing: window)
        defer {
            watch.cancel()
            window.close()
        }
        let refresh = WindowVideoRefresh.of(window.window)
        report.measure("20", "display", ["refresh": refresh, "scale": Double(window.window.backingScaleFactor), "load": loadAverage()])
        for mode in [VideoMode.quality, .budget] {
            let edge = mode == .quality ? ComputerDefaults.VideoStream.maxMaxEdge : ComputerDefaults.VideoStream.linkMaxEdge
            let bitrate = mode == .quality ? ComputerDefaults.VideoStream.qualityBitrate : ComputerDefaults.VideoStream.startBitrate
            let (run, from) = try await videoRun(window.windowID, capture: capture, mode: mode, bitrate: bitrate, maxEdge: edge, warmup: 1, seconds: 5, followFlow: mode == .budget)
            let name = mode.rawValue
            let records = run.frames.map(\.record)
            guard let first = records.first else {
                report.check("20", "\(name): frames came", false, "no frame in 6 s")
                continue
            }
            let types = AnnexB.unitTypes(first.payload.subdata(in: NSL1.framePrefix..<first.payload.count))
            report.check("20", "\(name): the first frame is a keyframe with its SPS and PPS", first.flags == NSL1.keyframeFlag && types.prefix(2) == [7, 8] && types.contains(5), "flags \(first.flags), NAL types \(types)")
            let sequences = records.map(\.sequence)
            report.check("20", "\(name): sequences run 1, 2, 3 … in generation 1", sequences == Array(1...UInt32(records.count)) && records.allSatisfy { $0.generation == 1 }, "\(records.count) frames, \(sequences.prefix(5))…")
            let sizes = Set(records.map { [UInt8]($0.payload.prefix(4)) })
            let answered: [UInt8] = [UInt8(run.size.width >> 8), UInt8(run.size.width & 0xFF), UInt8(run.size.height >> 8), UInt8(run.size.height & 0xFF)]
            report.check("20", "\(name): every frame is the size start answered", sizes == [answered], "\(run.size.width)×\(run.size.height)")
            report.check("20", "\(name): no encoder failure", run.failures.isEmpty, run.failures.joined(separator: "; "))
            let figures = videoFigures(run, from: from)
            report.check("20", "\(name): figures", false, String(format: "%.1f fps (capture %.1f), encode p50 %.2f ms p95 %.2f ms, %.2f Mbit/s at %d×%d, display %d Hz", figures.fps, figures.capture, figures.p50, figures.p95, figures.mbps, run.size.width, run.size.height, refresh), finding: true)
            report.measure("20", name, ["fps": figures.fps, "captureFps": figures.capture, "encodeP50Ms": figures.p50, "encodeP95Ms": figures.p95, "mbps": figures.mbps, "width": run.size.width, "height": run.size.height])
            await pause(300)
        }
        // still: a second of motion, then nothing changes; what follows is the sharpening and no more
        var stopped: UInt64 = 0
        let (still, _) = try await videoRun(window.windowID, capture: capture, mode: .quality, bitrate: ComputerDefaults.VideoStream.qualityBitrate, maxEdge: 3_840, warmup: 1, seconds: 2.5, followFlow: false) { @MainActor in
            window.still()
            stopped = monotonicMicros()
            await pause(2_500)
        }
        // the last drawn frames may still be on their way out for a few refreshes after the stop
        let after = still.frames.filter { $0.atMicros > stopped + 50_000 }
        let repeats = after.filter(\.again).count
        report.check("20", "a still window sends at most the sharpening frames", after.count <= ComputerDefaults.VideoStream.sharpenFrames, "\(after.count) frames from 50 ms after the window went still, \(repeats) of them repeats (sharpenFrames \(ComputerDefaults.VideoStream.sharpenFrames))")
    }

    // MARK: 21. The DataRateLimits trial

    func scene21() async throws {
        guard let window = await videoWindow("21") else { return }
        let watch = watchInput(closing: window)
        defer {
            watch.cancel()
            window.close()
        }
        let refresh = WindowVideoRefresh.of(window.window)
        let runs: [(String, VideoMode, VideoRate, Int)] = [
            ("quality, default rate control, 20 Mbit/s", .quality, VideoRate(lowLatency: false, dataRateLimits: false), 20_000_000),
            ("quality, DataRateLimits 20 Mbit/s", .quality, VideoRate(lowLatency: false, dataRateLimits: true), 20_000_000),
            ("budget, low-latency rate control, 8 Mbit/s", .budget, VideoRate(lowLatency: true, dataRateLimits: false), 8_000_000),
            ("budget, DataRateLimits without low latency, 8 Mbit/s", .budget, VideoRate(lowLatency: false, dataRateLimits: true), 8_000_000),
        ]
        var table: [[String: Any]] = []
        for (name, mode, rate, bitrate) in runs {
            let trial = ScreenCaptureKitCapture(videoRate: { _ in rate })
            let (run, from) = try await videoRun(window.windowID, capture: trial, mode: mode, bitrate: bitrate, maxEdge: 3_840, warmup: 2, seconds: 8, followFlow: false)
            let figures = videoFigures(run, from: from)
            report.check("21", name, false, String(format: "%.1f fps of %.1f captured, %.2f Mbit/s, encode p50 %.2f ms p95 %.2f ms, %d×%d, display %d Hz, load %.1f", figures.fps, figures.capture, figures.mbps, figures.p50, figures.p95, run.size.width, run.size.height, refresh, loadAverage()), finding: true)
            table.append(["run": name, "fps": figures.fps, "captureFps": figures.capture, "mbps": figures.mbps, "encodeP50Ms": figures.p50, "encodeP95Ms": figures.p95, "width": run.size.width, "height": run.size.height])
            await pause(500)
        }
        report.measure("21", "trial", table)
    }
}

enum WindowVideoRefresh {
    @MainActor static func of(_ window: NSWindow) -> Int { window.screen?.maximumFramesPerSecond ?? 0 }
}

func loadAverage() -> Double {
    var loads = [Double](repeating: 0, count: 3)
    return getloadavg(&loads, 3) > 0 ? loads[0] : 0
}

#endif
