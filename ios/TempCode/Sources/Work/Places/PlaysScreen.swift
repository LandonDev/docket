import SwiftUI
import TempCodeClient
import TempCodeContract

/// A job's Plays (docs/IOS-DESIGN.md "A job's small places"): his plays, each its name with what it takes under it.
/// A play that takes a line of text, a date or nothing runs here: its row opens the run sheet, whose Run starts the
/// play as a Work thread (`work.routines.playStart`) and opens it. A play about a mail, a task, an event or a file
/// starts from that thing on the computer; its row reads what it takes and opens nothing. Proposals and writing
/// plays stay on the desktop.
struct PlaysScreen: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var plays: [PlayPhoneRow]?
    @State private var error: String?
    @State private var running: PlayPhoneRow?
    /// A refresh that failed over plays that showed: one line with Try Again above them.
    @State private var refreshError: String?

    private var work: WorkHost { client.work }

    var body: some View {
        Group {
            if let plays {
                let shown = plays.filter { !$0.proposed }
                if shown.isEmpty {
                    if let refreshError {
                        // A read that failed over nothing shown is never "No Plays": the failure, with Try Again.
                        ContentUnavailableView {
                            Label("Can’t Read Plays", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(refreshError)
                        } actions: {
                            Button("Try Again") { Task { await load() } }
                        }
                    } else {
                        ContentUnavailableView("No Plays", systemImage: "play.square.stack")
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
                        ForEach(shown, id: \.id) { play in
                            if PlayRun.runsHere(play), work.may(.playStart) {
                                Button { running = play } label: { PlayRowView(play: play) }
                                    .buttonStyle(.pressable)
                                    .accessibilityHint("Opens Run")
                            } else {
                                PlayRowView(play: play)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Can’t Read Plays", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { self.error = nil; Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Plays")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: work.playsRev[workspace.id] ?? 0) { await load() }
        .refreshable { await load() }
        .sheet(item: $running) { play in
            PlayRunSheet(work: work, play: play) { sessionId in
                navigator.open(.thread(environmentId: client.environment.id, sessionId: sessionId, seq: nil))
            }
        }
        .accessibilityIdentifier("plays")
    }

    private func load() async {
        do {
            plays = try await work.plays(workspace.id)
            error = nil
            refreshError = nil
        } catch {
            if plays == nil { self.error = ActionError.wrap(error).message } else { refreshError = ActionError.wrap(error).message }
        }
    }
}

private struct PlayRowView: View {
    let play: PlayPhoneRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(play.name).textStep(.title).lineLimit(1)
            if let takes = PlayRun.takesLine(play.takes) {
                Text(takes).textStep(.meta).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Run a play: its instructions to read, then the line of text and the date it takes; Run stays off until each is
/// there. The thread it starts opens; the play only drafts, as every Work thread does, and holds what goes out.
private struct PlayRunSheet: View {
    @Environment(\.dismiss) private var dismiss
    let work: WorkHost
    let play: PlayPhoneRow
    let started: (String) -> Void
    @State private var text = ""
    @State private var date = Date()
    @State private var starting = false
    @State private var error: String?
    @FocusState private var typing: Bool

    private var inputs: PlayRun.Inputs? {
        PlayRun.inputs(play, text: text, date: PlayRun.asksDate(play) ? date : nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(play.instructions)
                        .textStep(.meta)
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                }
                if PlayRun.asksText(play) {
                    Section("Text") {
                        TextField("Paste or type what it works from", text: $text, axis: .vertical)
                            .lineLimit(3...8)
                            .focused($typing)
                            .accessibilityIdentifier("play-text")
                    }
                }
                if PlayRun.asksDate(play) {
                    Section {
                        DatePicker("Date", selection: $date, displayedComponents: .date)
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle(play.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if starting {
                        ProgressView()
                    } else {
                        Button("Run") { Task { await run() } }
                            .disabled(inputs == nil)
                            .accessibilityIdentifier("play-run")
                    }
                }
            }
            .onAppear { typing = PlayRun.asksText(play) }
        }
        .tcSheet(.form)
    }

    private func run() async {
        guard let inputs, !starting else { return }
        starting = true
        defer { starting = false }
        do {
            let sessionId = try await work.startPlay(play, inputs: inputs)
            dismiss()
            started(sessionId)
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

extension PlayPhoneRow: @retroactive Identifiable {}
