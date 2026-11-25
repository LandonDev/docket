import Foundation

/// On a table: the Duo half open and turned tall (669 × 951), the fold's division band lying across the
/// window's middle (docs/IOS-DESIGN.md "Work in every pose"). The thing stands on the upper half (a file,
/// a slide's notes, a video, the live picture, a voice note's words) and its controls lie on the lower
/// (the chat and its box, Next and Previous, the comments, the hold control). Nothing sits within the band.
/// Pure: the app hands the window and the band (`Duo.divisionBand`, iOS 27.1) in one coordinate space.
public enum TabletopHalves {
    public struct Halves: Equatable, Sendable {
        /// Above the band: what he looks at.
        public var thing: CGRect
        /// Below the band: what his hand reaches.
        public var controls: CGRect
    }

    /// The shortest half worth having: a slide's notes over a few lines, or Next and Previous at full height.
    public static let minimumHalf: Double = 200

    /// The two halves, or nil where the window is no table: no band, a band standing upright (the book pose
    /// and the open Duo, whose columns `ThreadPose` and `ClickerPanes` place), a band outside the window, or
    /// one that leaves either half under `minimumHalf`.
    public static func of(window: CGRect, division: CGRect?) -> Halves? {
        guard let band = division, band.width > band.height else { return nil }
        let upper = band.minY - window.minY
        let lower = window.maxY - band.maxY
        guard upper >= minimumHalf, lower >= minimumHalf else { return nil }
        return Halves(
            thing: CGRect(x: window.minX, y: window.minY, width: window.width, height: upper),
            controls: CGRect(x: window.minX, y: band.maxY, width: window.width, height: lower)
        )
    }
}
