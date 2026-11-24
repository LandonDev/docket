import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work workspace's Microsoft forms (docs/agents/ios-client.md "Microsoft forms"): each row its title with how it
/// stands as the stamp; a tap opens it in Safari (`MsForms.url`). Made and changed on the desktop.
struct MsFormsScreen: View {
    @Environment(\.openURL) private var openURL
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var rows: [MsFormPhoneRow]?
    @State private var error: String?

    var body: some View {
        Group {
            if let rows {
                if rows.isEmpty {
                    ContentUnavailableView("No Forms", systemImage: "checklist")
                } else {
                    List(rows, id: \.formId) { row in
                        Button {
                            if let url = MsForms.url(row) { openURL(url) }
                        } label: {
                            MsFormRowView(row: row)
                        }
                        .buttonStyle(.pressable)
                        .disabled(MsForms.url(row) == nil)
                        .accessibilityAddTraits(.isLink)
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
        .task { await load() }
        .refreshable { await load() }
        .accessibilityIdentifier("msforms")
    }

    private func load() async {
        do {
            rows = try await client.work.canvas.msforms(workspace.id)
            error = nil
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

private struct MsFormRowView: View {
    let row: MsFormPhoneRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(row.title).textStep(.title).lineLimit(1)
            Spacer(minLength: 8)
            Text(MsForms.stamp(row)).textStep(.stamp).foregroundStyle(.secondary).monospacedDigit()
        }
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
