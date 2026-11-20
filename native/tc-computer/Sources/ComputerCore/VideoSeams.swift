import ComputerProtocol
import Foundation

/// Live video of one window (docs/computer-protocol.md §30), as the shell sees Capture: one capture per
/// window, shared by its streams, and one encoder per stream. The shell keeps the streams, the bytes
/// pipe, the flow, the pacing and the still window; Capture captures and encodes.
public protocol VideoCapturing {
    /// Starts a capture of the window at the display's own rate and at least `fps`, its pictures sized for
    /// a first stream of `maxEdge`. It delivers nothing until an encoder is added.
    func startVideo(windowID: UInt32, fps: Int, maxEdge: Int) async throws -> any WindowVideo
}

/// One window's running capture.
public protocol WindowVideo: AnyObject, Sendable {
    /// the window's own pixels when the capture started
    var pixels: PixelSize { get }
    /// A stream's encoder on this capture: its first frame is a keyframe of generation 1. Throws when
    /// the system has no encoder to give.
    func addEncoder(_ spec: VideoEncoderSpec, output: any VideoOutput) throws -> any VideoEncoder
    /// The encoder is gone: the capture keeps running for the others.
    func removeEncoder(_ encoder: any VideoEncoder)
    /// Ends the capture and every encoder on it; `ended()` then says `.stopped`.
    func stop() async
    /// Resolves once, when the capture ends: the window closed, the grant went, ScreenCaptureKit failed, or `stop`.
    func ended() async -> StreamEndReason
    /// The capture has ended, as `ended()` will say.
    var isOver: Bool { get }
}

/// A picture's size in pixels.
public struct PixelSize: Equatable, Hashable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// What one stream asks of its encoder.
public struct VideoEncoderSpec: Equatable, Sendable {
    /// the picture's long edge at most, already held to `linkMaxEdge` in `budget`
    public let maxEdge: Int
    public let fps: Int
    public let mode: VideoMode
    /// bits a second to start at
    public let bitrate: Int
    /// the picture's size the shell expects, `VideoGeometry.picture` of the capture's pixels; the encoder
    /// works its own out from the window's pixels as it joins (`VideoEncoder.startSize`)
    public let size: PixelSize

    public init(maxEdge: Int, fps: Int, mode: VideoMode, bitrate: Int, size: PixelSize) {
        self.maxEdge = maxEdge
        self.fps = fps
        self.mode = mode
        self.bitrate = bitrate
        self.size = size
    }
}

/// One stream's encoder. Every call returns at once; the work runs on the capture's queue.
public protocol VideoEncoder: AnyObject, Sendable {
    /// The picture's size when it joined, from the window's pixels at that moment: `capture.video.start`'s answer.
    var startSize: PixelSize { get }
    /// `budget`: the bitrate the flow asks for now
    func setBitrate(_ bitsPerSecond: Int)
    /// The still window: the last picture the capture took is offered again (through `admit`).
    func encodeLast()
    /// The next picture is a keyframe.
    func keyframe()
}

/// Where an encoder's pictures go: the shell's side of one stream. Called on the capture's queue, one at a time.
public protocol VideoOutput: AnyObject, Sendable {
    /// A picture is about to be encoded: `again` for the still window's repeat. False skips it for this
    /// stream (the pacing or the flow); true takes a place in the flow until `encoded` or `dropped`.
    func admit(captureMicros: UInt64, again: Bool) -> Bool
    /// An admitted picture as an access unit.
    func encoded(_ unit: EncodedVideo)
    /// The encoder gave nothing for an admitted picture.
    func dropped()
    /// The encoder failed and could not be made again: the stream ends with `error`.
    func failed(_ why: String)
}

/// One encoded picture.
public struct EncodedVideo: Sendable {
    /// 1 for the encoder's first life, one more each time it is made again (a new size, a failure)
    public let generation: UInt32
    public let keyframe: Bool
    public let size: PixelSize
    /// the monotonic clock in microseconds when ScreenCaptureKit delivered the picture
    public let captureMicros: UInt64
    /// one H.264 access unit, Annex B; a keyframe's carries its SPS and PPS
    public let accessUnit: Data
    /// the capture callback to these bytes, in microseconds
    public let encodeMicros: UInt64

    public init(generation: UInt32, keyframe: Bool, size: PixelSize, captureMicros: UInt64, accessUnit: Data, encodeMicros: UInt64) {
        self.generation = generation
        self.keyframe = keyframe
        self.size = size
        self.captureMicros = captureMicros
        self.accessUnit = accessUnit
        self.encodeMicros = encodeMicros
    }
}

/// The picture size of a video stream (§30). Pure.
public enum VideoGeometry {
    /// The window's own pixels scaled down to fit `maxEdge` on the long edge, never up, each side even
    /// (H.264's 4:2:0 needs it) and at least 2.
    public static func picture(_ pixels: PixelSize, maxEdge: Int) -> PixelSize {
        let width = Double(max(pixels.width, 1)), height = Double(max(pixels.height, 1))
        let k = min(1, Double(maxEdge) / max(width, height))
        return PixelSize(width: even(width * k), height: even(height * k))
    }

    private static func even(_ value: Double) -> Int {
        max(2, Int(value.rounded(.down)) & ~1)
    }
}

/// The monotonic clock the video side runs on, in microseconds: mach_absolute_time's (the clock
/// ScreenCaptureKit stamps its samples with).
public func monotonicMicros() -> UInt64 {
    #if canImport(Darwin)
    clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1_000
    #else
    var spec = timespec()
    clock_gettime(CLOCK_MONOTONIC, &spec)
    return UInt64(spec.tv_sec) * 1_000_000 + UInt64(spec.tv_nsec) / 1_000
    #endif
}
