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

    /// Every host's open requests (each host lists only to a key that may read them, `KeyMethod.outboxRequests`).
    static func requests(_ clients: [EnvironmentClient]) -> [OutboxModel.RequestEntry] {
        clients.filter(\.work.isOn).flatMap { client in
            client.work.requests.map { OutboxModel.RequestEntry(environmentId: client.environment.id, request: $0) }
        }
    }

    /// The Outbox's one count (`OutboxModel.waitingCount`, over master's `needsHim`): what waits on him, less what
    /// a Send holds back right now; a host whose list has not answered yet counts the rows kept from its last one.
    /// The Work list's Outbox row reads this; Today's line counts the same rows (TodayFeed hands it the same items
    /// less the same holds).
    static func count(_ clients: [EnvironmentClient]) -> Int {
        let hosts = clients.filter(\.work.isOn).map { client in
            OutboxModel.CountedHost(
                listed: client.work.listed,
                entries: client.work.items.map { OutboxModel.Entry(environmentId: client.environment.id, item: $0) },
                kept: OutboxKeeping.rows(client).count
            )
        }
        return OutboxModel.waitingCount(hosts, holds: OutboxPresses.shared.hides)
    }

    /// The rows kept on the phone for each host whose list has not answered on this link, as bands.
    static func kept(_ clients: [EnvironmentClient]) -> [WorkCache.KeptBand] {
        WorkCache.keptBands(clients.flatMap(OutboxKeeping.rows))
    }
}

/// The Outbox in prototype A's order (docs/IOS-DESIGN.md "Work on the phone"): Asked in threads (a thread's open
/// request, one row each, which opens its sheet), Not sent, Starts soon, a band per thread by the job's rail order,
/// then Scheduled. A row opens the item; swiping it offers Send and Discard, and so does its context menu. A failed
/// send carries the destructive dot and its reason. Held is not Needs you: nothing here wears the warning colour.
struct OutboxScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.shellPose) private var pose
    @State private var confirmDiscard: OutboxModel.Entry?
    /// Hosts whose Retry is reading.
    @State private var retrying: Set<String> = []
    /// The rows that waited on him as the list last drew them, held-back ones in place: where the next pick is
    /// found when the shown one leaves (`OutboxModel.pickOrder`).
    @State private var seen: [String] = []
    /// The phone's summary sheet, from Send N….
    @State private var summaryOpen = false

    private var selecting: OutboxSelecting { OutboxSelecting.shared }

    var body: some View {
        let clients = model.registry.ordered
        let workHosts = clients.filter(\.work.isOn)
        let presses = OutboxPresses.shared
        // Every section with what a Send holds back still in place (the pick's order), then as drawn without them.
        let all = OutboxModel.waitingSections(OutboxEntries.of(clients), requests: OutboxEntries.requests(clients), places: places(clients))
        let sections = all.compactMap { section -> OutboxModel.Section? in
            var shown = section
            shown.entries = section.entries.filter { !presses.hides($0) }
            return shown.entries.isEmpty && shown.requests.isEmpty ? nil : shown
        }
        let entries = sections.flatMap(\.entries)
        let ids = entries.map(\.id)
        // The Duo picks held items alone, in the order the sections draw them; a request opens its sheet instead.
        let present = all.flatMap(\.entries).map(\.id)
        let order = all.flatMap(\.entries).filter { OutboxModel.needsHim($0.item) }.map(\.id)
        let shown = navigator.detailRoot.flatMap(OutboxPick.row)
        let first = OutboxModel.pickOrder(now: entries.filter { OutboxModel.needsHim($0.item) }.map(\.id), seen: seen, shown: shown)
        let kept = OutboxEntries.kept(clients)
        let tickable = Set(entries.filter { mayTick($0) }.map(\.id))
        // Each host whose read failed, named above the sections with its own Retry, whatever the others hold; the
        // rows it read before stay below (`OutboxModel.failedReads`).
        // A host that is not linked and never listed on this launch is named too, as Today names it: never a spinner
        // for as long as it is down.
        let failed = OutboxModel.failedReads(workHosts.map { (id: $0.environment.id, name: $0.environment.name, error: $0.work.listError ?? (!$0.work.listed && !TodayFeed.open($0) ? TodaySources.notConnected : nil)) })
        List {
            if !failed.isEmpty {
                Section {
                    ForEach(failed) { read in failedRow(read) }
                }
            }
            ForEach(sections) { section in sectionView(section, tickable: tickable) }
            // A cold launch: what each host's last list held, until that host answers on this link.
            ForEach(kept) { band in
                Section {
                    ForEach(band.rows) { row in KeptRow(row: row) }
                } header: {
                    BandHeader(title: band.place, job: nil, sector: nil, dot: false)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            switch OutboxModel.emptyState(bandsEmpty: sections.isEmpty && kept.isEmpty, anyReading: workHosts.contains { !$0.work.listed && $0.work.listError == nil && TodayFeed.open($0) }, anyFailed: !failed.isEmpty) {
            case .reading?: ProgressView()
            case .nothingHeld?: ContentUnavailableView("Nothing Held", systemImage: WorkGlyph.outbox)
            case nil: EmptyView()
            }
        }
        .refreshable { for client in workHosts { await client.work.refreshOutbox() } }
        .navigationTitle(selecting.on ? OutboxScreen.selectTitle(selecting.selection.count) : "Outbox")
        .shellTitleDisplay()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if selecting.on {
                    Button("Done") { selecting.end() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("outbox-select-done")
                } else if !tickable.isEmpty {
                    Button("Select") { selecting.begin() }
                        .accessibilityIdentifier("outbox-select")
                }
            }
        }
        .modifier(SelectFoot(on: selecting.on && !pose.isSplit, count: selecting.selection.count, clear: { selecting.selection.clear() }, review: { summaryOpen = true }))
        .sheet(isPresented: $summaryOpen) { OutboxSummarySheet() }
        .outboxUndoInset()
        .outboxDiscardPrompt(Binding(get: { confirmDiscard?.item }, set: { if $0 == nil { confirmDiscard = nil } })) { _, reason in
            guard let entry = confirmDiscard else { return }
            Task { await discard(entry, reason: reason) }
        }
        // The open Duo: the first waiting item fills an empty detail, and when the shown one leaves the list the
        // next one he saw after it takes the detail (`OutboxModel.pickOrder`). The summary of his ticks holds the
        // detail while he selects.
        .placeTop(.place(.outbox), ids: ids)
        .placePick(.place(.outbox), ids: present, pick: PlacePick(first: first, rowOf: OutboxPick.row) { id in
            guard let entry = entries.first(where: { $0.id == id }) else { return }
            navigator.open(OutboxPick.route(entry))
        })
        .onChange(of: order, initial: true) { seen = order }
        // A tick on a row that left, or no longer takes one, goes.
        .onChange(of: tickable) { selecting.selection.keep(tickable) }
        .onChange(of: selecting.on) { _, on in selected(on, first: first, entries: entries) }
        #if DEBUG
        // M1d's proof: Select with the first three rows that take a tick ticked (`outbox-select`), and on a phone
        // the summary sheet over it (`outbox-summary`), two seconds after the list has rows.
        .task(id: tickable.isEmpty) {
            guard TestHooks.action == "outbox-select" || TestHooks.action == "outbox-summary", !tickable.isEmpty, TestHooks.once("outbox-select") else { return }
            try? await Task.sleep(for: .seconds(2))
            selecting.begin()
            selecting.selection.toggleAll(entries.map(\.id).filter(tickable.contains).prefix(3).map { $0 })
            if TestHooks.action == "outbox-summary", !pose.isSplit { summaryOpen = true }
        }
        #endif
        .listOnScreen("outbox")
        .accessibilityIdentifier("outbox")
    }

    /// "3 Selected", or "Select Items" before the first tick.
    static func selectTitle(_ count: Int) -> String {
        count == 0 ? "Select Items" : "\(count) Selected"
    }

    /// A row takes a tick: it waits on a plain press (`OutboxModel.tickable`), no press of its own is out, and its
    /// host's key may decide there.
    private func mayTick(_ entry: OutboxModel.Entry) -> Bool {
        guard OutboxModel.tickable(entry.item), let work = model.registry.client(entry.environmentId)?.work else { return false }
        return work.may(.outboxSend) && work.may(.outboxDecide) && !work.presses.busy(host: entry.environmentId, ref: OutboxModel.key(entry.item.ref))
    }

    /// Select on the open Duo puts the summary in the detail; Done, or a press from it, gives the detail back the
    /// first row that waits on him.
    private func selected(_ on: Bool, first: [String], entries: [OutboxModel.Entry]) {
        guard pose.isSplit else { return }
        if on {
            navigator.detailStack = NavigationPath()
            navigator.detailRoot = OutboxPick.summary
        } else if navigator.detailRoot == OutboxPick.summary {
            navigator.detailStack = NavigationPath()
            navigator.detailRoot = first.first.flatMap { id in entries.first { $0.id == id } }.map(OutboxPick.route)
        }
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
                PillButton("Try Again") { Task { await retry(read.id) } }
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

    private func sectionView(_ section: OutboxModel.Section, tickable: Set<String>) -> some View {
        let ticks = section.entries.map(\.id).filter(tickable.contains)
        return Section {
            ForEach(section.requests) { entry in AskedRow(entry: entry) }
            ForEach(section.entries) { entry in
                let client = model.registry.client(entry.environmentId)
                let presses = client?.work.presses
                let ref = OutboxModel.key(entry.item.ref)
                // A press whose answer is out or lost offers no second Send or Discard until it is read back.
                let busy = presses?.busy(host: entry.environmentId, ref: ref) == true
                OutboxRow(
                    entry: entry,
                    section: section.kind,
                    decides: client?.work.may(.outboxSend) == true && !busy,
                    // What a press made of it says first ("Checking…"), then why a press on many left it here.
                    pressLine: presses?.state(host: entry.environmentId, ref: ref).flatMap(OutboxRow.line) ?? OutboxPresses.shared.reason(entry),
                    tick: selecting.on ? (tickable.contains(entry.id) ? .open(selecting.selection.contains(entry.id)) : .closed) : nil,
                    toggle: { selecting.selection.toggle(entry.id) },
                    discard: { confirmDiscard = entry }
                )
            }
        } header: {
            BandHeader(
                title: section.title, job: section.job, sector: section.kind == .thread ? section.sector : nil, dot: section.kind == .thread,
                all: selecting.on && !ticks.isEmpty ? (selecting.selection.allTicked(ticks) ? "Deselect All" : "Select All") : nil,
                selectAll: { selecting.selection.toggleAll(ticks) }
            )
            .listRowInsets(EdgeInsets())
        }
    }

    /// The owner's check and the host's answer; what did not go is said in the capsule.
    private func discard(_ entry: OutboxModel.Entry, reason: String?) async {
        let presses = OutboxPresses.shared
        if let line = await presses.discard(entry, reason: reason) { presses.say(line) }
    }
}

/// An Outbox row's id is its entry's (`OutboxModel.Entry.id`), and the held item's route names the same.
enum OutboxPick {
    static func route(_ entry: OutboxModel.Entry) -> Route {
        .outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(entry.item.ref))
    }

    /// The open Duo's detail while he selects: the summary of his ticks. An item route with no host, which no held
    /// item can have, so the shell needs no new route; `OutboxItemScreen` draws `OutboxSummary` for it.
    static let summary = Route.outboxItem(environmentId: "", ref: "selection")

    static func isSummary(environmentId: String, ref: String) -> Bool {
        environmentId.isEmpty && ref == "selection"
    }

    /// The row a detail's root shows: a held item's, by its entry's id. The summary is none of the list's rows, so
    /// the pick never replaces it.
    static func row(_ route: Route) -> String? {
        guard case .outboxItem(let environmentId, let ref) = route, !isSummary(environmentId: environmentId, ref: ref) else { return nil }
        return "\(environmentId):\(ref)"
    }
}

/// The list's foot while he selects on a phone: Clear, and Send N…, which opens the summary sheet. On the open Duo
/// the summary is the detail column itself, so there is no foot.
private struct SelectFoot: ViewModifier {
    let on: Bool
    let count: Int
    let clear: () -> Void
    let review: () -> Void

    func body(content: Content) -> some View {
        if on {
            content.tcBottomBar {
                HStack(spacing: 8) {
                    // A glass capsule of its own, as Send's: plain words over the scroll edge read over the row behind.
                    Button("Clear", action: clear)
                        .font(.body)
                        .padding(.horizontal, 10)
                        .frame(minHeight: Layout.rowHeight)
                        .buttonBorderShape(.capsule)
                        .tcGlassButton()
                        .disabled(count == 0)
                        .accessibilityIdentifier("outbox-select-clear")
                    Spacer(minLength: 0)
                    Button("Send \(count)…", action: review)
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(minHeight: Layout.rowHeight)
                        .buttonBorderShape(.capsule)
                        .tcGlassButton(prominent: true)
                        .disabled(count == 0)
                        .accessibilityIdentifier("outbox-select-review")
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, 8)
            }
        } else {
            content
        }
    }
}

/// A row kept from a host's last list, drawn before that host answers: its kind's glyph, what it does, what it is
/// about, when it was held. It opens the item to read; nothing on it can be pressed or ticked.
private struct KeptRow: View {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dynamicTypeSize) private var typeSize
    let row: WorkCache.WaitingRow

    var body: some View {
        Button { navigator.open(.outboxItem(environmentId: row.environmentId, ref: row.ref)) } label: {
            let large = typeSize.isAccessibilitySize
            HStack(alignment: large ? .firstTextBaseline : .center, spacing: Layout.rowGap) {
                Image(systemName: WorkGlyph.of(OutboxItem.Kind(rawValue: row.kind)))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.act).textStep(.title).lineLimit(large ? 3 : 1)
                    if let about = row.about { Text(about).textStep(.meta).lineLimit(large ? 3 : 1) }
                    if large { Text(HeldTime.of(row.at)).textStep(.stamp, tint: Color(.label)) }
                }
                if !large {
                    Spacer(minLength: 8)
                    Text(HeldTime.of(row.at)).textStep(.stamp, tint: Color(.label))
                }
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("outbox-row-kept")
    }
}

/// A thread's request in Asked in threads: what it would do, the thread that asked, when. It opens the sheet.
private struct AskedRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: OutboxModel.RequestEntry

    var body: some View {
        let request = entry.request
        let thread = model.registry.client(entry.environmentId)?.session(request.sessionId)?.title
        // At accessibility sizes the request's words wrap and the time goes under them, as the held rows do.
        let large = typeSize.isAccessibilitySize
        Button { OutboxRequestCenter.shared.open(environmentId: entry.environmentId, id: request.id) } label: {
            HStack(alignment: large ? .firstTextBaseline : .center, spacing: Layout.rowGap) {
                Image(systemName: "checklist")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text(RequestSheetModel.askedHead(request)).textStep(.title).lineLimit(large ? 3 : 1)
                    if let thread { Text(thread).textStep(.meta).lineLimit(large ? 3 : 1) }
                    if large { Text(HeldTime.of(request.createdAt)).textStep(.stamp, tint: Color(.label)) }
                }
                if !large {
                    Spacer(minLength: 8)
                    Text(HeldTime.of(request.createdAt))
                        .textStep(.stamp, tint: Color(.label))
                }
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
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: OutboxModel.Entry
    let section: OutboxModel.SectionKind
    /// This key may press Send and Discard on it, and no press of its own is out or lost.
    let decides: Bool
    /// What a press on it came to, while it has words ("Checking…", "Changed"), or why a press on many left it:
    /// the meta line says it.
    let pressLine: String?
    /// While he selects: the row's tick (ticked or not), or `.closed` for one that takes none; nil otherwise.
    let tick: Tick?
    let toggle: () -> Void
    let discard: () -> Void

    enum Tick: Equatable { case open(Bool), closed }

    /// The words a row shows for a press. "May have gone" is the item's own failure line (Check Sent first),
    /// never said twice.
    static func line(_ state: PressState) -> String? {
        state == .mayHaveGone ? nil : state.line
    }

    private var item: OutboxItem { entry.item }
    private var failed: Bool { item.state == .failed }
    /// Send and Discard by swipe only on what waits on a plain press: a timed send and one on its way take theirs from the item.
    private var pressable: Bool { decides && OutboxModel.needsHim(item) && item.state != .stale }

    var body: some View {
        let side = OutboxModel.rowSide(item, in: section)
        Button {
            switch tick {
            case .open(_)?: toggle()
            case .closed?: break
            case nil: navigator.open(OutboxPick.route(entry))
            }
        } label: {
            // At accessibility sizes the words wrap and the time goes under them (Today's rule), so a long title or
            // a failed send's reason is read whole rather than cut to a few letters beside a stamp.
            let large = typeSize.isAccessibilitySize
            HStack(alignment: large ? .firstTextBaseline : .center, spacing: Layout.rowGap) {
                // The mark column holds one mark: his tick while he selects, the destructive dot for a failed send,
                // else the kind's glyph.
                Group {
                    if case .open(let on)? = tick {
                        OutboxTick(on: on)
                    } else if failed {
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
                        .lineLimit(large ? 3 : 1)
                    if let line = pressLine ?? words.line {
                        Text(line)
                            .textStep(.meta, tint: (failed && pressLine == nil) || reasonShown ? Tint.destructiveText : nil)
                            .lineLimit(large ? 3 : 1)
                    }
                    if large { stamp(side) }
                }
                if !large {
                    Spacer(minLength: 8)
                    stamp(side)
                }
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        // While he selects, a row that takes no tick steps back.
        .opacity(tick == .closed ? 0.45 : 1)
        .listRowInsets(Layout.rowInsets)
        // The item the detail shows, beside the list on the open Duo.
        .placeSelected(tick == nil && navigator.detailRoot.flatMap(OutboxPick.row) == entry.id)
        .rowInitProbe(work: entry.id)
        // Dragged onto a Work thread's box on the open Duo, the held act is its chip there.
        .modifier(ChipDragSource(chip: RowChips.held(item)))
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if pressable, tick == nil {
                Button("Discard", systemImage: "trash", role: .destructive, action: discard)
                sendButton
                    .tint(.accentColor)
            }
        }
        .contextMenu {
            if pressable, tick == nil {
                sendButton
                Button("Discard", systemImage: "trash", role: .destructive, action: discard)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(tick == .open(true) ? .isSelected : [])
        .accessibilityIdentifier("outbox-row")
    }

    /// The meta line is the reason a press on many left it here.
    /// A reason his press on many left in this row, in the failure ink; "May have gone" is not a failure and keeps the
    /// meta ink, as the late answer's line does.
    private var reasonShown: Bool { pressLine != nil && pressLine == OutboxPresses.shared.reason(entry) && pressLine != PressState.mayHaveGone.line }

    /// Send, or for what only its detail shows (a LifeOS reply's quote, a computer act's picture)
    /// "Send…", which opens the detail: a list never sends what he has not seen whole.
    private var sendButton: some View {
        let title = OutboxModel.pressWord(item, fallback: "Send")
        return Group {
            if OutboxModel.sendsFromDetailOnly(item.kind) || item.state == .live {
                Button("\(title)…", systemImage: OutboxModel.pressGlyph(item.kind)) { navigator.open(OutboxPick.route(entry)) }
            } else {
                Button(title, systemImage: OutboxModel.pressGlyph(item.kind)) { Task { await OutboxPresses.shared.send(entry) } }
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
extension OutboxRow {
    /// The stamp step in `label`, as the Outbox's other stamps: tertiary measured 1.7:1 on white. A time that is a
    /// deadline (Starts soon) is the one word in the title's weight.
    fileprivate func stamp(_ side: (text: String, strong: Bool)?) -> some View {
        Text(side?.text ?? HeldTime.of(item.createdAt))
            .textStep(side?.strong == true ? .meta : .stamp, weight: side?.strong == true ? .semibold : .regular, tint: Color(.label))
            .lineLimit(1)
    }
}

private struct BandHeader: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let job: String?
    let sector: String?
    let dot: Bool
    /// While he selects: "Select All" or "Deselect All" for the section's rows that take a tick.
    var all: String? = nil
    var selectAll: () -> Void = {}

    var body: some View {
        // At accessibility sizes the band's name wraps whole and Select All sits under it at its full size, never
        // broken mid-word beside a cut job name (IOS-DESIGN "Large text").
        let large = typeSize.isAccessibilitySize
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if dot { SectorDot(sector: sector, size: 7) }
                // Explicit inks, never the hierarchical steps: inside a list's section header those nest under the
                // header's own dimming and measured 1.7:1 and 1.3:1 on the chrome fill in light. `label` keeps 18.8:1
                // (light) and 17:1 (dark) on it. The title at semibold, the job after it at regular: the job gives way
                // first when the width runs out.
                Text(title)
                    .textStep(.meta, weight: .semibold, tint: Color(.label))
                    .lineLimit(large ? 3 : 1)
                    .layoutPriority(1)
                if let job {
                    Text(job)
                        .textStep(.meta, tint: Color(.label))
                        .lineLimit(large ? 3 : 1)
                }
            }
            if !large { Spacer(minLength: 0) }
            if let all {
                Button(all, action: selectAll)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize()
                    .buttonStyle(.pressable)
                    .frame(minHeight: large ? Layout.rowHeight : nil)
                    .contentShape(Rectangle().inset(by: -8))
                    .accessibilityIdentifier("outbox-select-all")
            }
        }
        .padding(.vertical, large ? Layout.rowVertical : 0)
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .textCase(nil)
        .accessibilityElement(children: all == nil ? .combine : .contain)
        .accessibilityAddTraits(.isHeader)
    }
}
