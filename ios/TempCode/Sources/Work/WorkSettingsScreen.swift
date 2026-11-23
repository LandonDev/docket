import SwiftUI
import TempCodeClient
import TempCodeContract

/// Settings → Work (settings.html, on the phone): per host, the switch,
/// where LifeOS stands, the standing grants (each removable, no confirm: a
/// grant comes back from the next held item), and each add-on's tools with
/// the rule a Work thread runs them under. A host from before Work, or a key
/// that cannot read it, is left out. Guest links come with milestone 31. The
/// Digest leads, once for every host (docs/agents/work-digest.md "The phone").
struct WorkSettingsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let hosts = model.registry.ordered.filter { $0.work.settings != nil }
        List {
            if hosts.isEmpty {
                Text("No paired host has Work yet.")
                    .textStep(.meta)
            }
            // One digest across hosts: the section writes every host with Work on.
            if hosts.contains(where: \.work.isOn) {
                DigestSettingsSection(hosts: hosts.filter(\.work.isOn))
            }
            ForEach(hosts, id: \.environment.id) { client in
                WorkHostSection(client: client, named: hosts.count > 1)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Work")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("work-settings")
    }
}

private struct WorkHostSection: View {
    let client: EnvironmentClient
    let named: Bool
    @State private var grants: WorkRead<[OutboxGrant]> = .reading
    @State private var rules: WorkRead<[ToolRulesCard]> = .reading
    /// This host's guest links; nil while reading, or when another host serves them.
    @State private var guests: WorkRead<[GuestLinkRow]>?
    /// A new address, shown once after New Address.
    @State private var rekeyed: String?
    @State private var switching = false

    var body: some View {
        let work = client.work
        Section {
            Toggle("Work", isOn: Binding(get: { work.isOn }, set: { on in Task { await flip(on) } }))
                .disabled(!work.canAdmin || switching)
            if work.isOn {
                LabeledContent("LifeOS", value: lifeosWords(work.lifeos))
            }
        } header: {
            if named { Text(client.environment.name) }
        } footer: {
            if !work.canAdmin { Text("This phone’s key can’t change Work on \(client.environment.name).") }
        }
        .task(id: "\(work.isOn)-\(work.guestsRev)") { await load() }
        if work.isOn {
            if let guests {
                Section("Guest links") {
                    if let failure = guests.failure {
                        failed(failure)
                    } else if let links = guests.value {
                        if links.isEmpty { Text("No guest links").textStep(.meta) }
                        ForEach(links, id: \.id) { link in guestRow(link, work: work) }
                    }
                }
                // The new address itself, once, with Copy and Share: the guest link sheet's last step.
                .sheet(isPresented: Binding(get: { rekeyed != nil }, set: { if !$0 { rekeyed = nil } })) {
                    if let rekeyed { NewAddressSheet(address: rekeyed) }
                }
            }
            Section("Grants") {
                switch grants {
                case .reading:
                    ProgressView().frame(maxWidth: .infinity)
                case .failed(let failure):
                    failed(failure)
                case .loaded(let grants):
                    if grants.isEmpty { Text("No grants").textStep(.meta) }
                    ForEach(grants, id: \.id) { grant in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(grant.label).textStep(.title).lineLimit(2)
                                Text("\(client.workPlace(grant.workspaceId).name), made \(HeldTime.of(grant.createdAt))").textStep(.meta).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            if work.canAdmin {
                                Button("Remove") { Task { await remove(grant) } }
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(Tint.destructive)
                                    .rowActionHit()
                                    .buttonStyle(.pressable)
                            }
                        }
                    }
                }
            }
            if let failure = rules.failure {
                Section("Tools") { failed(failure) }
            } else if let rules = rules.value {
                ForEach(rules.filter { !$0.lifeos }, id: \.addonId) { card in
                    Section(card.name) {
                        ForEach(card.tools, id: \.tool) { row in
                            // A tool with no rule yet is held until he answers; no choice shows as made, so Held can be picked too.
                            Picker(selection: Binding<String?>(get: { row.rule?.rawValue }, set: { value in if let value { Task { await set(card, row.tool, value) } } })) {
                                // No rule yet: the tool is held until he answers, and the picker says so.
                                if row.rule == nil { Text("Not set").tag(String?.none) }
                                Text("Runs").tag(String?.some("runs"))
                                Text("Held").tag(String?.some("held"))
                                Text("Off").tag(String?.some("off"))
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.words).textStep(.title)
                                    if row.changed { Text("Changed since you set it").textStep(.meta, tint: Tint.warningText) }
                                }
                            }
                            .disabled(!work.canAdmin)
                        }
                    }
                }
            }
        }
    }

    /// A read that did not come back: its reason and Retry, never an empty list.
    private func failed(_ message: String) -> some View {
        HStack(spacing: 12) {
            Text(message).textStep(.meta, tint: Tint.destructiveText)
            Spacer(minLength: 8)
            PillButton("Retry") { Task { await load() } }
        }
    }

    /// A link: who it is for and what, the role and when it ends (or that it ended), and its actions.
    private func guestRow(_ link: GuestLinkRow, work: WorkHost) -> some View {
        let ended = link.revokedAt != nil || Double(link.expiresAt) < Date.now.timeIntervalSince1970 * 1000
        let ends = Date(timeIntervalSince1970: Double(link.expiresAt) / 1000).formatted(.dateTime.month(.abbreviated).day())
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                // Who, then what, told apart by step; the role and its end, then "open now" in its own weight.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(link.name).textStep(.title).lineLimit(1).layoutPriority(1)
                    Text(link.title).textStep(.meta).lineLimit(1)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(link.revokedAt != nil ? "Revoked" : ended ? "Ended \(ends)" : "\(link.role.rawValue.capitalized), ends \(ends)")
                        .textStep(.meta)
                        .lineLimit(1)
                    if !ended, link.open > 0 { Text("Open now").textStep(.meta, weight: .medium) }
                }
            }
            .opacity(ended ? 0.5 : 1)
            Spacer(minLength: 8)
            if !ended {
                Menu {
                    if work.canApprove {
                        Button("New Address", systemImage: "arrow.triangle.2.circlepath") { Task { await rekey(link) } }
                    }
                    Button("Revoke", systemImage: "xmark.circle", role: .destructive) { Task { await revoke(link) } }
                } label: {
                    Image(systemName: GlassMetrics.moreSymbol)
                        .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                }
                .accessibilityLabel("Actions for \(link.name)’s link")
            }
        }
    }

    private func rekey(_ link: GuestLinkRow) async {
        do { rekeyed = try await client.work.rekey(link) } catch {
            FleetToastCenter.shared.post(message: "No new address: \(ActionError.wrap(error).message)")
        }
    }

    private func revoke(_ link: GuestLinkRow) async {
        do {
            try await client.work.revoke(link)
            await loadGuests()
        } catch {
            FleetToastCenter.shared.post(message: "Not revoked: \(ActionError.wrap(error).message)")
        }
    }

    private func load() async {
        guard client.work.isOn else { return }
        await loadGuests()
        grants = await .of { try await client.work.grants() }
        rules = await .of { try await client.work.rules() }
    }

    /// Only the host that serves LifeOS's documents keeps links; the others answer "served elsewhere" and show none.
    private func loadGuests() async {
        let read = await WorkRead.of { try await client.work.guestLinks() }
        guests = read.failure.map(GuestLinksRead.servedElsewhere) == true ? nil : read
    }

    private func flip(_ on: Bool) async {
        switching = true
        defer { switching = false }
        do { try await client.work.setWork(on) } catch {
            FleetToastCenter.shared.post(message: "Work not changed: \(ActionError.wrap(error).message)")
        }
    }

    private func remove(_ grant: OutboxGrant) async {
        do {
            try await client.work.ungrant(grant)
            if var left = grants.value {
                left.removeAll { $0.id == grant.id }
                grants = .loaded(left)
            }
        } catch {
            FleetToastCenter.shared.post(message: "Not removed: \(ActionError.wrap(error).message)")
        }
    }

    private func set(_ card: ToolRulesCard, _ tool: String, _ value: String) async {
        do {
            let next = try await client.work.setRule(card, tool: tool, rule: .init(rawValue: value))
            if var cards = rules.value, let index = cards.firstIndex(where: { $0.addonId == next.addonId }) {
                cards[index] = next
                rules = .loaded(cards)
            }
        } catch {
            FleetToastCenter.shared.post(message: "Rule not set: \(ActionError.wrap(error).message)")
        }
    }

    private func lifeosWords(_ status: LifeosStatus?) -> String {
        switch status?.lifeos {
        case .connected?: "Signed in"
        case .signedOut?: "Signed out"
        case .pairing?: "Waiting for approval in LifeOS"
        case .connecting?: "Connecting…"
        case .unreachable?: "Can’t reach LifeOS. Retrying…"
        case .refused?: "Signed out by LifeOS"
        case .off?, .unknown?, nil: "—"
        }
    }
}

/// Settings → Work → Digest: the time, then a level for three groups, each
/// written to every host with Work on. Every group starts at "When it can’t
/// wait"; only a changed group is sent. A host that refused a change is that
/// row's red line.
private struct DigestSettingsSection: View {
    /// A row of the section.
    private enum Row: Hashable {
        case time
        case group(TellGroup)
    }

    let hosts: [EnvironmentClient]
    /// Each row's refusals, by host name.
    @State private var refused: [Row: [String: String]] = [:]
    /// A read that failed on every host.
    @State private var readFailure: String?
    /// The picked time until the hosts answer, so the wheel never springs back under his finger.
    @State private var pickedAt: Date?
    /// The picked time, written after the wheel rests.
    @State private var timeWrite: Task<Void, Never>?

    /// The first host that answered: the hosts are written alike.
    private var settings: DigestSettings? { hosts.lazy.compactMap(\.work.digest.settings).first }

    var body: some View {
        Section("Digest") {
            if let settings {
                DatePicker(selection: Binding(get: { pickedAt ?? DigestModel.atDate(settings.at) }, set: { pick($0) }), displayedComponents: .hourAndMinute) {
                    Text("Time").textStep(.title)
                }
                .disabled(!canAdmin)
                refusal(.time)
                ForEach(DigestModel.settingsGroups, id: \.self) { group in
                    Picker(selection: Binding(get: { DigestModel.level(settings, group) }, set: { level in Task { await write(.group(group), levels: [group.rawValue: level]) } })) {
                        ForEach(DigestModel.levels, id: \.self) { level in
                            Text(DigestModel.levelName(level)).tag(level)
                        }
                    } label: {
                        Text(DigestModel.groupName(group)).textStep(.title)
                    }
                    .disabled(!canAdmin)
                    refusal(.group(group))
                }
            } else if let readFailure {
                HStack(spacing: 12) {
                    Text(readFailure).textStep(.meta, tint: Tint.destructiveText)
                    Spacer(minLength: 8)
                    PillButton("Retry") { Task { await read() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task(id: hosts.map(\.environment.id)) { await read() }
    }

    private var canAdmin: Bool { hosts.contains { $0.work.canAdmin } }

    /// Each host that refused the row's last change, in the screen's destructive meta.
    @ViewBuilder
    private func refusal(_ row: Row) -> some View {
        if let lines = refused[row], !lines.isEmpty {
            ForEach(lines.sorted { $0.key < $1.key }, id: \.key) { line in
                Text(hosts.count > 1 ? "\(line.key): \(line.value)" : line.value)
                    .textStep(.meta, tint: Tint.destructiveText)
            }
        }
    }

    private func read() async {
        let missing = hosts.filter { $0.work.digest.settings == nil }
        guard !missing.isEmpty else { return }
        var failure: String?
        for client in missing {
            do { try await client.work.digest.readSettings() } catch { failure = ActionError.wrap(error).message }
        }
        readFailure = settings == nil ? failure : nil
    }

    /// The wheel moves through every minute on its way; the time is written once it rests.
    private func pick(_ date: Date) {
        pickedAt = date
        timeWrite?.cancel()
        timeWrite = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await write(.time, at: DigestModel.atString(date))
            pickedAt = nil
        }
    }

    private func write(_ row: Row, at: String? = nil, levels: [String: TellLevel]? = nil) async {
        let refusedById = await WorkDigest.setAll(hosts.map { ($0.environment.id, $0.work.digest) }, at: at, levels: levels)
        let names = Dictionary(hosts.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
        refused[row] = Dictionary(refusedById.map { (names[$0.key] ?? $0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
    }
}
