import SwiftUI
import TempCodeClient
import TempCodeContract

/// LifeOS's six sectors, in the order its own screens list them.
enum Sectors {
    static let all: [(key: String, name: String)] = [
        ("cosmic", "Cosmic"), ("hypixel", "Hypixel"), ("purdue", "Purdue"), ("ref", "Ref"), ("unify", "Unify"), ("life", "Life")
    ]
}

/// The hosts with Work on, and which one a new thing lands on: the first,
/// unless there are several, when a Host row asks.
private struct WorkHostPicker: View {
    let hosts: [EnvironmentClient]
    @Binding var hostId: String

    var body: some View {
        if hosts.count > 1 {
            Picker("Host", selection: $hostId) {
                ForEach(hosts, id: \.environment.id) { Text($0.environment.name).tag($0.environment.id) }
            }
        }
    }
}

/// New Work workspace, from the "Work" header's +: a name and the LifeOS
/// sector it serves (one Work workspace per sector per host). The host makes
/// its folder; the workspace opens when it lands.
struct NewWorkWorkspaceSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var sector: String?
    @State private var hostId = ""
    @State private var saving = false
    @State private var error: String?

    private var hosts: [EnvironmentClient] { model.registry.ordered.filter(\.work.isOn) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("new-work-name")
                    Picker("Sector", selection: $sector) {
                        Text("None").tag(String?.none)
                        ForEach(Sectors.all, id: \.key) { sector in
                            Label { Text(sector.name) } icon: { SectorDot(sector: sector.key) }
                                .tag(String?.some(sector.key))
                        }
                    }
                    WorkHostPicker(hosts: hosts, hostId: $hostId)
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle("New Work Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await create() } }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || hosts.isEmpty)
                    }
                }
            }
            .onAppear { if hostId.isEmpty { hostId = hosts.first?.environment.id ?? "" } }
        }
        .tcSheet(.form)
    }

    private func create() async {
        guard let client = model.registry.client(hostId) else { return }
        saving = true
        defer { saving = false }
        do {
            let workspace = try await client.work.createWorkspace(name: name.trimmingCharacters(in: .whitespaces), sector: sector)
            dismiss()
            navigator.open(.workspace(key: ProjectPairs.key(client.environment.id, workspace)))
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// New Work Chat: a Work thread in no workspace, started with what he types.
/// It opens on its thread when the host has made it.
struct NewWorkChatSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var hostId = ""
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var hosts: [EnvironmentClient] { model.registry.ordered.filter(\.work.isOn) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should it do?", text: $text, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($focused)
                        .accessibilityIdentifier("new-work-chat-text")
                    WorkHostPicker(hosts: hosts, hostId: $hostId)
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle("New Work Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hosts.isEmpty)
                    }
                }
            }
            .onAppear {
                if hostId.isEmpty { hostId = hosts.first?.environment.id ?? "" }
                focused = true
            }
        }
        .tcSheet(.form)
    }

    private func start() async {
        guard let client = model.registry.client(hostId) else { return }
        saving = true
        defer { saving = false }
        do {
            let session = try await client.work.newWorkChat(firstMessage: text.trimmingCharacters(in: .whitespacesAndNewlines))
            dismiss()
            navigator.open(.thread(environmentId: client.environment.id, sessionId: session.id, seq: nil))
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}
