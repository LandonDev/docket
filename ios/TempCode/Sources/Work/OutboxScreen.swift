import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every item Waiting lists, of every host with Work on, newest first.
@MainActor
enum OutboxEntries {
    static func of(_ clients: [EnvironmentClient]) -> [OutboxModel.Entry] {
        clients.filter(\.work.isOn).flatMap { client in
            client.work.items.map { OutboxModel.Entry(environmentId: client.environment.id, item: $0) }
        }
    }

    /// Every host's open requests (each host lists only to a key with approve).
    static func requests(_ clients: [EnvironmentClient]) -> [OutboxModel.RequestEntry] {
        clients.filter(\.work.isOn).flatMap { client in
            client.work.requests.map { OutboxModel.RequestEntry(environmentId: client.environment.id, request: $0) }
        }
    }

    /// Home's count: what the hosts say waits, less what a Send holds back right now.
    static func count(_ clients: [EnvironmentClient]) -> Int {
        let presses = OutboxPresses.shared
        let hidden = of(clients).filter { OutboxModel.needsHim($0.item) }.count(where: presses.hides)
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
                    // The stamp step in `label`: the hierarchical tertiary measured 1.7:1 on white (IOS-DESIGN "Work on the phone").
                    Text(count, format: .number)
                        .textStep(.stamp, tint: Color(.label))
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

/// The Outbox in prototype A's order (docs/IOS-DESIGN.md "Work on the phone"): Asked in threads (a thread's open
/// request, one row each, which opens its sheet), Not sent, Starts soon, a band per thread by the job's rail order,
/// then Scheduled. A row opens the item; swiping it offers Send and Discard, and so does its context menu. A failed
/// send carries the destructive dot and its reason. Held is not Needs you: nothing here wears the warning colour.
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
        let sections = OutboxModel.waitingSections(OutboxEntries.of(clients).filter { !presses.hides($0) }, requests: OutboxEntries.requests(clients), places: places(clients))
        // Each host whose read failed, named above the sections with its own Retry, whatever the others hold; the
        // rows it read before stay below (`OutboxModel.failedReads`).
        let failed = OutboxModel.failedReads(workHosts.map { (id: $0.environment.id, name: $0.environment.name, error: $0.work.listError) })
        List {
            if !failed.isEmpty {
                Section {
                    ForEach(failed) { read in failedRow(read) }
                }
            }
            ForEach(sections) { section in sectionView(section) }
        }
        .listStyle(.plain)
        .overlay {
            switch OutboxModel.emptyState(bandsEmpty: sections.isEmpty, anyReading: workHosts.contains { !$0.work.listed && $0.work.listError == nil }, anyFailed: !failed.isEmpty) {
            case .reading?: ProgressView()
            case .nothingHeld?: ContentUnavailableView("Nothing Held", systemImage: WorkGlyph.outbox)
            case nil: EmptyView()
            }
        }
        .refreshable { for client in workHosts { await client.work.refreshOutbox() } }
        .navigationTitle("Outbox")
        .shellTitleDisplay()
        .outboxUndoInset()
        .outboxDiscardPrompt(Binding(get: { confirmDiscard?.item }, set: { if $0 == nil { confirmDiscard = nil } })) { _, reason in
            guard let entry = confirmDiscard else { return }
            Task { await discard(entry, reason: reason) }
        }
        .listOnScreen("outbox")
        .accessibilityIdentifier("outbox")
    }

    /// The job's rail place (host by host, each host's Work workspaces in its own order, Work Chats after them),
    /// its name, and a thread's title as the host lists it.
    private func places(_ clients: [EnvironmentClient]) -> OutboxModel.Places {
        let hostOrder = Dictionary(clients.enumerated().map { ($1.environment.id, $0) }, uniquingKeysWith: { a, _ in a })
        return OutboxModel.Places(
            jobOrder: { env, workspaceId in
                let client = model.registry.client(env)
                let index = workspaceId.flatMap { id in client?.workspaces.firstIndex { $0.id == id } } ?? 9_999
                return (hostOrder[env] ?? 99) * 10_000 + index
            },
            jobOf: { env, workspaceId in model.registry.client(env)?.workPlace(workspaceId).name ?? "Work Chats" },
            titleOf: { entry in entry.item.sessionId.flatMap { model.registry.client(entry.environmentId)?.session($0)?.title } }
        )
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

    private func sectionView(_ section: OutboxModel.Section) -> some View {
        Section {
            ForEach(section.requests) { entry in AskedRow(entry: entry) }
            ForEach(section.entries) { entry in
                OutboxRow(entry: entry, section: section.kind, canApprove: model.registry.client(entry.environmentId)?.work.canApprove == true, discard: { confirmDiscard = entry })
            }
        } header: {
            BandHeader(title: section.title, job: section.job, sector: section.kind == .thread ? section.sector : nil, dot: section.kind == .thread)
                .listRowInsets(EdgeInsets())
        }
    }

    private func discard(_ entry: OutboxModel.Entry, reason: String?) async {
        guard let client = model.registry.client(entry.environmentId) else { return }
        do {
            try await client.work.discard(entry.item, reason: reason)
        } catch {
            FleetToastCenter.shared.post(message: "Not discarded: \(ActionError.wrap(error).message)")
        }
    }
}

/// A thread's request in Asked in threads: what it would do, the thread that asked, when. It opens the sheet.
private struct AskedRow: View {
    @Environment(AppModel.self) private var model
    let entry: OutboxModel.RequestEntry

    var body: some View {
        let request = entry.request
        let thread = model.registry.client(entry.environmentId)?.session(request.sessionId)?.title
        Button { OutboxRequestCenter.shared.open(environmentId: entry.environmentId, id: request.id) } label: {
            HStack(alignment: .center, spacing: Layout.rowGap) {
                Image(systemName: "checklist")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text(RequestSheetModel.askedHead(request)).textStep(.title).lineLimit(1)
                    if let thread { Text(thread).textStep(.meta).lineLimit(1) }
                }
                Spacer(minLength: 8)
                Text(HeldTime.of(request.createdAt))
                    .textStep(.stamp, tint: Color(.label))
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens what the thread asked for")
        .accessibilityIdentifier("outbox-asked")
    }
}

/// One held item: the kind's glyph in the mark column (the destructive dot for a failed one), what it does, its
/// target or its failure, and one trailing word (when it goes, when its event starts, Out of date, Changed, else
/// when it was held).
private struct OutboxRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let entry: OutboxModel.Entry
    let section: OutboxModel.SectionKind
    let canApprove: Bool
    let discard: () -> Void

    private var item: OutboxItem { entry.item }
    private var failed: Bool { item.state == .failed }
    /// Send and Discard by swipe only on what waits on a plain press: a timed send and one on its way take theirs from the item.
    private var pressable: Bool { canApprove && OutboxModel.needsHim(item) && item.state != .stale }

    var body: some View {
        let side = OutboxModel.rowSide(item, in: section)
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
                // The stamp step in `label`, as the Outbox's other stamps: tertiary measured 1.7:1 on white. A
                // time that is a deadline (Starts soon) is the one word in the title's weight.
                Text(side?.text ?? HeldTime.of(item.createdAt))
                    .textStep(side?.strong == true ? .meta : .stamp, weight: side?.strong == true ? .semibold : .regular, tint: Color(.label))
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if pressable {
                Button("Discard", systemImage: "trash", role: .destructive, action: discard)
                sendButton
                    .tint(.accentColor)
            }
        }
        .contextMenu {
            if pressable {
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
        let title = OutboxModel.pressWord(item, fallback: "Send")
        return Group {
            if OutboxModel.sendsFromDetailOnly(item.kind) || item.state == .live {
                Button("\(title)…", systemImage: OutboxModel.pressGlyph(item.kind)) { navigator.open(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) }
            } else {
                Button(title, systemImage: OutboxModel.pressGlyph(item.kind)) { OutboxPresses.shared.send(entry) }
            }
        }
    }

    /// The act as its title and one line under it (`OutboxModel.rowWords`): the failure's reason, the
    /// When, a mail's subject, or the summary's words after its ": ".
    private var words: (title: String, line: String?) { OutboxModel.rowWords(item) }
}

/// A section's head on the one gray step: a thread band's sector dot, its title, its job after it; or the section's
/// own name (Asked in threads, Not sent, Starts soon, Scheduled). The dot is the only colour on it, and it carries no
/// count: the rows are the count.
private struct BandHeader: View {
    let title: String
    let job: String?
    let sector: String?
    let dot: Bool

    var body: some View {
        HStack(spacing: 8) {
            if dot { SectorDot(sector: sector, size: 7) }
            // Explicit inks, never the hierarchical steps: inside a list's section header those nest under the
            // header's own dimming and measured 1.7:1 and 1.3:1 on the chrome fill in light. `label` keeps 18.8:1
            // (light) and 17:1 (dark) on it. The title at semibold, the job after it at regular: the job gives way
            // first when the width runs out.
            Text(title)
                .textStep(.meta, weight: .semibold, tint: Color(.label))
                .lineLimit(1)
                .layoutPriority(1)
            if let job {
                Text(job)
                    .textStep(.meta, tint: Color(.label))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
