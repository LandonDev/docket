import ComputerProtocol
import Foundation

/// Every number and choice live video's capture and encoder run on (docs/computer-protocol.md §30), in one
/// place. The wire's numbers come from `VIDEO_STREAM` in protocol.ts; the rest are what the spike of
/// 2026-11-19 and the DataRateLimits trial measured on an M4 Max at 2560×1600 (docs/agents/live-video.md).
public enum VideoTuning {
    /// H.264 High at the level the size and rate need: the viewer reads its codec string from the
    /// keyframe's SPS (`h264Codec` in nsl1.ts), and Chromium's WebCodecs decodes High in hardware and software.
    public static let profileHigh = true
    /// No periodic keyframes: a keyframe starts a stream, a generation, or follows a frame that was never sent.
    public static let maxKeyFrameInterval = 1_000_000
    public static let maxKeyFrameIntervalSeconds = 100_000.0
    /// `quality`: the system's default rate control at 20 Mbit/s keeps every frame (the spike: 104 of 104 a
    /// second busy). Without a cap it treats the bitrate as a hint (52 Mbit/s busy at an 8 Mbit/s ask);
    /// true adds `DataRateLimits` at `qualityBitrate` over `dataRateWindowSeconds`, if the trial showed it
    /// still keeps every frame.
    public static let qualityDataRateLimits = false
    /// `budget`: low-latency rate control holds the bitrate by dropping frames (13 of 105 a second busy
    /// at 8 Mbit/s). True uses `DataRateLimits` without it instead, if the trial showed 90 fps or more within
    /// 1.5 times the bitrate.
    public static let budgetDataRateLimits = false
    public static let dataRateWindowSeconds = 1.0
    /// Surfaces ScreenCaptureKit may have out at once: the encoders' frames in flight and the last picture
    /// kept for the still window.
    public static let queueDepth = 6
    /// An encoder failing this many times in a row ends its stream with `error`; fewer make it again.
    public static let rebuildLimit = 3
    /// How often the window's live bounds are read: gone is `window-closed`, another size a resize.
    public static let windowCheck: Duration = .milliseconds(250)
    /// A window this far off the size the capture is configured for (in points) has resized.
    public static let resizeTolerance = 0.01
    /// The display's rate when it cannot be read.
    public static let fallbackRefresh = 60
}
