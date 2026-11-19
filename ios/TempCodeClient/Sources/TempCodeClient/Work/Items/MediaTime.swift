import Foundation
import TempCodeContract

/// A version's frames (src/shared/mediaFrames.ts, the same arithmetic): the
/// player's time to the frame a comment is pinned at, and back.
public extension FrameTable {
    var frameCount: Int {
        switch self {
        case .cfr(let t): t.count
        case .vfr(let t): t.times.count
        case .unknown: 0
        }
    }

    var fps: Double {
        switch self {
        case .cfr(let t):
            return t.rate.den == 0 ? 0 : Double(t.rate.num) / Double(t.rate.den)
        case .vfr(let t):
            let duration = frameStart(frameCount) - frameStart(0)
            return duration > 0 ? Double(t.times.count) / duration : 0
        case .unknown:
            return 0
        }
    }

    func frameStart(_ n: Int) -> Double {
        switch self {
        case .cfr(let t): t.rate.num == 0 ? t.start : t.start + Double(n) * Double(t.rate.den) / Double(t.rate.num)
        case .vfr(let t): n >= t.times.count ? t.end : (t.times.isEmpty ? 0 : t.times[max(0, n)])
        case .unknown: 0
        }
    }

    /// The middle of frame `n`: a seek there shows it in every decoder.
    func frameCentre(_ n: Int) -> Double {
        let i = max(0, min(frameCount - 1, n))
        return (frameStart(i) + frameStart(i + 1)) / 2
    }

    /// The frame showing at media time `s`.
    func frameAt(_ s: Double) -> Int {
        let last = max(0, frameCount - 1)
        let slack = min(0.001, 0.25 / (fps > 0 ? fps : 24))
        switch self {
        case .cfr(let t):
            guard t.rate.den != 0 else { return 0 }
            let n = Int(((s + slack - t.start) * Double(t.rate.num) / Double(t.rate.den)).rounded(.down))
            return max(0, min(last, n))
        case .vfr(let t):
            var lo = 0, hi = last
            while lo < hi {
                let mid = (lo + hi + 1) >> 1
                if t.times[mid] <= s + slack { lo = mid } else { hi = mid - 1 }
            }
            return lo
        case .unknown:
            return 0
        }
    }
}

/// `0:41`, `1:02:05`: a clock for people.
public func mediaClock(_ seconds: Double) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    let h = whole / 3600, m = (whole % 3600) / 60, s = whole % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

/// What the phone plays of a version: the fMP4 proxy's segments, which it fetches and joins into
/// one file, or a picture from its tiles.
public enum MediaPick: Equatable, Sendable {
    case segments(init: String, count: Int, table: FrameTable)
    /// The proxy is still being cut: read the view again.
    case preparing
    case picture(preview: String, width: Double, height: Double, tile: Double, overlap: Double, levels: Int, minLevel: Int)
    case none

    public static func of(_ plays: [MediaPlay]) -> MediaPick {
        for play in plays {
            switch play {
            case .hls(let hls): return hls.ended ? .segments(init: hls.`init`, count: hls.segments.count, table: hls.table) : .preparing
            case .tiles(let t): return .picture(preview: t.preview, width: t.width, height: t.height, tile: t.tile, overlap: t.overlap, levels: t.levels, minLevel: t.minLevel)
            default: continue
            }
        }
        return .none
    }
}

/// Deep Zoom: the level whose picture is at most `maxSide` on its long side, and the tiles that cover it.
public struct TileGrid: Equatable, Sendable {
    public var level: Int
    public var width: Int
    public var height: Int
    public var columns: Int
    public var rows: Int

    public init(width: Double, height: Double, tile: Double, levels: Int, minLevel: Int, maxSide: Double) {
        let full = max(1, levels - 1)
        var level = full
        while level > minLevel, max(width, height) / pow(2, Double(full - level)) > maxSide { level -= 1 }
        let scale = pow(2, Double(full - level))
        self.level = level
        self.width = max(1, Int((width / scale).rounded(.up)))
        self.height = max(1, Int((height / scale).rounded(.up)))
        let side = max(1, tile)
        columns = max(1, Int((Double(self.width) / side).rounded(.up)))
        rows = max(1, Int((Double(self.height) / side).rounded(.up)))
    }
}
