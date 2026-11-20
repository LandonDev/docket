import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every waiting held item of every host with Work on, newest first.
@MainActor
enum OutboxEntries {
    static func of(_ clients: [EnvironmentClient]) -> [OutboxModel.Entry] {
        clients.filter(\.work.isOn).flatMap { client in
            client.work.items.map { OutboxModel.Entry(environmentId: client.environment.id, item: $0) }
        }
    }

    /// Home's count: what the hosts say waits, less what a Send holds back right now.
    static func count(_ clients: [EnvironmentClient]) -> Int {
        let presses = OutboxPresses.shared
        let hidden = of(clients).count(where: presses.hides)
        return max(0, clients.filter(\.work.isOn).reduce(0) { $0 + $1.work.waiting } - hidden)
    }
}

/// Home's first row while any host has Work on: the Outbox, its count a
/// plain stamp. Held is not Needs you, so the count is never amber.
struct OutboxHomeRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let count: Int
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { navigator.open(.outbox) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                Image(systemName: WorkGlyph.outbox)
                    .font(TextStep.title.font.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: icon, height: icon)
                Text("Outbox")
                    .textStep(.title, weight: .medium)
                Spacer(minLength: 8)
                if count > 0 {
                    Text(count, format: .number)
                        .textStep(.stamp)
                        .contentTransition(.numericText())
                }
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .animation(Motion.numeric, value: count)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(count > 0 ? "Outbox, \(count) held" : "Outbox")
        .accessibilityIdentifier("home-outbox")
    }
}

/// The Outbox (phone-outbox.html, "A row on Home"): held items in bands, a
/// band per Work workspace led by its sector's dot, with its count. A row
/// opens the item; swiping it offers Send and Discard, and so does its
/// context menu. A failed send carries the destructive dot and its reason.
struct OutboxScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @State private var confirmDiscard: OutboxModel.Entry?
    /// Hosts whose Retry is reading.
    @State private var retrying: Set<String> = []

    var body: some View {
        let clients = model.registry.ordered
        let workHosts = clients.filter(\.work.isOn)
        let presses = OutboxPresses.shared
        let bands = OutboxModel.bands(OutboxEntries.of(clients).filter { !presses.hides($0) })
        // Each host whose read failed, named above the bands with its own Retry, whatever the others hold; the rows
        // it read before stay below (`OutboxModel.failedReads`).
        let failed = OutboxModel.failedReads(workHosts.map { (id: $0.environment.id, name: $0.environment.name, error: $0.work.listError) })
        List {
            if !failed.isEmpty {
                Section {
                    ForEach(failed) { read in failedRow(read) }
                }
            }
            ForEach(bands) { band in bandSection(band) }
        }
        .listStyle(.plain)
        .overlay {
            switch OutboxModel.emptyState(bandsEmpty: bands.isEmpty, anyReading: workHosts.contains { !$0.work.listed && $0.work.listError == nil }, anyFailed: !failed.isEmpty) {
            case .reading?: ProgressView()
            case .nothingHeld?: ContentUnavailableView("Nothing Held", systemImage: WorkGlyph.outbox, description: Text("What a Work thread sends waits here for you."))
            case nil: EmptyView()
            }
        }
        .refreshable { for client in workHosts { await client.work.refreshOutbox() } }
        .navigationTitle("Outbox")
        .shellTitleDisplay()
        .outboxUndoInset()
        .confirmationDialog("Discard this?", isPresented: Binding(get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }), titleVisibility: .visible, presenting: confirmDiscard) { entry in
            Button("Discard", role: .destructive) { Task { await discard(entry) } }
        } message: { entry in
            Text("\(entry.item.summary) will never go.")
        }
        .listOnScreen("outbox")
        .accessibilityIdentifier("outbox")
    }

    /// "Box did not answer", its error under it, and Retry, which reads that host alone again.
    private func failedRow(_ read: OutboxModel.FailedRead) -> some View {
        HStack(spacing: Layout.rowGap) {
            Circle()
                .fill(Tint.destructive)
                .frame(width: Layout.dotSize, height: Layout.dotSize)
                .frame(width: Layout.glyphWidth + Layout.markWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(read.line).textStep(.title).lineLimit(1)
                Text(read.error).textStep(.meta).lineLimit(2)
            }
            Spacer(minLength: 8)
            if retrying.contains(read.id) {
                ProgressView()
            } else {
                PillButton("Retry") { Task { await retry(read.id) } }
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .listRowInsets(Layout.rowInsets)
        // Retry stays its own element, never folded into the row's words.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("outbox-host-failed")
    }

    private func retry(_ id: String) async {
        guard let client = model.registry.client(id) else { return }
        retrying.insert(id)
        defer { retrying.remove(id) }
        await client.work.refreshOutbox()
    }

    private func bandSection(_ band: OutboxModel.Band) -> some View {
        let client = model.registry.client(band.environmentId)
        let place: (name: String, sector: String?) = client?.workPlace(band.workspaceId) ?? ("Work Chats", nil)
        let canApprove = client?.work.canApprove == true
        return Section {
            ForEach(band.entries) { entry in
                OutboxRow(entry: entry, canApprove: canApprove, discard: { confirmDiscard = entry })
            }
        } header: {
            BandHeader(name: place.name, sector: band.sector ?? place.sector, count: band.entries.count)
                .listRowInsets(EdgeInsets())
        }
    }

    private func discard(_ entry: OutboxModel.Entry) async {
        guard let client = model.registry.client(entry.environmentId) else { return }
        do {
            try await client.work.discard(entry.item)
        } catch {
            FleetToastCenter.shared.post(message: "Not discarded: \(ActionError.wrap(error).message)")
        }
    }
}

/// One held item: the kind's glyph in the mark column (the destructive dot
/// for a failed one), what it does, its target or its failure, the time.
private struct OutboxRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let entry: OutboxModel.Entry
    let canApprove: Bool
    let discard: () -> Void

    private var item: OutboxItem { entry.item }
    private var failed: Bool { item.state == .failed }

    var body: some View {
        Button { navigator.open(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) } label: {
            HStack(alignment: .center, spacing: Layout.rowGap) {
                // The mark column holds one mark: the destructive dot for a failed send, else the kind's glyph.
                Group {
                    if failed {
                        Circle()
                            .fill(Tint.destructive)
                            .frame(width: Layout.dotSize, height: Layout.dotSize)
                            .accessibilityLabel("Failed")
                    } else {
                        Image(systemName: WorkGlyph.of(item.kind))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text(words.title)
                        .textStep(.title)
                        .lineLimit(1)
                    if let line = words.line {
                        Text(line)
                            .textStep(.meta, tint: failed ? Tint.destructiveText : nil)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Text(HeldTime.of(item.createdAt))
                    .textStep(.stamp)
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canApprove {
                Button("Discard", systemImage: "trash", role: .destructive, action: discard)
                sendButton
                    .tint(.accentColor)
            }
        }
        .contextMenu {
            if canApprove {
                sendButton
                Button("Discard", systemImage: "trash", role: .destructive, action: discard)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("outbox-row")
    }

    /// Send, or for what only its detail shows (a LifeOS reply's quote, a computer act's picture)
    /// "Send…", which opens the detail: a list never sends what he has not seen whole.
    private var sendButton: some View {
        let title = failed ? "Send Again" : "Send"
        return Group {
            if OutboxModel.sendsFromDetailOnly(item.kind) {
                Button("\(title)…", systemImage: "paperplane") { navigator.open(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) }
            } else {
                Button(title, systemImage: "paperplane") { OutboxPresses.shared.send(entry) }
            }
        }
    }

    /// The act as its title and one line under it (`OutboxModel.rowWords`): the failure's reason, the
    /// When, a mail's subject, or the summary's words after its ": ".
    private var words: (title: String, line: String?) { OutboxModel.rowWords(item) }
}

/// An Outbox band's head on the one gray step: the sector's dot, the
/// workspace's name, the count. The dot is the only colour on it.
private struct BandHeader: View {
    let name: String
    let sector: String?
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            SectorDot(sector: sector, size: 7)
            // Explicit inks, never the hierarchical steps: inside a list's section header those nest under the
            // header's own dimming and measured 1.7:1 and 1.3:1 on the chrome fill in light. `label` keeps 18.8:1
            // (light) and 17:1 (dark) on it; `secondaryLabel` would be 3.3:1 in light. The two type steps stay: the
            // name in the meta step at semibold, the count in the stamp step.
            Text(name)
                .textStep(.meta, weight: .semibold, tint: Color(.label))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(count, format: .number)
                .textStep(.stamp, tint: Color(.label))
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
