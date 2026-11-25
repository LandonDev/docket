import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A meeting (milestone 47, M3b): the recording's player over the tasks it yielded and its transcript. A line or a
/// task plays from its moment. A task waits on his word: Add files it in LifeOS for the job, Drop takes it away; the
/// bar adds every one that waits. Video stands above the fold's band on a table and beside the transcript on the
/// open Duo.
struct MeetingItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.meeting(item.id) }) { meeting, reload in
            if let meeting, !meeting.segments.isEmpty || !MeetingActions.shown(meeting).isEmpty {
                MeetingPage(client: client, item: item, initial: meeting, reload: reload)
            } else {
                ContentUnavailableView(meeting?.error ?? "No Transcript Yet", systemImage: "waveform", description: Text(meeting.map { "\($0.status.capitalized)." } ?? "Nothing has been recorded."))
            }
        }
        .accessibilityIdentifier("meeting-item")
    }
}

private struct MeetingPage: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let initial: MeetingPhone
    let reload: () -> Void
    @State private var meeting: MeetingPhone?
    @State private var player = MeetingPlayer()
    @State private var deciding = false
    @State private var failure: String?
    @State private var decided = 0

    private var shown: MeetingPhone { meeting ?? initial }
    private var plays: Bool { shown.media != nil }
    private var video: Bool { shown.media?.kind == .video }
    private var mayDecide: Bool { client.work.may(.meetingsDecide) }
    private var waiting: [MeetingActions.Action] { MeetingActions.waiting(shown) }

    var body: some View {
        ReaderSpread(enabled: video) {
            if plays { MeetingPlayerBar(player: player) }
        } with: {
            list
        } single: { thing, with in
            VStack(spacing: 0) {
                if plays {
                    thing
                    Divider()
                }
                with
            }
        }
        .tcBottomBar {
            if mayDecide, !waiting.isEmpty {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    if deciding { ProgressView() }
                    Button(MeetingActions.addWords(waiting.count)) { Task { await decide(waiting.map(\.id), accept: true) } }
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(minHeight: Layout.rowHeight)
                        .buttonBorderShape(.capsule)
                        .tcGlassButton(prominent: true)
                        .disabled(deciding)
                        .accessibilityIdentifier("meeting-add-all")
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, 8)
            }
        }
        .task(id: item.id) {
            guard plays, client.work.may(.meetingsRecording) else { return }
            await player.open(item.id, canvas: client.work.canvas, video: video, duration: shown.durationSec)
        }
        .onDisappear { player.close() }
        .onChange(of: initial) { _, now in meeting = now }
        .alert("Couldn’t do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .sensoryFeedback(.impact(weight: .light), trigger: decided)
    }

    private var list: some View {
        let names = Dictionary(shown.speakers.map { ($0.id, $0.name ?? $0.label) }, uniquingKeysWith: { a, _ in a })
        let tasks = MeetingActions.shown(shown)
        return List {
            if !tasks.isEmpty {
                Section {
                    ForEach(tasks, id: \.id) { action in
                        taskRow(action)
                    }
                } header: {
                    GroupHeader("Tasks")
                }
            }
            if !shown.segments.isEmpty {
                Section {
                    ForEach(shown.segments, id: \.id) { line in
                        Button { if player.state == .ready { player.play(from: line.start) } } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(line.speaker.flatMap { names[$0] } ?? "Someone").textStep(.meta, weight: .semibold, tint: .primary)
                                    Text(mediaClock(line.start)).textStep(.stamp).monospacedDigit().foregroundStyle(.secondary)
                                }
                                Text(line.text).font(.body).foregroundStyle(.primary)
                            }
                            .padding(.vertical, 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(player.state == .ready ? "Plays from here" : "")
                    }
                } header: {
                    if !tasks.isEmpty { GroupHeader("Transcript") }
                }
            }
        }
        .listStyle(.plain)
        .animation(Motion.rowLeave, value: tasks.map(\.id))
        .refreshable { reload() }
    }

    private func taskRow(_ action: MeetingActions.Action) -> some View {
        let open = action.state == .proposed
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: open ? "circle" : "checkmark.circle.fill")
                .foregroundStyle(open ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Tint.success))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(action.text).font(.body)
                if let due = action.due { Text("Due \(due)").textStep(.meta) }
            }
            Spacer(minLength: 0)
            if let at = MeetingActions.seek(action), player.state == .ready {
                Button(mediaClock(at)) { player.play(from: at) }
                    .textStep(.stamp)
                    .monospacedDigit()
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Play from \(mediaClock(at))")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(open ? "Task, waiting: \(action.text)" : "Task, added: \(action.text)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if open, mayDecide, !deciding {
                Button("Add", systemImage: "checkmark") { Task { await decide([action.id], accept: true) } }
                    .tint(Tint.success)
            }
        }
        // No full swipe: a dropped task has no undo.
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if open, mayDecide, !deciding {
                Button("Drop", systemImage: "xmark") { Task { await decide([action.id], accept: false) } }
                    .tint(Tint.quiet)
            }
        }
        .rowAppearTransition()
        .accessibilityIdentifier("meeting-task")
    }

    /// One decision at a time; the meeting the host answers replaces this one, and what LifeOS would not file is said.
    private func decide(_ ids: [String], accept: Bool) async {
        guard !deciding, !ids.isEmpty else { return }
        deciding = true
        defer { deciding = false }
        do {
            let answer = try await client.work.canvas.decide(meeting: item.id, actionIds: ids, accept: accept)
            meeting = answer.meeting
            decided += 1
            failure = MeetingActions.failedWords(answer.failed)
        } catch {
            failure = ActionError.wrap(error).message
        }
    }
}

/// The browser (milestone 47): the page live, who drives and where, Take Over and Hand Back, and an act the
/// browser holds for him as the one prominent button, which opens it in the Outbox.
struct BrowserItemView: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let item: CanvasItem
    @State private var model: BrowserStateModel?
    @State private var error: String?

    private var held: [OutboxItem] {
        // The browser's own acts: a held computer act of this thread, not its mail.
        client.work.items.filter { $0.sessionId == item.sessionId && $0.state == .held && $0.kind == .computerAct }
    }

    var body: some View {
        Group {
            if let model, let state = model.state {
                list(state, model: model)
            } else if let model, let failed = model.error {
                ContentUnavailableView {
                    Label("Can’t Open This", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failed)
                } actions: {
                    // the phone's busy idiom: the spinner in the button's place while the read is out
                    if model.reading > 0 {
                        ProgressView()
                    } else {
                        Button("Try Again") { Task { await model.read() } }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            let model = self.model ?? BrowserStateModel(client: client, sessionId: item.sessionId)
            self.model = model
            if model.state == nil { await model.read() }
        }
        .accessibilityIdentifier("browser-item")
    }

    private func list(_ state: BrowserState, model: BrowserStateModel) -> some View {
        List {
            // a re-read that failed while the browser is shown: the content stays, with a short line and Retry
            if let refreshError = model.refreshError {
                Section {
                    HStack(spacing: 12) {
                        Text("Couldn’t read the browser again: \(refreshError)").textStep(.meta, tint: Tint.destructiveText)
                        Spacer(minLength: 8)
                        // the phone's busy idiom: the spinner in the button's place while the read is out
                        if model.reading > 0 {
                            ProgressView()
                        } else {
                            PillButton("Try Again") { Task { await model.read() } }
                        }
                    }
                    .accessibilityIdentifier("browser-reread-failed")
                }
            }
            Section {
                // the page as it is now, where the kept picture goes (docs/agents/live-video.md "From his other devices")
                LivePicture(client: client, threadId: item.sessionId, place: client.environment.name)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    .listRowBackground(Color.clear)
            }
            Section {
                LabeledContent(state.driver == .owner ? "You are driving" : "The agent is driving") {
                    if client.work.may(.browserDrive) {
                        Button(state.driver == .owner ? "Hand Back" : "Take Over") { Task { await drive(state.driver != .owner, model: model) } }
                            .disabled(model.driving)
                            .accessibilityIdentifier("browser-drive")
                    }
                }
                if let site = state.site {
                    LabeledContent("Site") { Text(site.name).lineLimit(1) }
                }
                if let needs = state.needs {
                    Text(needs).foregroundStyle(Tint.warningText)
                }
            }
            if !state.sources.isEmpty {
                Section("Where the values came from") {
                    ForEach(state.sources, id: \.field) { source in
                        LabeledContent(source.field, value: source.source)
                    }
                }
            }
            if let error {
                Text(error).foregroundStyle(Tint.destructiveText)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let act = held.first {
                Button {
                    navigator.open(.outboxItem(environmentId: client.environment.id, ref: OutboxModel.key(act.ref)))
                } label: {
                    Text(act.summary).lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal, Layout.textEdge)
                .padding(.bottom, 8)
                .accessibilityIdentifier("browser-held")
            }
        }
        .refreshable { await model.read() }
        .task {
            #if DEBUG
            // The work set: `TC_TEST_OPEN=browser-held` presses the held act once it shows.
            guard TestHooks.open == "browser-held" else { return }
            for _ in 0..<100 {
                if let act = held.first, TestHooks.once("browser-held") {
                    try? await Task.sleep(for: .seconds(2))
                    navigator.open(.outboxItem(environmentId: client.environment.id, ref: OutboxModel.key(act.ref)))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            #endif
        }
    }

    private func drive(_ owner: Bool, model: BrowserStateModel) async {
        do {
            // the call's own answer is the state now; a read still out from before it is dropped (BrowserStateModel)
            try await model.drive(owner: owner)
            error = nil
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A form's responses (milestone 47): how many, then each response as its answers under their questions.
struct FormItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.responses(item.id) }) { responses, reload in
            if responses.rows.isEmpty {
                ContentUnavailableView("No Responses", systemImage: "list.bullet.clipboard")
            } else {
                List {
                    Section {
                        ForEach(Array(responses.rows.enumerated()), id: \.offset) { index, row in
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(responses.columns.enumerated()), id: \.offset) { column, question in
                                    if column < row.count, !row[column].isEmpty {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(question.label).textStep(.meta).foregroundStyle(.secondary)
                                            Text(row[column]).font(.body)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                            .accessibilityIdentifier("form-response-\(index)")
                        }
                    } header: {
                        Text(responses.count == 1 ? "1 response" : "\(responses.count) responses")
                            .textStep(.meta, weight: .semibold)
                    } footer: {
                        if responses.cut { Text("The newest are shown.") }
                    }
                }
                .refreshable { reload() }
            }
        }
        .accessibilityIdentifier("form-item")
    }
}

/// A dashboard (milestone 47): its blocks in order: headings, words, figures, bars and tables. Pull to refresh reads
/// every figure again now (`work.dashboards.refresh`, M5b) for a key that may; a block whose sheet has a place on
/// the phone opens it (`DashSource`: a LifeOS sheet in the hosted editor, a Microsoft form's answers).
struct DashboardItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    /// The next read is his pull: every figure read again, not the page as last read.
    @State private var fresh = false

    var body: some View {
        let refreshes = client.work.may(.dashboardsRefresh)
        ItemLoad(read: { [fresh] in
            try await (fresh && refreshes ? client.work.refreshDashboard(item.id) : client.work.canvas.dashboard(item.id))
        }, onRead: { _ in fresh = false }) { dashboard, reload in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let failed = dashboard.failed {
                        Text(failed).textStep(.meta, tint: Tint.destructiveText)
                    } else if let asOf = dashboard.asOf {
                        Text((dashboard.stale ? "Last read " : "As of ") + Date(timeIntervalSince1970: asOf / 1000).formatted(date: .omitted, time: .shortened))
                            .textStep(.meta).foregroundStyle(.secondary)
                    }
                    ForEach(Array(dashboard.blocks.enumerated()), id: \.offset) { _, block in
                        if let source = DashSource.of(block), let route = route(source) {
                            // Pushed over the dashboard, so Back returns to it.
                            NavigationLink(value: route) {
                                DashBlockView(block: block).contentShape(Rectangle())
                            }
                            .buttonStyle(.pressable)
                            .accessibilityHint("Opens where its numbers come from")
                        } else {
                            DashBlockView(block: block)
                        }
                    }
                }
                .padding(Layout.textEdge)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable {
                fresh = true
                reload()
            }
        }
        .accessibilityIdentifier("dashboard-item")
    }

    /// A LifeOS sheet in the hosted editor, as a project's file opens; a form's answers on their page.
    private func route(_ source: DashSource) -> Route? {
        switch source {
        case .lifeosSheet(let id, let title):
            guard client.work.may(.guestsTicket), let workspaceId = item.workspaceId else { return nil }
            return .file(environmentId: client.environment.id, item: LifeDocItem.item(.sheet, id: id, title: title, workspaceId: workspaceId), sessionId: nil)
        case .msform(let workspaceId, let formId):
            guard client.work.may(.msformsResponses) else { return nil }
            return .msformAnswers(environmentId: client.environment.id, workspaceId: workspaceId, formId: formId)
        }
    }
}

private struct DashBlockView: View {
    let block: DashBlockPhone

    var body: some View {
        switch block {
        case .heading(let heading):
            Text(heading.text).font(.title3.weight(.semibold))
        case .text(let words):
            Text(words.text).font(.body)
        case .figures(let figures):
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 12) {
                ForEach(figures.figures, id: \.id) { figure in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(figure.value ?? "–").font(.title2.weight(.semibold)).monospacedDigit()
                        Text(figure.label).textStep(.meta).foregroundStyle(.secondary)
                        // The figure's line under its number reads at the 4.5:1 floor (baseline w39), as the Outbox's stamps do.
                        if let sub = figure.sub { Text(sub).textStep(.stamp) }
                    }
                }
            }
        case .chart(let chart):
            VStack(alignment: .leading, spacing: 6) {
                Text(chart.title).textStep(.title, weight: .semibold)
                let values = chart.bars.map(\.value)
                let zero = ChartBars.zero(values)
                ForEach(Array(chart.bars.enumerated()), id: \.offset) { _, bar in
                    HStack(spacing: 8) {
                        Text(bar.label).textStep(.meta).frame(width: 96, alignment: .leading).lineLimit(1)
                        GeometryReader { proxy in
                            let span = ChartBars.bar(bar.value, in: values)
                            let width = bar.value == 0 ? 0 : max(2, proxy.size.width * span.length)
                            ZStack(alignment: .leading) {
                                // With a negative value the zero line shows, one hairline through every row, and a
                                // loss runs left of it.
                                if zero > 0 {
                                    Hairline(axis: .vertical)
                                        .frame(height: 14)
                                        .offset(x: proxy.size.width * zero)
                                }
                                // One series is the neutral (DESIGN.md: chart-neutral, the foreground at 30 %), never a hue.
                                Capsule().fill(.tertiary)
                                    .frame(width: width, height: 8)
                                    .offset(x: bar.value < 0 ? proxy.size.width * zero - width : proxy.size.width * zero)
                            }
                            .frame(height: 8)
                        }
                        .frame(height: 8)
                        Text(bar.value.formatted()).textStep(.stamp).monospacedDigit()
                    }
                }
            }
        case .table(let table):
            VStack(alignment: .leading, spacing: 6) {
                Text(table.title).textStep(.title, weight: .semibold)
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                        GridRow { ForEach(Array(table.head.enumerated()), id: \.offset) { Text($1).textStep(.meta, weight: .semibold) } }
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                                    Text(cell).textStep(.meta).monospacedDigit()
                                        .gridColumnAlignment(column < table.numeric.count && table.numeric[column] ? .trailing : .leading)
                                }
                            }
                        }
                    }
                }
            }
        case .unknown:
            EmptyView()
        }
    }
}

/// History and compare (milestone 47): the versions, newest first; a version opens its compare
/// with the item as it is now, each change a paragraph with what went struck through and what came underlined.
struct HistoryItemView: View {
    let client: EnvironmentClient
    let source: CanvasSource
    /// The work set (`TC_TEST_OPEN=compare`): the oldest version's compare, pushed once the list is in.
    @State private var testCompare: String?

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.versions(source) }) { history, reload in
            let ids = history.versions.map(\.id)
            List(history.versions, id: \.id) { version in
                NavigationLink {
                    CompareView(client: client, source: source, versionId: version.id, versions: ids, names: history.names, restored: reload)
                        .navigationTitle(version.label ?? Date(timeIntervalSince1970: version.at / 1000).formatted(date: .abbreviated, time: .shortened))
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(version.label ?? Date(timeIntervalSince1970: version.at / 1000).formatted(date: .abbreviated, time: .shortened)).textStep(.title)
                        if !version.by.isEmpty {
                            Text(version.by.map { history.names[$0] ?? $0 }.joined(separator: ", ")).textStep(.meta).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("history-version")
            }
            .listStyle(.plain)
            .navigationDestination(item: $testCompare) { versionId in
                CompareView(client: client, source: source, versionId: versionId, versions: ids, names: history.names, restored: reload)
                    .sidebarButtonPage()
            }
            .task {
                #if DEBUG
                if TestHooks.open == "compare", TestHooks.once("history-compare") { testCompare = history.versions.last?.id }
                #endif
            }
        }
        .accessibilityIdentifier("history-item")
    }
}

/// A version against the document as it is now, with Restore in the bar for any version but the newest. On his own
/// document the host writes it back at once and the capsule offers Undo (back to the version cut just before); on a
/// document others can open it waits as suggestions in Review Changes, and nothing reaches anyone until he accepts.
private struct CompareView: View {
    let client: EnvironmentClient
    let source: CanvasSource
    let versionId: String
    /// Every version's id, newest first.
    let versions: [String]
    let names: [String: String]
    /// A restore wrote a new version: the list reads again.
    let restored: () -> Void
    @State private var restoring = false
    @State private var capsule: (id: Int, line: String, undo: String?)?
    @State private var failure: String?
    /// Reads the compare again after a restore.
    @State private var generation = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var mayRestore: Bool { client.work.may(.historyRestore) && HistoryRestore.restores(versionId, in: versions) }

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.compare(source, from: versionId) }) { compare, reload in
            let stats = compare.diff.stats
            List {
                Section {
                    ForEach(compare.diff.rows, id: \.id) { row in
                        changeText(row).font(.body).padding(.vertical, 2)
                    }
                } header: {
                    Text("\(stats.added) added, \(stats.removed) removed, \(stats.changed) changed").textStep(.meta).monospacedDigit()
                }
            }
            .listStyle(.plain)
            .overlay { if compare.diff.rows.isEmpty { ContentUnavailableView("No Changes", systemImage: "equal") } }
            .onChange(of: generation) { reload() }
        }
        .toolbar {
            if mayRestore {
                ToolbarItem(placement: .topBarTrailing) {
                    if restoring {
                        ProgressView().accessibilityLabel("Restoring")
                    } else {
                        Button("Restore") { Task { await restore(versionId) } }
                            .accessibilityIdentifier("history-restore")
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Group {
                if let capsule {
                    UndoCapsule(line: capsule.line, identifier: "history-undo", undo: capsule.undo.map { before in { Task { await restore(before, undoing: true) } } })
                }
            }
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
        }
        .animation(Motion.base, value: capsule?.id)
        .task(id: capsule?.id) {
            guard capsule != nil else { return }
            try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
            guard !Task.isCancelled else { return }
            capsule = nil
        }
        .alert("Couldn’t Restore", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .sensoryFeedback(.impact(weight: .light), trigger: capsule?.id)
        .accessibilityIdentifier("history-compare")
    }

    /// One restore at a time. Undo restores the version cut just before, and offers no Undo of its own.
    private func restore(_ id: String, undoing: Bool = false) async {
        guard !restoring else { return }
        restoring = true
        defer { restoring = false }
        do {
            let outcome = HistoryRestore.outcome(try await client.work.canvas.restore(source, versionId: id))
            let undo: String? = if case .written(let before) = outcome, !undoing { before } else { nil }
            capsule = ((capsule?.id ?? 0) + 1, undoing ? "Restore undone" : HistoryRestore.words(outcome), undo)
            generation += 1
            restored()
        } catch {
            failure = ActionError.wrap(error).message
        }
    }

    private func changeText(_ row: HistoryComparePhone.Diff.Row) -> Text {
        if let inline = row.inline {
            return inline.reduce(Text("")) { text, op in
                switch op.op {
                case .kept, .unknown: text + Text(op.text)
                case .removed: text + ChangeText.removed(op.text)
                case .added: text + ChangeText.added(op.text)
                }
            }
        }
        switch row.kind {
        case .removed: return ChangeText.removed(row.left?.text ?? "")
        case .added: return ChangeText.added(row.right?.text ?? "")
        default: return Text(row.right?.text ?? row.left?.text ?? "")
        }
    }
}

/// A held mail (milestone 47): the draft as LifeOS holds it, and once it has gone, the house rule
/// his edits suggest as one line with Add Rule.
struct MailItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let draftId: String
    @State private var proposals: [RuleProposal] = []

    var body: some View {
        if let workspace = client.workspaces.first(where: { $0.id == item.workspaceId }) {
            let host = WorkLifeHost.of(client, workspace: workspace)
            ItemLoad(read: { try await host.draft(draftId) }) { doc, _ in
                let message = doc.row.message
                List {
                    Section {
                        LabeledContent("To", value: (message.to ?? []).map(\.shown).joined(separator: ", "))
                        if let subject = message.subject { LabeledContent("Subject", value: subject) }
                    }
                    Section { Text(message.text ?? message.snippet ?? "").font(.body) }
                    if doc.row.status == .sent {
                        ForEach(proposals, id: \.id) { proposal in
                            ProposalLine(client: client, proposal: proposal)
                        }
                    }
                }
                .task(id: doc.row.status == .sent) {
                    guard doc.row.status == .sent else { return }
                    proposals = (try? await client.work.proposals(forDraft: draftId)) ?? []
                }
            }
            .accessibilityIdentifier("mail-item")
        } else {
            ContentUnavailableView("This mail opens in Mail.", systemImage: Symbol.mail)
        }
    }
}

/// Under a sent mail: the rule his edits suggest, one line, with Add Rule.
private struct ProposalLine: View {
    let client: EnvironmentClient
    let proposal: RuleProposal
    @State private var added = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(proposal.line).textStep(.meta).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if added {
                Text("Added").textStep(.meta).foregroundStyle(.secondary)
            } else if client.work.may(.rulesAdd) {
                Button("Add Rule") {
                    Task {
                        if (try? await client.work.addRule(proposal.workspaceId, text: proposal.text, proposalId: proposal.id)) != nil { added = true }
                    }
                }
                .accessibilityIdentifier("proposal-add")
            }
        }
        .accessibilityIdentifier("proposal-line")
    }
}
