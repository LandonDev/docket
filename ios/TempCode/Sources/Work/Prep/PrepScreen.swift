import SwiftUI
import TempCodeClient
import TempCodeContract

/// A meeting's page, in the detail (docs/IOS-DESIGN.md "Work on the phone", ### A meeting's page): the event's
/// title over one line (when, where, when to leave), then what the host keeps for it (`work.prep.page`). Before
/// the meeting the brief leads; after it the outcome does: the summary, his notes, what was decided, the tasks
/// he ticks and files, open questions, the follow-up mail that waits in the Outbox. The bar holds the one verb
/// where the meeting stands (Prepare, Preparing, Add Notes, Follow Up, Following Up) and More. Prepare and Follow
/// Up each start a Work thread that only drafts; nothing here sends.
struct PrepScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    let eventId: String

    var body: some View {
        if let client = model.registry.client(environmentId) {
            PrepPageView(client: client, workspaceId: workspaceId, eventId: eventId)
                .id("\(environmentId)|\(workspaceId)|\(eventId)")
        } else {
            ContentUnavailableView("Meeting Not Here", systemImage: "calendar", description: Text("Its job’s computer is not paired with this iPhone."))
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct PrepPageView: View {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let client: EnvironmentClient
    let workspaceId: String
    let eventId: String
    @State private var page: PrepPagePhone?
    @State private var readError: String?
    @State private var line: String?
    /// The line is a read that did not refresh, so Retry reads again; a press that failed keeps its reason, no Retry.
    @State private var lineRead = false
    @State private var starting = false
    @State private var ticks = PrepTicks()
    @State private var desk: PrepNotesDesk?
    @State private var writing = false
    @FocusState private var notesFocused: Bool

    private var now: Double { Date().timeIntervalSince1970 * 1000 }

    var body: some View {
        content
            .navigationTitle(page?.event.title ?? "Meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let page {
                    ToolbarItem(placement: .primaryAction) { verb(page) }
                    ToolbarItem(placement: .primaryAction) { more(page) }
                }
            }
            .refreshable { await read() }
            .task(id: client.work.prepRev[workspaceId] ?? 0) { await read() }
            .task(id: desk?.due) { await saveWhenQuiet() }
            .onChange(of: phase) { _, now in if now != .active { Task { await save(force: true) } } }
            .onDisappear { Task { await save(force: true) } }
            .accessibilityIdentifier("prep")
    }

    // MARK: - the page

    @ViewBuilder private var content: some View {
        if let page {
            List {
                Section {
                    Text(PrepRules.whenLine(page.event, now: now, calendar: .current))
                        .textStep(.meta)
                    if let line {
                        stateLine(line, retry: lineRead)
                    } else if let words = PrepRules.problemWords(page.problems) {
                        stateLine(words, retry: true)
                    }
                }
                if page.doc.after != nil {
                    after(page)
                    brief(page, title: "Brief")
                } else {
                    if showsNotes(page) { notes(page) }
                    brief(page, title: nil)
                }
                facts(page)
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
        } else if let readError {
            ContentUnavailableView {
                Label("This Page Did Not Load", systemImage: "calendar")
            } description: {
                Text(readError)
            } actions: {
                Button("Try Again") { Task { await read() } }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// A fault in one line, the failed-read row of every Work place; `retry`: what it says is the read's, and Try
    /// Again reads the page again.
    private func stateLine(_ words: String, retry: Bool) -> some View {
        FailedRead(words: words, retry: retry ? { await read() } : nil, identifier: "prep-state", tint: Tint.destructiveText)
    }

    /// The brief: what matters, what was agreed, the files it names; its bones while its thread writes.
    @ViewBuilder private func brief(_ page: PrepPagePhone, title: String?) -> some View {
        if let brief = page.doc.brief {
            lines(title, brief.matters)
            lines("Agreed", brief.agreed)
        } else if PrepRules.briefWorks(page, now: now) {
            Section {
                ForEach(0..<3, id: \.self) { _ in Text("A line the brief will hold").textStep(.title) }
            }
            .redacted(reason: .placeholder)
            .accessibilityLabel("Preparing the brief")
        }
    }

    /// After the meeting: the summary, his notes, what was decided, the tasks to file, open questions, the mail.
    @ViewBuilder private func after(_ page: PrepPagePhone) -> some View {
        if let after = page.doc.after {
            lines(nil, after.summary)
            notes(page)
            lines("Decided", after.decisions)
            todo(page)
            lines("Open Questions", after.questions)
        }
        if !page.drafts.isEmpty {
            Section("Mail") {
                ForEach(page.drafts, id: \.outboxId) { draft in
                    LineRow(title: PrepRules.draftLine(draft), line: "Waits in the Outbox", trail: nil, open: { navigator.open(.place(.outbox)) })
                }
            }
        }
    }

    /// The facts LifeOS gives: last time, who is coming, the open tasks, the files and links.
    @ViewBuilder private func facts(_ page: PrepPagePhone) -> some View {
        if let last = page.last {
            Section(PrepRules.lastLabel(last, calendar: .current)) {
                ForEach(Array((last.decided + last.open).enumerated()), id: \.offset) { _, line in Text(line.text).textStep(.title) }
                ForEach(last.tasks, id: \.id) { task in LineRow(title: task.title, line: PrepRules.taskLine(task), trail: nil, open: nil) }
            }
        }
        if !page.people.isEmpty {
            Section {
                ForEach(page.people, id: \.name) { person in
                    LineRow(title: person.name, line: PrepRules.personLine(person), trail: person.declined == true ? "Declined" : person.mail.map { TimeFormat.stamp(Int($0.at)) }, open: route(person).map { route in { navigator.open(route) } })
                }
            } header: {
                Text("People")
            } footer: {
                if let more = PrepRules.moreWords(page.morePeople) { Text(more) }
            }
        }
        if !page.tasks.isEmpty {
            Section("Tasks") {
                ForEach(page.tasks, id: \.id) { task in
                    LineRow(title: task.title, line: PrepRules.taskLine(task), trail: task.dueAt.map { TimeFormat.stamp(Int($0)) }, open: nil)
                }
            }
        }
        let files = page.files + (page.doc.brief?.files ?? [])
        if !files.isEmpty {
            Section("Files and Links") {
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                    if let url = file.url.flatMap(URL.init(string:)) {
                        Link(destination: url) { LineRow(title: file.title, line: url.host(), trail: nil, open: nil) }
                    } else {
                        LineRow(title: file.title, line: nil, trail: nil, open: nil)
                    }
                }
            }
        }
    }

    @ViewBuilder private func lines(_ title: String?, _ lines: [PrepLine]) -> some View {
        if !lines.isEmpty {
            Section {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in Text(line.text).textStep(.title) }
            } header: {
                if let title { Text(title) }
            }
        }
    }

    /// His notes, kept as he types (the house's draft rule).
    @ViewBuilder private func notes(_ page: PrepPagePhone) -> some View {
        let kept = page.doc.notes?.text ?? ""
        Section {
            if let file = page.notesFile {
                LineRow(title: file.title, line: file.error, trail: nil, open: nil)
            }
            TextField("Notes", text: Binding(
                get: { desk?.text ?? kept },
                set: { words in
                    var next = desk ?? PrepNotesDesk(kept: kept)
                    next.edit(words, at: Date().timeIntervalSince1970)
                    desk = next
                }
            ), axis: .vertical)
            .lineLimit(3...)
            .focused($notesFocused)
            .disabled(!client.work.may(.prepNotes))
            .accessibilityIdentifier("prep-notes")
        } header: {
            Text("Notes")
        } footer: {
            if let words = desk?.line {
                HStack(alignment: .firstTextBaseline) {
                    Text(words)
                    if words == PrepNotesDesk.changedLine {
                        PillButton("Keep Mine") { Task { await save(force: true) } }
                    }
                }
            }
        }
    }

    /// The suggested tasks: none ticked at first; Tick All, and Add N Tasks while any is ticked.
    @ViewBuilder private func todo(_ page: PrepPagePhone) -> some View {
        let tasks = PrepRules.shownTasks(page)
        if !tasks.isEmpty {
            let mayFile = client.work.may(.prepDecide)
            Section {
                ForEach(tasks, id: \.id) { task in suggestion(task, mayFile: mayFile) }
            } header: {
                Text("To Do")
            } footer: {
                if mayFile, !PrepTicks.open(tasks).isEmpty {
                    let count = ticks.toFile(tasks).count
                    HStack(spacing: Layout.rowGap) {
                        if !ticks.failed.isEmpty {
                            Text(PrepRules.failedWords(ticks.failed, tasks: tasks)).foregroundStyle(Tint.destructiveText)
                            PillButton("Try Again") { Task { await file(ticks.retrying) } }
                        } else {
                            PillButton("Tick All") { ticks.tickAll(tasks) }.disabled(ticks.filing)
                        }
                        Spacer(minLength: Layout.rowGap)
                        if count > 0 {
                            Button(PrepRules.addLabel(count)) { Task { await file(ticks.toFile(tasks)) } }
                                .buttonStyle(.borderedProminent)
                                .disabled(ticks.filing)
                                .accessibilityIdentifier("prep-add-tasks")
                        }
                    }
                }
            }
        }
    }

    private func suggestion(_ task: PrepSuggestion, mayFile: Bool) -> some View {
        let filed = task.state == .filed
        let ticked = filed || ticks.isTicked(task.id)
        return Button {
            withAnimation(reduceMotion ? nil : Motion.fast) { ticks.toggle(task.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(ticked ? Color.accentColor : .secondary)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title).textStep(.title)
                    if let why = ticks.failed[task.id] {
                        Text(why).textStep(.meta, tint: Tint.destructiveText)
                    } else if let who = task.who, !who.isEmpty {
                        Text(who).textStep(.meta)
                    }
                }
                Spacer(minLength: Layout.rowGap)
                if let due = task.due { Text(TimeFormat.stamp(Int(due))).textStep(.stamp) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(filed || !mayFile || ticks.filing)
        .sensoryFeedback(.selection, trigger: ticked)
        .accessibilityAddTraits(ticked ? .isSelected : [])
    }

    // MARK: - the bar

    @ViewBuilder private func verb(_ page: PrepPagePhone) -> some View {
        switch PrepRules.verb(page, now: now, calendar: .current) {
        case .prepare?:
            if client.work.may(.prepBrief) {
                Button("Prepare") { Task { await start(follow: false) } }.disabled(starting).accessibilityIdentifier("prep-verb")
            }
        case .followUp?:
            if client.work.may(.prepFollowUp) {
                Button("Follow Up") { Task { await start(follow: true) } }.disabled(starting).accessibilityIdentifier("prep-verb")
            }
        case .addNotes?:
            if client.work.may(.prepNotes) {
                Button("Add Notes") { notesFocused = true }.accessibilityIdentifier("prep-verb")
            }
        case let working?:
            Button { openThread(page) } label: {
                HStack(spacing: Layout.tagGap) {
                    ProgressView()
                    Text(PrepRules.label(working))
                }
            }
            .accessibilityIdentifier("prep-verb")
        case nil:
            EmptyView()
        }
    }

    private func more(_ page: PrepPagePhone) -> some View {
        Menu {
            if PrepRules.thread(page) != nil {
                Button("Open Thread", systemImage: "bubble.left") { openThread(page) }
            }
            if page.doc.brief != nil, !PrepRules.isOver(page.event, now: now, calendar: .current), !PrepRules.briefWorks(page, now: now), client.work.may(.prepBrief) {
                Button("Prepare Again", systemImage: "arrow.clockwise") { Task { await start(follow: false, restart: true) } }
            }
            if !showsNotes(page), client.work.may(.prepNotes) {
                Button("Add Notes", systemImage: "square.and.pencil") { writing = true; notesFocused = true }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("prep-more")
    }

    /// The notes show once there are some, once the meeting is over, or once he asks for them.
    private func showsNotes(_ page: PrepPagePhone) -> Bool {
        writing || page.doc.notes != nil || PrepRules.isOver(page.event, now: now, calendar: .current)
    }

    // MARK: - reads and presses

    private func read() async {
        do {
            let fresh = try await client.work.prepPage(workspaceId: workspaceId, eventId: eventId)
            page = fresh
            readError = nil
            line = nil
            lineRead = false
            ticks.keep(PrepRules.shownTasks(fresh))
            if var next = desk {
                next.heard(fresh.doc.notes?.text ?? "")
                desk = next
            }
        } catch {
            if page == nil {
                readError = ActionError.wrap(error).message
            } else {
                line = "This page did not refresh"
                lineRead = true
            }
        }
    }

    private func start(follow: Bool, restart: Bool = false) async {
        starting = true
        defer { starting = false }
        await save(force: true)
        do {
            _ = follow
                ? try await client.work.followUp(workspaceId: workspaceId, eventId: eventId, restart: restart)
                : try await client.work.prepare(workspaceId: workspaceId, eventId: eventId, restart: restart)
            await read()
        } catch {
            line = ActionError.wrap(error).message
            lineRead = false
        }
    }

    private func openThread(_ page: PrepPagePhone) {
        guard let sessionId = PrepRules.thread(page) else { return }
        navigator.open(.thread(environmentId: client.environment.id, sessionId: sessionId, seq: nil))
    }

    private func file(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        ticks.begin()
        do {
            let answer = try await client.work.decideTasks(workspaceId: workspaceId, eventId: eventId, taskIds: ids, accept: true)
            ticks.answered(ids, failed: answer.failed.map { ($0.id, $0.error) })
            page = answer.page
            ticks.keep(PrepRules.shownTasks(answer.page))
        } catch {
            ticks.lost()
            line = ActionError.wrap(error).message
            lineRead = false
        }
    }

    private func saveWhenQuiet() async {
        guard let due = desk?.due else { return }
        let wait = due - Date().timeIntervalSince1970
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        if !Task.isCancelled { await save(force: false) }
    }

    private func save(force: Bool) async {
        guard var next = desk, let sent = next.take(now: Date().timeIntervalSince1970, force: force) else { return }
        desk = next
        do {
            let answer = try await client.work.keepNotes(workspaceId: workspaceId, eventId: eventId, text: sent.text, base: sent.base)
            next = desk ?? next
            next.answered(sent: sent.text, kept: answer.page.doc.notes?.text ?? "", conflict: answer.conflict == true, now: Date().timeIntervalSince1970)
            desk = next
            page = answer.page
        } catch {
            next = desk ?? next
            next.failed("Not saved: \(ActionError.wrap(error).message)")
            desk = next
        }
    }

    /// Someone on the meeting opens their page when they are one of the job's people.
    private func route(_ person: PrepPagePhone.People) -> Route? {
        person.personId.map { .person(environmentId: client.environment.id, workspaceId: workspaceId, personId: $0) }
    }
}
