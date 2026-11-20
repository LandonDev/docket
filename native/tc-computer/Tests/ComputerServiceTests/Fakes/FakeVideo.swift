import ComputerCore
import ComputerProtocol
import Foundation

/// Capture's live video as the shell sees it: one fake capture per window, encoders the tests drive.
final class FakeVideos: @unchecked Sendable {
    private let lock = NSLock()
    private let log: CallLog
    private var made: [UInt32: [FakeWindowVideo]] = [:]
    /// the window's own pixels every capture reports
    var pixels = PixelSize(width: 2_560, height: 1_600)
    var failStart: ComputerError?
    /// the capture ends on its own while the first encoder joins (the window closed during a start)
    var endOnAdd = false

    init(log: CallLog) {
        self.log = log
    }

    func start(windowID: UInt32, fps: Int, maxEdge: Int) throws -> FakeWindowVideo {
        log.add("startVideo \(windowID) fps=\(fps) edge=\(maxEdge)")
        if let failStart = lock.withLock({ failStart }) { throw failStart }
        let video = FakeWindowVideo(pixels: lock.withLock { pixels }, log: log, endOnAdd: lock.withLock { endOnAdd })
        lock.withLock { made[windowID, default: []].append(video) }
        return video
    }

    /// The window's newest capture.
    func capture(_ windowID: UInt32) -> FakeWindowVideo? { lock.withLock { made[windowID]?.last } }
}

final class FakeWindowVideo: WindowVideo, @unchecked Sendable {
    private let lock = NSLock()
    private let log: CallLog
    let pixels: PixelSize
    private var live: [FakeEncoder] = []
    private var ending: [CheckedContinuation<StreamEndReason, Never>] = []
    private var endedWith: StreamEndReason?

    private let endOnAdd: Bool

    init(pixels: PixelSize, log: CallLog, endOnAdd: Bool = false) {
        self.pixels = pixels
        self.log = log
        self.endOnAdd = endOnAdd
    }

    var encoders: [FakeEncoder] { lock.withLock { live } }
    var stopped: Bool { lock.withLock { endedWith != nil } }
    var isOver: Bool { stopped }

    func addEncoder(_ spec: VideoEncoderSpec, output: any VideoOutput) throws -> any VideoEncoder {
        log.add("addEncoder \(spec.size.width)x\(spec.size.height) \(spec.mode.rawValue) \(spec.bitrate)")
        let encoder = FakeEncoder(spec: spec, output: output)
        lock.withLock { live.append(encoder) }
        if endOnAdd { end(.windowClosed) }
        return encoder
    }

    func removeEncoder(_ encoder: any VideoEncoder) {
        log.add("removeEncoder")
        lock.withLock { live.removeAll { $0 === encoder } }
    }

    func stop() async {
        log.add("stopVideo")
        end(.stopped)
    }

    func ended() async -> StreamEndReason {
        await withCheckedContinuation { continuation in
            let done: StreamEndReason? = lock.withLock {
                if let endedWith { return endedWith }
                ending.append(continuation)
                return nil
            }
            if let done { continuation.resume(returning: done) }
        }
    }

    /// The capture ends on its own (or by `stop`).
    func end(_ reason: StreamEndReason) {
        let waiting: [CheckedContinuation<StreamEndReason, Never>] = lock.withLock {
            guard endedWith == nil else { return [] }
            endedWith = reason
            defer { ending = [] }
            return ending
        }
        for waiter in waiting { waiter.resume(returning: reason) }
    }
}

final class FakeEncoder: VideoEncoder, @unchecked Sendable {
    private let lock = NSLock()
    let spec: VideoEncoderSpec
    let output: any VideoOutput
    private(set) var generation: UInt32 = 1
    private var sinceKey = 0
    private var asked: [String] = []

    init(spec: VideoEncoderSpec, output: any VideoOutput) {
        self.spec = spec
        self.output = output
    }

    var calls: [String] { lock.withLock { asked } }
    var startSize: PixelSize { spec.size }

    func setBitrate(_ bitsPerSecond: Int) { lock.withLock { asked.append("bitrate \(bitsPerSecond)") } }
    func encodeLast() { lock.withLock { asked.append("encodeLast") } }
    func keyframe() { lock.withLock { asked.append("keyframe") } }

    /// A picture captured at `micros`: offered to the stream, and when it admits it, encoded at once.
    /// True when it was admitted.
    @discardableResult
    func picture(at micros: UInt64, again: Bool = false, bytes: Int = 100, size: PixelSize? = nil, keyframe: Bool? = nil) -> Bool {
        guard output.admit(captureMicros: micros, again: again) else { return false }
        let key = keyframe ?? lock.withLock { () -> Bool in
            defer { sinceKey += 1 }
            return sinceKey == 0
        }
        output.encoded(EncodedVideo(
            generation: generation, keyframe: key, size: size ?? spec.size, captureMicros: micros,
            accessUnit: Data(repeating: key ? 0x65 : 0x41, count: bytes), encodeMicros: 900
        ))
        return true
    }

    /// The encoder is made again at a new size: a new generation, starting with a keyframe.
    func newGeneration() {
        lock.withLock {
            generation += 1
            sinceKey = 0
        }
    }
}
