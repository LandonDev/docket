import Foundation

/// What a list in the sidebar column shows beside it on the open Duo. With
/// nothing picked the list picks its first row that needs him, so the right
/// side is never empty on arrival; a pick that is still in the list is kept,
/// and a pick whose row left makes way for the next. Opening a row only reads:
/// a pick has no outward effect. In a stack, in the overlay pose and while the
/// detail shows something that is not this list's, nothing is picked for him.
public enum ShellSelection {
    /// What the detail column holds, as the list on screen sees it.
    public enum Detail: Sendable, Hashable {
        case empty
        /// One of this list's rows, by its id.
        case row(String)
        /// Something he opened from elsewhere: his, never replaced.
        case other
    }

    public enum Decision: Sendable, Hashable {
        case keep
        case open(String)
        /// The picked row left the list and nothing waits to take its place.
        case clear
    }

    /// `first`: the list's rows in the order to pick from, those that need him first (the caller
    /// leaves out rows that need nothing when an empty right side is the honest answer).
    /// `present`: every row in the list now. `onScreen`: the list is the sidebar column's top.
    public static func decide(first: [String], present: Set<String>, detail: Detail, pose: ShellPose, onScreen: Bool) -> Decision {
        guard onScreen, case .split(.tiled) = pose else { return .keep }
        switch detail {
        case .other:
            return .keep
        case .empty:
            return first.first.map(Decision.open) ?? .keep
        case .row(let id):
            if present.contains(id) { return .keep }
            return first.first.map(Decision.open) ?? .clear
        }
    }
}

public extension ShellPaths {
    /// The views of a job that take the whole open Duo: LifeOS's own screens, which show two
    /// pages on the hinge when they have the width.
    static let wideViews: Set<String> = ["mail", "tasks", "agenda"]

    /// The places of the Work tab that are LifeOS's own screens: each is a whole screen with its own list and
    /// pages, so it takes the detail rather than the sidebar, and it is wide.
    static let lifePlaces: Set<WorkPlace> = [.mail, .tasks, .agenda]

    /// A wide route puts the sidebar away so its two halves sit either side of the fold: LifeOS's
    /// Mail, Tasks and Agenda (a job's or every job's), an open file (a document with its comments, a deck with its
    /// notes) whether a thread or Files opened it, and a thread with a file beside its chat (`hasItem`: the thread
    /// at the route has an open item).
    static func wide(of route: Route?, hasItem: Bool = false) -> Bool {
        switch route {
        case .workView(_, _, let view)?: wideViews.contains(view)
        case .place(let place, _)?: lifePlaces.contains(place)
        case .file?, .filesFile?: true
        case .thread?, .project(_, .some, _)?: hasItem
        default: false
        }
    }
}

/// Whether the split shows its sidebar. Derived, never written by a route: his own toggle for
/// the tab stands on every ordinary route; a wide route hides the sidebar without touching that
/// toggle; and his press on the sidebar button while a wide route is open is that route's own
/// override, forgotten when he leaves it.
public struct SidebarVisibility: Sendable, Hashable {
    /// His toggle for this tab, remembered across folds and launches.
    public var preference: Bool
    /// His press while a wide route was open: the route's identity (`ShellPaths.identity`) and what he chose.
    public var override: Override?

    public struct Override: Sendable, Hashable {
        public var route: String
        public var shown: Bool
    }

    public init(preference: Bool = true, override: Override? = nil) {
        self.preference = preference
        self.override = override
    }

    /// What the split shows for the route in the detail.
    public func shown(route: String, wide: Bool) -> Bool {
        guard wide else { return preference }
        if let override, override.route == route { return override.shown }
        return false
    }

    /// His press on the sidebar button: the route's override on a wide route, his preference otherwise.
    public mutating func toggled(to shown: Bool, route: String, wide: Bool) {
        if wide {
            override = Override(route: route, shown: shown)
        } else {
            preference = shown
        }
    }

    /// The detail moved to another screen: an override is that screen's alone.
    public mutating func left(to route: String) {
        if let override, override.route != route { self.override = nil }
    }
}
