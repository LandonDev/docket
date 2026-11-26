import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every linked host's Connections (`work.health`, `work.lapses`), read when the Work list shows and at most once a
/// few minutes unless he asks again: the Work list's foot shows Connections while one does not work or an end is
/// near (`Connections.needsHim`).
@MainActor @Observable
final class ConnectionsFeed {
    static let shared = ConnectionsFeed()

    private(set) var hosts: [Connections.Host] = []
    /// Each Work host whose checks are not fresh on screen, and why: away, its read failed, or its ends did not come.
    private(set) var missed: [String: Connections.Missed] = [:]
    /// When each host's rows were read: a host missed since keeps them, said with this time.
    private(set) var readAtOf: [String: Date] = [:]
    private(set) var reading = false
    /// A read has ended once: before it the place draws its rows' shape, never "Nothing to Check".
    private(set) var hasRead = false
    @ObservationIgnored private var readAt: Date?
    /// The hosts the last read could ask: one whose link opens after it is read then, whatever the time.
    @ObservationIgnored private var askedLast: Set<String> = []
    /// How long a read stands before the Work list asks again: each check runs every pillar's own.
    @ObservationIgnored private let stands: TimeInterval = 5 * 60

    var needsHim: Bool { Connections.needsHim(hosts) }

    /// Each host with Work on whose key may read it; `fresh` is his own Check Again, which the hosts check anew. A host
    /// not connected is missed, never left out: the place names it and keeps what it said last.
    func read(_ clients: [EnvironmentClient], fresh: Bool = false) async {
        let work = clients.filter { $0.work.isOn && $0.work.may(.health) }
        let linked = Set(work.filter(\.work.linked).map(\.environment.id))
        if !fresh, let readAt, Date().timeIntervalSince(readAt) < stands, linked.isSubset(of: askedLast) { return }
        guard !reading else { return }
        reading = true
        defer { reading = false }
        readAt = Date()
        askedLast = linked
        var next: [Connections.Host] = []
        var misses: [String: Connections.Missed] = [:]
        for client in work {
            let id = client.environment.id
            let kept = hosts.first(where: { $0.id == id })
            guard client.work.linked else {
                misses[id] = .away
                if let kept { next.append(kept) }
                continue
            }
            do {
                let report = try await client.work.health(fresh: fresh)
                var lapses: [LapsePhone] = []
                if client.work.may(.lapses) {
                    do {
                        lapses = try await client.work.lapses()
                    } catch {
                        // The ends it said last stay, and the line says they did not come this time.
                        misses[id] = .lapses
                        lapses = kept?.lapses ?? []
                    }
                }
                next.append(.init(id: id, name: client.environment.name, report: report, lapses: lapses))
                readAtOf[id] = Date()
            } catch {
                // A host that did not answer keeps the rows it last gave, with its words above them.
                // In Work's words, never the host's raw text (`WorkErrorWords`); none says only that it did not answer.
                misses[id] = .failed(WorkErrorWords.say(ActionError.wrap(error).message, host: client.environment.name))
                if let kept { next.append(kept) }
            }
        }
        hosts = next
        missed = misses
        hasRead = true
    }
}

/// Connections, a place of the Work tab's foot (docs/IOS-DESIGN.md "A job's small places"): each host's sign-ins
/// and helpers by group, a row its state's word and the host's one line, a known end inside two weeks as its own
/// section. A row that does not work offers "Open on <computer>" (`work.reveal`, Settings → Connections there): every
/// fix a host names works in that computer's own window or browser. Pull to check again.
struct ConnectionsScreen: View {
    @Environment(AppModel.self) private var model
    private var feed: ConnectionsFeed { .shared }
    @State private var revealing: String?

    var body: some View {
        let clients = model.registry.ordered
        let sections = Connections.sections(feed.hosts)
        let ending = Connections.ending(feed.hosts)
        let ids = sections.flatMap { $0.rows.map(\.id) } + ending.map(\.key)
        WorkPlaceScreen(
            place: .connections,
            ids: ids,
            loading: feed.reading || !feed.hasRead,
            empty: PlaceEmpty(title: "Nothing to Check", line: nil),
            failure: failure,
            retry: { await feed.read(clients, fresh: true) },
            refresh: { await feed.read(clients, fresh: true) }
        ) {
            if !ending.isEmpty {
                Section {
                    ForEach(ending, id: \.key) { end in
                        ConnectionRowView(title: end.lapse.title, line: Connections.lapseLine(until: end.lapse.until), word: nil, state: .needsYou, busy: false)
                            .id(end.key)
                    }
                } header: {
                    SectionHeader("Ending Soon")
                        .listRowInsets(EdgeInsets())
                }
            }
            ForEach(sections, id: \.group) { section in
                Section {
                    ForEach(section.rows) { row in
                        ConnectionRowView(title: row.title, line: row.line, word: Connections.word(row.state), state: row.state, busy: revealing == row.id)
                            .id(row.id)
                            .contextMenu { revealButton(row, clients) }
                            .swipeActions(edge: .trailing) { revealButton(row, clients) }
                            .accessibilityActions { revealButton(row, clients) }
                    }
                } header: {
                    SectionHeader(section.group)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        // Read again when a host's link opens: a read made before it said nothing of that host.
        .task(id: clients.filter(\.work.linked).map(\.environment.id)) { await feed.read(clients) }
    }

    /// Every host missed, in one line (`Connections.missedLine`), with when the rows kept for it were read.
    private var failure: String? {
        let missed = feed.missed.compactMap { id, why -> (name: String, why: Connections.Missed, keptAt: String?)? in
            guard let name = model.registry.client(id)?.environment.name else { return nil }
            let kept = feed.hosts.contains { $0.id == id } && why != .lapses ? feed.readAtOf[id]?.formatted(date: .omitted, time: .shortened) : nil
            return (name, why, kept)
        }
        return Connections.missedLine(missed.sorted { $0.name < $1.name })
    }

    @ViewBuilder private func revealButton(_ row: Connections.Row, _ clients: [EnvironmentClient]) -> some View {
        if Connections.reveals(row), let client = clients.first(where: { $0.environment.id == row.hostId }), client.work.may(.reveal),
           // Settings → Connections there: the host asks admin for a Settings target (reveal.ts), beyond reveal.
           client.environment.caps.contains(.admin) {
            Button("Open on \(client.environment.name)", systemImage: "desktopcomputer") {
                Task { await reveal(row, client) }
            }
        }
    }

    private func reveal(_ row: Connections.Row, _ client: EnvironmentClient) async {
        revealing = row.id
        defer { revealing = nil }
        do {
            try await client.work.reveal(RevealTarget(settings: .connections))
            FleetToastCenter.shared.post(note: "Opened on \(client.environment.name)")
        } catch {
            FleetToastCenter.shared.post(message: ActionError.wrap(error).message)
        }
    }
}

/// One connection: its title, the host's one line under it, its state's word trailing (Broken and Needs you in their
/// inks, Ready muted).
private struct ConnectionRowView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let line: String?
    let word: String?
    let state: HealthRowPhone.State
    let busy: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).textStep(.title).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                if let line { Text(line).textStep(.meta).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView().controlSize(.small)
            } else if let word {
                Text(word).textStep(.stamp, weight: state == .working ? .regular : .semibold, tint: tint)
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight)
        .contentShape(Rectangle())
        // The house row's insets, so its text edge and the headers' band line up with every other Work place.
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
    }

    private var tint: Color? {
        switch state {
        case .working: nil
        case .needsYou: Tint.warningText
        case .broken, .unknown: Tint.destructiveText
        }
    }
}
