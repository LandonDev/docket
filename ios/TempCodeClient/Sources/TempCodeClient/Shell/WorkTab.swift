import Foundation

/// The Work tab's own rules: when the bar has it, what a second press does, and where it opens.
public enum WorkTab {
    /// The bar has the Work tab while any host has Work on. A launch on the tab keeps it until the
    /// hosts are read, so the place he left is not lost to a first frame that knows no host.
    public static func shows(anyOn: Bool, ready: Bool, selected: AppTab) -> Bool {
        anyOn || (!ready && selected == .work)
    }

    /// A press on the tab he is already on goes back to the Work list, as the system's tabs do.
    public static func popsToList(selected: AppTab, pressed: AppTab) -> Bool {
        selected == .work && pressed == .work
    }

    /// The place the tab opens on: Today, and the Outbox until Today ships.
    public static var firstPlace: WorkPlace { WorkPlace.shipped.contains(.today) ? .today : .outbox }

    /// UserDefaults key of the last local day the tab was entered.
    public static let dayKey = "work.tab.day"

    /// A local day as the stamp keeps it.
    public static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }

    /// Whether his own entry into the tab opens `firstPlace` instead of where he was: the first
    /// entry of a local day, or a tab with no place saved. Never over a draft he left in the
    /// detail. Something that brings him to the tab (a notice, a link, a new thread) stamps the
    /// day itself, so it is that day's first entry and what it opened stays.
    public static func opensFirstPlace(stamp: String?, today: String, saved: ColumnMemory?, draft: Bool) -> Bool {
        if draft { return false }
        return stamp != today || saved == nil
    }

    /// What his own entry into the tab opens (`opensFirstPlace`): the day's first place, a place's list pushed over the
    /// Work list in the sidebar column (`ShellPaths.column`), whose pick fills the empty detail on the tiled open Duo
    /// (`ShellSelection.decide`); nil where he goes back to where he was.
    public static func entryRoute(stamp: String?, today: String, saved: ColumnMemory?, draft: Bool) -> Route? {
        opensFirstPlace(stamp: stamp, today: today, saved: saved, draft: draft) ? .place(firstPlace) : nil
    }

    /// A landing on a list he must see: the day's first place opened by his entry, or the Work list after a press on the
    /// tab he is on. Both clear the detail, so with his sidebar hidden the split would show "Nothing Selected" alone
    /// (council 16, Sol 3). `top` is the sidebar's top route the landing put there (nil: the Work list itself).
    public struct ListLanding: Hashable, Sendable, Codable {
        public var top: Route?
        public init(top: Route?) { self.top = top }

        /// Whether the landing shows the sidebar over his saved toggle: in a split pose, with no wide route in the
        /// detail, while the sidebar's top is the list it follows (`followed`), or while the detail is empty (council
        /// 17, Sol 2). His toggle itself is never written; his own press on the sidebar button, or a pick that closes
        /// an overlay, ends it, and his saved choice decides again.
        public func showsSidebar(pose: ShellPose, top now: Route?, wide: Bool, detailEmpty: Bool = false) -> Bool {
            pose.isSplit && !wide && (now == top || detailEmpty)
        }

        /// He moved within the column the landing showed (a place tapped in the Work list, Back from Today): the landing
        /// follows him, so the list he is using stays on screen (council 17, Opus 2.1). It ends only by his press on the
        /// sidebar button, or where the pose closes the column on its own (a pick in the overlay pose).
        public mutating func followed(to now: Route?) {
            top = now
        }
    }

    /// Whether the detail holds words he has not sent: a project's draft with text, or an open thread whose
    /// composer holds text, a chip or a photo (`UnsentThreads`). The day's first place never covers either.
    public static func holdsDraft(projectText: String?, threadUnsent: Bool) -> Bool {
        threadUnsent || projectText.map(ComposerDraftText.hasContent) == true
    }
}

/// Words a composer holds: anything but white space (the send's own test, `ComposerDraft.hasContent`).
public enum ComposerDraftText {
    public static func hasContent(_ text: String) -> Bool {
        text.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
    }
}

/// Which open thread composers hold something he has not sent (text, a chip, a photo), by host and thread: each
/// composer says so as it changes, and the Work tab's day start reads it (`WorkTab.holdsDraft`).
@MainActor
public final class UnsentThreads {
    public static let shared = UnsentThreads()
    private var unsent: Set<String> = []

    public init() {}

    public func set(environmentId: String, sessionId: String, unsent holds: Bool) {
        let key = "\(environmentId)/\(sessionId)"
        if holds { unsent.insert(key) } else { unsent.remove(key) }
    }

    public func holds(environmentId: String, sessionId: String) -> Bool {
        unsent.contains("\(environmentId)/\(sessionId)")
    }
}

/// The Work list: the Work tab's root, and the left column on the open Duo.
public enum WorkList {
    public struct Sections: Sendable, Hashable {
        /// The places for every job at once, Today first.
        public var places: [WorkPlace]
        /// A row a Work workspace.
        public var jobs: [HomeSections.Entry]
        public var chats: HomeSections.Entry?
        /// Review and the Digest, Computers while something is driven, Connections while one is broken.
        public var foot: [WorkPlace]

        public var isEmpty: Bool { places.isEmpty && jobs.isEmpty && chats == nil && foot.isEmpty }
    }

    static let places: [WorkPlace] = [.today, .outbox, .mail, .messages, .tasks, .agenda, .files, .people]
    static let foot: [WorkPlace] = [.review, .digest, .computers, .connections]

    /// `work` is Home's Work band (`HomeSections.Home.work`): empty while every host has Work off,
    /// and then the list is empty too.
    public static func sections(work: [HomeSections.Entry], shipped: Set<WorkPlace> = WorkPlace.shipped, driving: Bool, broken: Bool) -> Sections {
        guard !work.isEmpty else { return Sections(places: [], jobs: [], chats: nil, foot: []) }
        return Sections(
            places: places.filter(shipped.contains),
            jobs: work.filter { $0.kind != .workChats },
            chats: work.first { $0.kind == .workChats },
            foot: foot.filter { place in
                guard shipped.contains(place) else { return false }
                switch place {
                case .computers: return driving
                case .connections: return broken
                default: return true
                }
            }
        )
    }
}
