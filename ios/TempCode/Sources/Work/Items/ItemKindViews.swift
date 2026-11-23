import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A meeting (milestone 47): its transcript, each line with who said it and when.
struct MeetingItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.meeting(item.id) }) { meeting, reload in
            if let meeting, !meeting.segments.isEmpty {
                let names = Dictionary(meeting.speakers.map { ($0.id, $0.name ?? $0.label) }, uniquingKeysWith: { a, _ in a })
                List(meeting.segments, id: \.id) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text(line.speaker.flatMap { names[$0] } ?? "Someone").textStep(.meta, weight: .semibold)
                            Text(mediaClock(line.start)).textStep(.stamp).monospacedDigit().foregroundStyle(.secondary)
                        }
                        Text(line.text).font(.body)
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.plain)
                .refreshable { reload() }
            } else {
                ContentUnavailableView(meeting?.error ?? "No transcript yet", systemImage: "waveform", description: Text(meeting.map { "\($0.status.capitalized)." } ?? "Nothing has been recorded."))
            }
        }
        .accessibilityIdentifier("meeting-item")
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
                            PillButton("Retry") { Task { await model.read() } }
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
                    if client.work.canApprove {
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

/// A dashboard (milestone 47): its blocks in order: headings, words, figures, bars and tables.
struct DashboardItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.dashboard(item.id) }) { dashboard, reload in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let failed = dashboard.failed {
                        Text(failed).textStep(.meta, tint: Tint.destructiveText)
                    } else if let asOf = dashboard.asOf {
                        Text((dashboard.stale ? "Last read " : "As of ") + Date(timeIntervalSince1970: asOf / 1000).formatted(date: .omitted, time: .shortened))
                            .textStep(.meta).foregroundStyle(.secondary)
                    }
                    ForEach(Array(dashboard.blocks.enumerated()), id: \.offset) { _, block in
                        DashBlockView(block: block)
                    }
                }
                .padding(Layout.textEdge)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { reload() }
        }
        .accessibilityIdentifier("dashboard-item")
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
                        if let sub = figure.sub { Text(sub).textStep(.stamp).foregroundStyle(.secondary) }
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
                        Text(bar.value.formatted()).textStep(.stamp).monospacedDigit().foregroundStyle(.secondary)
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
        ItemLoad(read: { try await client.work.canvas.versions(source) }) { history, _ in
            List(history.versions, id: \.id) { version in
                NavigationLink {
                    CompareView(client: client, source: source, versionId: version.id, names: history.names)
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
                CompareView(client: client, source: source, versionId: versionId, names: history.names)
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

private struct CompareView: View {
    let client: EnvironmentClient
    let source: CanvasSource
    let versionId: String
    let names: [String: String]

    var body: some View {
        ItemLoad(read: { try await client.work.canvas.compare(source, from: versionId) }) { compare, _ in
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
        }
        .accessibilityIdentifier("history-compare")
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
            } else if client.work.canApprove {
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
