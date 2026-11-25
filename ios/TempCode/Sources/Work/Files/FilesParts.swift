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
