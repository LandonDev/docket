import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every host with Work on, as the digest's rules read them.
@MainActor
enum DigestHosts {
    static func of(_ clients: [EnvironmentClient]) -> [EnvironmentClient] {
        clients.filter(\.work.isOn)
    }

    static func inputs(_ clients: [EnvironmentClient]) -> [DigestModel.HostInput] {
        of(clients).map { client in
            DigestModel.HostInput(environmentId: client.environment.id, name: client.environment.name, ledger: client.work.digest.ledger, error: client.work.digest.error)
        }
    }
}

/// Home's Digest row, after the Outbox while any host has Work on. No count:
/// the day's notice says how many, and the list is the record.
struct DigestHomeRow: View {
    @Environment(ShellNavigator.self) private var navigator
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { navigator.open(.digest) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                Image(systemName: DigestScreen.glyph)
                    .font(TextStep.title.font.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: icon, height: icon)
                Text("Digest")
                    .textStep(.title, weight: .medium)
                Spacer(minLength: 8)
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("home-digest")
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
        List {
            if sections.isEmpty && screen.reading {
                DigestSkeleton()
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        DigestRow(entry: entry, now: now)
                    }
                } header: {
                    DayHeader(title: section.title)
                        .listRowInsets(EdgeInsets())
                }
            }
            if !screen.silent.isEmpty {
                Section {
                    ForEach(screen.silent, id: \.self) { name in
                        Text(DigestModel.silentLine(name))
                            .textStep(.meta)
                            .listRowInsets(Layout.rowInsets)
                            .listRowSeparator(.hidden)
                            .accessibilityIdentifier("digest-host-silent")
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if sections.isEmpty && !screen.reading && screen.silent.isEmpty {
                ContentUnavailableView("Nothing Waited", systemImage: Self.glyph, description: Text(DigestModel.emptyLine(now: now)))
            }
        }
        .refreshable { await load(hosts) }
        // The first open reads every host; from then on the pushes keep each ledger.
        .task { await load(hosts.filter { $0.work.digest.ledger == nil }) }
        // What he has on screen is seen: at the open, and for a day made while he looks.
        .task(id: screen.days.filter { $0.seenAt == nil }.map(\.day)) { await markSeen(screen.days) }
        .navigationTitle("Digest")
        .shellTitleDisplay()
        .listOnScreen(Self.listId)
        .accessibilityIdentifier("digest")
    }

    private func load(_ hosts: [EnvironmentClient]) async {
        await withTaskGroup(of: Void.self) { group in
            for client in hosts {
                group.addTask { @MainActor in await client.work.digest.load() }
            }
        }
    }

    private func markSeen(_ days: [DigestModel.Day]) async {
        for call in DigestModel.seenCalls(days) {
            await model.registry.client(call.environmentId)?.work.digest.seen(call.day)
        }
    }
}

/// One tell: the job's dot (a muted ring for a row about no one job), the
/// title, the detail under it, the time at the end. A row the phone has a
/// route for is a button; one it has none for is not.
private struct DigestRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let entry: DigestModel.Entry
    let now: Date

    private var row: TellRow { entry.row }

    var body: some View {
        if let route = DigestModel.route(row.open, environmentId: entry.environmentId) {
            Button { navigator.open(route) } label: { content }
                .buttonStyle(.pressable)
                .listRowInsets(Layout.rowInsets)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("digest-row")
        } else {
            content
                .listRowInsets(Layout.rowInsets)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("digest-row")
        }
    }

    private var content: some View {
        HStack(alignment: .center, spacing: Layout.rowGap) {
            Group {
                if row.sector != nil {
                    SectorDot(sector: row.sector, size: Layout.dotSize)
                } else {
                    Circle()
                        .strokeBorder(.tertiary, lineWidth: 1)
                        .frame(width: Layout.dotSize, height: Layout.dotSize)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: Layout.glyphWidth + Layout.markWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .textStep(.title)
                    .lineLimit(2)
                if let detail = row.detail, !detail.isEmpty {
                    Text(detail)
                        .textStep(.meta)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            // The stamp step in `label`, as the Outbox's stamps: tertiary measured 1.7:1 on white.
            Text(DigestModel.when(row, now: now))
                .textStep(.stamp, tint: Color(.label))
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .contentShape(Rectangle())
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
                HStack(spacing: Layout.rowGap) {
                    Circle()
                        .fill(.quaternary)
                        .frame(width: Layout.dotSize, height: Layout.dotSize)
                        .frame(width: Layout.glyphWidth + Layout.markWidth)
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
