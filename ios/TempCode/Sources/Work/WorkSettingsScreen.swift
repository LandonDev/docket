import SwiftUI
import TempCodeClient
import TempCodeContract

/// Settings → Work (settings.html, on the phone): per computer, the switch,
/// where LifeOS stands, the things threads may send on their own (each
/// removable, no confirm: a grant comes back from the next held item), and
/// each add-on's tools with the rule a Work thread runs them under. A
/// computer from before Work, or a key that cannot read it, is left out. The
/// Digest follows the first Work computer's switch, once for every computer,
/// and only while some computer has Work on (docs/agents/work-digest.md "The
/// phone"). Every section holds its place, in its rows' shape, while its
/// first read is out.
struct WorkSettingsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let hosts = model.registry.ordered.filter { $0.work.settings != nil }
        List {
            if hosts.isEmpty {
                // Still asking a computer: the switch's shape; else none has Work.
                if model.registry.ordered.contains(where: { !SettingsView.settled($0.status) }) {
                    Section { SettingsPlaceholderRows(labels: ["Work"], toggles: true) }
                } else {
                    Text("No computer has Work yet.")
                        .textStep(.meta)
                }
            }
            // One digest across computers, under the first Work computer's switch: the section writes every one with Work on.
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
    /// Every computer with Work on, for the one that draws the Digest section after its switch; else empty.
    let digestHosts: [EnvironmentClient]
    /// The first computer's section also holds the phone's own switch, "Require Touch ID to Send" (one per phone).
    let gateRow: Bool
    @State private var grants: WorkRead<[OutboxGrant]> = .reading
    @State private var rules: WorkRead<[ToolRulesCard]> = .reading
    /// This computer's guest links; nil while reading, or when another computer serves them.
    @State private var guests: WorkRead<[GuestLinkRow]>?
    /// Whether the first read of the links has answered: until then the section holds its place, unless this
    /// computer is already known to leave its links to another (`GuestLinksElsewhere`).
    @State private var guestsAnswered = false
    /// Why his last New Address on a link did not start (the owner's check said no, or he cancelled it), by link: said
    /// on its row, where he pressed, never only in the shared toast an older failure may hold.
    @State private var stopped: [String: String] = [:]
    /// Links whose New Address is between his press and the host's answer, for the row's spinner.
    @State private var pressing: Set<String> = []
    /// The new address the sheet shows, fixed for the sheet's life: its link, the attempt it answered and the address.
    /// Done acknowledges that attempt alone; a second address that came meanwhile shows next, in its own sheet.
    @State private var showing: ShownAddress?
    /// A link he chose Revoke on, asked once before it goes.
    @State private var revoking: GuestLinkRow?
    /// A link he chose New Address on, asked once before its address changes (the plan's section 5).
    @State private var replacing: GuestLinkRow?
    @State private var switching = false

    var body: some View {
        let work = client.work
        Section {
            Toggle("Work", isOn: Binding(get: { work.isOn }, set: { on in Task { await flip(on) } }))
                .disabled(!work.may(.workSet) || switching)
            if gateRow {
                // This phone's, not the computer's: turning it off asks the check once, and a failure leaves it on.
                let gates = PressGates.shared
                Toggle(isOn: Binding(get: { gates.on }, set: { on in Task { await gates.setOn(on) } })) {
                    Text(PressGate.settingTitle(sensor: gates.sensor))
                    Text("This phone")
                }
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
            if guests == nil, !guestsAnswered, !GuestLinksElsewhere.ids.contains(client.environment.id) {
                Section("Guest links") { SettingsPlaceholderRows(labels: ["Guest link"]) }
            }
            if let guests {
                Section("Guest links") {
                    if let failure = guests.failure {
                        failed(failure)
                    } else if let links = guests.value {
                        if links.isEmpty { Text("No guest links").textStep(.meta) }
                        ForEach(links, id: \.id) { link in guestRow(link, work: work) }
                    }
                }
                // The new address itself, once, with Copy and Share: the guest link sheet's last step. It waits in memory
                // by its attempt key (`GuestAttempts.unseen`) from the host's answer until this sheet closes, so Back
                // during New Address, or an answer after the fifteen seconds, shows it on return.
                .sheet(item: Binding(get: { showing }, set: { if $0 == nil { acknowledge() } })) { shown in
                    NewAddressSheet(address: shown.address, name: shown.name, title: shown.title)
                }
                .onChange(of: nextAddress(guests.value)?.id, initial: true) { if showing == nil { showing = nextAddress(guests.value) } }
                .confirmationDialog("Revoke this link?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { link in
                    Button("Revoke", role: .destructive) { Task { await revoke(link) } }
                } message: { link in
                    Text("\(link.name)’s address stops opening.")
                }
                // The item sheet's Replace Address… asks the same: the old address is what is lost.
                .confirmationDialog("Make a new address?", isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }), titleVisibility: .visible, presenting: replacing) { link in
                    Button("New Address", role: .destructive) { Task { await rekey(link) } }
                } message: { link in
                    Text("\(link.name)’s current address stops opening.")
                }
            }
            Section("Things threads may send on their own") {
                switch grants {
                case .reading:
                    SettingsPlaceholderRows(labels: ["A thing threads may send"])
                case .failed(let failure):
                    failed(failure)
                case .loaded(let grants):
                    if grants.isEmpty { Text("Nothing yet").textStep(.meta) }
                    ForEach(grants, id: \.id) { grant in
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(grant.label).textStep(.title).lineLimit(2)
                                Text("\(client.workPlace(grant.workspaceId).name), made \(HeldTime.of(grant.createdAt))").textStep(.meta).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            if work.may(.outboxUngrant) {
                                // A grouped list keeps the system highlight: nothing in it scales on press.
                                Button("Remove") { Task { await remove(grant) } }
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(Tint.destructive)
                                    .rowActionHit()
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
            if let failure = rules.failure {
                Section("Tools") { failed(failure) }
            } else if rules.value == nil {
                Section("Tools") { SettingsPlaceholderRows(labels: ["A tool", "A tool"]) }
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
        if !work.may(.workSet) { lines.append("This phone may not change Work on \(client.environment.name).") }
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
                // His last New Address on this link, while it has words: Checking, then what came of it; or why it did not
                // start.
                if let replaced = work.rekeyLine(link.id) ?? stopped[link.id] {
                    Text(replaced).textStep(.meta).fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(ended ? 0.5 : 1)
            Spacer(minLength: 8)
            // While New Address is out on this link (his check, then the host; or still out on return), a spinner in
            // the menu's place.
            if pressing.contains(link.id) || work.presses.busy(host: client.environment.id, ref: ShareRules.rekeyRef(link.id)) {
                ProgressView()
                    .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                    .accessibilityLabel("Making a new address for \(link.name)")
            // New Address needs approve and Revoke operate (contract-work-guests.ts): a key with neither has no menu.
            } else if !ended, work.may(.guestsRekey) || work.may(.guestsRevoke) {
                Menu {
                    if work.mayReplace(link.id) {
                        Button("New Address…", systemImage: "arrow.triangle.2.circlepath") { replacing = link }
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

    /// The first new address of this host's links that no screen has shown yet.
    /// The next new address of this host's links that no screen has shown.
    private func nextAddress(_ links: [GuestLinkRow]?) -> ShownAddress? {
        let refs = (links ?? []).map { ShareRules.rekeyRef($0.id) }
        return GuestAttempts.shared.next(host: client.environment.id, refs: refs).map { ShownAddress(ref: $0.ref, attempt: $0.kept.attempt, address: $0.kept.address, name: $0.kept.name, title: $0.kept.title) }
    }

    /// The sheet closed: the attempt it showed is seen, and the next waiting address, if any, shows in its own sheet.
    private func acknowledge() {
        guard let shown = showing else { return }
        GuestAttempts.shared.shown(host: client.environment.id, ref: shown.ref, attempt: shown.attempt)
        showing = nil
        Task { @MainActor in showing = nextAddress(guests?.value) }
    }

    private func rekey(_ link: GuestLinkRow) async {
        stopped[link.id] = nil
        pressing.insert(link.id)
        defer { pressing.remove(link.id) }
        // A new address shares the document again: the link and the owner's check first; its key rides to the leave.
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .guestsRekey, ref: link.id, rev: String(link.expiresAt), reason: "Make a new address for \(link.name)’s link") {
            stopped[link.id] = line
            return
        }
        // One attempt key per link through the ledger (`replaceAddress`): a lost answer never replaces it twice. The
        // address itself is kept by `replaceAddress` as it lands, and the sheet above shows it.
        switch await client.work.replaceAddress(link, key: key) {
        case .address: break
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

    /// Only the computer that serves LifeOS's documents keeps links; the others answer "served elsewhere" and show none.
    private func loadGuests() async {
        let read = await WorkRead.of { try await client.work.guestLinks() }
        let elsewhere = read.failure.map(GuestLinksRead.servedElsewhere) == true
        if elsewhere { GuestLinksElsewhere.ids.insert(client.environment.id) } else { GuestLinksElsewhere.ids.remove(client.environment.id) }
        guests = elsewhere ? nil : read
        guestsAnswered = true
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
/// written to every computer with Work on, as the footer says. Every group
/// starts at "When it can’t wait"; only a changed group is sent. A computer
/// that refused a change is that row's red line.
private struct DigestSettingsSection: View {
    /// A row of the section.
    private enum Row: Hashable {
        case time
        case group(TellGroup)
    }

    let hosts: [EnvironmentClient]
    /// Each row's refusals, by computer name.
    @State private var refused: [Row: [String: String]] = [:]
    /// A read that failed on every computer.
    @State private var readFailure: String?
    /// The picked time until the hosts answer, so the wheel never springs back under his finger.
    @State private var pickedAt: Date?
    /// The picked time, written after the wheel rests.
    @State private var timeWrite: Task<Void, Never>?
    /// Which pick of the time is the latest: a slow host's answer to an earlier one is not applied over it.
    @State private var timeEdit = EditGate()

    /// The first computer that answered: they are written alike.
    private var settings: DigestSettings? { hosts.lazy.compactMap(\.work.digest.settings).first }

    var body: some View {
        Section {
            if let settings {
                DatePicker(selection: Binding(get: { pickedAt ?? DigestModel.atDate(settings.at) }, set: { pick($0) }), displayedComponents: .hourAndMinute) {
                    Text("Arrives at").textStep(.title)
                }
                .disabled(!maySet)
                refusal(.time)
                ForEach(DigestModel.settingsGroups, id: \.self) { group in
                    Picker(selection: Binding(get: { DigestModel.level(settings, group) }, set: { level in Task { await write(.group(group), levels: [group.rawValue: level]) } })) {
                        ForEach(DigestModel.levels, id: \.self) { level in
                            Text(DigestModel.levelName(level)).tag(level)
                        }
                    } label: {
                        Text(Self.groupName(group)).textStep(.title)
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
                SettingsPlaceholderRows(labels: ["Arrives at"] + DigestModel.settingsGroups.map(Self.groupName))
            }
        } header: {
            Text("Digest")
        } footer: {
            Text("One set for every computer with Work on.")
        }
        .task(id: hosts.map(\.environment.id)) { await read() }
    }

    private var maySet: Bool { hosts.contains { $0.work.may(.digestSet) } }

    /// A group's row in the glossary's words: the desktop's Digest page calls held items "Things waiting for me".
    static func groupName(_ group: TellGroup) -> String {
        group == .held ? "Things waiting for me" : DigestModel.groupName(group)
    }

    /// Each computer that refused the row's last change, in the screen's destructive meta.
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
            // He picked again while the computers answered: the wheel and the row's line are that pick's now.
            guard timeEdit.isLatest(edit) else { return }
            refused[.time] = lines
            pickedAt = nil
        }
    }

    private func write(_ row: Row, levels: [String: TellLevel]) async {
        refused[row] = await refusals(levels: levels)
    }

    /// One change written to every computer; each that refused, by name, with why.
    private func refusals(at: String? = nil, levels: [String: TellLevel]? = nil) async -> [String: String] {
        let refusedById = await WorkDigest.setAll(hosts.map { ($0.environment.id, $0.work.digest) }, at: at, levels: levels)
        let names = Dictionary(hosts.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
        return Dictionary(refusedById.map { (names[$0.key] ?? $0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
    }
}

/// The computers that answered that another serves their guest links, for this launch: their section is not held
/// open while the next read is out, so it never shows and then goes.
@MainActor
private enum GuestLinksElsewhere {
    static var ids: Set<String> = []
}

/// One new address on Settings → Work's sheet, as it was when the sheet opened.
private struct ShownAddress: Identifiable, Hashable {
    let ref: String
    let attempt: String
    let address: String
    /// Whose link the address opens and to what: the sheet names both.
    let name: String
    let title: String
    var id: String { attempt }
}
