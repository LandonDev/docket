import SwiftUI
import TempCodeClient
import TempCodeContract

/// Settings → Work's jobs (M5b): one row a Work workspace of the host, pushing its settings to read. They are set on
/// the computer, where its folders, Start places and Mail's settings are too.
struct JobSettingsSection: View {
    let client: EnvironmentClient

    var body: some View {
        let jobs = client.workspaces.filter { $0.kind == .work }
        if client.work.isOn, !jobs.isEmpty, client.work.may(.workspaceGet) {
            Section("Jobs") {
                ForEach(jobs, id: \.id) { job in
                    NavigationLink {
                        JobSettingsView(client: client, workspace: job)
                    } label: {
                        Label { Text(job.name) } icon: { SectorDot(sector: job.sector) }
                    }
                    .accessibilityIdentifier("work-settings-job")
                }
            }
        }
    }
}

/// A job's settings, read only: the model its threads start on, Write in My Voice, the Windows VM, the computers its
/// threads may use. Its one press is "Open on <computer>", which opens Settings → Work there.
struct JobSettingsView: View {
    @Environment(AppModel.self) private var model
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    @State private var settings: Methods.WorkWorkspaceGet.Output?
    @State private var error: String?
    @State private var revealing = false

    var body: some View {
        List {
            if let settings {
                Section {
                    LabeledContent("Model", value: settings.model ?? "Default")
                    if let reasoning = settings.reasoning { LabeledContent("Reasoning", value: reasoning.capitalized) }
                    LabeledContent("Write in My Voice", value: settings.voice ? "On" : "Off")
                    if let vm = settings.windowsVm { LabeledContent("Windows VM", value: vm ? "On" : "Off") }
                }
                if !settings.mayUseDesktop.isEmpty {
                    Section("Computers") {
                        ForEach(settings.mayUseDesktop, id: \.self) { id in
                            Text(model.registry.client(id)?.environment.name ?? id)
                        }
                    }
                }
                // Settings → Work on the computer: the host asks admin for a Settings target (reveal.ts), beyond reveal.
                if client.work.may(.reveal), client.environment.caps.contains(.admin) {
                    Section {
                        Button {
                            Task { await reveal() }
                        } label: {
                            HStack {
                                Text("Open on \(client.environment.name)")
                                if revealing { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(revealing)
                        .accessibilityIdentifier("job-settings-reveal")
                    }
                }
            } else if let error {
                Section {
                    Text(error).textStep(.meta, tint: Tint.destructiveText)
                    Button("Try Again") { self.error = nil; Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .accessibilityIdentifier("job-settings")
    }

    private func load() async {
        do {
            settings = try await client.work.workspaceSettings(workspace.id)
            error = nil
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private func reveal() async {
        revealing = true
        defer { revealing = false }
        do {
            try await client.work.reveal(RevealTarget(settings: .work))
            FleetToastCenter.shared.post(message: "Opened on \(client.environment.name)")
        } catch {
            FleetToastCenter.shared.post(message: ActionError.wrap(error).message)
        }
    }
}
