import Observation
import SwiftUI
import TempCodeClient

/// Where one tab is: the sidebar's routes, the route at the detail's root
/// and whatever the detail pushed over it. The same values drive both
/// shapes: collapsed, the detail sits on top of the sidebar's stack;
/// expanded, beside it. Every tap in the shell's lists goes through `open`,
/// which places the route by its column (`ShellPaths.column(of:)`) and a
/// thread in its project's shell (`ShellPaths.place`); a project's tap goes
/// through `openProject`, which lands it (`ShellPaths.land`). Pushes made
/// from inside the detail keep using `NavigationLink(value:)` on the
/// detail's own stack.
@MainActor @Observable
final class ShellNavigator {
    let tab: AppTab
    var sidebarPath: [Route]
    var detailRoot: Route? {
        // His press on the sidebar button over a wide route is that screen's alone (`SidebarVisibility`).
        // A held write is its route's too: another route never shows it, even for the half second it waits.
        didSet {
            let route = ShellPaths.identity(of: detailRoot)
            if let held = sidebarOverride, held.route != route { sidebarOverride = nil }
            if let held = heldWrite, held.route != route { heldWrite = nil }
        }
    }
    var detailStack: NavigationPath
    /// This tab's sidebar toggle, remembered across folds and launches. A wide route hides the
    /// sidebar without writing it: what the split shows is `sidebarVisible`.
    var sidebarShown: Bool
    /// His press on the sidebar button while a wide route is open, forgotten when he leaves it.
    var sidebarOverride: SidebarVisibility.Override?
    /// Each list's top row by its route's identity (`ShellPaths.identity`), so a list a fold or a pose
    /// change builds again comes back at its row (`placeTop`, WorkPlaceScreen.swift). Written once per
    /// settled scroll, never under a moving finger; read only when a list is built; never saved across
    /// launches, and never a reason to draw.
    @ObservationIgnored var tops: [String: String] = [:]
    /// Whether the thread a route shows has a file open beside its chat; the root sets it. Read without observing
    /// the canvas, so a push that leaves the answer as it was redraws nothing.
    @ObservationIgnored var hasItem: (Route) -> Bool = { _ in false }
    /// Moves when the shown thread's first item opens or its last closes (`itemsMoved`): the one change of `hasItem`
    /// the split must hear, since a thread's items land after its route opens.
    private(set) var itemsRev = 0
    /// This tab is the one on screen: its split writes the proofs' layout notes (`ShellSplit`).
    @ObservationIgnored var focused = false
    /// The shell's pose, set by the root: a detail opened in the overlay pose
    /// hides the overlay, the way Mail's sidebar closes on a pick.
    var pose = ShellPose.stack(short: false) {
        didSet { if pose != oldValue { poseChangedAt = Date(); heldWrite = nil } }
    }
    /// When the pose last changed: a write of the split's visibility inside
    /// `ShellPose.foldSettle` of it is the fold's, not the person's.
    @ObservationIgnored private(set) var poseChangedAt = Date.distantPast
    /// When this tab's split last came on screen, and whether it is on screen: a write before it appears (as it is
    /// built) or inside `ShellPose.foldSettle` of it is the split's own.
    @ObservationIgnored private(set) var shownAt = Date.distantPast
    @ObservationIgnored private(set) var splitOnScreen = false

    /// The tab's split came on screen (built, or its tab picked again), or left it.
    func splitAppeared(_ on: Bool) {
        splitOnScreen = on
        if on { shownAt = Date() }
    }

    /// How long the split has been on screen; 0 while it is not yet.
    var sinceShown: TimeInterval { splitOnScreen ? Date().timeIntervalSince(shownAt) : 0 }
    /// The window's width, for the fold's place (`ShellSplit`).
    var windowWidth: CGFloat = 0
    /// Every host's lists, for placing a thread in its shell; the root sets it.
    @ObservationIgnored var hosts: () -> [HomeHostInput] = { [] }

    init(tab: AppTab, memory: ColumnMemory = ColumnMemory(), sidebarShown: Bool = true) {
        self.tab = tab
        sidebarPath = memory.sidebar
        detailRoot = memory.detailRoot
        detailStack = NavigationMemory.path(memory.detailStack)
        self.sidebarShown = sidebarShown
    }

    /// The detail's root takes the whole open Duo, its two halves either side of the fold (`ShellPaths.wide`).
    var wide: Bool {
        _ = itemsRev
        return ShellPaths.wide(of: detailRoot, hasItem: detailRoot.map(hasItem) ?? false)
    }

    /// The thread on screen gained its first item or lost its last: the split asks `wide` again. A fold writes
    /// nothing here, so the sidebar it shows stays derived.
    func itemsMoved() {
        itemsRev &+= 1
        // A held write is of the width it was made at (the canvas has already changed when this runs, so the write's
        // own width is what to compare): the thread turning wide or narrow drops it at once.
        if let held = heldWrite, held.wide != wide { heldWrite = nil }
    }

    /// A write of the split's visibility waiting out `ShellPose.foldSettle`
    /// (`HeldVisibilityWrite`): the split shows it at once; it becomes his toggle
    /// only if the pose holds, and a pose change drops it.
    private(set) var heldWrite: HeldVisibilityWrite?

    /// What the split shows: a held write, else his toggle, hidden by a wide route, or his own press on that route.
    var sidebarVisible: Bool {
        if let heldWrite { return heldWrite.shown }
        return SidebarVisibility(preference: sidebarShown, override: sidebarOverride).shown(route: ShellPaths.identity(of: detailRoot), wide: wide)
    }

    /// His press on the shell's sidebar button (ShellSplit's own, in place of the system toggle): his toggle at once,
    /// however soon after the tab appeared or the pose changed (`ShellPose.isHisToggle(.button, …)`). A held write
    /// goes, and a stray check already waiting finds the split agreeing, so the settle never undoes it.
    func pressSidebar() {
        guard ShellPose.isHisToggle(.button, pose: pose, sincePoseChange: Date().timeIntervalSince(poseChangedAt), sinceShown: sinceShown) else { return }
        let shown = !splitShown
        heldWrite = nil
        splitAnswer.pressed()
        showSidebar(shown)
        splitShows = shown
        pressedSidebar &+= 1
    }

    /// How many presses of the sidebar button this run (the proof's note).
    @ObservationIgnored private(set) var pressedSidebar = 0

    /// His press on the sidebar button: the route's override on a wide route, his toggle otherwise.
    func showSidebar(_ shown: Bool) {
        var visibility = SidebarVisibility(preference: sidebarShown, override: sidebarOverride)
        visibility.toggled(to: shown, route: ShellPaths.identity(of: detailRoot), wide: wide)
        sidebarShown = visibility.preference
        sidebarOverride = visibility.override
    }

    /// What the split last wrote of its own visibility, kept or not.
    @ObservationIgnored private var splitShows: Bool?
    /// What the split's binding answers: the shell's `sidebarVisible`, or for one turn after it strayed the split's own
    /// value, so the shell's reads as a change (`SplitAnswer`).
    private(set) var splitAnswer = SplitAnswer()

    /// The value the split's binding gives it.
    var splitShown: Bool { splitAnswer.answer(shows: sidebarVisible) }
    /// Moves when the split shows other than `sidebarVisible` after a pose settles
    /// (`ShellPose.splitStrays`): the split reads it, so its binding is read again.
    private(set) var visibilityAsk = 0

    /// When both the pose and the split's appearance have held `ShellPose.foldSettle`, and a beat more.
    private var settledAt: Date {
        max(poseChangedAt, splitOnScreen ? shownAt : Date()).addingTimeInterval(ShellPose.foldSettle + ShellPose.echoTurn)
    }

    /// The split wrote its visibility; a dropped write that leaves it showing other than
    /// `sidebarVisible` is checked again once the pose has settled.
    func splitWrote(_ shown: Bool, kept: Bool) {
        splitShows = shown
        guard !kept, ShellPose.splitStrays(pose: pose, splitShows: shown, shows: sidebarVisible) else { return }
        Task { [weak self] in
            // Once the pose and the split's own appearance have both settled; it may appear after this write (as it is built).
            // A split that never comes on screen (its tab not picked) stops waiting after a few turns.
            for _ in 0..<ShellPose.settleTries {
                guard let wait = self?.settledAt.timeIntervalSinceNow, wait > 0 else { break }
                try? await Task.sleep(for: .seconds(wait))
            }
            guard let self, self.splitAnswer.strayed(pose: self.pose, splitShows: self.splitShows, shows: self.sidebarVisible) else { return }
            // One turn on the split's own value, then the shell's: a change the split takes.
            self.visibilityAsk &+= 1
            try? await Task.sleep(for: .seconds(ShellPose.echoTurn))
            self.splitAnswer.settle()
            self.splitShows = self.sidebarVisible
            self.visibilityAsk &+= 1
        }
    }

    /// A write the split made once the pose had settled: shown at once, and his
    /// press (`showSidebar`) only if the pose and the detail's route still hold `ShellPose.foldSettle` later.
    func holdSidebarWrite(_ shown: Bool) {
        let write = HeldVisibilityWrite(shown: shown, pose: pose, at: Date(), route: ShellPaths.identity(of: detailRoot), wide: wide)
        heldWrite = write
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShellPose.foldSettle))
            guard let self, self.heldWrite == write else { return }
            self.heldWrite = nil
            // Only over the route it was written for, as wide as it was then: never another route's preference.
            if write.applies(pose: self.pose, poseChangedAt: self.poseChangedAt, route: ShellPaths.identity(of: self.detailRoot), wide: self.wide) {
                self.showSidebar(write.shown)
            }
        }
    }

    /// A sidebar route pushes; a detail route replaces the detail's root and
    /// clears what was pushed over the old one. A thread of a project (or of
    /// a workspace's loose chats) opens in its shell, a subagent pushed over
    /// its root's; a chat outside every workspace opens bare.
    func open(_ route: Route) {
        switch ShellPaths.column(of: route) {
        case .sidebar:
            sidebarPath.append(route)
        case .detail:
            let placed = ShellPaths.place(route, hosts: hosts())
            detailRoot = placed.root
            detailStack = NavigationPath()
            if let push = placed.push { detailStack.append(push) }
            if pose.isOverlay { sidebarShown = false }
        }
    }

    /// How many complete lists a host has had in this process; the root sets it.
    @ObservationIgnored var lists: (String) -> Int = { _ in 0 }
    /// A host's workspace and project lists' stamp; the root sets it.
    @ObservationIgnored var catalog: (String) -> Int = { _ in 0 }
    /// A thread's placing fields on its host, read untracked behind the host's stamp; the root sets it.
    @ObservationIgnored var placing: (String, String) -> String? = { _, _ in nil }
    /// A bare root its host's complete list left bare, and what decided it (`ShellPaths.awaitsListing`).
    @ObservationIgnored private var settledBare: BareSettle?

    /// The detail's root is a thread that opened bare before its host listed
    /// it, and with nothing pushed over it the lists now place it in a shell.
    /// A root a complete list left bare is checked again only on that host's
    /// next list, its workspaces or projects push, or a push that names or
    /// moves the thread; it never observes the host's whole sessions.
    var awaitsListing: Bool {
        ShellPaths.awaitsListing(detailRoot, stackEmpty: detailStack.isEmpty, settled: &settledBare, lists: lists, catalog: catalog, placing: placing, hosts: hosts)
    }

    /// That thread into its shell once the list arrives (`ShellPaths.relisted`);
    /// what the person pushed over it is never taken away.
    func placeListed() {
        guard detailStack.isEmpty, let placed = ShellPaths.relisted(detailRoot, hosts: hosts()) else { return }
        detailRoot = placed.root
        if let push = placed.push { detailStack.append(push) }
    }

    /// A project card's tap: its shell on its landing, or, already there,
    /// the shell as it is with what was pushed over it gone.
    func openProject(_ key: String) {
        open(ShellPaths.land(key: key, current: detailRoot, hosts: hosts(), remembered: ShellLandingStore.shared[key]))
    }

    /// Back to the tab's root with nothing open.
    /// The sidebar's routes, the detail's root and the detail's stack, counted.
    var depth: Int { sidebarPath.count + (detailRoot == nil ? 0 : 1) + detailStack.count }

    /// A route over the list it belongs to, so Back is that list. In the
    /// collapsed split one change that pushes the sidebar and shows the
    /// detail keeps only the detail, so the route opens once the list's push
    /// has landed.
    func open(_ route: Route, over list: Route) async {
        if sidebarPath.last != list {
            sidebarPath.append(list)
            try? await Task.sleep(for: .milliseconds(400))
        }
        open(route)
    }

    /// A held item over the Outbox, so Send returns to the list and its Undo.
    func openHeld(_ route: Route) async {
        await open(route, over: .place(.outbox))
    }

    func popToRoot() {
        sidebarPath = []
        detailRoot = nil
        detailStack = NavigationPath()
    }

    /// The thread at the detail's root, bare or in its shell, is this one (any row of it).
    func isOpen(environmentId: String, sessionId: String) -> Bool {
        guard let shown = ShellPaths.shown(detailRoot) else { return false }
        return shown.environmentId == environmentId && shown.sessionId == sessionId
    }

    /// What the memory keeps of this tab.
    var memory: ColumnMemory {
        ColumnMemory(sidebar: sidebarPath, detailRoot: detailRoot, detailStack: NavigationMemory.encode(detailStack), sidebarShown: sidebarShown)
    }

    /// The tab as a memory has it: an old save's Work screens moved here (`NavigationSnapshot.movingWork`).
    func restore(_ memory: ColumnMemory) {
        sidebarPath = memory.sidebar
        detailRoot = memory.detailRoot
        detailStack = NavigationMemory.path(memory.detailStack)
    }
}
