import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every host with Work on, as the digest's rules read them.
@MainActor
enum DigestHosts {
    /// A host whose key was refused is not among them: no load, no seen call and no "did not answer" line for it.
    static func of(_ clients: [EnvironmentClient]) -> [EnvironmentClient] {
        clients.filter { $0.work.isOn && !$0.work.keyRevoked }
    }

    static func inputs(_ clients: [EnvironmentClient]) -> [DigestModel.HostInput] {
        of(clients).map { client in
            // What the phone kept of a host stands in, read-only, until it answers; never under a key it refused.
            DigestModel.HostInput(
                environmentId: client.environment.id, name: client.environment.name, ledger: client.work.digest.ledger, error: client.work.digest.error,
                kept: client.work.keyRevoked ? nil : client.work.digest.kept
            )
        }
    }
}

/// The digest (docs/agents/work-digest.md "The phone"): what Work told him on
/// every Work host, one list by day, newest first. A row is the job's dot, the
/// title, the detail under it and the time; the whole row opens its target
/// where the phone has a route for it. Opening the screen marks the days in it
/// seen on every host that holds them.
struct DigestScreen: View {
    /// Its id among the lists on screen: a notice of Work's shows no banner while it is.
    static let listId = "digest"
    static let glyph = "newspaper"

    @Environment(AppModel.self) private var model

    var body: some View {
        let hosts = DigestHosts.of(model.registry.ordered)
        let screen = DigestModel.screen(DigestHosts.inputs(model.registry.ordered))
        let now = Date.now
        let sections = DigestModel.sections(screen.entries, days: screen.days, now: now)
        // A host whose key was refused is read for nothing, but named: one muted line each, as Today names it.
        let refused = model.registry.ordered.filter { $0.work.isOn && $0.work.keyRevoked }.map(\.environment.name)
        List {
            if sections.isEmpty && screen.reading {
                DigestSkeleton()
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        DigestRow(entry: entry, day: section.day, now: now)
                    }
                } header: {
                    DayHeader(title: section.title)
                        .listRowInsets(EdgeInsets())
                }
            }
            if !screen.silent.isEmpty || !refused.isEmpty {
                Section {
                    // Each host that did not answer, with Try Again, which reads that host again (the failed-read row).
                    ForEach(screen.silent, id: \.self) { name in
                        FailedRead(words: DigestModel.silentLine(name), retry: { await load(hosts.filter { $0.environment.name == name }) }, identifier: "digest-host-silent")
                            .listRowSeparator(.hidden)
                    }
                    ForEach(refused, id: \.self) { name in
                        Text(WorkHost.refusedLine(name))
                            .textStep(.meta)
                            .listRowInsets(Layout.rowInsets)
                            .listRowSeparator(.hidden)
                            .accessibilityIdentifier("digest-host-refused")
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if sections.isEmpty && !screen.reading && screen.silent.isEmpty && refused.isEmpty {
                // One line: the title says since when, and nothing is said twice under it.
                ContentUnavailableView(DigestModel.emptyLine(now: now), systemImage: Self.glyph)
            }
        }
        .refreshable { await load(hosts) }
        // The first open reads every host, and a host whose Work turns on while the list is open is read then; from
        // then on the pushes keep each ledger.
        .task(id: hosts.map(\.environment.id)) { await load(hosts.filter { $0.work.digest.ledger == nil }) }
        // What he has on screen is seen: at the open, and for a day made while he looks. A day drawn from what the
        // phone kept is marked only once its host answers on this link.
        .task(id: screen.days.filter { $0.seenAt == nil }.map(\.day) + live(hosts).sorted()) { await markSeen(screen.days, live: live(hosts)) }
        .navigationTitle("Digest")
        .shellTitleDisplay()
        .listOnScreen(Self.listId)
        .clashSheet()
        .accessibilityIdentifier("digest")
    }

    /// Every host at once: one task each, started before the first is awaited (a task group's main-actor
    /// child stops Swift 6.4's region checker).
    private func load(_ hosts: [EnvironmentClient]) async {
        let reads = hosts.map { client in Task { @MainActor in await client.work.digest.load() } }
        for read in reads { await read.value }
    }

    /// The hosts that answered on this link.
    private func live(_ hosts: [EnvironmentClient]) -> Set<String> {
        Set(hosts.filter { $0.work.digest.ledger != nil }.map(\.environment.id))
    }

    private func markSeen(_ days: [DigestModel.Day], live: Set<String>) async {
        for call in DigestModel.seenCalls(days, live: live) {
            await model.registry.client(call.environmentId)?.work.digest.seen(call.day)
        }
    }
}

/// One tell: the job's dot (a muted ring for a row about no one job), the
/// title, the detail under it, the time at the end. A row the phone has a
/// route for is a button; one it has none for is not.
private struct DigestRow: View {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.shellPose) private var pose
    let entry: DigestModel.Entry
    /// The day key of the heading the row sits under: a time told that day needs no day of its own.
    let day: String
    let now: Date

    private var row: TellRow { entry.row }
    /// The job by name for VoiceOver: on screen the dot alone says it.
    private var spoken: String { DigestModel.spoken(row, when: DigestModel.when(row, now: now, day: day)) }

    var body: some View {
        if let route = DigestModel.route(row.open, environmentId: entry.environmentId, key: row.key) {
            Button {
                // A clash is a sheet on a phone and the detail on the open Duo.
                if case .clash(let environmentId, let clashId) = route {
                    ClashOpen.open(environmentId: environmentId, clashId: clashId, pose: pose, navigator: navigator)
                } else {
                    // The review's tell names its week by its first moment: Review opens on it.
                    if let week = DigestModel.reviewWeek(row.open) { ReviewFeed.store.show(named: week) }
                    navigator.open(route)
                }
            } label: { content }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spoken)
                .accessibilityIdentifier("digest-row")
        } else {
            content
                .listRowInsets(Layout.rowInsets)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spoken)
                .accessibilityIdentifier("digest-row")
        }
    }

    // The dot and the time sit on the title's first line, as the Inbox's two-line rows do: the row aligns on
    // the first baseline, and the dot is centred on one line of the title step (`FirstLineMark`).
    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            FirstLineMark {
                if row.sector != nil {
                    SectorDot(sector: row.sector, size: Layout.dotSize)
                } else {
                    Circle()
                        .strokeBorder(.tertiary, lineWidth: 1)
                        .frame(width: Layout.dotSize, height: Layout.dotSize)
                        .accessibilityHidden(true)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                // The list is the record, and for a row with no screen to open the only place its words show: never cut.
                Text(row.title)
                    .textStep(.title)
                if let detail = row.detail, !detail.isEmpty {
                    Text(detail)
                        .textStep(.meta)
                }
            }
            Spacer(minLength: 8)
            // The stamp step in `label`, as the Outbox's stamps: tertiary measured 1.7:1 on white.
            Text(DigestModel.when(row, now: now, day: day))
                .textStep(.stamp, tint: Color(.label))
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .contentShape(Rectangle())
        // At the title: the mark column's hidden line is the row's first text, which the list would start it at.
        .separatorAtTextEdge(Layout.glyphWidth + Layout.markWidth + Layout.rowGap)
    }
}

/// A day's head on the one gray step, as the Outbox's bands: the words alone.
private struct DayHeader: View {
    let title: String

    var body: some View {
        // Explicit ink, never the hierarchical steps: inside a list's section header those measured 1.7:1 on the
        // chrome fill in light (the Outbox's BandHeader).
        Text(title)
            .textStep(.meta, weight: .semibold, tint: Color(.label))
            .lineLimit(1)
            .padding(.horizontal, Layout.textEdge)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
            .background(Surface.chrome)
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The rows' shape while the first read is out.
private struct DigestSkeleton: View {
    var body: some View {
        Section {
            ForEach(0..<4, id: \.self) { i in
                HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                    FirstLineMark {
                        Circle()
                            .fill(.quaternary)
                            .frame(width: Layout.dotSize, height: Layout.dotSize)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(i.isMultiple(of: 2) ? "Budget review starts soon" : "A routine finished its run").textStep(.title)
                        Text("Placeholder detail").textStep(.meta)
                    }
                    Spacer(minLength: 8)
                    Text("8:00 AM").textStep(.stamp)
                }
                .padding(.vertical, Layout.rowVertical)
                .frame(minHeight: Layout.rowHeight + 8)
                .redacted(reason: .placeholder)
                .accessibilityHidden(true)
                .listRowInsets(Layout.rowInsets)
            }
        } header: {
            DayHeader(title: "Today")
                .redacted(reason: .placeholder)
                .accessibilityHidden(true)
                .listRowInsets(EdgeInsets())
        }
    }
}
