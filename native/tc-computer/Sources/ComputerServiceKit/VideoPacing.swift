import ComputerProtocol
import Foundation

/// Drops a capture running at the display's own rate to a stream's `fps` (docs/computer-protocol.md §30).
/// A cap asked of ScreenCaptureKit itself drops any frame sooner than 1/fps after the last, which on a
/// 144 Hz display gave 105 a second for 120 asked. This keeps, of the frames that come, the one nearest
/// each slot of an even 1/fps grid: a frame half a slot early is taken and the grid moves on by one slot,
/// or restarts from a late frame. No more than `fps` frames are taken in any second. Pure; times in µs.
public struct FramePacer: Sendable {
    public let fps: Int
    private let interval: Double
    private var next: Double?
    /// the last `fps` frames taken, oldest first
    private var taken: [UInt64] = []

    public init(fps: Int) {
        self.fps = max(1, fps)
        interval = 1_000_000 / Double(self.fps)
    }

    /// Whether the frame captured at `atUs` is one to keep; a kept frame counts.
    public mutating func take(_ atUs: UInt64) -> Bool {
        let at = Double(atUs), slack = interval / 2
        if let next, at + slack < next { return false }
        if taken.count == fps, let oldest = taken.first, atUs < oldest + 1_000_000 { return false }
        next = max((next ?? at) + interval, at + interval - slack)
        if taken.count == fps { taken.removeFirst() }
        taken.append(atUs)
        return true
    }
}

/// A still window (§30): once the capture has had no new picture for `afterMs`, the last picture is
/// encoded again, one frame interval apart, up to `frames` times, so the picture left on the viewer's
/// screen is sharp; then nothing until a new picture comes. Pure; times in µs.
public struct StillWindow: Sendable {
    private let afterUs: UInt64
    private let frames: Int
    private let intervalUs: UInt64
    private var lastPictureUs: UInt64?
    private var lastAskUs: UInt64 = 0
    public private(set) var repeats = 0

    public init(fps: Int, afterMs: Int = ComputerDefaults.VideoStream.sharpenAfterMs, frames: Int = ComputerDefaults.VideoStream.sharpenFrames) {
        afterUs = UInt64(afterMs) * 1_000
        self.frames = frames
        intervalUs = 1_000_000 / UInt64(max(1, fps))
    }

    /// A new picture came from the capture, sent or not.
    public mutating func picture(atUs: UInt64) {
        lastPictureUs = atUs
        repeats = 0
    }

    /// Whether the last picture should be encoded again now; true marks the ask, so the next waits an interval.
    public mutating func due(atUs: UInt64) -> Bool {
        guard let last = lastPictureUs, repeats < frames, atUs >= last + afterUs, atUs >= lastAskUs + intervalUs else { return false }
        lastAskUs = atUs
        return true
    }

    /// The repeat was taken for encoding.
    public mutating func repeated() {
        repeats += 1
    }
}
