import SwiftUI
import TempCodeClient
import TempCodeContract

/// Add to Thread (a Files row's menu): the job's open Work threads, pinned first then the newest (`AddToThread`); a
/// tap puts the row's chip in that thread's box and opens the thread with it waiting there. Nothing is sent: the
/// chip rides his next message, as an `@` pick would.
struct AddToThreadSheet: View {
    let client: EnvironmentClient
    let workspaceId: String
    let chip: ContextChip
    /// The thread the chip went into.
    let added: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let threads = AddToThread.threads(client.listedSessions, workspaceId: workspaceId,
                                          projectWorkspace: Dictionary(client.projects.map { ($0.id, $0.workspaceId) }, uniquingKeysWith: { a, _ in a }))
        NavigationStack {
            Group {
                if threads.isEmpty {
                    ContentUnavailableView("No Open Threads", systemImage: "bubble.left.and.bubble.right")
                } else {
                    List(threads, id: \.id) { meta in
                        Button { add(to: meta.id) } label: {
                            ThreadRow(row: ThreadRowModel(session: meta))
                        }
                        .buttonStyle(.pressable)
                        .listRowInsets(Layout.rowInsets)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Add to Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .tcSheet(.picker)
        .accessibilityIdentifier("add-to-thread")
    }

    private func add(to sessionId: String) {
        ComposerChips.shared.box(environmentId: client.environment.id, sessionId: sessionId).add(chip)
        dismiss()
        added(sessionId)
    }
}
