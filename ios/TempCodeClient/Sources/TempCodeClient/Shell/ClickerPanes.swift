import Foundation

/// How the clicker lays out (docs/IOS-DESIGN.md "The clicker"). A phone held upright stacks: the notes on top,
/// the count line, Previous as a band, Next as the lower half. On its side, or on the Duo unfolded, it splits:
/// the notes on the leading pane, the controls on the trailing one, at half the width, or on the fold's
/// division band where the app reports one that leaves each pane `minimum`.
public enum ClickerPanes {
    public enum Layout: Equatable, Sendable {
        case stacked
        /// The panes' widths; what lies between them is the band.
        case split(notes: Double, controls: Double)
    }

    /// The narrowest pane worth having: the notes at the document measure's half, Next's word with room.
    public static let minimumPane: Double = 240

    /// `regularWidth`: the window's width size class (the Duo unfolded either way up). `division`: the active
    /// division band in the screen's own coordinates, leading to trailing.
    public static func of(width: Double, height: Double, regularWidth: Bool, division: CGRect? = nil) -> Layout {
        guard regularWidth || width > height else { return .stacked }
        if let band = division, band.height > band.width, band.minX >= minimumPane, width - band.maxX >= minimumPane {
            return .split(notes: band.minX, controls: width - band.maxX)
        }
        let notes = (width / 2).rounded(.down)
        return .split(notes: notes, controls: width - notes)
    }
}
