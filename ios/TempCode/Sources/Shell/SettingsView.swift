import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// System, light or dark, remembered.
enum Appearance: String, CaseIterable {
    case system
    case light
    case dark

    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// Settings, from the Home navigation bar, as Apple's own Settings lays it
/// out: the computers, Work, Away, notifications and the appearance, then
/// Diagnostics with the app's version as its value. Inset grouped, one sentence
/// of footer where a row needs explaining. The words are the Settings 2
/// glossary's: a computer, never a host.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage("appearance") private var appearance = Appearance.system
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Where the switch sits while the permission prompt and the computers are
    /// asked; nil once they have answered and the registrar's word is true.
    @State private var pushPending: Bool?
    /// Diagnostics, from its row (and the proof's route).
    @State private var showsDiagnostics = false

    var body: some View {
        let clients = model.registry.ordered
        let push = model.registry.push
        List {
            Section {
                NavigationLink(value: Route.hosts) {
                    // The computer's name wraps under the label at accessibility sizes instead of truncating.
                    if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Computers")
                            HostsSummary(clients: clients)
                        }
                    } else {
                        HStack(spacing: Layout.rowGap) {
                            Text("Computers")
                            Spacer(minLength: Layout.rowGap)
                            HostsSummary(clients: clients)
                        }
                    }
                }
                .accessibilityIdentifier("hosts-row")
            } footer: {
                if clients.isEmpty { Text("Sign this phone in to a computer to see its threads here.") }
            }

            // Work (milestone 46): each computer's switch, LifeOS, grants and tool rules. It holds its place, in the
            // row's shape, until a computer has answered.
            if !clients.isEmpty {
                Section {
                    switch WorkRowState.of(clients.map { (answered: $0.work.settings != nil, settled: Self.settled($0.status)) }) {
                    case .shown:
                        NavigationLink(value: Route.workSettings) { Text("Work") }
                            .accessibilityIdentifier("work-settings-row")
                    case .waiting:
                        SettingsPlaceholderRows(labels: ["Work"])
                    case .hidden:
                        EmptyView()
                    }
                    // Away (the host menu's switches, `away.get` and `away.set`): Code and Work threads per computer.
                    // Its value is the computers' answers: bones while one is still out, never Off before it is known.
                    NavigationLink {
                        AwaySettingsScreen().sidebarButtonPage()
                    } label: {
                        let word = AwayWords.summary(clients.map { client in
                            AwayWords.computer(away: client.work.away.map { AwayKinds.any($0.state) }, read: client.work.awayRead, transport: client.status.transport)
                        })
                        LabeledContent("Away") {
                            Text(word ?? "Off")
                                .redacted(reason: word == nil ? .placeholder : [])
                                .accessibilityHidden(word == nil)
                        }
                    }
                    .accessibilityIdentifier("away-settings-row")
                }
            }

            Section {
                // One row: the switch, with the registration's state beside it only when the switch cannot say it.
                Toggle(isOn: pushBinding) {
                    HStack(spacing: Layout.rowGap) {
                        Text("Notifications")
                        Spacer(minLength: Layout.rowGap)
                        if let word = pushWord(push) {
                            Text(word)
                                .foregroundStyle(.secondary)
                                .contentTransition(.opacity)
                        }
                    }
                    .animation(Motion.crossFade, value: pushWord(push))
                }
                .accessibilityIdentifier("push-row")
                if push.enabled, push.permission == .denied {
                    Button("Allow in Settings") { openSystemSettings() }
                }
            } footer: {
                Text(pushFooter(push))
            }

            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Appearance")
            } footer: {
                Text("System follows the phone's setting.")
            }

            Section {
                // The app's version is the row's value, as Apple's About rows put it: the first thing to read off a
                // screenshot when a computer says the app is too old, and clear of the tab bar (the council's round 1).
                // The contract it speaks is on Diagnostics.
                NavigationLink {
                    DiagnosticsScreen().sidebarButtonPage()
                } label: {
                    LabeledContent("Diagnostics") {
                        Text(AppVersion.line)
                            .monospacedDigit()
                    }
                }
                .accessibilityIdentifier("diagnostics-row")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showsDiagnostics) { DiagnosticsScreen().sidebarButtonPage() }
        #if DEBUG
        // The proof's `diagnostics` route (RootView): Settings opens straight onto Diagnostics and its Work Checks.
        .task { if ProcessInfo.processInfo.environment["TC_TEST_ROUTE"] == "diagnostics" { showsDiagnostics = true } }
        #endif
    }

    /// A link that has answered or stopped trying: its Work settings will not come by waiting.
    static func settled(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .open, .offline, .unauthorized: true
        case .connecting, .reconnecting, .suspended: false
        }
    }

    private var pushBinding: Binding<Bool> {
        Binding(
            get: { pushPending ?? model.registry.push.enabled },
            set: { on in
                guard pushPending == nil else { return }
                pushPending = on
                Task {
                    await model.setPushEnabled(on)
                    pushPending = nil
                }
            }
        )
    }

    private func pushWord(_ push: PushRegistrar) -> String? {
        if let pending = pushPending { return pending ? "Turning on…" : "Turning off…" }
        return NotificationWords.beside(push.summary)
    }

    /// One sentence under the row: what the switch does, or what stands in its way.
    private func pushFooter(_ push: PushRegistrar) -> String {
        guard push.enabled else { return "Approvals, questions, errors and finished work from every computer." }
        if push.permission == .denied { return "Notifications for Docket are turned off in the phone's Settings." }
        if let error = push.tokenError { return "The phone could not register for push: \(sentence(error))" }
        if push.device == nil { return "Waiting for the phone's push token." }
        if let failure = push.failures.values.first { return "A computer refused the registration: \(sentence(failure))" }
        let registered = push.statuses.values.filter(\.registered)
        if registered.contains(where: { $0.relay == .ok }) { return "Approvals, questions, errors and finished work come here from every computer." }
        if let failed = registered.first(where: { $0.relay == .failed }) {
            return failed.error.map { "A computer could not reach the relay: \(sentence($0))" } ?? "A computer could not reach the relay."
        }
        if !registered.isEmpty { return "A computer has no relay to Apple; its notifications stay on it." }
        return "Registering with the computers."
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

/// Settings → Away: each computer's switches, the host menu's own
/// (`AwayMenuItem`, `away.get` and `away.set`): Code threads, and Work
/// threads while Work is on there. A flip goes to that computer alone, as the
/// menu's does; a refusal puts the switch back and says so in a toast.
struct AwaySettingsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let clients = model.registry.ordered
        List {
            ForEach(clients, id: \.environment.id) { client in
                AwayComputerSection(client: client, named: clients.count > 1, last: client.environment.id == clients.last?.environment.id)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Away")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("away-settings")
    }
}

/// One computer's Away: its switches once `away.get` has answered, their shape while it has not, and a line when it
/// will not (out of reach, or a computer from before Away).
private struct AwayComputerSection: View {
    let client: EnvironmentClient
    let named: Bool
    /// The last section carries the screen's one footer, what Away does.
    let last: Bool

    var body: some View {
        let work = client.work
        let threads = client.listedSessions
        let switches = work.awaySwitches { id in threads.first { $0.id == id }?.scope }
            .filter { $0.kind != .work || work.isOn }
        Section {
            if work.away == nil {
                // Old-release words only for a reply that says so; a read still out is bones (the council's round 3).
                switch (client.status.transport, work.awayRead) {
                case (.offline, _), (.unauthorized, _):
                    Text(ConnectionSentence.text(name: client.environment.name, status: client.status, now: .now))
                        .textStep(.meta)
                case (_, .unsupported):
                    Text("Away needs a newer Docket on \(nameInLine(client.environment.name)).")
                        .textStep(.meta)
                case (.open, .failed):
                    HStack(spacing: Layout.rowGap) {
                        Text("\(nameAtStart(client.environment.name)) did not answer.")
                            .textStep(.meta, tint: Tint.destructiveText)
                        Spacer(minLength: Layout.rowGap)
                        // A grouped list keeps the system highlight: a plain button, no press scale.
                        Button("Retry") { Task { await work.readAway() } }
                            .buttonStyle(.borderless)
                    }
                default:
                    SettingsPlaceholderRows(labels: [AwayWords.title(.code)], toggles: true)
                }
            }
            ForEach(switches) { item in
                Toggle(isOn: Binding(get: { item.on }, set: { on in Task { await flip(item.kind, on) } })) {
                    Text(AwayWords.title(item.kind))
                    if let tally = item.tally { Text(tally) }
                }
                .disabled(!work.may(.awaySet))
                .accessibilityIdentifier("away-settings-\(item.id)")
            }
        } header: {
            if named { Text(client.environment.name) }
        } footer: {
            let lines = (work.away != nil && !work.may(.awaySet) ? ["This phone may not change Away on \(client.environment.name)."] : []) + (last ? [AwayWords.footer] : [])
            if !lines.isEmpty { Text(lines.joined(separator: "\n")) }
        }
    }

    private func flip(_ kind: AwayKinds.Kind?, _ on: Bool) async {
        do { try await client.work.setAway(kind, on) } catch {
            FleetToastCenter.shared.post(message: "Away not changed: \(ActionError.wrap(error).message)")
        }
    }
}

/// The trailing half of the Computers row: the single computer's name, or
/// the count. Each one's state is on the Computers list, said once there.
private struct HostsSummary: View {
    let clients: [EnvironmentClient]

    var body: some View {
        Text(clients.isEmpty ? "None" : clients.count == 1 ? clients[0].environment.name : "\(clients.count)")
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .monospacedDigit()
    }
}

/// The app's version and build, "1.0.401 (5)", read from the bundle.
enum AppVersion {
    static var line: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }
}
