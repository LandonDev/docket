import SwiftUI
import TempCodeClient
import TempCodeContract

/// Four tabs: Home, Work, Inbox, Search. Settings is a button in the Home bar;
/// Work is absent while every host has Work off (`WorkTab.shows`).
/// Home, Work and Search are each one `ShellSplit` on its own `ShellNavigator`
/// (the Inbox is `InboxScreen`, its own split over one typed path): the stacks of
/// the phone in compact width, a sidebar beside (or over) the detail in
/// regular width, the same values under both. The pose (`ShellPose`) is
/// decided here from the window's size classes and the root's own bounds
/// and published as `\.shellPose`. The tab, the navigators and the Inbox's path come
/// back from `NavigationMemory` before the first frame, so a cold launch
/// opens on the screen the app was killed on.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(NavigationRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @AppStorage("appearance") private var appearance = Appearance.system
    @State private var tab: AppTab
    @State private var home: ShellNavigator
    @State private var work: ShellNavigator
    /// False for a save from before the Work tab until its Work screens have moved there (`moveWork`).
    @State private var movedWork: Bool
    /// A place was saved for the Work tab, by the last run or this one (`WorkTab.opensFirstPlace`).
    @State private var workSaved: Bool
    /// The Inbox's typed path: InboxScreen reads its first element as the split's selection.
    @State private var inboxPath: [InboxRoute]
    @State private var search: ShellNavigator
    @State private var size = CGSize.zero
    @State private var routed = false
    @State private var restoredSheet: SheetMemory?
    /// The app went to the background since it was last in front: only that return opens the day's first place, never
    /// the return from `.inactive` the system's Face ID sheet or Control Center makes mid-press.
    @State private var wentAway = false

    init() {
        let memory = NavigationMemory.restore()
        let snapshot = memory?.snapshot ?? NavigationSnapshot()
        _tab = State(initialValue: snapshot.tab)
        _home = State(initialValue: ShellNavigator(tab: .home, memory: snapshot[.home], sidebarShown: snapshot.sidebarShown(in: .home)))
        _work = State(initialValue: ShellNavigator(tab: .work, memory: snapshot[.work], sidebarShown: snapshot.sidebarShown(in: .work)))
        _movedWork = State(initialValue: snapshot.hasWorkTab == true)
        _workSaved = State(initialValue: snapshot.columns[.work] != nil)
        _inboxPath = State(initialValue: memory?.inbox ?? [])
        _search = State(initialValue: ShellNavigator(tab: .search, memory: snapshot[.search], sidebarShown: snapshot.sidebarShown(in: .search)))
        _restoredSheet = State(initialValue: memory?.sheet)
    }
    /// Project settings present from the root: a sheet on a menu item never shows.
    @State private var projectSettings = ProjectSettingsPresenter()
    /// The new-thread sheet, opened from any screen of the Home stack.
    @State private var newThread = NewThreadPresenter()

    private var pose: ShellPose {
        ShellPose.of(horizontal: SizeClass(horizontalSizeClass), vertical: SizeClass(verticalSizeClass), size: size)
    }

    /// Home, Work and Search ride the shell split; the Inbox keeps its own (InboxScreen).
    private var navigators: [ShellNavigator] { [home, work, search] }

    /// The bar has the Work tab while a host has Work on (`WorkTab.shows`).
    private var showsWork: Bool {
        WorkTab.shows(anyOn: model.registry.ordered.contains { $0.work.isOn }, ready: model.ready, selected: tab)
    }

    /// The bar's selection. A press on the Work tab while it shows goes back to the Work list.
    private var selection: Binding<AppTab> {
        Binding(
            get: { tab },
            set: { pressed in
                // The Work list, seen: over a hidden sidebar too (`landOnList`).
                if WorkTab.popsToList(selected: tab, pressed: pressed) { work.landOnList() }
                tab = pressed
            }
        )
    }

    var body: some View {
        // One chain in two parts (`shell`, then the lifecycle below): as one expression it
        // is past what the type checker answers in reasonable time.
        shell
        .task(id: model.ready) {
            // An old save's Work screens move to the Work tab once the cached lists say which they are.
            moveWork()
            // The restored stacks are built by now; anything pushed from here keeps the row it names.
            LaunchRestore.end()
            #if DEBUG
            LayoutProbe.route(tab: tab.rawValue, depth: focusedDepth)
            #endif
            await followLaunchRoute()
        }
        .task { await MasterReleaseWatcher.shared.run() } // master's release for the drift marks (Shell/Hosts, iOS 21)
        // The sheet the last run had up, handed to the view that owns it once
        // the restored stacks are on screen.
        .task {
            guard let sheet = restoredSheet else { return }
            restoredSheet = nil
            router.restoredSheet = sheet
        }
        .onChange(of: tab) { remember() }
        .onChange(of: memoryKey) { remember() }
        // The new-thread sheet the last run had up (return flow, thread 14); the cached shell is painted by `ready`.
        .onChange(of: router.restoredSheet, initial: true) { restoreSheet() }
        .onChange(of: model.ready) { restoreSheet() }
        .onChange(of: router.visible) { reportVisibility() }
        // The Work workspace open now, for Save to TempCode's first check (`ShareTargets.preselected`).
        .onChange(of: [work.detailRoot, work.sidebarPath.last]) {
            ShareBridge.noteOpen(ShareBridge.open(work.detailRoot, registry: model.registry) ?? ShareBridge.open(work.sidebarPath.last, registry: model.registry))
        }
        .onChange(of: router.lists) { reportVisibility() }
        // A thread opened bare before its host listed it moves into its shell when the list lands.
        .onChange(of: navigators.map(\.awaitsListing)) { for navigator in navigators { navigator.placeListed() } }
        .onChange(of: scenePhase) {
            reportVisibility()
            // A Send waiting its five seconds is cancelled and its item put back: nothing goes while the app is away.
            // A request's Send too; a reply's goes back by MessagesPresses' own ear.
            if scenePhase == .background {
                OutboxPresses.shared.leftScreen()
                RequestPresses.wait.leftScreen()
                wentAway = true
            }
            // The first foreground of a local day on the Work tab opens its first place.
            if scenePhase == .active, wentAway {
                wentAway = false
                enterWork()
            }
        }
        // The reader's renders live in memory alone and go at the first warning (Work/Reader/ReaderCache.swift).
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            ReaderCache.shared.drop()
            HostedWebPool.shared.drop()
        }
        // Away ended on a host while the app was not in front: one notice on the lock screen (milestone 46).
        .onChange(of: model.registry.ordered.compactMap(\.work.awayEnd)) { _, ends in
            guard !ends.isEmpty, scenePhase != .active else { return }
            AwayEnds.notify(OutboxModel.awayLine(AwayEnds.counts(model.registry.ordered)) ?? "Nothing waits for you.")
        }
        // A notification or Live Activity tap: its tab's sidebar at its root, the thread in its
        // project's shell in the detail, on its card. Work's places, screens and threads land in
        // the Work tab (`ShellPaths.tab`), the rest on Home.
        .onChange(of: router.pending) { _, route in
            guard let route else { return }
            // A tap names its card: it lands there even this early in a cold launch.
            LaunchRestore.end()
            let hosts = HomeRows.inputs(model.registry.ordered, current: true)
            let navigator = show(ShellPaths.tab(of: route) { ShellPaths.isWork($0, hosts: hosts) })
            navigator.sidebarPath = []
            // A held act's notice: the item over the Outbox, so Back is the list.
            if let list = ShellPaths.list(under: route) {
                Task { await navigator.open(route, over: list) }
            } else {
                navigator.open(route)
            }
            router.pending = nil
        }
        .onOpenURL(perform: open)
        // Outermost, so the sheets the root presents (new thread, project settings, the fleet confirm) read
        // the window's size classes too (Design/SheetShape.swift); a sheet never reads its own.
        .publishesWindowClasses()
    }

    /// The tabs and the modifiers up to the root's sheets: the first part of `body`'s chain.
    private var shell: some View {
        TabView(selection: selection) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                ShellSplit(navigator: home) {
                    HomeView(slots: shellSlots)
                } placeholder: {
                    DetailPlaceholder(title: "No Thread Selected", symbol: "bubble.left.and.bubble.right")
                } destination: { destination($0) }
                // Over the whole split, as Work's: Settings → Work pushed from Home says its outcome over that page.
                .fleetToastInset()
                .outboxUndoFallback()
                .environment(home)
            }
            if showsWork {
                Tab("Work", systemImage: "briefcase", value: AppTab.work) {
                    ShellSplit(navigator: work) {
                        WorkListView()
                    } placeholder: {
                        DetailPlaceholder(title: "Nothing Selected", symbol: "briefcase")
                    } destination: { destination($0) }
                    // One host for the sticky outcome over every route Work pushes (a person's page, Today, a job's
                    // place), not only the list at the stack's root: a Mail send stopped while he was there is seen.
                    .fleetToastInset()
                    // The Outbox's Undo, while neither its list nor an item's page is on screen (another tab's, too).
                    .outboxUndoFallback()
                    .environment(work)
                }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                // The Inbox keeps its own split over one typed path (InboxScreen, plan 3).
                InboxScreen(path: $inboxPath)
            }
            Tab(value: AppTab.search, role: .search) {
                ShellSplit(navigator: search) {
                    SearchView(initialQuery: model.launchSearch)
                } placeholder: {
                    DetailPlaceholder(title: "No Result Selected", symbol: "magnifyingglass")
                } destination: { destination($0) }
                // Over the whole split, as Work's: a Work page Search opens (a person, a job's Forms) says a stopped
                // or refused send over that page, not behind it under Search's list.
                .fleetToastInset()
                .outboxUndoFallback()
                .environment(search)
            }
        }
        .environment(\.shellPose, pose)
        // The root's own bounds, never the orientation: with the size classes, the one layout input.
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .onChange(of: pose, initial: true) { for navigator in navigators { navigator.pose = pose } }
        .onChange(of: size.width, initial: true) { for navigator in navigators { navigator.windowWidth = size.width } }
        .onChange(of: size.height > size.width, initial: true) { for navigator in navigators { navigator.windowTall = size.height > size.width } }
        // The launch's first frame on screen: the signpost `launch.firstFrame` (Perf/LaunchFrames.swift).
        .onAppear { LaunchFrames.rootAppeared() }
        .onAppear {
            let registry = model.registry
            OutboxPresses.shared.attach { registry.client($0) }
            // The other presses' clients at the root too, so a screen opened straight from Today (a conversation,
            // a request) can send on a fresh launch; the owner's check reads each host's live key after its answer.
            MessagesPresses.shared.attach { registry.client($0) }
            MailPresses.shared.attach()
            // A host's access going ends every LifeOS session made through it, whether or not Today ever started.
            WorkHost.accessLost = { WorkLifeHost.accessLost(host: $0) }
            RequestPresses.attach { registry.client($0) }
            PressGates.shared.attach { registry.client($0) }
            // The record's last word before any request leaves: the app in front, the link, the key he pressed under.
            PressLedger.shared.mayLeave = { host, key, method in OutboxPresses.mayLeave(host, key: key, method: method) }
            // KeyMay's lane: a relayed Mac the box last called locked takes no `screen` method.
            WorkHost.relayLocked = { registry.client($0)?.relayState == .locked }
            // His own mail draft read back on a job's LifeOS session, so a lost composer Send settles on each link.
            WorkHost.mailDraftTruth = { host, draftId in try await WorkLifeHost.draftTruth(host: host, draftId: draftId) }
            for navigator in navigators {
                navigator.hosts = { HomeRows.inputs(registry.ordered, current: true) }
                navigator.lists = { registry.client($0)?.completeLists ?? 0 }
                navigator.catalog = { registry.client($0)?.catalogStamp ?? 0 }
                navigator.placing = { registry.client($0)?.watchPlacing($1) }
                // A thread with a file open beside its chat is a wide route; read without observing, so a
                // canvas push never redraws the shell.
                navigator.hasItem = { route in
                    guard let thread = ShellPaths.thread(of: route) else { return false }
                    return registry.client(thread.environmentId)?.work.canvas.hasOpenItems(thread.sessionId) == true
                }
            }
            // New thread opens the project's shell with its draft focused: in the Work tab for a
            // Work workspace, on Home for any other.
            newThread.openDraft = { client, workspace, project, type in
                let environmentId = client.environment.id
                let key = project.map { ProjectPairs.key(environmentId, $0) }
                    ?? ThreadStrip.scope(workspace: environmentId, workspaceId: workspace.id, hosts: HomeRows.inputs(registry.ordered, current: true))?.key
                guard let key else { return }
                ProjectDraftStore.shared.focus(key, type: type)
                show(workspace.kind == .work ? .work : .home).open(.project(key: key, thread: nil, seq: nil))
            }
        }
        // The tab on screen writes the proofs' layout notes, and entering Work may open the day's first place.
        .onChange(of: tab, initial: true) {
            for navigator in navigators { navigator.focused = navigator.tab == tab }
            enterWork()
        }
        // Work went off on every host while he stood on its tab.
        .onChange(of: showsWork) { if !showsWork, tab == .work { tab = .home } }
        .preferredColorScheme(appearance.scheme)
        .modifier(layoutProbe) // DEBUG: the layout report the Duo proof reads (LayoutProbe.swift)
        // The fleet switches' confirm sheet, shared by every menu; the outcome line sits on each tab (thread iOS 20).
        .fleetSwitchHost()
        .onChange(of: model.registry.ordered.map { $0.bootResume }) { BootResumeNotes.shared.observe(model.registry.ordered) }
        .environment(projectSettings)
        // A thread's request for his press, over every tab: from the Outbox, its notice and the thread's card (Outbox 2).
        .modifier(OutboxRequestSheetHost())
        .modifier(NewThreadSheetHost(presenter: newThread) { created, workspace in
            show(workspace.kind == .work ? .work : .home).open(created)
        })
        // Capture over every tab: the Work list's and Today's plus, and the App Shortcuts (Work/Capture).
        // A thread his Save started opens in the Work tab.
        .modifier(CaptureSheetHost { environmentId, sessionId in
            show(.work).open(.thread(environmentId: environmentId, sessionId: sessionId, seq: nil))
        })
        .sheet(item: $projectSettings.target) { target in
            if let client = model.registry.client(target.home.environmentId) {
                ProjectSettingsSheet(client: client, target: target)
            } else {
                Color.clear.onAppear { projectSettings.target = nil }
            }
        }
    }

    /// A notification's or Live Activity's link: the thread it names, or Home for a group activity's card.
    private func open(_ url: URL) {
        if let target = PushTarget(url: url) {
            router.open(target)
        } else if url.host == "home" {
            tab = .home
            home.popToRoot()
        }
    }

    /// The tab a route from outside opens in, selected, and its navigator. With Work off the
    /// route opens on Home. Being brought to Work is the day's first entry: what brought him
    /// stays on screen (`WorkTab.opensFirstPlace`).
    @discardableResult
    private func show(_ wanted: AppTab) -> ShellNavigator {
        guard wanted == .work, showsWork else {
            tab = .home
            return home
        }
        UserDefaults.standard.set(WorkTab.day(Date()), forKey: WorkTab.dayKey)
        workSaved = true
        tab = .work
        return work
    }

    /// His own entry into the Work tab (a press on it, a launch on it, the first foreground of
    /// a day): the day's first place, or where he was (`WorkTab.opensFirstPlace`).
    private func enterWork() {
        guard tab == .work, movedWork else { return }
        let today = WorkTab.day(Date())
        let stamp = UserDefaults.standard.string(forKey: WorkTab.dayKey)
        // Never over words he has not sent: a project's draft, or an open thread's composer (`UnsentThreads`).
        var projectText: String?
        if case .project(let key, nil, _)? = work.detailRoot { projectText = ProjectDraftStore.shared.draft(key)?.text }
        let thread = work.detailRoot.flatMap(ShellPaths.thread(of:))
        let draft = WorkTab.holdsDraft(projectText: projectText, threadUnsent: thread.map { UnsentThreads.shared.holds(environmentId: $0.environmentId, sessionId: $0.sessionId) } ?? false)
        if let first = WorkTab.entryRoute(stamp: stamp, today: today, saved: workSaved ? work.memory : nil, draft: draft) {
            // The day's first place, seen: over a hidden sidebar too (`landOnList`).
            work.landOnList(first)
        }
        workSaved = true
        if stamp != today { UserDefaults.standard.set(today, forKey: WorkTab.dayKey) }
    }

    /// A save from before the Work tab kept Work's screens on Home. Once the hosts' cached
    /// lists are read they move to the Work tab, and the tab follows what he was looking at
    /// (`NavigationSnapshot.movingWork`). Until then the save keeps its old shape.
    private func moveWork() {
        guard !movedWork, model.ready else { return }
        let hosts = HomeRows.inputs(model.registry.ordered, current: true)
        let moved = snapshot.movingWork { ShellPaths.isWork($0, hosts: hosts) }
        movedWork = true
        home.restore(moved[.home])
        work.restore(moved[.work])
        if moved.tab == .work, showsWork {
            workSaved = true
            UserDefaults.standard.set(WorkTab.day(Date()), forKey: WorkTab.dayKey)
            tab = .work
        }
    }

    /// The new-thread sheet the last run had up (return flow, thread 14).
    private func restoreSheet() {
        guard case .newThread(let environmentId, let workspaceId, let projectId)? = router.restoredSheet,
              let client = model.registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) else { return }
        router.restoredSheet = nil
        newThread.compose(client, workspace, projectId.flatMap { id in client.projects.first { $0.id == id } })
    }

    /// Every field of every navigator the memory keeps, as one value to watch.
    private var memoryKey: NavigationSnapshot { snapshot }

    private var snapshot: NavigationSnapshot {
        var snapshot = NavigationSnapshot(tab: tab, sidebarShown: home.sidebarShown, hasWorkTab: movedWork ? true : nil)
        for navigator in navigators { snapshot[navigator.tab] = navigator.memory }
        return snapshot
    }

    /// Every change of where the person is, written at once: the write is one
    /// small defaults key, and the background has no reliable last moment.
    private func remember() {
        NavigationMemory.save(snapshot, inbox: InboxRoute.remembered(inboxPath))
        reportVisibility()
        #if DEBUG
        LayoutProbe.route(tab: tab.rawValue, depth: focusedDepth)
        // The Work fold check: the focused navigator's typed route, the sidebar's top and the detail's root.
        if let shown = navigators.first(where: { $0.tab == tab }) { LayoutProbe.note("work.route", "\(shown.sidebarPath.last.map { String(describing: $0) } ?? "list") > \(shown.detailRoot.map { String(describing: $0) } ?? "none")") }
        #endif
    }

    /// How deep the selected tab is: the sidebar's routes, the detail's root and its stack
    /// (the same values in every pose, so a fold never changes it).
    private var focusedDepth: Int {
        switch tab {
        case .home: home.depth
        case .work: work.depth
        case .inbox: inboxPath.count
        case .search: search.depth
        }
    }

    #if DEBUG
    private var layoutProbe: some ViewModifier { LayoutProbeModifier() }
    #else
    private var layoutProbe: some ViewModifier { EmptyModifier() }
    #endif

    /// What is on screen, for the clients: Home's or Work's lists when their tab shows
    /// one; the thread the thread screen reported. Off screen, nothing.
    private func reportVisibility() {
        let active = scenePhase == .active
        model.setVisible(thread: active ? router.visible : nil, listVisible: active && (tab == .home || tab == .work) && !router.lists.isEmpty)
    }

    /// Home's slots with the fleet switches: what every screen of the Home stack reads.
    private var shellSlots: HomeSlots {
        var slots = FleetSwitches.homeSlots(homeSlots)
        // Away as a check item in the host menu, beside the fleet switches (milestone 46).
        let fleet = slots.hostMenu
        slots.hostMenu = { client in
            AnyView(Group {
                AwayMenuItem(client: client)
                fleet?(client)
            })
        }
        return slots
    }

    /// What sibling features plug into Home; every slot optional.
    private var homeSlots: HomeSlots {
        var slots = HomeSlots(
            projectSettings: { client, project in AnyView(ProjectSettingsMenuItem(client: client, project: project)) },
            projectTrailing: { AnyView(ProjectPlanChip(client: $0, project: $1)) },
            projectPlan: { AnyView(ProjectPlanMenuItem(client: $0, project: $1)) }
        )
        let registry = model.registry
        slots.hostTrailing = { AnyView(DriftMark(client: $0)) } // iOS 21: the deploy drift mark (Shell/Hosts)
        // Thread 29: a relayed host's "through <carrier>, <presence>" line under its header's name.
        slots.hostSubline = { client in
            AnyView(HostSubline(client: client, carrierName: registry.carrier(of: client.environment.id)?.environment.name))
        }
        return slots
    }

    /// Every route's screen, in whichever column `ShellPaths.column(of:)` placed it.
    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .thread(let environmentId, let sessionId, let seq):
            if let client = model.registry.client(environmentId) {
                ThreadScreen(client: client, sessionId: sessionId, targetSeq: seq)
            }
        case .workspace(let key):
            WorkspaceScreen(key: key, slots: shellSlots)
        case .project(let key, let thread, let seq):
            ProjectShell(key: key, thread: thread, seq: seq, slots: shellSlots)
        case .archivedThreads(let environmentId, let projectId):
            if let client = model.registry.client(environmentId) {
                ArchivedThreadsView(client: client, projectId: projectId)
            }
        case .archivedProjects(let environmentId, let workspaceId):
            if let client = model.registry.client(environmentId) {
                ArchivedProjectsView(client: client, workspaceId: workspaceId)
            }
        case .settings:
            SettingsView()
        case .hosts:
            HostsView()
        case .place, .outbox, .digest, .computers:
            if case .place(let place, let job) = route.current {
                WorkPlaceList(place: place, job: job)
            }
        case .outboxItem(let environmentId, let ref):
            OutboxItemScreen(environmentId: environmentId, refKey: ref)
        case .workSettings:
            WorkSettingsScreen()
        case .houseRules(let environmentId, let workspaceId):
            HouseRulesScreen(environmentId: environmentId, workspaceId: workspaceId)
        case .workView(let environmentId, let workspaceId, let view):
            WorkViewScreen(environmentId: environmentId, workspaceId: workspaceId, view: view)
        case .file(let environmentId, let item, let sessionId):
            if let client = model.registry.client(environmentId) {
                FileReaderPage(client: client, item: item, thread: sessionId)
            }
        case .chat(let environmentId, let workspaceId, let chatId):
            ChatScreen(environmentId: environmentId, workspaceId: workspaceId, chatId: chatId)
        case .person(let environmentId, let workspaceId, let personId):
            PersonScreen(environmentId: environmentId, workspaceId: workspaceId, personId: personId)
        case .lifeProject(let environmentId, let workspaceId, let projectId):
            WorkViewScreen(environmentId: environmentId, workspaceId: workspaceId, view: LifeViewScreen.Kind.projects.rawValue, project: projectId)
        case .prep(let environmentId, let workspaceId, let eventId):
            PrepScreen(environmentId: environmentId, workspaceId: workspaceId, eventId: eventId)
        case .clash(let environmentId, let clashId):
            ClashScreen(environmentId: environmentId, clashId: clashId)
        case .msformAnswers(let environmentId, let workspaceId, let formId):
            MsFormAnswersScreen(environmentId: environmentId, workspaceId: workspaceId, formId: formId)
        case .folder(let environmentId, let workspaceId, let placeId, let at, let title, let through):
            if let client = model.registry.client(environmentId) {
                FolderScreen(client: client, workspaceId: workspaceId, placeId: placeId, at: at, title: title, through: through)
            }
        case .filesFile(let environmentId, let workspaceId, let placeId, let entry):
            if let client = model.registry.client(environmentId) {
                FilesOpen.page(client: client, route: FileOpenRoute(environmentId: environmentId, workspaceId: workspaceId, placeId: placeId, entry: entry))
                    .id(entry.key)
            }
        }
    }

    /// DEBUG only: the Work workspace a proof route names by a part of its name (`TC_TEST_JOB`); nil when none is named.
    private func proofJob(_ client: EnvironmentClient) -> WorkspaceMeta? {
        guard let want = TestHooks.job else { return nil }
        return client.workspaces.first { $0.kind == .work && $0.name.localizedCaseInsensitiveContains(want) }
    }

    /// DEBUG only: the proof script launches with `TC_TEST_ROUTE` and reads
    /// the screen off the simulator, so the app walks there itself once the
    /// first host has listed its threads (or painted them from the cache).
    private func followLaunchRoute() async {
        guard let route = model.launchRoute, !routed, model.ready else { return }
        guard let client = model.registry.ordered.first else { return }
        // Work's routes, and the sheets the Work list owns, wait for the host's Work switch: a fresh device has none cached.
        let workRoutes: Set<String> = ["work", "work-day", "today", "computers", "digest", "outbox", "outbox-item", "house-rules", "work-view", "work-workspace", "place", "reader", "work-chats", "work-settings", "outbox-request", "request-notice"]
        let workSheets: Set<String> = ["new-work", "voice-note", "receipt"]
        let inWork = workRoutes.contains(route) || workSheets.contains(TestHooks.sheet ?? "")
        if inWork {
            for _ in 0..<100 where !client.work.isOn {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if route == "work-day" {
                // His own first entry of a day, as a launch on the tab makes it (the m1 part): no day stamped yet and no
                // place saved, so entering the tab runs `enterWork` and opens the day's first place by the rule, not
                // `show`, which is being brought to the tab and stamps the day itself.
                UserDefaults.standard.removeObject(forKey: WorkTab.dayKey)
                workSaved = false
                if tab == .work { enterWork() } else { tab = .work }
            } else {
                show(.work)
            }
        }
        if route == "home" || route == "hosts-status" { return }
        for _ in 0..<600 {
            if client.hasShell || !client.currentSessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        routed = true
        let environmentId = client.environment.id
        // Work's routes open in the Work tab, as a tap on its rows would.
        let home = inWork && tab == .work ? work : self.home
        switch route {
        case "work", "work-day":
            break
        case "inbox":
            tab = .inbox
        case "search":
            tab = .search
        case "settings":
            home.open(.settings)
        case "diagnostics":
            // The access proof's Work Checks: Settings, then Diagnostics (SettingsView opens it on this route).
            home.open(.settings)
        case "computers":
            // the video set: the Computers list once a host says something is driven
            for _ in 0..<100 where ComputerEntries.tiles(model.registry.ordered).isEmpty {
                try? await Task.sleep(for: .milliseconds(100))
            }
            home.open(.place(.computers))
        case "today":
            // The work-perf proof's fill launch: Today open, so the measured launch after it comes back onto Today.
            home.open(.place(.today))
        case "digest":
            // the digest's proof (docs/agents/work-digest.md "The phone"): the Digest list
            home.open(.place(.digest))
        case "outbox", "outbox-item":
            // Milestone 46's proof: the Outbox, or its first held item, once a host has listed it.
            for _ in 0..<100 where OutboxEntries.of(model.registry.ordered).isEmpty {
                try? await Task.sleep(for: .milliseconds(100))
            }
            // `TC_TEST_OPEN=<held id>` names the item (milestone 47's send whose outcome is unknown); else the newest.
            let bands = OutboxModel.bands(OutboxEntries.of(model.registry.ordered))
            let named = TestHooks.open.flatMap { id in bands.flatMap(\.entries).first { OutboxModel.key($0.item.ref) == "host:\(id)" } }
            if route == "outbox-item", let entry = named ?? bands.first?.entries.first {
                await home.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(entry.item.ref)))
            } else {
                home.open(.place(.outbox))
            }
        case "outbox-request", "request-notice":
            // Outbox 2's proof (TC_WORK_ONLY=outbox2): a thread's open request as its sheet over the Outbox, from the
            // list's Asked row or from its notice (a tell keyed `request:<id>`, through the delegate's one route).
            for _ in 0..<150 where OutboxEntries.requests(model.registry.ordered).isEmpty {
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard let asked = OutboxEntries.requests(model.registry.ordered).first else { return }
            if route == "request-notice" {
                let tc: [AnyHashable: Any] = ["event": "needs_you", "kind": "waiting", "environmentId": asked.environmentId, "work": ["key": "now", "tell": "request:\(asked.request.id)", "open": ["thread": asked.request.sessionId]], "ts": 0]
                PushDelegate.route(["aps": ["alert": ["title": "Asked: \(asked.request.head)"]], "tc": tc])
            } else {
                home.open(.place(.outbox))
                try? await Task.sleep(for: .milliseconds(600))
                OutboxRequestCenter.shared.open(environmentId: asked.environmentId, id: asked.request.id)
            }
        case "away":
            // The work set: Away on and off from the phone, as the host menu's item does; the note follows.
            try? await client.work.setAway(true)
            try? await Task.sleep(for: .seconds(1))
            try? await client.work.setAway(false)
        case "held-notice":
            // The work set: a held act's notice, shaped as the host sends it, through the delegate's one route.
            for _ in 0..<100 where OutboxEntries.of(model.registry.ordered).isEmpty {
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard let entry = OutboxModel.bands(OutboxEntries.of(model.registry.ordered)).first?.entries.first,
                  case .host(let ref) = entry.item.ref else { return }
            let tc: [AnyHashable: Any] = ["event": "needs_you", "kind": "waiting", "environmentId": entry.environmentId, "threadId": entry.item.sessionId ?? "", "held": ["at": "host", "id": ref.id], "ts": 0]
            PushDelegate.route(["aps": ["alert": ["title": entry.item.summary]], "tc": tc])
        case "house-rules":
            // The work set: the first Work workspace's house rules.
            guard let workspace = client.workspaces.first(where: { $0.kind == .work }) else { return }
            home.open(.houseRules(environmentId: environmentId, workspaceId: workspace.id))
        case "work-view":
            // Milestone 47's work set: the first Work workspace's Mail, Tasks, Agenda or Routines (`TC_TEST_WORK_VIEW`),
            // or the one whose name holds `TC_TEST_JOB` (the proof parts m2 to m5: a job's Money, Plays, Forms).
            guard let workspace = proofJob(client) ?? client.workspaces.first(where: { $0.kind == .work }) else { return }
            home.open(.workView(environmentId: environmentId, workspaceId: workspace.id, view: TestHooks.workView ?? "mail"))
        case "place":
            // The proof parts m2 to m5: a place of the Work tab (`TC_TEST_WORK_VIEW`: mail, messages, people, files,
            // review, …) for every job, or for the one `TC_TEST_JOB` names. `TC_TEST_OPEN=chat:<sector>:<id>` or
            // `person:<sector>:<id>` then opens that conversation or person in the detail, in the job of that sector,
            // as a tap on its row does.
            guard let place = TestHooks.workView.flatMap(WorkPlace.init(rawValue:)) else { return }
            home.open(.place(place, job: proofJob(client).map { ProjectPairs.key(environmentId, $0) }))
            let parts = TestHooks.open?.split(separator: ":", maxSplits: 2).map(String.init) ?? []
            guard parts.count == 3, let holder = client.workspaces.first(where: { $0.kind == .work && $0.sector == parts[1] }) else { return }
            try? await Task.sleep(for: .milliseconds(600))
            switch parts[0] {
            case "chat": home.open(.chat(environmentId: environmentId, workspaceId: holder.id, chatId: parts[2]))
            case "person": home.open(.person(environmentId: environmentId, workspaceId: holder.id, personId: parts[2]))
            default: break
            }
        case "work-workspace":
            // Milestone 47's work set: the first Work workspace's screen, with Mail, Tasks, Agenda and Routines at its head.
            guard let workspace = client.workspaces.first(where: { $0.kind == .work }) else { return }
            // A Work workspace is an entry of Home's Work band, not of its code entries.
            let entry = HomeSections.home(hosts: HomeRows.inputs([client], current: true)).work.first {
                if case .workspace(let home) = $0.kind { home.members.contains { $0.workspace.id == workspace.id } } else { false }
            }
            if let entry { home.open(.workspace(key: entry.id)) }
        case "reader":
            // The reader's set: a Work thread's item (`TC_TEST_THREAD`, `TC_TEST_ITEM`) on its own page. The named thread
            // and its items can land after the first list: wait for each, as the outbox and computers routes wait, or a
            // launch that raced them stays on Home.
            var wanted: SessionMeta?
            for _ in 0..<100 {
                let candidates = client.currentSessions.filter { $0.parentId == nil }
                wanted = model.launchThread.flatMap { needle in candidates.first { $0.title.localizedCaseInsensitiveContains(needle) } }
                if wanted != nil { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard let session = wanted ?? client.currentSessions.first(where: { $0.parentId == nil }) else { return }
            var items: [CanvasItem] = []
            for _ in 0..<20 {
                await client.work.canvas.load(session.id)
                items = client.work.canvas.items(session.id)
                if !items.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
            let pick = TestHooks.item.flatMap { want in items.first { $0.kind.rawValue == want } ?? items.first { $0.title.localizedCaseInsensitiveContains(want) } } ?? items.first
            if let pick {
                client.work.canvas.warmTicket(pick)
                home.open(.file(environmentId: environmentId, item: pick, sessionId: session.id))
            }
        case "work-chats":
            home.open(.workspace(key: HomeSections.workChatsKey))
        case "work-settings":
            home.open(.workSettings)
        case "hosts":
            home.open(.settings)
            home.detailStack.append(Route.hosts)
        case "archived":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.currentSessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if let group = groups.projects.first(where: { $0.archivedCount > 0 }) {
                    home.open(.archivedThreads(environmentId: environmentId, projectId: group.id))
                    return
                }
            }
        case "archived-projects":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.currentSessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if !groups.archived.isEmpty {
                    home.open(.archivedProjects(environmentId: environmentId, workspaceId: workspace.id))
                    return
                }
            }
        case "thread":
            let candidates = client.currentSessions.filter { $0.parentId == nil }
            let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
            if let session = wanted.first ?? candidates.first {
                home.open(.thread(environmentId: environmentId, sessionId: session.id, seq: TestHooks.targetSeq))
                if let next = TestHooks.targetSeqNext {
                    // The second hit names a row of the same thread, whose screen stays mounted.
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(4))
                        home.open(.thread(environmentId: environmentId, sessionId: session.id, seq: next))
                    }
                }
                // The sidebar over the detail in the overlay pose, for the shot; `open` just hid it.
                if TestHooks.open == "sidebar" { home.sidebarShown = true }
                if let shown = TestHooks.sidebar { home.sidebarShown = shown }
            }
        case "thread-in-project":
            // The thread in its shell with its workspace open in the sidebar: the split's selected card.
            let candidates = client.currentSessions.filter { $0.parentId == nil && $0.projectId != nil }
            let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
            guard let session = wanted.first ?? candidates.first,
                  let project = client.projects.first(where: { $0.id == session.projectId }),
                  let workspace = client.workspaces.first(where: { $0.id == project.workspaceId }) else { return }
            home.open(.workspace(key: ProjectPairs.key(environmentId, workspace)))
            home.open(.thread(environmentId: environmentId, sessionId: session.id, seq: nil))
        case "project":
            // A project card's tap: the workspace in the sidebar, the project's shell on its landing
            // (TC_TEST_THREAD names a thread whose project it is, else the first project).
            let candidates = client.currentSessions.filter { $0.parentId == nil && $0.projectId != nil }
            let session = model.launchThread.flatMap { needle in candidates.first { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates.first
            guard let project = client.projects.first(where: { $0.id == session?.projectId }) ?? client.projects.first,
                  let workspace = client.workspaces.first(where: { $0.id == project.workspaceId }) else { return }
            home.open(.workspace(key: ProjectPairs.key(environmentId, workspace)))
            home.openProject(ProjectPairs.key(environmentId, project))
        case "workspace":
            // The sidebar at the Workspace level with nothing open: the split's empty detail.
            // A workspace, not the Chats entry: the project cards are what the shot shows.
            let entries = HomeSections.home(hosts: HomeRows.inputs([client], current: true)).entries
            let workspace = entries.first { if case .workspace = $0.kind { true } else { false } }
            if let entry = workspace ?? entries.first {
                home.open(.workspace(key: entry.id))
            }
        case "payload":
            // The digest set's taps: a notice exactly as the host sends it (`tc.work`), through the delegate's one route.
            guard let data = TestHooks.payload?.data(using: .utf8),
                  let userInfo = (try? JSONSerialization.jsonObject(with: data)) as? [AnyHashable: Any] else { return }
            PushDelegate.route(userInfo)
        case "notification":
            // The proof's tap: a payload shaped like the hub's, through the delegate's one route.
            guard let hook = TestHooks.notification else { return }
            let parts = hook.split(separator: "|", maxSplits: 1).map(String.init)
            let candidates = client.currentSessions.filter { $0.parentId == nil }
            guard let session = candidates.first(where: { $0.title.localizedCaseInsensitiveContains(parts[0]) }) else { return }
            var tc: [AnyHashable: Any] = ["event": "needs_you", "hostId": "box", "environmentId": environmentId, "threadId": session.id, "ts": 0]
            if parts.count > 1, let seq = Int(parts[1]) { tc["seq"] = seq }
            PushDelegate.route(["aps": ["alert": ["title": session.title]], "tc": tc])
        default:
            break
        }
    }
}

/// The new-thread sheet over every tab, opened from any screen of a shell
/// through `NewThreadPresenter`; a created thread opens in its workspace's tab.
private struct NewThreadSheetHost: ViewModifier {
    @Bindable var presenter: NewThreadPresenter
    let open: (Route, WorkspaceMeta) -> Void

    func body(content: Content) -> some View {
        content
            .environment(presenter)
            .sheet(item: $presenter.target) { target in
                NewThreadSheet(client: target.client, workspace: target.workspace, project: target.project) { created in
                    open(Route.thread(environmentId: target.client.environment.id, sessionId: created.id, seq: nil), target.workspace)
                }
            }
            // Return flow (thread 14): the sheet survives a kill; HomeView reopens it.
            .onChange(of: presenter.target?.id) {
                NavigationMemory.rememberSheet(presenter.target.map { .newThread(environmentId: $0.client.environment.id, workspaceId: $0.workspace.id, projectId: $0.project?.id) })
            }
    }
}
