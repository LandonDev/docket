import SwiftUI
import TempCodeClient
import TempCodeContract

/// Go to (⌘P, the desktop's): a field, and the names each job's host has seen that hold every word, recents
/// first (`work.files.names`, twenty a job from its table, never a walk). The next keystroke cancels the asks
/// still out. A folder pushes its list, a file opens; the sheet goes either way.
struct FilesGoTo: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    let jobs: [FilesRoot.Job]
    @State private var text = ""
    @State private var rows: [FilesFound.Row] = []
    @State private var asking = true
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                ForEach(rows) { row in
                    Button { open(row) } label: {
                        FilesRowLabel(symbol: FilesGlyph.of(row.entry.kind), title: row.entry.name, fact: row.entry.where?.name ?? "", sector: jobs.count > 1 ? row.job.sector : nil)
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(Layout.rowInsets)
                    .accessibilityIdentifier("files-go-to-row")
                }
            }
            .listStyle(.plain)
            .overlay {
                if rows.isEmpty, !asking {
                    ContentUnavailableView(text.isEmpty ? "Nothing Recent" : "No Names Match", systemImage: "arrow.forward.circle")
                }
            }
            .navigationTitle("Go To")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: "File or folder name")
            .searchFocused($focused)
            .onSubmit(of: .search) { if let first = rows.first { open(first) } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .onAppear { focused = true }
        .task(id: text) { await ask() }
        .accessibilityIdentifier("files-go-to-sheet")
    }

    private func ask() async {
        asking = true
        let words = text.trimmingCharacters(in: .whitespaces)
        if !words.isEmpty { try? await Task.sleep(for: .milliseconds(150)) }
        guard !Task.isCancelled else { return }
        var found: [FilesFound.Row] = []
        await withTaskGroup(of: (FilesRoot.Job, [FileEntry]).self) { group in
            for job in jobs {
                guard let files = model.registry.client(job.environmentId)?.work.files else { continue }
                group.addTask { (job, (try? await files.names(job.workspaceId, words)) ?? []) }
            }
            for await (job, entries) in group {
                found += entries.map { FilesFound.Row(job: job, entry: $0) }
            }
        }
        guard !Task.isCancelled else { return }
        // Each host ranks its own; across jobs the order of the jobs holds.
        let order = Dictionary(jobs.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        rows = found.enumerated().sorted { (order[$0.element.job.id] ?? 0, $0.offset) < (order[$1.element.job.id] ?? 0, $1.offset) }.map(\.element)
        asking = false
    }

    private func open(_ row: FilesFound.Row) {
        guard let client = model.registry.client(row.job.environmentId) else { return }
        let places = client.work.files.places[row.job.workspaceId]?.value ?? []
        let home = FilesRules.homeId(of: row.entry, places: places) ?? FilesRules.workspaceFolder(places)?.id ?? ""
        dismiss()
        if let folder = row.entry.folder {
            navigator.open(.folder(environmentId: client.environment.id, workspaceId: row.job.workspaceId, placeId: home, at: folder, title: row.entry.name))
        } else if row.entry.ref != nil {
            navigator.open(.filesFile(environmentId: client.environment.id, workspaceId: row.job.workspaceId, placeId: home, entry: row.entry))
        }
    }
}
