import Foundation

/// Two pages for an open file on the Duo (docs/IOS-DESIGN.md "Work in every pose"): a document beside its
/// comments, a slide beside its notes, a video beside its notes. Open and upright like a book, the fold's band
/// stands between the two pages, the thing on the leading one and what goes with it on the trailing. Half open on a
/// table, the band lies across the middle (`TabletopHalves`): the thing stands on the upper half and what goes with
/// it lies on the lower. Anywhere else the file keeps its one column. Nothing sits within the band. Pure: the app
/// hands the container's own size and the band in the container's space.
public enum ReaderHalves {
    public enum Layout: Equatable, Sendable {
        /// Side by side across a band that stands upright.
        case pages(thing: CGRect, with: CGRect)
        /// Above and below a band that lies across.
        case table(thing: CGRect, with: CGRect)
    }

    /// The narrowest page worth having: the 320 pt a phone's column holds a comment or a slide's notes in.
    public static let minimumPage: Double = 320

    public static func of(size: CGSize, division: CGRect?) -> Layout? {
        guard let band = division, size.width > 0, size.height > 0 else { return nil }
        let window = CGRect(origin: .zero, size: size)
        if band.width > band.height {
            return TabletopHalves.of(window: window, division: band).map { .table(thing: $0.thing, with: $0.controls) }
        }
        let leading = band.minX, trailing = size.width - band.maxX
        guard leading >= minimumPage, trailing >= minimumPage else { return nil }
        return .pages(
            thing: CGRect(x: 0, y: 0, width: leading, height: size.height),
            with: CGRect(x: band.maxX, y: 0, width: trailing, height: size.height)
        )
    }
}
