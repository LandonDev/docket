import SwiftUI
import TempCodeClient
import TempCodeContract

/// One Mac's simulators and iPhones, as `client` (that Mac, or a box linked
/// to it) reports them: a state dot, the runtime and state with a booted
/// one's CPU rolling, and who holds each, pushing that thread when its host
/// is paired here. Shut Down and Delete (confirmed, naming the holder) on a
/// swipe and in the context menu, Open in Xcode on a phone's; a key that may
/// run threads acts, a lesser one reads why in the footer. The watch itself runs in
/// `ActivityPollers`, so the section's rows can change freely.
struct MacDevicesSection: View {
    let client: EnvironmentClient
    let host: HostDevicesHost
    @Environment(AppModel.self) private var model
    @State private var deleting: Simulator?
    @State private var actionError: String?
    @State private var painted = false

    var body: some View {
        let state = client.extras.devices[host.environmentId]
        let canAct = HostExtrasAccess.deviceActions.allowed(client.environment) && client.status.transport == .open
        Section {
            if let report = state?.report {
                let ids = report.simulators.map(\.udid) + report.phones.map(\.udid)
                if ids.isEmpty {
                    Text("No simulators")
                        .foregroundStyle(.tertiary)
                }
                Group {
                    ForEach(report.simulators, id: \.udid) { sim in
                        simulatorRow(sim, busy: state?.busy == sim.udid, canAct: canAct)
                    }
                    ForEach(report.phones, id: \.udid) { phone in
                        phoneRow(phone, canAct: canAct)
                    }
                }
                .animation(painted ? Motion.rowAppear : nil, value: ids)
                .onAppear { painted = true }
            } else if let error = state?.error {
                Text(error)
                    .textStep(.meta, tint: Tint.destructive)
            } else {
                LookingRow()
            }
            RowErrorLine(message: $actionError)
        } header: {
            Text(host.local ? "Devices" : "Devices on \(host.name)")
        } footer: {
            if let report = state?.report {
                FooterText(lines: footer(report))
            }
        }
    }

    /// What the rows do not already say: a tool that did not answer, and why a key cannot act. The count of
    /// simulators, the load and the Xcode version were the rows again or a builder's numbers (the council's round 2).
    private func footer(_ report: HostDevicesReport) -> [String] {
        var lines = report.problems
        if !HostExtrasAccess.deviceActions.allowed(client.environment) { lines.append(HostExtrasAccess.deviceActions.reason) }
        return lines
    }

    @ViewBuilder
    private func simulatorRow(_ sim: Simulator, busy: Bool, canAct: Bool) -> some View {
        DeviceRow(name: sim.name, state: DeviceWords.simulatorState(sim), busy: busy, holder: sim.holder, route: route(for: sim.holder))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Delete", systemImage: "trash") { deleting = sim }
                    .tint(Tint.destructive)
                    .disabled(!canAct)
                if sim.state == .booted {
                    Button("Shut Down", systemImage: "power") { shutDown(sim) }
                        .disabled(!canAct)
                }
            }
            .contextMenu {
                if sim.state == .booted {
                    Button("Shut Down", systemImage: "power") { shutDown(sim) }
                        .disabled(!canAct)
                }
                Button("Delete", systemImage: "trash", role: .destructive) { deleting = sim }
                    .disabled(!canAct)
            }
            // On the row it confirms: a header scrolls away and takes its alert with it.
            .alert(
                DeviceWords.deleteConfirm(sim).title,
                isPresented: Binding(get: { deleting?.udid == sim.udid }, set: { if !$0 { deleting = nil } })
            ) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { act { try await $0.deleteSimulator(mac: host.environmentId, udid: sim.udid) } }
            } message: {
                Text(DeviceWords.deleteConfirm(sim).body)
            }
            .rowAppearTransition()
    }

    @ViewBuilder
    private func phoneRow(_ phone: Phone, canAct: Bool) -> some View {
        DeviceRow(name: phone.name, state: DeviceWords.phoneState(phone), busy: false, holder: phone.holder, route: route(for: phone.holder))
            .contextMenu {
                Button("Open in Xcode", systemImage: "hammer") {
                    act { try await $0.openXcode(mac: host.environmentId) }
                }
                .disabled(!canAct)
            }
            .rowAppearTransition()
    }

    /// The holder's thread, when its host is paired here (absent host: the answering one).
    private func route(for holder: DeviceHolder?) -> Route? {
        guard let holder else { return nil }
        let hostId = holder.environmentId ?? client.environment.id
        guard model.registry.client(hostId) != nil else { return nil }
        return .thread(environmentId: hostId, sessionId: holder.sessionId, seq: nil)
    }

    private func shutDown(_ sim: Simulator) {
        act { try await $0.shutdownSimulator(mac: host.environmentId, udid: sim.udid) }
    }

    private func act(_ body: @escaping @MainActor (HostExtras) async throws -> Void) {
        let extras = client.extras
        Task { @MainActor in
            do {
                try await body(extras)
            } catch {
                withAnimation(Motion.rowAppear) { actionError = ActionError.wrap(error).message }
            }
        }
    }
}

/// A device: the dot (a spinner while an action is out for it), the name,
/// under it what the device is doing in the meta step with what it is after
/// it in tertiary, and who holds it trailing in the footnote's tertiary; a
/// row whose holder is reachable pushes that thread.
struct DeviceRow: View {
    let name: String
    let state: DeviceState
    let busy: Bool
    let holder: DeviceHolder?
    let route: Route?

    var body: some View {
        if let route {
            NavigationLink(value: route) { content }
        } else {
            content
        }
    }

    private var content: some View {
        HStack(spacing: Layout.rowGap) {
            MarkColumn(key: busy) {
                if busy {
                    ProgressView().controlSize(.mini)
                } else {
                    DeviceDot(tone: state.tone)
                }
            }
            // The holder trails on the row's one line while everything fits whole; when it would be cut (a long
            // thread title, a narrow phone, large text) it goes under the state and wraps. Nothing is cut mid-word
            // (the council's round 2).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Layout.rowGap) {
                    facts(stacked: false)
                    Spacer(minLength: Layout.rowGap)
                    if holder != nil { holderText }
                }
                facts(stacked: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 2)
        // The line already is the spoken phrase; the combined element reads it once.
        .accessibilityElement(children: .combine)
    }

    /// The name and the state with its platform as one phrase, "Booted, 13% CPU, iOS 26.0" (`DeviceState.spoken`);
    /// stacked, the holder under them, every line free to wrap. A device nothing holds ends with nothing: no dash
    /// that reads as a minus (the council's round 3).
    private func facts(stacked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .lineLimit(stacked ? nil : 1)
            Text(state.spoken)
                .textStep(.meta)
                .numeric(state.spoken)
                .lineLimit(stacked ? nil : 1)
            if stacked, holder != nil { holderText }
        }
        .fixedSize(horizontal: !stacked, vertical: stacked)
    }

    /// Secondary, not tertiary: the holder is a fact he reads, in both themes.
    private var holderText: some View {
        Text(holder.map(DeviceWords.holder) ?? "")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
