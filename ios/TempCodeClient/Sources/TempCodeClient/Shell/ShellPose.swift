import Foundation

/// A window's size class along one axis, as the shell reads it: a package
/// enum so the rule needs no SwiftUI.
public enum SizeClass: Sendable, Hashable {
    case compact
    case regular
}

/// How the split lays its sidebar when the width is regular: beside the
/// detail (every regular pose, upright too, where the list asks 320 pt), or
/// over it behind the toggle, a mode kept for a split told otherwise. The
/// plan's overlay upright, with a 640 pt reading width, is the owner's flip
/// (council 18 Opus 2.1).
public enum SidebarMode: Sendable, Hashable {
    case tiled
    case overlay
}

/// A list screen's title mode: large where there is height for it, inline
/// where there is not (a 96 pt title on a 466 pt screen leaves four rows).
public enum TitleDisplay: Sendable, Hashable {
    case large
    case inline
}

/// The shell's one shape fact, decided once at the root from the window's
/// size classes and its own bounds (never the idiom, the orientation or the
/// screen): compact width is the phone's stacks; regular width is a split
/// per tab. Every screen reads this, never `horizontalSizeClass`, for a
/// shell decision.
public enum ShellPose: Sendable, Hashable {
    /// The three stacks; `short` when the height is compact too (folded landscape).
    case stack(short: Bool)
    /// Sidebar and detail side by side (tiled) or the sidebar over the detail (overlay).
    case split(sidebar: SidebarMode)

    /// The rule. A nil size class (no window yet) reads as compact.
    public static func of(horizontal: SizeClass?, vertical: SizeClass?, size: CGSize) -> ShellPose {
        switch horizontal ?? .compact {
        case .compact:
            return .stack(short: vertical == .compact)
        case .regular:
            // Tiled in every regular pose, upright too: iOS 27.1 lays the open Duo's split side by side at 669×951
            // (iw13: a 250 pt list beside the detail), and the split asks the balanced style so it always does
            // (`ShellSplit`). The overlay mode stays for a split that is told otherwise.
            _ = size
            return .split(sidebar: .tiled)
        }
    }

    public var isSplit: Bool {
        if case .split = self { return true }
        return false
    }

    public var isStack: Bool { !isSplit }

    /// The overlay pose: the sidebar hides behind the system toggle.
    public var isOverlay: Bool { self == .split(sidebar: .overlay) }

    /// How long after the pose changes a write of the split's visibility is
    /// the split's own: collapsing, SwiftUI writes `.all`, and expanding it
    /// writes `.detailOnly` then `.all` inside about 40 ms, none of it the
    /// person's toggle.
    public static let foldSettle: TimeInterval = 0.5

    /// Whether a write of the split's visibility is the person's, to keep as
    /// the remembered toggle: only in a split, and only once the pose has held
    /// for `foldSettle`, and the split has been on screen as long (`sinceShown`):
    /// a split built or shown again in the overlay pose writes `.detailOnly` as
    /// it appears (a tab first opened there), which is never his toggle.
    public static func keepsVisibilityWrite(pose: ShellPose, sincePoseChange: TimeInterval, sinceShown: TimeInterval = .infinity) -> Bool {
        pose.isSplit && sincePoseChange >= foldSettle && sinceShown >= foldSettle
    }

    /// Whether opening a route in the detail closes the sidebar by writing his toggle: in the overlay pose, as Mail's
    /// overlay closes on a pick, but never for a wide route, which puts the sidebar away without writing it
    /// (`SidebarVisibility`); otherwise the list he comes back to would stay hidden (council 13 and 14, Sol).
    public static func pickHidesSidebar(pose: ShellPose, wide: Bool) -> Bool {
        pose.isOverlay && !wide
    }

    /// Whether a change of the sidebar is his toggle, by where it came from. His press on the shell's sidebar
    /// button is his, in a split, at any moment (the tab just shown, a fold a breath ago); a write of the split's
    /// binding is his only by `keepsVisibilityWrite`'s time rule, which filters the split's own writes as it is
    /// built, shown or folded (council 11, Sol 3).
    public static func isHisToggle(_ source: SidebarChange, pose: ShellPose, sincePoseChange: TimeInterval, sinceShown: TimeInterval) -> Bool {
        switch source {
        case .button: pose.isSplit
        case .binding: keepsVisibilityWrite(pose: pose, sincePoseChange: sincePoseChange, sinceShown: sinceShown)
        }
    }
}

/// Where the shell's sidebar button stands, in place of the system's toggle, on every page of the column it is in.
public enum SidebarButtonPlace: Sendable, Hashable {
    /// The column whose bar holds it.
    public enum Column: String, Sendable, Hashable { case sidebar, detail }
    /// The edge of that bar: the system's toggle sat at the sidebar bar's trailing edge and the detail bar's leading.
    public enum Edge: Sendable, Hashable { case leading, trailing }

    /// Whether the column's bar holds the button: the sidebar's while the sidebar shows, the detail's while it does not;
    /// never in a stack.
    public static func shows(in column: Column, pose: ShellPose, sidebarShown: Bool) -> Bool {
        guard pose.isSplit else { return false }
        switch column {
        case .sidebar: return sidebarShown
        // One button: the detail's bar holds it only while the sidebar is put away (iw13 drew two side by side).
        case .detail: return !sidebarShown
        }
    }

    public static func edge(of column: Column) -> Edge { column == .sidebar ? .trailing : .leading }
}

/// Where a change of the split's sidebar came from: the shell's own sidebar button (his press, recorded by the
/// button's action), or the split writing its visibility binding (a fold, a build, a swipe, a tap outside an overlay).
public enum SidebarChange: Sendable, Hashable {
    case button
    case binding
}

/// A write of the split's visibility that `keepsVisibilityWrite` let through,
/// held for `foldSettle` before it becomes his toggle: a fold can make the
/// split write `.detailOnly` a few milliseconds before the root sees the new
/// pose, so a write counts only if the pose also holds after it. The split
/// shows the held value at once; a pose change drops it.
public struct HeldVisibilityWrite: Sendable, Hashable {
    /// What the split wrote: the sidebar shown, or the detail alone.
    public var shown: Bool
    /// The pose it was written in.
    public var pose: ShellPose
    /// When it was written.
    public var at: Date
    /// The detail's route it was written over (`ShellPaths.identity`), and whether that route was wide: a write
    /// held over one route is never his toggle for another.
    public var route: String
    public var wide: Bool

    public init(shown: Bool, pose: ShellPose, at: Date, route: String = "", wide: Bool = false) {
        self.shown = shown
        self.pose = pose
        self.at = at
        self.route = route
        self.wide = wide
    }

    /// When the hold ends and the write may apply.
    public var due: Date { at.addingTimeInterval(ShellPose.foldSettle) }

    /// Whether the write becomes his toggle: the pose is still the one it was
    /// written in and has not changed since (`poseChangedAt`, the latest change).
    public func applies(pose now: ShellPose, poseChangedAt: Date) -> Bool {
        now == pose && poseChangedAt <= at
    }

    /// `applies`, and the detail still shows the route it was written over, as wide as it was: a pick in the
    /// sidebar during the hold that opened another route drops it, so it never writes that route's preference.
    public func applies(pose now: ShellPose, poseChangedAt: Date, route: String, wide: Bool) -> Bool {
        applies(pose: now, poseChangedAt: poseChangedAt) && route == self.route && wide == self.wide
    }
}

extension ShellPose {

    /// Whether the split, once a pose has settled, shows other than what the shell
    /// remembers: a write it made was dropped as a fold's (a tab built mid-fold
    /// hides its own column), and the binding, unchanged on our side, is never
    /// read again. Then the shell asks the split to read it once more.
    public static func splitStrays(pose: ShellPose, splitShows: Bool?, shows: Bool) -> Bool {
        guard pose.isSplit, let splitShows else { return false }
        return splitShows != shows
    }

    /// How long the split's binding answers what the split itself shows before it answers the shell's again
    /// (`SplitAnswer`): long enough for one update of the split to read it.
    public static let echoTurn: TimeInterval = 0.1

    /// How many times a stray split's check waits for the split to come on screen and settle before it gives up.
    public static let settleTries = 10

    /// Inline titles only on the short stack.
    public var titleDisplay: TitleDisplay {
        if case .stack(short: true) = self { return .inline }
        return .large
    }
}

/// What the split's visibility binding answers. NavigationSplitView acts on a change of the value it reads, never on
/// a value it already read: a tab built as the window settles (iw12: unfolded-portrait, then read as overlay) writes
/// `.detailOnly` as it is built, that write is dropped as a fold's, and a binding that keeps answering `.all` is a value
/// the split has already seen, so its list never comes back (iw12, Work's tab). Once a pose has settled and the split strays
/// (`ShellPose.splitStrays`), the binding answers what the split shows for one turn (`ShellPose.echoTurn`), then the
/// shell's again: a real change, which the split takes.
public struct SplitAnswer: Sendable, Hashable {
    /// The split's own value, answered for the one turn; nil: the shell's.
    public private(set) var echo: Bool?

    public init() {}

    /// What the binding answers now, the shell showing `shows`.
    public func answer(shows: Bool) -> Bool { echo ?? shows }

    /// The pose has settled: when the split shows other than the shell, answer the split's own value now (true).
    public mutating func strayed(pose: ShellPose, splitShows: Bool?, shows: Bool) -> Bool {
        guard ShellPose.splitStrays(pose: pose, splitShows: splitShows, shows: shows), let splitShows else { return false }
        echo = splitShows
        return true
    }

    /// The turn is over: the shell's value again, which the split now reads as a change.
    public mutating func settle() { echo = nil }

    /// His press on the sidebar button: whatever the split showed of its own, the shell's value (his press) is what
    /// the binding answers from now, and a stray check already waiting finds the split agreeing with it.
    public mutating func pressed() { echo = nil }
}

/// The split's sidebar column, the desktop's 260 px workspace column: 260
/// pt asked for, never past 320. Half open, the column follows the fold
/// when the fold sits past 260, so the sidebar fills the first panel.
public struct SidebarColumn: Sendable, Hashable {
    public var min: CGFloat
    public var ideal: CGFloat
    public var max: CGFloat

    public static let width: CGFloat = 260
    public static let widest: CGFloat = 320

    public static func of(halfOpen: Bool, foldX: CGFloat, tall: Bool = false) -> SidebarColumn {
        // A window taller than wide (unfolded portrait, tabletop): the list asks its widest, so its rows are not cut to a
        // few letters (iw13 measured 250 there and cut "Send to Kare…"). First: tabletop is half open, but its fold runs
        // across, so no seam to follow (council 18 Opus 2.3).
        if tall { return SidebarColumn(min: widest, ideal: widest, max: widest) }
        if halfOpen, foldX > width { return SidebarColumn(min: width, ideal: foldX, max: Swift.max(widest, foldX)) }
        return SidebarColumn(min: width, ideal: width, max: widest)
    }
}
