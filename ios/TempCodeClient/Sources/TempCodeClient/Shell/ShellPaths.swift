import Foundation
import TempCodeContract

/// The two columns of a tab's split.
public enum ShellColumn: Sendable, Hashable {
    case sidebar
    case detail
}

/// Which column each route opens in, and where a thread lives. The lists
/// stay in the sidebar; a project's shell, a bare thread, Settings and Hosts
/// take the detail (a 320 pt sidebar is no place for a settings form), and so
/// do LifeOS's places (`lifePlaces`), which carry their own lists.
/// Collapsed, both push as one stack.
public enum ShellPaths {
    public static func column(of route: Route) -> ShellColumn {
        switch route {
        case .place(let place, _):
            return lifePlaces.contains(place) ? .detail : .sidebar
        case .workspace, .archivedThreads, .archivedProjects, .outbox, .digest, .computers, .folder:
            return .sidebar
        case .project, .thread, .settings, .hosts, .outboxItem, .workSettings, .houseRules, .workView, .file, .chat, .person, .lifeProject, .prep, .clash, .filesFile, .msformAnswers:
            return .detail
        }
    }

    /// The tab a route opens in when something outside a tab names it (a notice, a link, a new
    /// thread, an old save): Work's places and screens in Work, the rest on Home. A thread, a
    /// project's shell and a workspace are Work's when the lists say so (`isWork`).
    public static func tab(of route: Route, isWork: (Route) -> Bool) -> AppTab {
        switch route {
        case .place, .outbox, .digest, .computers, .outboxItem, .workSettings, .houseRules, .workView, .file, .chat, .person, .lifeProject, .prep, .clash, .folder, .filesFile, .msformAnswers:
            return .work
        case .thread, .project, .workspace:
            return isWork(route) ? .work : .home
        case .archivedThreads, .archivedProjects, .settings, .hosts:
            return .home
        }
    }

    /// Whether the lists put a thread, a project's shell or a workspace in Work: a thread by its
    /// scope, a shell by its workspace's kind, a workspace by its own. False while no host lists it.
    public nonisolated static func isWork(_ route: Route, hosts: [HomeHostInput]) -> Bool {
        switch route {
        case .thread(let environmentId, let sessionId, _):
            return hosts.first { $0.environmentId == environmentId }?.sessions.first { $0.id == sessionId }?.scope == .work
        case .project(let key, let thread, _):
            if let shown = thread.flatMap(split) {
                return isWork(.thread(environmentId: shown.environmentId, sessionId: shown.sessionId, seq: nil), hosts: hosts)
            }
            guard let lead = ThreadStrip.scope(key: key, hosts: hosts)?.lead else { return false }
            return hosts.first { $0.environmentId == lead.environmentId }?.workspaces.first { $0.id == lead.workspaceId }?.kind == .work
        case .workspace(let key):
            if key == HomeSections.workChatsKey { return true }
            return hosts.contains { host in host.workspaces.contains { $0.kind == .work && ProjectPairs.key(host.environmentId, $0) == key } }
        default:
            return false
        }
    }

    /// The list a route from outside stands on, so Back from it is that list: a held item over
    /// the Outbox. Nil for a route that opens alone.
    public static func list(under route: Route) -> Route? {
        if case .outboxItem = route { return .place(.outbox) }
        if case .chat = route { return .place(.messages) }
        if case .person = route { return .place(.people) }
        // A meeting's page and a clash are reached from Today's rows: from outside, Back is Today.
        if case .prep = route { return .place(.today) }
        if case .clash = route { return .place(.today) }
        // A project's page is reached from Today's Due rows.
        if case .lifeProject = route { return .place(.today) }
        // A folder or a file named from outside stands on Files.
        if case .folder = route { return .place(.files) }
        if case .filesFile = route { return .place(.files) }
        return nil
    }

    /// What a detail root is as a screen: a project's shell is the same
    /// screen whichever of its threads it shows, so a chip's tap swaps the
    /// thread under the strip and keeps the strip; anything else is its route.
    public static func identity(of route: Route?) -> String {
        switch route {
        case .project(let key, _, _)?: return "project:\(key)"
        case let route?: return String(describing: route)
        case nil: return ""
        }
    }

    /// The thread a route shows: a bare thread, or the one a shell holds.
    public static func shown(_ route: Route?) -> (environmentId: String, sessionId: String)? {
        switch route {
        case .thread(let environmentId, let sessionId, _)?: return (environmentId, sessionId)
        case .project(_, let thread?, _)?: return split(thread)
        default: return nil
        }
    }

    /// A chip id (`<environmentId>:<sessionId>`) in its two parts. An
    /// environment id never holds a colon; a session id may.
    public static func split(_ thread: String) -> (environmentId: String, sessionId: String)? {
        guard let colon = thread.firstIndex(of: ":") else { return nil }
        let env = String(thread[..<colon])
        let id = String(thread[thread.index(after: colon)...])
        return env.isEmpty || id.isEmpty ? nil : (env, id)
    }

    /// The thread a route shows: a thread's own, or the one a project's shell has open.
    public static func thread(of route: Route) -> (environmentId: String, sessionId: String)? {
        switch route {
        case .thread(let environmentId, let sessionId, _): (environmentId, sessionId)
        case .project(_, let thread?, _): split(thread)
        default: nil
        }
    }

    /// Where a route opens: the detail's root and what to push over it.
    public struct Placement: Sendable, Hashable {
        public var root: Route
        public var push: Route?
    }

    /// Every root of a project or of a workspace's loose chats opens in its
    /// shell; a subagent opens its root's shell and pushes over it; a chat
    /// outside every workspace, or a thread no host lists, opens bare. Any
    /// other route is itself.
    public nonisolated static func place(_ route: Route, hosts: [HomeHostInput]) -> Placement {
        guard case .thread(let environmentId, let sessionId, let seq) = route,
              let host = hosts.first(where: { $0.environmentId == environmentId }),
              let root = ThreadStrip.root(of: sessionId, in: host.sessions),
              let scope = ThreadStrip.scope(for: route, hosts: hosts) else { return Placement(root: route, push: nil) }
        if root.id == sessionId {
            return Placement(root: .project(key: scope.key, thread: "\(environmentId):\(sessionId)", seq: seq), push: nil)
        }
        return Placement(root: .project(key: scope.key, thread: "\(environmentId):\(root.id)"), push: route)
    }

    /// A thread that opened bare because its host had not listed it yet (a
    /// notification's tap on a cold launch, a thread made a moment ago),
    /// placed where `place` puts it now that the lists know it; nil while
    /// it still opens bare, and for any other route.
    public nonisolated static func relisted(_ root: Route?, hosts: [HomeHostInput]) -> Placement? {
        guard let root, case .thread = root else { return nil }
        let placed = place(root, hosts: hosts)
        return placed.root == root ? nil : placed
    }

    /// Whether the shell still waits on the lists for the bare thread at the
    /// detail's root (`relisted`), nothing pushed over it. A root still bare
    /// after its host's complete list is `settled` with what decided it: the
    /// count of that host's complete lists (`lists`, 0 before the first; a
    /// walk cut short is no list), its workspace and project lists' stamp
    /// (`catalog`: their push, or a list answer after one that failed) and
    /// how the host names the thread (`placing`: absent, or the fields that
    /// place it, `BareSettle.placing`). It is looked at again only when one
    /// of them moves. The three are the client's stamps and its untracked
    /// index (`EnvironmentClient.completeLists`, `catalogStamp`,
    /// `watchPlacing`), so a push that moves none of them re-runs nothing,
    /// and the lists (`hosts`, every host's rows) are built only then.
    public nonisolated static func awaitsListing(_ root: Route?, stackEmpty: Bool, settled: inout BareSettle?, lists: (String) -> Int, catalog: (String) -> Int, placing: (String, String) -> String?, hosts: () -> [HomeHostInput]) -> Bool {
        guard let root, case .thread(let environmentId, let sessionId, _) = root, stackEmpty else { return false }
        let now = BareSettle(root: root, lists: lists(environmentId), catalog: catalog(environmentId), placing: placing(environmentId, sessionId))
        if now == settled { return false }
        if relisted(root, hosts: hosts()) != nil { return true }
        if now.lists > 0 { settled = now }
        return false
    }

    /// A project's tap (its card, a search's project row): the shell with
    /// its landing. Already in that shell, nothing moves (a thread turning
    /// active never takes the person's place). Else the landing:
    /// `ProjectLanding`'s active thread, else the remembered one (a project
    /// left on its draft comes back on it), else the draft.
    public nonisolated static func land(key: String, current: Route?, hosts: [HomeHostInput], remembered: ShellLanding?) -> Route {
        if case .project(let open, _, _)? = current, open == key, let current { return current }
        guard let scope = ThreadStrip.scope(key: key, hosts: hosts) else { return .project(key: key) }
        if let active = ProjectLanding.active(scope: scope, hosts: hosts) {
            return .project(key: key, thread: "\(active.environmentId):\(active.meta.id)")
        }
        guard case .thread(let thread)? = remembered,
              scope.roots.contains(where: { $0.id == thread && !$0.item.meta.archived }) else { return .project(key: key) }
        return .project(key: key, thread: thread)
    }
}

/// What a project's shell showed last: one of its threads, or its draft.
public enum ShellLanding: Codable, Sendable, Hashable {
    case thread(String)
    case draft
}

/// The thread last on screen in each shell, keyed by the scope's key (a
/// linked project's copies share their link id), so a card's tap comes back
/// where the person left. Persisted in UserDefaults by `ShellLandingStore`.
public struct ShellLandings: Codable, Sendable, Hashable {
    public static let maxEntries = 256
    public var entries: [String: ShellLanding] = [:]
    /// Most recent last, for the cap.
    public var order: [String] = []

    public init() {}

    public subscript(key: String) -> ShellLanding? { entries[key] }

    /// True when anything changed.
    @discardableResult
    public mutating func remember(_ landing: ShellLanding, for key: String) -> Bool {
        guard entries[key] != landing || order.last != key else { return false }
        entries[key] = landing
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.maxEntries { entries[order.removeFirst()] = nil }
        return true
    }
}

@MainActor
public final class ShellLandingStore {
    public static let defaultsKey = "shell.landing.v1"
    public static let shared = ShellLandingStore()
    private let defaults: UserDefaults
    public private(set) var landings: ShellLandings

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        landings = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(ShellLandings.self, from: $0) } ?? ShellLandings()
    }

    public subscript(key: String) -> ShellLanding? { landings[key] }

    /// The shell at `route` is on screen: remember what it shows.
    public func remember(_ route: Route) {
        guard case .project(let key, let thread, _) = route else { return }
        guard landings.remember(thread.map(ShellLanding.thread) ?? .draft, for: key),
              let data = try? JSONEncoder().encode(landings) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

/// One tab's place: the sidebar's routes, the route at the detail's root,
/// and whatever the detail pushed over it (the app's own routes, encoded by
/// the app as a `NavigationPath.CodableRepresentation`, opaque here).
public struct ColumnMemory: Codable, Hashable, Sendable {
    public var sidebar: [Route]
    public var detailRoot: Route?
    public var detailStack: Data?
    /// This tab's own sidebar toggle; nil in a save from before each tab kept its own.
    public var sidebarShown: Bool?
    /// A landing still showing its list over his hidden sidebar (`WorkTab.ListLanding`), so a same-day relaunch comes
    /// back on the list he saw; nil in an older save, and when none is in force.
    public var landing: WorkTab.ListLanding?

    public init(sidebar: [Route] = [], detailRoot: Route? = nil, detailStack: Data? = nil, sidebarShown: Bool? = nil, landing: WorkTab.ListLanding? = nil) {
        self.sidebar = sidebar
        self.detailRoot = detailRoot
        self.detailStack = detailStack
        self.sidebarShown = sidebarShown
        self.landing = landing
    }

    /// Nothing open and nothing pushed: the tab at its root.
    public var isRoot: Bool { sidebar.isEmpty && detailRoot == nil }

    private enum CodingKeys: String, CodingKey { case sidebar, detailRoot, detailStack, sidebarShown, landing }

    /// A route this build cannot read (a later contract changed one of its bodies) costs only itself: the sidebar
    /// keeps the routes before it, and a detail root it cannot read goes with what was pushed over it. The other
    /// tabs, and the rest of this one, come back.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var sidebar: [Route] = []
        if var list = try? c.nestedUnkeyedContainer(forKey: .sidebar) {
            while !list.isAtEnd, let route = try? list.decode(Route.self) { sidebar.append(route) }
        }
        self.sidebar = sidebar
        let saved = c.contains(.detailRoot) && (try? c.decodeNil(forKey: .detailRoot)) == false
        let root = try? c.decode(Route.self, forKey: .detailRoot)
        detailRoot = saved ? root : nil
        detailStack = saved && root == nil ? nil : (try? c.decodeIfPresent(Data.self, forKey: .detailStack)) ?? nil
        sidebarShown = (try? c.decodeIfPresent(Bool.self, forKey: .sidebarShown)) ?? nil
        landing = (try? c.decodeIfPresent(WorkTab.ListLanding.self, forKey: .landing)) ?? nil
    }
}

/// Where the person was, shape-independent: the same snapshot opens a
/// thread on top of the Project list folded and in the detail beside it
/// unfolded. The app writes it on every navigator change under
/// `navigation.memory.v3` and restores it before the first frame.
public struct NavigationSnapshot: Codable, Hashable, Sendable {
    public static let key = "navigation.memory.v3"
    /// v2 kept a thread at the detail's root and a project's list in the
    /// sidebar; its routes mean other screens now.
    public static let v2Key = "navigation.memory.v2"

    /// What a launch restores: the v3 snapshot whole, else v2's tab and
    /// toggle with every column at its root (mapping a v2 thread to its
    /// project needs the session cache, which the restore runs before).
    public static func restore(v3: Data?, v2: Data?) -> NavigationSnapshot? {
        if let v3, let snapshot = try? JSONDecoder().decode(NavigationSnapshot.self, from: v3) { return snapshot }
        struct Old: Decodable {
            var tab: AppTab
            var sidebarShown: Bool?
        }
        guard let v2, let old = try? JSONDecoder().decode(Old.self, from: v2) else { return nil }
        return NavigationSnapshot(tab: old.tab, sidebarShown: old.sidebarShown ?? true, hasWorkTab: nil)
    }

    public var tab: AppTab
    public var columns: [AppTab: ColumnMemory]
    /// The sidebar toggle of a save from before each tab kept its own (`ColumnMemory.sidebarShown`);
    /// still written, as Home's.
    public var sidebarShown: Bool
    /// True in a save made with the Work tab. One without it keeps Work's screens on Home, and
    /// `movingWork` moves them once the lists can say which are Work's.
    public var hasWorkTab: Bool?

    public init(tab: AppTab = .home, columns: [AppTab: ColumnMemory] = [:], sidebarShown: Bool = true, hasWorkTab: Bool? = true) {
        self.tab = tab
        self.columns = columns
        self.sidebarShown = sidebarShown
        self.hasWorkTab = hasWorkTab
    }

    /// A tab's sidebar toggle: its own, else the old save's one toggle.
    public func sidebarShown(in tab: AppTab) -> Bool { self[tab].sidebarShown ?? sidebarShown }

    /// A save from before the Work tab, with what Home held of Work moved to the Work tab: the
    /// sidebar when its first list is Work's (the Outbox, the Digest, Computers, a Work workspace,
    /// Work Chats), the detail and what it pushed when its root is. A place saved under its old
    /// route becomes its place. The tab follows what he was looking at: the detail when one was
    /// open, else the sidebar. `isWork` answers for a thread, a shell and a workspace from the
    /// lists, so the move waits for them. A save made with the Work tab comes back as it is.
    public func movingWork(isWork: (Route) -> Bool) -> NavigationSnapshot {
        guard hasWorkTab != true else { return self }
        var next = self
        next.hasWorkTab = true
        var home = self[.home]
        home.sidebar = home.sidebar.map(\.current)
        func works(_ route: Route) -> Bool { ShellPaths.tab(of: route, isWork: isWork) == .work }
        let sidebarWorks = home.sidebar.first.map(works) ?? false
        let detailWorks = home.detailRoot.map(works) ?? false
        var work = ColumnMemory(sidebarShown: home.sidebarShown)
        if sidebarWorks {
            work.sidebar = home.sidebar
            home.sidebar = []
        }
        if detailWorks {
            work.detailRoot = home.detailRoot
            work.detailStack = home.detailStack
            home.detailRoot = nil
            home.detailStack = nil
        }
        next[.home] = home
        if sidebarWorks || detailWorks { next[.work] = work }
        if tab == .home, self[.home].detailRoot == nil ? sidebarWorks : detailWorks { next.tab = .work }
        return next
    }

    public subscript(tab: AppTab) -> ColumnMemory {
        get { columns[tab] ?? ColumnMemory() }
        set { columns[tab] = newValue }
    }
}

/// What left a bare thread bare (`ShellPaths.awaitsListing`): its route, the
/// host's complete lists so far, its workspace and project lists' stamp, and
/// the fields its place reads, nil while the host has not named it.
public struct BareSettle: Sendable, Hashable {
    public var root: Route
    public var lists: Int
    public var catalog: Int
    public var placing: String?

    public init(root: Route, lists: Int, catalog: Int = 0, placing: String?) {
        self.root = root
        self.lists = lists
        self.catalog = catalog
        self.placing = placing
    }

    /// The meta's fields `ShellPaths.place` reads: its project, workspace, parent and folder.
    public static func placing(of meta: SessionMeta) -> String {
        [meta.projectId ?? "", meta.workspaceId ?? "", meta.parentId ?? "", meta.cwd].joined(separator: "\u{1F}")
    }
}
