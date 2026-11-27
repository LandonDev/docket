import SwiftUI
import TempCodeClient
import TempCodeContract

/// Search every host: thread rows that mention the query (`session.search`,
/// a thread's working notes among them), the app's notes (`notes.search`),
/// or lines of each live project's files (`search.project`) and projects by
/// name. The field is the system one; the scopes show only when an open
/// host has a project to grep; `host:`, `type:` (which wins over the scope)
/// and `project:` are typed in the box. A query waits 250 ms after the last
/// keystroke and runs on every open host at once, off the main actor; rows
/// land per host as it answers, ranked together without regard to the host,
/// and the previous answer stays on screen until the first batch lands, so
/// two queries' rows never mix. Tap a thread to open it, tap a hit to land
/// on its row. The Work scope (`WorkSearchRows`) asks every Work host in two
/// speeds (`WorkSearchRun`), Recent before he types. Nothing here animates
/// on a keystroke.
///
/// The rows are `CrossHostSearch.run`'s: the one loop in `run()` is the
/// model's seam, and the view draws whatever it emits.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    var initialQuery: String?
    @State private var query = ""
    @State private var scope = SearchScope.threads
    @State private var answer = SearchAnswer.none
    @State private var searching = false
    /// The Work scope's run, its one kind when he took "All mail for …", and a file being seated.
    @State private var work = WorkSearchRun()
    @State private var workKind: String?
    @State private var workOpening: String?
    @State private var workFailure: String?
    /// Where a head's title starts past the text edge: the glyph column and
    /// its gap, scaled with the glyph. Hits and separators start here.
    @ScaledMetric(relativeTo: .subheadline) private var glyphEdge = Layout.glyphWidth + Layout.rowGap
    /// Unfolded, the rows sit in a reading measure (`Layout.listMeasure`) instead of running across 951 pt.
    @Environment(\.windowClasses) private var window

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Every paired host in rail order, open or not.
    private var paired: [EnvironmentClient] { model.registry.ordered }
    private var openHosts: [EnvironmentClient] { paired.filter { $0.status.transport == .open } }
    private var offersFiles: Bool { openHosts.contains { client in client.projects.contains { !$0.archived } } }
    private var severalHosts: Bool { paired.count > 1 }
    private var workInputs: [WorkSearchHosts.Input] {
        paired.map { client in
            WorkSearchHosts.Input(
                id: client.environment.id,
                name: client.environment.name,
                platform: client.status.lastHello?.build?.platform,
                workOn: client.work.isOn,
                open: client.status.transport == .open,
                may: client.work.may(.searchQuery)
            )
        }
    }
    private var offersWork: Bool { WorkSearchHosts.offered(workInputs) }
    /// Every Work job across the hosts: a sector's workspaces are one job.
    private var workJobs: [String: String] {
        var jobs: [String: String] = [:]
        for client in paired { for space in client.workspaces where space.kind == .work { jobs[space.id] = space.sector ?? "ws:\(space.id)" } }
        return jobs
    }
    private var prompt: String {
        switch (offersFiles, offersWork) {
        case (true, true): "Threads, files and Work"
        case (true, false): "Threads and files"
        case (false, true): "Threads and Work"
        case (false, false): "Threads"
        }
    }
    private var hitInsets: EdgeInsets {
        EdgeInsets(top: 0, leading: Layout.textEdge + glyphEdge, bottom: 0, trailing: Layout.textEdge)
    }

    /// What `.task(id:)` keys on: the query, the scope and the open hosts, so
    /// a host coming or going re-runs the search.
    nonisolated private struct SearchKey: Hashable {
        let query: String
        let scope: SearchScope
        let hosts: [String]
    }

    /// What the Work scope asks again on: his words, the kind, and the hosts it may ask.
    nonisolated private struct WorkKey: Hashable {
        let query: String
        let kind: String?
        let hosts: [WorkSearchModel.Host]
        let offline: [String]
    }

    /// Nil while the Work scope is not shown or no host can be asked.
    private var workKey: WorkKey? {
        guard scope == .work else { return nil }
        let asked = WorkSearchHosts.hosts(workInputs)
        guard !asked.hosts.isEmpty else { return nil }
        return WorkKey(query: trimmed, kind: workKind, hosts: asked.hosts, offline: asked.offline)
    }

    var body: some View {
        let jobs = workJobs
        let workRows = scope == .work ? work.model.rows(jobOf: { id in id.map { jobs[$0] ?? $0 } ?? "" }) : []
        List {
            if scope == .work {
                WorkSearchRows(
                    run: work,
                    rows: workRows,
                    mixed: WorkSearchModel.placesMix(jobs: Set(jobs.values).count, rows: workRows),
                    narrow: { workKind = $0 },
                    opening: $workOpening,
                    failure: $workFailure
                )
            } else {
            ForEach(answer.rows) { row in
                switch row {
                case .threadHead(let head):
                    Button { open(head.environmentId, head.sessionId, seq: nil) } label: {
                        ThreadHeadRow(head: head)
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(Layout.rowInsets)
                    .separatorAtTextEdge(glyphEdge)
                    .listRowSeparator(.hidden, edges: .top)
                case .hit(let hit):
                    Button { open(hit.environmentId, hit.sessionId, seq: hit.seq) } label: {
                        HitRow(hit: hit)
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(hitInsets)
                case .projectHead(let head):
                    ProjectHeadRow(head: head)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                case .file(let file):
                    SearchFileRow(file: file)
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(glyphEdge)
                case .project(let project):
                    ProjectRow(project: project)
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(glyphEdge)
                case .note(let note):
                    NoteRow(note: note)
                        .listRowInsets(Layout.rowInsets)
                        .separatorAtTextEdge(glyphEdge)
                case .more:
                    MoreRow()
                        .listRowInsets(Layout.rowInsets)
                        .listRowSeparator(.hidden)
                }
            }
            if severalHosts, !answer.isEmpty, let foot = SearchRows.footLine(answer.hosts) {
                FootRow(text: foot)
                    .listRowInsets(Layout.rowInsets)
                    .listRowSeparator(.hidden)
            }
            }
        }
        .listStyle(.plain)
        .frame(maxWidth: window.horizontal == .regular ? Layout.listMeasure : .infinity)
        .frame(maxWidth: .infinity)
        .modifier(SearchField(query: $query, prompt: prompt))
        .searchPresentationToolbarBehavior(.avoidHidingContent)
        .modifier(SearchScopes(scope: $scope, files: offersFiles, work: offersWork))
        // Return takes the first row, as the desktop's picker does.
        .onSubmit(of: .search) { submitWork(workRows) }
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .overlay(alignment: .top) {
            Group {
                if scope == .work { workStatus(workRows) } else { status }
            }
            .padding(.top, 24)
        }
        .toolbar {
            if scope == .work, workKind != nil {
                ToolbarItem(placement: .primaryAction) {
                    // Held to one kind: the filled filter says so, and a tap widens to every kind.
                    Button("All Kinds", systemImage: "line.3.horizontal.decrease.circle.fill") { workKind = nil }
                }
            }
        }
        .alert("Can’t Open", isPresented: Binding(get: { workFailure != nil }, set: { if !$0 { workFailure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(workFailure ?? "")
        }
        .navigationTitle("Search")
        .onAppear {
            if query.isEmpty, let initialQuery { query = initialQuery }
            #if DEBUG
            // The simulator proof's shot of the Files scope; nothing else reads it.
            if let asked = ProcessInfo.processInfo.environment["TC_TEST_SEARCH_SCOPE"], let shot = SearchScope(rawValue: asked), shot != .threads { scope = shot }
            #endif
        }
        .onChange(of: offersFiles) {
            if !offersFiles, scope == .files { scope = .threads }
        }
        .onChange(of: offersWork) {
            if !offersWork, scope == .work { scope = .threads }
        }
        .onChange(of: scope) {
            workKind = nil
            if scope != .work { work.cancel() }
        }
        // Every change of his words asks at once (the fast answer); the run waits 120 ms for the slow one.
        .onChange(of: workKey, initial: true) { _, key in
            guard let key else { return }
            Motion.withoutAnimation {
                work.search(key.query, kind: key.kind, hosts: key.hosts, offline: key.offline, ask: ask)
            }
        }
        .onDisappear { work.cancel() }
        .task(id: SearchKey(query: trimmed, scope: scope, hosts: openHosts.map(\.environment.id))) { await run() }
    }

    /// What sits over the empty list (`SearchStatus`); nothing while an older answer is still showing.
    @ViewBuilder private var status: some View {
        if answer.isEmpty {
            let connecting = paired.count { [.connecting, .reconnecting].contains($0.status.transport) }
            switch SearchStatus.of(paired: paired.count, open: openHosts.count, connecting: connecting, queryLength: trimmed.count,
                                   searching: searching, answered: answer.query == trimmed && answer.scope == scope, hosts: answer.hosts) {
            case .noHosts: NoHostsView()
            case .offline: SearchStatusLine("Every computer is offline.")
            case .spinner:
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(openHosts.isEmpty ? "Connecting" : "Searching")
            case .noResults: ContentUnavailableView.search(text: answer.query)
            case .failed(let names): SearchStatusLine(SearchStatus.failedLine(names))
            case .noResultsFailed(let names):
                // The system's no-results view, its spelling hint traded for the computers that never answered.
                ContentUnavailableView {
                    Label("No Results for “\(answer.query)”", systemImage: "magnifyingglass")
                } description: {
                    Text(SearchStatus.failedLine(names))
                }
            case .none: EmptyView()
            }
        }
    }

    /// One calm line over an empty Work list: the hint, a spinner while the first answers are out, or nothing found.
    @ViewBuilder private func workStatus(_ rows: [WorkSearchModel.Row]) -> some View {
        if !rows.contains(where: { if case .hit = $0 { true } else { false } }) {
            if WorkSearchHosts.hosts(workInputs).hosts.isEmpty {
                SearchStatusLine("Every host with Work is offline.")
            } else if work.model.busy {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Searching")
            } else if rows.contains(where: { $0.id == "nothing" }) {
                ContentUnavailableView.search(text: work.model.text)
            } else if trimmed.isEmpty {
                SearchStatusLine("Everything in every job.")
            }
        }
    }

    /// `work.search.query` on the host the run names.
    private var ask: WorkSearchRun.Ask {
        let registry = model.registry
        return { host, params in
            guard let client = registry.client(host) else { throw TransportError.notConnected }
            return try await client.work.searchWork(params)
        }
    }

    /// Return in the field: the first row that opens, or "All … for" narrows.
    private func submitWork(_ rows: [WorkSearchModel.Row]) {
        guard scope == .work, let id = work.model.active(in: rows), let row = rows.first(where: { $0.id == id }) else { return }
        switch row {
        case .all(_, let kind, _): workKind = kind
        case .hit(_, let hit, let host):
            guard let target = WorkSearchTarget.of(hit, environmentId: host), case .route(let route) = target, let client = model.registry.client(host) else { return }
            Task { await client.work.searchOpened(hit) }
            navigator.open(route)
        default: break
        }
    }

    private func open(_ environmentId: String, _ sessionId: String, seq: Int?) {
        navigator.open(.thread(environmentId: environmentId, sessionId: sessionId, seq: seq))
    }

    private func run() async {
        let text = trimmed
        let scope = scope
        // The Work scope runs on its own (`work`); this task asks nothing for it.
        guard scope != .work else { return }
        // The words alone must be long enough: `host:box` by itself asks nobody.
        guard ParsedQuery.parse(text).text.count >= SearchDebounce.minimumLength else {
            answer = .none
            searching = false
            return
        }
        let delay = SearchDebounce.delay(previousQuery: answer.query, nextQuery: text)
        if delay > .zero {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
        }
        // Every paired host in rail order, open or not, snapshotted on the main
        // actor; the closures hop back to it only to send. `EnvironmentClient`
        // is main-actor, so capturing it in a `@Sendable` closure is allowed.
        let targets: [SearchTarget] = paired.map { client in
            SearchTarget(
                id: client.environment.id,
                name: client.environment.name,
                open: client.status.transport == .open,
                isMac: client.status.lastHello?.build?.platform == "darwin",
                sessions: client.listedSessions.filter { $0.parentId == nil },
                projects: client.projects.filter { !$0.archived },
                workspaces: client.workspaces,
                ask: SearchAsk(
                    threads: { query in try await client.request(Methods.SessionSearch.self, .init(query: query, limit: CrossHostSearch.threadLimit)) },
                    files: { cwd, query in try await client.request(Methods.SearchProject.self, .init(options: .init(cwd: cwd, query: query))) },
                    notes: { query in try await client.request(Methods.NotesSearch.self, .init(query: query, limit: CrossHostSearch.noteLimit)) }
                )
            )
        }
        searching = true
        // A cancelled search may finish after its replacement started; only the live one clears the cue.
        defer { if !Task.isCancelled { searching = false } }
        // The cross-host model: a batch after every landed source, the previous
        // answer kept until the first lands. Ids are stable across batches, so an
        // unchanged row keeps its place and nothing animates on a keystroke.
        for await next in CrossHostSearch.run(raw: text, scope: scope, targets: targets, pairs: pairLookup, clock: SystemClock(), now: { Int(Date().timeIntervalSince1970 * 1000) }) {
            guard !Task.isCancelled else { return }
            Motion.withoutAnimation { answer = next }
        }
    }

    /// Where a path sits in its paired project, for the fold of the same
    /// file on two hosts: the pairs over every paired host's workspaces, read
    /// on the main actor once per search.
    private var pairLookup: PairLookup {
        CrossHostSearch.pairLookup(ProjectPairs.pairs(paired.map { HostWorkspaces(environmentId: $0.environment.id, workspaces: $0.workspaces) }))
    }
}

/// The system field, placed by version: on iOS 26 `.automatic` keeps the
/// search-role tab's own field; before it the navigation drawer, always shown.
/// On the iPhone Duo the system places the field per pose; the decided
/// fallback, if a pose ever moves or drops it, is the drawer always shown in
/// every pose (the one line below), never a custom field.
private struct SearchField: ViewModifier {
    @Binding var query: String
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            // Fallback: content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
            content.searchable(text: $query, placement: .automatic, prompt: prompt)
        } else {
            content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        }
    }
}

/// The scope buttons under the field, only where a second scope is on offer. With Work they show as the
/// field opens, so Recent is one tap away before he types.
private struct SearchScopes: ViewModifier {
    @Binding var scope: SearchScope
    let files: Bool
    let work: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if files || work {
            content.searchScopes($scope, activation: work ? .onSearchPresentation : .onTextEntry) {
                Text("Threads").tag(SearchScope.threads)
                if files { Text("Files").tag(SearchScope.files) }
                if work { Text("Work").tag(SearchScope.work) }
            }
        } else {
            content
        }
    }
}
