import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work workspace's routines and watches (milestone 47, the phone-canvas
/// page; M5b's Run Now and last runs): two bands, each row its name with the
/// trigger in plain words under it and when it next runs as the stamp; a watch
/// carries the watching dot, a paused one the pause glyph. A tap unfolds its
/// last runs, a run that started a thread opening it. Run Now is the leading
/// swipe and the context menu; Pause or Resume the trailing swipe.
struct RoutinesScreen: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var rows: [RoutinePhoneRow]?
    @State private var error: String?
    /// The routines unfolded, and the runs each last read (nil: reading).
    @State private var open: Set<String> = []
    @State private var runs: [String: [RoutineRunPhone]] = [:]
    @State private var runFailed: [String: String] = [:]
    @State private var done = 0
    /// A refresh that failed over routines that showed: one line with Try Again above them.
    @State private var refreshError: String?
    /// The routines a Run Now is out for: a spinner stands in their stamp, and no second press runs them twice.
    @State private var running: Set<String> = []

    private var work: WorkHost { client.work }

    var body: some View {
        Group {
            if let rows {
                let bands = RoutineBands.bands(rows)
                if bands.routines.isEmpty, bands.watches.isEmpty {
                    if let refreshError {
                        // A read that failed over nothing shown is never "No Routines": the failure, with Try Again.
                        ContentUnavailableView {
                            Label("Can’t Read Routines", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(refreshError)
                        } actions: {
                            Button("Try Again") { Task { await load() } }
                        }
                    } else {
                        ContentUnavailableView("No Routines", systemImage: "clock.arrow.circlepath")
                    }
                } else {
                    List {
                        if let refreshError {
                            Section {
                                HStack(spacing: Layout.rowGap) {
                                    Text(refreshError).textStep(.meta, tint: Tint.destructiveText)
                                    Spacer(minLength: Layout.rowGap)
                                    PillButton("Try Again") { Task { await load() } }
                                }
                            }
                        }
                        let both = RoutineBands.headed(bands)
                        band("Routines", bands.routines, headed: both)
                        band("Watches", bands.watches, headed: both)
                    }
                    .listStyle(.plain)
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Can’t Read Routines", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { self.error = nil; Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: work.canvas.routinesRev[workspace.id] ?? 0) { await load() }
        .refreshable { await load() }
        .sensoryFeedback(.impact(weight: .light), trigger: done)
        .accessibilityIdentifier("routines")
    }

    @ViewBuilder private func band(_ title: String, _ rows: [RoutinePhoneRow], headed: Bool) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.id) { row in
                    DisclosureGroup(isExpanded: expanded(row)) {
                        runList(row)
                    } label: {
                        // The presses ride the routine's own row: on the group they would reach each run's row too.
                        RoutineRowView(row: row, running: running.contains(row.id))
                        .swipeActions(edge: .leading) {
                            if runsNow(row) {
                                Button("Run Now", systemImage: "play.fill") { Task { await runNow(row) } }.tint(Tint.info)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if !row.ended, work.may(.routinesPause) {
                                Button(row.enabled ? "Pause" : "Resume", systemImage: row.enabled ? "pause" : "play") { Task { await pause(row) } }
                                    .tint(row.enabled ? Tint.warning : Tint.info)
                            }
                        }
                        .contextMenu {
                            if runsNow(row) {
                                Button("Run Now", systemImage: "play.fill") { Task { await runNow(row) } }
                            }
                        }
                    }
                }
            } header: {
                if headed { SectionHeader(title).listRowInsets(EdgeInsets()) }
            }
        }
    }

    /// The last runs under an unfolded routine: a spinner while they are read, "None yet", the read's error, or a row
    /// a run; a run that started a thread opens it.
    @ViewBuilder private func runList(_ row: RoutinePhoneRow) -> some View {
        if let failed = runFailed[row.id] {
            // The failed-read row of every Work place: the words, and Try Again, which reads this routine's runs again.
            FailedRead(words: failed, retry: { await readRuns(row.id) }, identifier: "routine-runs-failed", insets: nil)
        } else if let list = runs[row.id] {
            if list.isEmpty {
                Text("None yet").textStep(.meta).foregroundStyle(.secondary)
            }
            ForEach(list, id: \.id) { run in
                if let sessionId = run.sessionId {
                    Button {
                        navigator.open(.thread(environmentId: client.environment.id, sessionId: sessionId, seq: nil))
                    } label: {
                        RunRowView(run: run)
                    }
                    .buttonStyle(.pressable)
                    .accessibilityAddTraits(.isLink)
                } else {
                    RunRowView(run: run)
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func expanded(_ row: RoutinePhoneRow) -> Binding<Bool> {
        Binding(get: { open.contains(row.id) }, set: { on in
            if on {
                open.insert(row.id)
                Task { await readRuns(row.id) }
            } else {
                open.remove(row.id)
            }
        })
    }

    private func runsNow(_ row: RoutinePhoneRow) -> Bool {
        RoutineRuns.runsNow(row) && work.may(.routinesRunNow) && !running.contains(row.id)
    }

    private func load() async {
        do {
            rows = try await work.canvas.routines(workspace.id)
            error = nil
            refreshError = nil
            for id in open { await readRuns(id) }
        } catch {
            if rows == nil { self.error = ActionError.wrap(error).message } else { refreshError = ActionError.wrap(error).message }
        }
    }

    private func readRuns(_ id: String) async {
        guard work.may(.routinesRuns) else { return runs[id] = [] }
        do {
            runs[id] = try await work.runs(id)
            runFailed[id] = nil
        } catch {
            runFailed[id] = ActionError.wrap(error).message
        }
    }

    private func runNow(_ row: RoutinePhoneRow) async {
        guard running.insert(row.id).inserted else { return }
        defer { running.remove(row.id) }
        do {
            let run = try await work.runNow(row.id)
            done += 1
            FleetToastCenter.shared.post(note: run == nil ? "\(row.name) had nothing to run" : "Running \(row.name)")
            open.insert(row.id)
            await readRuns(row.id)
        } catch {
            FleetToastCenter.shared.post(message: "Not run: \(ActionError.wrap(error).message)")
        }
    }

    private func pause(_ row: RoutinePhoneRow) async {
        do {
            let changed = try await work.canvas.pause(row, row.enabled)
            rows = rows?.map { $0.id == changed.id ? changed : $0 }
        } catch {
            // The list is up: a failed swipe is a toast, never the page's read error (which the list hides).
            FleetToastCenter.shared.post(message: "\(row.enabled ? "Not paused" : "Not resumed"): \(ActionError.wrap(error).message)")
        }
    }
}

private struct RoutineRowView: View {
    let row: RoutinePhoneRow
    var running = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if !row.enabled, !row.ended {
                        Image(systemName: "pause.fill").imageScale(.small).foregroundStyle(.secondary)
                    } else if row.kind == .watch, !row.ended {
                        Circle().fill(Tint.info).frame(width: 7, height: 7).accessibilityLabel("Watching")
                    }
                    Text(row.name).textStep(.title)
                }
                Text(row.words).textStep(.meta).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            if running {
                ProgressView().controlSize(.small).accessibilityLabel("Running")
            } else {
                Text(RoutineBands.stamp(row)).textStep(.stamp).foregroundStyle(.secondary).monospacedDigit()
            }
        }
        .opacity(row.ended ? 0.5 : 1)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}

/// One run: its mark (a spinner while it works, the destructive dot when it failed), its outcome, when it fired.
private struct RunRowView: View {
    let run: RoutineRunPhone
    @ScaledMetric(relativeTo: .footnote) private var mark: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var dot: CGFloat = 7

    var body: some View {
        let state = RoutineRuns.mark(run)
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Group {
                switch state {
                case .working: ProgressView().controlSize(.mini)
                case .failed: Circle().fill(Tint.destructive).frame(width: dot, height: dot)
                case .waiting: Image(systemName: "questionmark.circle").imageScale(.small).foregroundStyle(.secondary)
                case .done: Image(systemName: "checkmark").imageScale(.small).foregroundStyle(.secondary)
                }
            }
            .frame(width: mark)
            Text(RoutineRuns.words(run))
                .textStep(.meta, tint: state == .failed ? Tint.destructiveText : nil)
                .lineLimit(2)
            Spacer(minLength: 8)
            Text(RoutineRuns.when(run)).textStep(.stamp).foregroundStyle(.secondary).monospacedDigit()
        }
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
