import SwiftUI
import TempCodeClient
import TempCodeContract

/// Settings → Work (settings.html, on the phone): per host, the switch,
/// where LifeOS stands, the standing grants (each removable, no confirm: a
/// grant comes back from the next held item), and each add-on's tools with
/// the rule a Work thread runs them under. A host from before Work, or a key
/// that cannot read it, is left out. Guest links come with milestone 31. The
/// Digest follows the first Work host's switch, once for every host, and only
/// while some host has Work on (docs/agents/work-digest.md "The phone").
struct WorkSettingsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let hosts = model.registry.ordered.filter { $0.work.settings != nil }
        List {
            if hosts.isEmpty {
                Text("No paired host has Work yet.")
                    .textStep(.meta)
            }
            // One digest across hosts, under the first Work host's switch: the section writes every host with Work on.
            let on = hosts.filter(\.work.isOn)
            ForEach(hosts, id: \.environment.id) { client in
                WorkHostSection(client: client, named: hosts.count > 1, digestHosts: client.environment.id == on.first?.environment.id ? on : [], gateRow: client.environment.id == hosts.first?.environment.id)
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
    /// Every host with Work on, for the one host that draws the Digest section after its switch; else empty.
    let digestHosts: [EnvironmentClient]
    /// The first host's section also holds the phone's own switch, "Require Touch ID to Send" (one per phone).
    let gateRow: Bool
    @State private var grants: WorkRead<[OutboxGrant]> = .reading
    @State private var rules: WorkRead<[ToolRulesCard]> = .reading
    /// This host's guest links; nil while reading, or when another host serves them.
    @State private var guests: WorkRead<[GuestLinkRow]>?
    /// A new address, shown once after New Address.
    @State private var rekeyed: String?
    /// A link he chose Revoke on, asked once before it goes.
    @State private var revoking: GuestLinkRow?
    @State private var switching = false

    var body: some View {
        let work = client.work
        Section {
            Toggle("Work", isOn: Binding(get: { work.isOn }, set: { on in Task { await flip(on) } }))
                .disabled(!work.may(.workSet) || switching)
            if gateRow {
                // This phone's, not the host's: turning it off asks the check once, and a failure leaves it on.
                let gates = PressGates.shared
                Toggle(PressGate.settingTitle(sensor: gates.sensor), isOn: Binding(get: { gates.on }, set: { on in Task { await gates.setOn(on) } }))
                    .accessibilityIdentifier("work-press-gate")
            }
            if work.isOn {
                LabeledContent("LifeOS", value: lifeosWords(work.lifeos))
            }
        } header: {
            if named { Text(client.environment.name) }
        } footer: {
            let lines = footerLines(work)
            if !lines.isEmpty { Text(lines.joined(separator: "\n")) }
        }
        .task(id: "\(work.isOn)-\(work.guestsRev)") { await load() }
        // Whether a passcode is set, and the sensor's name, as the phone is now.
        .task { if gateRow { PressGates.shared.readDevice() } }
        // Each job's settings to read (M5b); they are set on the computer.
        JobSettingsSection(client: client)
        if !digestHosts.isEmpty {
            DigestSettingsSection(hosts: digestHosts)
        }
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
                .confirmationDialog("Revoke this link?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { link in
                    Button("Revoke", role: .destructive) { Task { await revoke(link) } }
                } message: { link in
                    Text("\(link.name)’s address stops opening.")
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
                            if work.may(.outboxUngrant) {
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
                            .disabled(!work.may(.outboxSetRules))
                        }
                    }
                }
            }
        }
    }

    /// Under the switches: a key that can't change Work, and with the check on and no passcode, why nothing goes.
    private func footerLines(_ work: WorkHost) -> [String] {
        var lines: [String] = []
        if !work.may(.workSet) { lines.append("This iPhone’s key can’t change Work on \(client.environment.name).") }
        let gates = PressGates.shared
        if gateRow, gates.on, gates.device == .noPasscode { lines.append(PressGate.unavailableLine) }
        return lines
    }

    /// A read that did not come back: its reason and Retry, never an empty list.
    private func failed(_ message: String) -> some View {
        HStack(spacing: 12) {
            Text(message).textStep(.meta, tint: Tint.destructiveText)
            Spacer(minLength: 8)
            PillButton("Try Again") { Task { await load() } }
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
                // His last New Address on this link, while it has words: Checking, then what came of it.
                if let replaced = work.rekeyLine(link.id) {
                    Text(replaced).textStep(.meta).fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(ended ? 0.5 : 1)
            Spacer(minLength: 8)
            // New Address needs approve and Revoke operate (contract-work-guests.ts): a key with neither has no menu.
            if !ended, work.may(.guestsRekey) || work.may(.guestsRevoke) {
                Menu {
                    if work.mayReplace(link.id) {
                        Button("New Address", systemImage: "arrow.triangle.2.circlepath") { Task { await rekey(link) } }
                    }
                    if work.may(.guestsRevoke) {
                        Button("Revoke…", systemImage: "xmark.circle", role: .destructive) { revoking = link }
                    }
                } label: {
                    Image(systemName: GlassMetrics.moreSymbol)
                        .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                }
                .accessibilityLabel("Actions for \(link.name)’s link")
            }
        }
    }

    private func rekey(_ link: GuestLinkRow) async {
        // A new address shares the document again: the link and the owner's check first; its key rides to the leave.
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .guestsRekey, ref: link.id, rev: String(link.expiresAt), reason: "Make a new address for \(link.name)’s link") {
            return FleetToastCenter.shared.post(message: line)
        }
        // One attempt key per link through the ledger (`replaceAddress`): a lost answer never replaces it twice.
        switch await client.work.replaceAddress(link, key: key) {
        case .address(let url): rekeyed = url
        // Checking, and an earlier try's address, are said in the link's own row (`rekeyLine`) and settle there.
        case .again, .checking: break
        case .refused(let words): FleetToastCenter.shared.post(message: "No new address: \(words)")
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

/// Settings → Work → Digest: the time, then a level for four groups, each
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
    /// Which pick of the time is the latest: a slow host's answer to an earlier one is not applied over it.
    @State private var timeEdit = EditGate()

    /// The first host that answered: the hosts are written alike.
    private var settings: DigestSettings? { hosts.lazy.compactMap(\.work.digest.settings).first }

    var body: some View {
        Section("Digest") {
            if let settings {
                DatePicker(selection: Binding(get: { pickedAt ?? DigestModel.atDate(settings.at) }, set: { pick($0) }), displayedComponents: .hourAndMinute) {
                    Text("Time").textStep(.title)
                }
                .disabled(!maySet)
                refusal(.time)
                ForEach(DigestModel.settingsGroups, id: \.self) { group in
                    Picker(selection: Binding(get: { DigestModel.level(settings, group) }, set: { level in Task { await write(.group(group), levels: [group.rawValue: level]) } })) {
                        ForEach(DigestModel.levels, id: \.self) { level in
                            Text(DigestModel.levelName(level)).tag(level)
                        }
                    } label: {
                        Text(DigestModel.groupName(group)).textStep(.title)
                    }
                    .disabled(!maySet)
                    refusal(.group(group))
                }
            } else if let readFailure {
                HStack(spacing: 12) {
                    Text(readFailure).textStep(.meta, tint: Tint.destructiveText)
                    Spacer(minLength: 8)
                    PillButton("Try Again") { Task { await read() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task(id: hosts.map(\.environment.id)) { await read() }
    }

    private var maySet: Bool { hosts.contains { $0.work.may(.digestSet) } }

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
        let edit = timeEdit.begin()
        timeWrite?.cancel()
        timeWrite = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            let lines = await refusals(at: DigestModel.atString(date))
            // He picked again while the hosts answered: the wheel and the row's line are that pick's now.
            guard timeEdit.isLatest(edit) else { return }
            refused[.time] = lines
            pickedAt = nil
        }
    }

    private func write(_ row: Row, levels: [String: TellLevel]) async {
        refused[row] = await refusals(levels: levels)
    }

    /// One change written to every host; each host that refused, by name, with why.
    private func refusals(at: String? = nil, levels: [String: TellLevel]? = nil) async -> [String: String] {
        let refusedById = await WorkDigest.setAll(hosts.map { ($0.environment.id, $0.work.digest) }, at: at, levels: levels)
        let names = Dictionary(hosts.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
        return Dictionary(refusedById.map { (names[$0.key] ?? $0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
    }
}
