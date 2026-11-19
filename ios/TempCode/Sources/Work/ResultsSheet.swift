import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work thread's Results (the desktop's right panel section; the phone has
/// no panel, so it is a sheet from the thread's menu): what the thread and its
/// subagents changed that lasts, newest first, in two groups. "Can undo" rows
/// carry their way back ("Undo", or the pillar's own words); "Can't undo"
/// ones say what was written and where. An undone row stays, marked.
struct ResultsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let sessionId: String
    @State private var results: [WorkResult]?
    @State private var error: String?
    @State private var undoing: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                if let results {
                    let canUndo = results.filter { $0.undo != nil && $0.undoneAt == nil }
                    let rest = results.filter { !($0.undo != nil && $0.undoneAt == nil) }
                    List {
                        if !canUndo.isEmpty {
                            Section("Can undo") { ForEach(canUndo, id: \.id) { row($0) } }
                        }
                        if !rest.isEmpty {
                            Section("Can’t undo") { ForEach(rest, id: \.id) { row($0) } }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .overlay {
                        if results.isEmpty {
                            ContentUnavailableView("Nothing Written Yet", systemImage: "arrow.uturn.backward", description: Text("What this thread changes on your files shows here."))
                        }
                    }
                } else if let error {
                    ContentUnavailableView("Can’t Read Results", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Results")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .task(id: client.work.resultsRev) { await load() }
        .tcSheet(.document)
        .accessibilityIdentifier("results")
    }

    private func row(_ result: WorkResult) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(result.summary)
                    .textStep(.title)
                    .strikethrough(result.undoneAt != nil, color: .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let account = result.account { Text(account).textStep(.meta).lineLimit(1) }
                    Text(HeldTime.of(result.createdAt)).textStep(.stamp)
                }
            }
            Spacer(minLength: 8)
            if result.undoneAt != nil {
                Text("Undone").textStep(.stamp)
            } else if let undo = result.undo, client.work.canApprove {
                Button(undo.label ?? "Undo") { Task { await run(result) } }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.tint)
                    .rowActionHit()
                    .buttonStyle(.pressable)
                    .disabled(undoing.contains(result.id))
            }
        }
        .frame(minHeight: Layout.rowHeight)
    }

    private func load() async {
        do {
            results = try await client.work.results(sessionId: sessionId)
            error = nil
        } catch {
            if results == nil { self.error = ActionError.wrap(error).message }
        }
    }

    private func run(_ result: WorkResult) async {
        undoing.insert(result.id)
        defer { undoing.remove(result.id) }
        do {
            let undone = try await client.work.undo(result)
            if let index = results?.firstIndex(where: { $0.id == undone.id }) { results?[index] = undone }
        } catch {
            FleetToastCenter.shared.post(message: "Not undone: \(ActionError.wrap(error).message)")
        }
    }
}
