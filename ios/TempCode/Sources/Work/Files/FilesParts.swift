import SwiftUI
import TempCodeClient
import TempCodeContract

/// A delete just made, for its five seconds of Undo (the Trash rows Put back takes).
struct TrashUndo: Identifiable, Equatable {
    let id = UUID()
    let ids: [String]
    let line: String
}

extension View {
    /// Undo after a delete: the Outbox's capsule over the list's foot for five seconds, entering and leaving
    /// from the same edge (opacity alone with Reduce Motion). The delete has happened: Undo puts it back.
    func filesUndoInset(_ pending: Binding<TrashUndo?>, undo: @escaping (TrashUndo) -> Void) -> some View {
        modifier(FilesUndoInset(pending: pending, undo: undo))
    }
}

private struct FilesUndoInset: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var pending: TrashUndo?
    let undo: (TrashUndo) -> Void

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let shown = pending {
                    UndoCapsule(line: shown.line, identifier: "files-undo") {
                        pending = nil
                        undo(shown)
                    }
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
                    .task(id: shown.id) {
                        try? await Task.sleep(for: .seconds(5))
                        if pending?.id == shown.id { pending = nil }
                    }
                }
            }
            .animation(Motion.base, value: pending)
    }
}

/// What the search field finds: at once, the rows the phone already has whose names match; then, when the
/// host's search answers (F4), its rows across every place instead. A host that cannot search yet leaves the
/// first.
struct FilesSearchList: View {
    let client: EnvironmentClient
    let workspaceId: String
    let query: String
    /// The rows shown before the search began (the folder's own).
    let local: [FileEntry]
    let places: [FilePlace]
    @State private var found: [FileEntry]?

    var body: some View {
        let rows = found ?? FilesRules.filter(local, query: query)
        Group {
            if rows.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    ForEach(rows, id: \.key) { entry in
                        FileRow(client: client, workspaceId: workspaceId, placeId: entry.where?.place ?? FilesRules.workspaceFolder(places)?.id ?? "", entry: entry, inLens: found != nil)
                    }
                }
                .listStyle(.plain)
            }
        }
        .task(id: query) {
            // The host's search runs once he pauses; the local rows show meanwhile, never an older query's answer.
            found = nil
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let answer = try? await client.work.files.search(workspaceId, query.trimmingCharacters(in: .whitespaces))
            guard !Task.isCancelled else { return }
            found = answer
        }
        .accessibilityIdentifier("files-search")
    }
}
