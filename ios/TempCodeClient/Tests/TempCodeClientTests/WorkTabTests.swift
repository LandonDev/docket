import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The Work tab: when the bar has it, where it opens, what an old save keeps, and where a route
/// from outside lands (docs/IOS-DESIGN.md "Information architecture").
@Suite struct WorkTabTests {
    private func ws(_ id: String, kind: WorkspaceKind? = nil) -> WorkspaceMeta {
        WorkspaceMeta(id: id, name: id, path: "/repo/\(id)", git: kind != .work, kind: kind, sector: kind == .work ? id : nil, createdAt: 1)
    }

    private func thread(_ id: String, workspaceId: String? = nil, scope: SessionScope? = nil) -> SessionMeta {
        SessionMeta(id: id, parentId: nil, projectId: nil, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-opus-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: workspaceId.map { "/repo/\($0)" } ?? "/tmp/\(id)", status: .idle, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, scope: scope, createdAt: 1, updatedAt: 100)
    }

    private func host(workOn: Bool = true) -> HomeHostInput {
        HomeHostInput(
            environmentId: "box",
            name: "box",
            workspaces: [ws("code"), ws("purdue", kind: .work)],
            sessions: [thread("chat"), thread("work-chat", scope: .work), thread("t1", workspaceId: "code"), thread("t2", workspaceId: "purdue", scope: .work)],
            workOn: workOn
        )
    }

    private func isWork(_ route: Route) -> Bool { ShellPaths.isWork(route, hosts: [host()]) }

    // MARK: - the tab

    @Test func `the bar has four tabs in order, and Work only while a host has it on`() {
        #expect(AppTab.allCases == [.home, .work, .inbox, .search])
        #expect(WorkTab.shows(anyOn: true, ready: true, selected: .home))
        #expect(!WorkTab.shows(anyOn: false, ready: true, selected: .home))
        // Work went off while he stood on it: the tab goes.
        #expect(!WorkTab.shows(anyOn: false, ready: true, selected: .work))
    }

    @Test func `a relaunch on the Work tab keeps it until the hosts are read`() {
        #expect(WorkTab.shows(anyOn: false, ready: false, selected: .work))
        #expect(!WorkTab.shows(anyOn: false, ready: false, selected: .home))
    }

    @Test func `the tab pressed twice goes back to the Work list, and only that tab's press does`() {
        #expect(WorkTab.popsToList(selected: .work, pressed: .work))
        #expect(!WorkTab.popsToList(selected: .home, pressed: .work))
        #expect(!WorkTab.popsToList(selected: .work, pressed: .home))
        #expect(!WorkTab.popsToList(selected: .home, pressed: .home))
    }

    // MARK: - where the tab opens

    @Test func `the first entry of a local day opens the first place, a later one where he was`() {
        let was = ColumnMemory(sidebar: [.place(.digest)])
        #expect(WorkTab.opensFirstPlace(stamp: "2026-11-23", today: "2026-11-24", saved: was, draft: false))
        #expect(WorkTab.opensFirstPlace(stamp: nil, today: "2026-11-24", saved: was, draft: false))
        #expect(!WorkTab.opensFirstPlace(stamp: "2026-11-24", today: "2026-11-24", saved: was, draft: false))
        // At the Work list by his own Back: he stays there the rest of the day.
        #expect(!WorkTab.opensFirstPlace(stamp: "2026-11-24", today: "2026-11-24", saved: ColumnMemory(), draft: false))
        // Nothing was ever saved for the tab: the first place.
        #expect(WorkTab.opensFirstPlace(stamp: "2026-11-24", today: "2026-11-24", saved: nil, draft: false))
    }

    @Test func `a notice's tap or a draft he left wins over the day's first place`() {
        // A notice that brings him stamps the day and saves its place: the entry after it stays put.
        let brought = ColumnMemory(sidebar: [.place(.outbox)], detailRoot: .outboxItem(environmentId: "box", ref: "host:h1"))
        #expect(!WorkTab.opensFirstPlace(stamp: "2026-11-24", today: "2026-11-24", saved: brought, draft: false))
        #expect(!WorkTab.opensFirstPlace(stamp: "2026-11-23", today: "2026-11-24", saved: ColumnMemory(), draft: true))
        #expect(!WorkTab.opensFirstPlace(stamp: nil, today: "2026-11-24", saved: nil, draft: true))
    }

    @Test func `the tab opens on Today, and the day's stamp is the local day`() {
        #expect(WorkPlace.shipped.contains(.today))
        #expect(WorkPlace.shipped.contains(.review)) // M5a: the week, in the Work list's foot
        #expect(WorkTab.firstPlace == .today)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        // 11:30 PM Central on Nov 24 is Nov 25 in UTC: the day is his.
        let late = Date(timeIntervalSince1970: 1_795_584_600)
        #expect(WorkTab.day(late, calendar: calendar) == "2026-11-24")
        #expect(WorkTab.day(late.addingTimeInterval(3_600), calendar: calendar) == "2026-11-25")
    }

    // MARK: - the Work list

    @Test func `with Work off the Work list is empty`() {
        let off = HomeSections.home(hosts: [host(workOn: false)])
        #expect(WorkList.sections(work: off.work, driving: true, broken: true).isEmpty)
    }

    @Test func `the Work list is the places, the jobs, Work Chats, then the foot, each place only once it ships`() {
        let home = HomeSections.home(hosts: [host()])
        let all = WorkList.sections(work: home.work, shipped: Set(WorkPlace.allCases), driving: true, broken: true)
        #expect(all.places == [.today, .outbox, .mail, .messages, .tasks, .agenda, .files, .people])
        #expect(all.jobs.map(\.id) == ["box:purdue"])
        #expect(all.chats?.id == HomeSections.workChatsKey)
        #expect(all.foot == [.review, .digest, .computers, .connections])
        // Computers shows only while something is driven, Connections only while one is broken.
        let quiet = WorkList.sections(work: home.work, shipped: Set(WorkPlace.allCases), driving: false, broken: false)
        #expect(quiet.foot == [.review, .digest])
        // What this build ships.
        let now = WorkList.sections(work: home.work, driving: false, broken: false)
        #expect(Set(now.places + now.foot).isSubset(of: WorkPlace.shipped))
        // Today leads the list, then the Outbox.
        #expect(Array(now.places.prefix(2)) == [.today, .outbox])
        #expect(now.foot.contains(.digest))
    }

    // MARK: - where a route from outside lands

    @Test func `Work's places and screens open in the Work tab, a thread and a workspace by what the lists say`() {
        for route in [Route.place(.outbox), .place(.mail, job: "box:purdue"), .outboxItem(environmentId: "box", ref: "host:h1"), .workSettings, .houseRules(environmentId: "box", workspaceId: "purdue"), .workView(environmentId: "box", workspaceId: "purdue", view: "mail")] {
            #expect(ShellPaths.tab(of: route, isWork: isWork) == .work)
        }
        #expect(ShellPaths.tab(of: .thread(environmentId: "box", sessionId: "t2", seq: nil), isWork: isWork) == .work)
        #expect(ShellPaths.tab(of: .thread(environmentId: "box", sessionId: "work-chat", seq: 4), isWork: isWork) == .work)
        #expect(ShellPaths.tab(of: .thread(environmentId: "box", sessionId: "t1", seq: nil), isWork: isWork) == .home)
        #expect(ShellPaths.tab(of: .project(key: "p", thread: "box:t2"), isWork: isWork) == .work)
        #expect(ShellPaths.tab(of: .project(key: "p", thread: "box:t1"), isWork: isWork) == .home)
        #expect(ShellPaths.tab(of: .workspace(key: HomeSections.workChatsKey), isWork: isWork) == .work)
        #expect(ShellPaths.tab(of: .workspace(key: "box:purdue"), isWork: isWork) == .work)
        #expect(ShellPaths.tab(of: .workspace(key: "box:code"), isWork: isWork) == .home)
        #expect(ShellPaths.tab(of: .workspace(key: HomeSections.chatsKey), isWork: isWork) == .home)
        #expect(ShellPaths.tab(of: .settings, isWork: isWork) == .home)
        // A thread no host lists yet is not known to be Work's: Home, as before.
        #expect(ShellPaths.tab(of: .thread(environmentId: "box", sessionId: "new", seq: nil), isWork: isWork) == .home)
    }

    @Test func `a held item lands over the Outbox, so Back at compact width is the list, then the Work list`() {
        #expect(ShellPaths.list(under: .outboxItem(environmentId: "box", ref: "host:h1")) == .place(.outbox))
        #expect(ShellPaths.column(of: .place(.outbox)) == .sidebar)
        #expect(ShellPaths.column(of: .outboxItem(environmentId: "box", ref: "host:h1")) == .detail)
        #expect(ShellPaths.list(under: .place(.digest)) == nil)
        #expect(ShellPaths.list(under: .thread(environmentId: "box", sessionId: "t2", seq: nil)) == nil)
    }

    // MARK: - an old save

    /// A save as a build before the Work tab wrote it: no `hasWorkTab`, the old place routes.
    private func old(_ json: String) throws -> NavigationSnapshot {
        try #require(NavigationSnapshot.restore(v3: Data(json.utf8), v2: nil))
    }

    @Test func `a place saved under its old route is that place`() throws {
        #expect(Route.outbox.current == .place(.outbox))
        #expect(Route.digest.current == .place(.digest))
        #expect(Route.computers.current == .place(.computers))
        #expect(Route.settings.current == .settings)
        #expect(try JSONDecoder().decode(Route.self, from: Data(#"{"outbox":{}}"#.utf8)) == .outbox)
        #expect(try JSONDecoder().decode(Route.self, from: Data(#"{"place":{"_0":"mail"}}"#.utf8)) == .place(.mail))
    }

    @Test func `an old save on the Outbox with a held item open moves whole to the Work tab`() throws {
        let saved = try old(#"{"tab":"home","sidebarShown":false,"columns":{"home":{"sidebar":[{"outbox":{}}],"detailRoot":{"outboxItem":{"environmentId":"box","ref":"host:h1"}},"detailStack":"AQID"}}}"#)
        #expect(saved.hasWorkTab == nil)
        let moved = saved.movingWork(isWork: isWork)
        #expect(moved.tab == .work)
        #expect(moved.hasWorkTab == true)
        #expect(moved[.work].sidebar == [.place(.outbox)])
        #expect(moved[.work].detailRoot == .outboxItem(environmentId: "box", ref: "host:h1"))
        #expect(moved[.work].detailStack == Data([1, 2, 3]))
        #expect(moved[.home].isRoot)
        #expect(moved[.home].detailStack == nil)
        // The one toggle of the old save is both tabs'.
        #expect(!moved.sidebarShown(in: .home))
        #expect(!moved.sidebarShown(in: .work))
    }

    @Test func `an old save in a Work workspace on one of its threads moves; a code one stays`() throws {
        let work = try old(#"{"tab":"home","sidebarShown":true,"columns":{"home":{"sidebar":[{"workspace":{"key":"box:purdue"}}],"detailRoot":{"project":{"key":"loose:box:purdue","thread":"box:t2"}}}}}"#)
        let moved = work.movingWork(isWork: isWork)
        #expect(moved.tab == .work)
        #expect(moved[.work].sidebar == [.workspace(key: "box:purdue")])
        #expect(moved[.work].detailRoot == .project(key: "loose:box:purdue", thread: "box:t2"))
        #expect(moved[.home].isRoot)

        let code = try old(#"{"tab":"home","sidebarShown":true,"columns":{"home":{"sidebar":[{"workspace":{"key":"box:code"}}],"detailRoot":{"project":{"key":"loose:box:code","thread":"box:t1"}}}}}"#)
        let kept = code.movingWork(isWork: isWork)
        #expect(kept.tab == .home)
        #expect(kept[.home] == code[.home])
        #expect(kept.columns[.work] == nil)
        #expect(kept.hasWorkTab == true)
    }

    @Test func `an old save with a Work list beside a code thread splits: the tab follows the thread he read`() throws {
        let mixed = try old(#"{"tab":"home","sidebarShown":true,"columns":{"home":{"sidebar":[{"digest":{}}],"detailRoot":{"project":{"key":"loose:box:code","thread":"box:t1"}}}}}"#)
        let moved = mixed.movingWork(isWork: isWork)
        #expect(moved.tab == .home)
        #expect(moved[.work].sidebar == [.place(.digest)])
        #expect(moved[.work].detailRoot == nil)
        #expect(moved[.home].sidebar.isEmpty)
        #expect(moved[.home].detailRoot == .project(key: "loose:box:code", thread: "box:t1"))
    }

    @Test func `an old save on another tab keeps its tab, and a save made with the Work tab is never moved`() throws {
        let search = try old(#"{"tab":"search","sidebarShown":true,"columns":{"home":{"sidebar":[{"computers":{}}]}}}"#)
        let moved = search.movingWork(isWork: isWork)
        #expect(moved.tab == .search)
        #expect(moved[.work].sidebar == [.place(.computers)])

        var current = NavigationSnapshot(tab: .home)
        current[.home] = ColumnMemory(sidebar: [.workspace(key: "box:purdue")])
        #expect(current.movingWork(isWork: isWork) == current)
        #expect(try JSONDecoder().decode(NavigationSnapshot.self, from: JSONEncoder().encode(current)).hasWorkTab == true)
    }

    @Test func `before the lists know a thread, the move leaves it on Home: the restore waits for them`() throws {
        let saved = try old(#"{"tab":"home","sidebarShown":true,"columns":{"home":{"sidebar":[{"workspace":{"key":"box:purdue"}}],"detailRoot":{"project":{"key":"loose:box:purdue","thread":"box:t2"}}}}}"#)
        let early = saved.movingWork { ShellPaths.isWork($0, hosts: []) }
        #expect(early.tab == .home)
        #expect(early.columns[.work] == nil)
    }

    @Test func `each tab keeps its own sidebar toggle`() throws {
        var snapshot = NavigationSnapshot(tab: .work, sidebarShown: true)
        snapshot[.work] = ColumnMemory(sidebar: [.place(.outbox)], sidebarShown: false)
        let back = try JSONDecoder().decode(NavigationSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(!back.sidebarShown(in: .work))
        #expect(back.sidebarShown(in: .home))
        #expect(back.sidebarShown(in: .search))
    }

    @Test @MainActor func `a draft in an open Work thread holds the day's first place, as a project's draft does`() {
        let unsent = UnsentThreads()
        #expect(!unsent.holds(environmentId: "box", sessionId: "t1"))
        unsent.set(environmentId: "box", sessionId: "t1", unsent: true)
        let holds = WorkTab.holdsDraft(projectText: nil, threadUnsent: unsent.holds(environmentId: "box", sessionId: "t1"))
        #expect(holds)
        #expect(!WorkTab.opensFirstPlace(stamp: "2026-11-23", today: "2026-11-24", saved: nil, draft: holds))
        unsent.set(environmentId: "box", sessionId: "t1", unsent: false)
        #expect(!WorkTab.holdsDraft(projectText: nil, threadUnsent: unsent.holds(environmentId: "box", sessionId: "t1")))
        #expect(WorkTab.holdsDraft(projectText: " words ", threadUnsent: false))
        #expect(!WorkTab.holdsDraft(projectText: " \n ", threadUnsent: false))
    }

    // MARK: - the day's first place in every pose (iw12: m1 shot the Work list, never Today)

    static let poses: [(name: String, pose: ShellPose)] = [
        ("folded", .stack(short: false)), ("folded-landscape", .stack(short: true)), ("unfolded", .split(sidebar: .tiled)),
        ("half-open", .split(sidebar: .tiled)), ("unfolded-portrait", .split(sidebar: .overlay)), ("tabletop", .split(sidebar: .overlay)),
    ]

    @Test(arguments: poses.map(\.name))
    func `his first entry of a day opens Today, and on the open Duo its first held row fills the detail`(_ name: String) throws {
        let pose = try #require(Self.poses.first { $0.name == name }).pose
        // No day stamped yet, no place saved: his own entry opens the day's first place, Today, whatever the pose.
        let first = try #require(WorkTab.entryRoute(stamp: nil, today: "2026-11-25", saved: nil, draft: false))
        #expect(first == .place(.today))
        // Today is a place's list: the sidebar column's (pushed over the Work list), in the Work tab.
        #expect(ShellPaths.column(of: first) == .sidebar)
        #expect(ShellPaths.tab(of: first, isWork: { _ in false }) == .work)
        // Beside it, the detail: on the tiled open Duo the list picks its first held row for the empty detail; the
        // overlay pose and a stack leave the pick to him.
        let pick = ShellSelection.decide(first: ["held:mac:host:1"], present: ["held:mac:host:1", "task:t1"], detail: .empty, pose: pose, onScreen: true)
        #expect(pick == (pose == .split(sidebar: .tiled) ? .open("held:mac:host:1") : .keep))
        // Being brought to the tab stamps the day first (a notice, a link, the proof's plain `work` route), so a later
        // entry that day opens nothing over where he was; nor does any entry over a draft.
        #expect(WorkTab.entryRoute(stamp: "2026-11-25", today: "2026-11-25", saved: ColumnMemory(), draft: false) == nil)
        #expect(WorkTab.entryRoute(stamp: nil, today: "2026-11-25", saved: nil, draft: true) == nil)
    }
}
