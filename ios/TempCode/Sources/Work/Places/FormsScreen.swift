import SwiftUI
import TempCodeClient
import TempCodeContract

/// A job's Forms (docs/IOS-DESIGN.md "A job's small places"): TempCode's own forms, then the job's Microsoft forms,
/// each row its title with how it stands as the stamp. Close is the trailing swipe and the context menu on a form
/// that takes answers; Reopen on a closed one only for a key the host takes it from (approve on the key itself), after
/// the owner's check: it starts the form taking answers again. A Microsoft form that has collected opens its answers
/// here; a draft opens in Forms. Made and changed on the desktop.
struct FormsScreen: View {
    @Environment(\.openURL) private var openURL
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var ours: [FormListPhoneRow]?
    @State private var ms: [MsFormPhoneRow]?
    @State private var error: String?
    /// A read that failed over forms that showed: one line with Try Again above them, what showed kept.
    @State private var refreshError: String?
    /// The form a press is out for: its row holds a spinner and no second press.
    @State private var pressing: String?
    @State private var done = 0

    private var work: WorkHost { client.work }

    var body: some View {
        Group {
            if let ours, let ms {
                if ours.isEmpty, ms.isEmpty {
                    if let refreshError {
                        // A read that failed over nothing shown is never "No Forms": the failure, with Try Again.
                        ContentUnavailableView {
                            Label("Can’t Read Forms", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(refreshError)
                        } actions: {
                            Button("Try Again") { Task { await load() } }
                        }
                    } else {
                        ContentUnavailableView("No Forms", systemImage: "checklist")
                    }
                } else {
                    List {
                        if let refreshError {
                            Section {
                                // The list's own insets, as its rows have.
                                FailedRead(words: refreshError, retry: { await load() }, identifier: "forms-reread-failed", insets: nil,
                                           tint: Tint.destructiveText)
                            }
                        }
                        let both = !ours.isEmpty && !ms.isEmpty
                        if !ours.isEmpty {
                            Section {
                                ForEach(ours, id: \.id) { row in ourRow(row) }
                            } header: {
                                if both { Text("Docket").textStep(.meta, weight: .semibold) }
                            }
                        }
                        if !ms.isEmpty {
                            Section {
                                ForEach(ms, id: \.formId) { row in msRow(row) }
                            } header: {
                                if both { Text("Microsoft").textStep(.meta, weight: .semibold) }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Can’t Read Forms", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { self.error = nil; Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Forms")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: work.msformsRev[workspace.id] ?? 0) { await load() }
        .refreshable { await load() }
        .sensoryFeedback(.impact(weight: .light), trigger: done)
        .accessibilityIdentifier("forms")
    }

    // MARK: rows

    private func ourRow(_ row: FormListPhoneRow) -> some View {
        let presses = FormsList.presses(row, mayClose: work.may(.formsClose), mayReopen: work.may(.formsReopen))
        return FormRowView(title: row.title, stamp: FormsList.stamp(row), busy: pressing == row.id)
            .swipeActions(edge: .trailing) { pressButtons(presses) { press in Task { await setOurs(row, press) } } }
            .contextMenu { pressButtons(presses) { press in Task { await setOurs(row, press) } } }
            .accessibilityActions { pressButtons(presses) { press in Task { await setOurs(row, press) } } }
    }

    private func msRow(_ row: MsFormPhoneRow) -> some View {
        let presses = FormsList.presses(row, mayClose: work.may(.msformsClose), mayReopen: work.may(.msformsReopen))
        let answers = FormsList.answersHere(row) && work.may(.msformsResponses)
        return Group {
            if answers {
                // Pushed over Forms, so Back returns to the list.
                NavigationLink(value: Route.msformAnswers(environmentId: client.environment.id, workspaceId: workspace.id, formId: row.formId)) {
                    FormRowView(title: row.title, stamp: FormsList.stamp(row), busy: pressing == row.formId)
                }
            } else {
                Button {
                    if let url = MsForms.url(row) { openURL(url) }
                } label: {
                    FormRowView(title: row.title, stamp: FormsList.stamp(row), busy: pressing == row.formId)
                }
                .disabled(MsForms.url(row) == nil)
                .accessibilityAddTraits(.isLink)
            }
        }
        .buttonStyle(.pressable)
        .swipeActions(edge: .trailing) { pressButtons(presses) { press in Task { await setMs(row, press) } } }
        .contextMenu {
            if let url = MsForms.url(row) {
                Button("Open in Forms", systemImage: "safari") { openURL(url) }
            }
            pressButtons(presses) { press in Task { await setMs(row, press) } }
        }
        .accessibilityActions { pressButtons(presses) { press in Task { await setMs(row, press) } } }
    }

    @ViewBuilder private func pressButtons(_ presses: [FormsList.Press], run: @escaping (FormsList.Press) -> Void) -> some View {
        ForEach(presses, id: \.self) { press in
            switch press {
            case .close:
                Button("Close", systemImage: "stop.circle") { run(.close) }.tint(Tint.warning)
            case .reopen:
                Button("Reopen", systemImage: "arrow.counterclockwise.circle") { run(.reopen) }.tint(Tint.info)
            }
        }
    }

    // MARK: reads and presses

    /// Both lists, each read on its own: a read that fails keeps what it showed and says why above the list, and a
    /// failure is never "No Forms". With nothing shown at all, the failure is the page.
    private func load() async {
        async let oursRead = readOurs()
        var msRows: [MsFormPhoneRow]?
        var failure: String?
        do {
            msRows = work.may(.msformsList) ? try await client.work.canvas.msforms(workspace.id) : []
        } catch {
            failure = ActionError.wrap(error).message
        }
        let (oursRows, oursFailure) = await oursRead
        failure = failure ?? oursFailure
        let nextOurs = oursRows ?? ours
        let nextMs = msRows ?? ms
        guard nextOurs != nil || nextMs != nil else {
            error = failure
            return
        }
        ours = nextOurs ?? []
        ms = nextMs ?? []
        error = nil
        refreshError = failure
    }

    private func readOurs() async -> ([FormListPhoneRow]?, String?) {
        guard work.may(.formsList) else { return ([], nil) }
        do { return (try await work.ourForms(workspace.id), nil) } catch { return (nil, ActionError.wrap(error).message) }
    }

    private func setOurs(_ row: FormListPhoneRow, _ press: FormsList.Press) async {
        await run(press, id: row.id, title: row.title, ref: "form:\(row.id)", rev: row.state.rawValue, gate: .formsReopen) { key in
            let next = try await work.setFormOpen(row.id, open: press == .reopen, key: key)
            ours = ours?.map { $0.id == row.id ? FormListPhoneRow(id: $0.id, title: $0.title, state: .init(rawValue: next.state.rawValue), updatedAt: $0.updatedAt) : $0 }
        }
    }

    private func setMs(_ row: MsFormPhoneRow, _ press: FormsList.Press) async {
        await run(press, id: row.formId, title: row.title, ref: "msform:\(row.formId)", rev: row.state.rawValue, gate: .msformsReopen) { key in
            let next = try await work.setMsformOpen(workspace.id, formId: row.formId, open: press == .reopen, key: key)
            ms = ms?.map { $0.formId == next.formId ? next : $0 }
        }
    }

    /// One press: Reopen asks the owner's check first (it starts a form taking answers again); Close goes at once.
    private func run(_ press: FormsList.Press, id: String, title: String, ref: String, rev: String, gate: KeyMethod, call: (_ key: String) async throws -> Void) async {
        guard pressing == nil else { return }
        // Held through the owner's check too, so a second tap while it is up starts nothing.
        pressing = id
        defer { pressing = nil }
        // Frozen before the owner's check: Reopen's frame is held to it where the socket releases it.
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if press == .reopen, let line = await PressGates.shared.pass(client, gate, ref: ref, rev: rev, reason: "Reopen \(title)") {
            return FleetToastCenter.shared.post(message: line)
        }
        do {
            try await call(key)
            done += 1
            FleetToastCenter.shared.post(note: FormsList.doneWords(press, title: title))
        } catch {
            FleetToastCenter.shared.post(message: "\(press == .close ? "Not closed" : "Not reopened"): \(ActionError.wrap(error).message)")
        }
    }
}

private struct FormRowView: View {
    let title: String
    let stamp: String
    let busy: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Text(title).textStep(.title).lineLimit(1)
            Spacer(minLength: 8)
            if busy {
                ProgressView().controlSize(.small)
            } else {
                // Muted in the secondary label ink: the stamp step's own tertiary sits closer to the text and would win.
                Text(stamp).textStep(.stamp, tint: Color(.secondaryLabel)).monospacedDigit()
            }
        }
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A Microsoft form's answers in the app (M5b): when they were read, then each answer under its question, newest
/// first, as our own form's answers read. Opening them marks them seen on the host, so the digest's line goes. The
/// bar's menu has Open in Forms, and Close or Reopen as the key allows.
struct MsFormAnswersScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let environmentId: String
    let workspaceId: String
    let formId: String
    @State private var form: MsFormPhoneRow?
    @State private var answers: MsFormResponsesPhone?
    @State private var error: String?
    @State private var pressing = false
    @State private var done = 0

    var body: some View {
        Group {
            if let client = model.registry.client(environmentId) {
                content(client)
                    .task(id: client.work.msformsRev[workspaceId] ?? 0) { await load(client) }
                    .refreshable { await load(client) }
                    .toolbar { ToolbarItem(placement: .primaryAction) { menu(client) } }
            } else {
                ContentUnavailableView("Not Connected", systemImage: "wifi.slash")
            }
        }
        .navigationTitle(form?.title ?? "Answers")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.impact(weight: .light), trigger: done)
        .accessibilityIdentifier("msform-answers")
    }

    @ViewBuilder private func content(_ client: EnvironmentClient) -> some View {
        if let answers, let form {
            // A refresh that failed keeps the last read, its time in the footer, with the failed-read row above it.
            List {
                if let error {
                    Section { FailedRead(words: error, retry: { await load(client) }, identifier: "msform-reread-failed", insets: nil) }
                }
                if !answers.rows.isEmpty {
                    Section {
                        ForEach(Array(answers.rows.enumerated()), id: \.offset) { index, row in
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(answers.columns.enumerated()), id: \.offset) { column, question in
                                    if column < row.count, !row[column].isEmpty {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(question.label).textStep(.meta).foregroundStyle(.secondary)
                                            Text(row[column]).font(.body)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                            .accessibilityIdentifier("msform-answer-\(index)")
                        }
                    } header: {
                        Text(FormsList.stamp(form)).textStep(.meta, weight: .semibold)
                    } footer: {
                        VStack(alignment: .leading, spacing: 2) {
                            if let line = FormsList.readLine(answers) { Text(line) }
                            if answers.cut { Text("The newest are shown.") }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if answers.rows.isEmpty {
                    ContentUnavailableView("No Answers Yet", systemImage: "checklist", description: answers.none ? nil : FormsList.readLine(answers).map { Text($0) })
                }
            }
        } else if let error {
            ContentUnavailableView {
                Label("Can’t Read Answers", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again") { self.error = nil; Task { await load(client) } }
            }
        } else {
            ProgressView()
        }
    }

    private func menu(_ client: EnvironmentClient) -> some View {
        let presses = form.map { FormsList.presses($0, mayClose: client.work.may(.msformsClose), mayReopen: client.work.may(.msformsReopen)) } ?? []
        return Menu {
            if let form, let url = MsForms.url(form) {
                Button("Open in Forms", systemImage: "safari") { openURL(url) }
            }
            ForEach(presses, id: \.self) { press in
                Button(press == .close ? "Close" : "Reopen", systemImage: press == .close ? "stop.circle" : "arrow.counterclockwise.circle") {
                    Task { await set(client, press) }
                }
            }
        } label: {
            if pressing { ProgressView() } else { Label("More", systemImage: "ellipsis") }
        }
        .disabled(form == nil || pressing)
        .accessibilityIdentifier("msform-more")
    }

    private func load(_ client: EnvironmentClient) async {
        do {
            async let row = client.work.msform(workspaceId, formId: formId)
            async let read = client.work.msformAnswers(workspaceId, formId: formId)
            let (got, rows) = try await (row, read)
            form = got
            answers = rows
            error = nil
            // He has them on screen: what was new is seen, once a read shows any.
            if (got.unseen ?? 0) > 0, client.work.may(.msformsSeen), let seen = try? await client.work.msformSeen(workspaceId, formId: formId) {
                form = seen
            }
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func set(_ client: EnvironmentClient, _ press: FormsList.Press) async {
        guard let form, !pressing else { return }
        pressing = true
        defer { pressing = false }
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if press == .reopen, let line = await PressGates.shared.pass(client, .msformsReopen, ref: "msform:\(form.formId)", rev: form.state.rawValue, reason: "Reopen \(form.title)") {
            return FleetToastCenter.shared.post(message: line)
        }
        do {
            self.form = try await client.work.setMsformOpen(workspaceId, formId: formId, open: press == .reopen, key: key)
            done += 1
            FleetToastCenter.shared.post(note: FormsList.doneWords(press, title: form.title))
        } catch {
            FleetToastCenter.shared.post(message: "\(press == .close ? "Not closed" : "Not reopened"): \(ActionError.wrap(error).message)")
        }
    }
}
