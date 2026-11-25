import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Messages for every job: a place of the Work tab (docs/IOS-DESIGN.md "Work on the phone", ### Messages). One row a
/// conversation, unread first, then the newest: the job's dot, the route's glyph, who, the last words and the time.
/// LifeOS's chat on LifeKit's live `chats:list`, one query a sector, on the whole LifeOS session (`LifeReach`), else
/// the picked job's own session; held only while the list is on screen. A row opens its conversation in the detail
/// (`Route.chat`); on the open Duo the first unread fills an empty detail.
struct MessagesScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    /// The filter's pick: a job's entry key, nil for All Jobs. Starts at the route's job.
    @State private var pick: String?
    @State private var refused: Set<String> = []
    let job: String?

    init(job: String?) {
        self.job = job
        _pick = State(initialValue: job)
    }

    var body: some View {
        let clients = model.registry.ordered.filter(\.work.isOn)
        let jobs = clients.flatMap { LifeReach.jobs(environmentId: $0.environment.id, workspaces: $0.workspaces) }
        let hosts = clients.map { LifeReach.Host(environmentId: $0.environment.id, name: $0.environment.name, open: $0.work.linked, key: $0.work.key) }
        let reach = LifeReach.reach(jobs: jobs, hosts: hosts, refused: refused)
        let offered = LifeReach.offered(reach, jobs: jobs)
        let all = LifeReach.offersAll(reach)
        let shown = LifeReach.pick(pick, jobs: jobs, offered: offered, all: all)
        let filter = offered.count > 1 ? offered.map { PlaceJob(id: $0.id, name: $0.name, sector: $0.sector) } : []
        Group {
            switch reach {
            case .unavailable(let why):
                ContentUnavailableView(WorkPlace.messages.title, systemImage: WorkPlace.messages.glyph, description: Text(why))
                    .navigationTitle(WorkPlace.messages.title)
            case .whole(let environmentId):
                if let client = model.registry.client(environmentId) {
                    MessagesList(
                        host: WorkLifeHost.every(client),
                        sectors: LifeReach.sectors(pick: shown, offered: offered),
                        jobs: offered,
                        showsJob: shown == nil,
                        job: job,
                        filter: filter,
                        pick: Binding(get: { shown }, set: { pick = $0 }),
                        all: all
                    )
                    .onChange(of: WorkLifeHost.every(client).refusedWhole, initial: true) { _, refusedNow in
                        if refusedNow { refused.insert(environmentId) }
                    }
                }
            case .perJob:
                if let picked = offered.first(where: { $0.id == shown }),
                   let client = model.registry.client(picked.environmentId),
                   let workspace = client.workspaces.first(where: { $0.id == picked.workspaceId }) {
                    MessagesList(
                        host: WorkLifeHost.of(client, workspace: workspace),
                        sectors: [picked.sector],
                        jobs: [picked],
                        showsJob: false,
                        job: job,
                        filter: filter,
                        pick: Binding(get: { shown }, set: { pick = $0 }),
                        all: all
                    )
                    .id(picked.id)
                }
            }
        }
        .task { MessagesPresses.shared.attach { [registry = model.registry] in registry.client($0) } }
        .accessibilityIdentifier("place-messages")
    }
}

/// The list on one LifeOS session: each sector's live page, joined and ordered.
private struct MessagesList: View {
    @Environment(ShellNavigator.self) private var navigator
    let host: WorkLifeHost
    let sectors: [String]
    let jobs: [LifeReach.Job]
    /// All Jobs: each row leads with its job's dot.
    let showsJob: Bool
    let job: String?
    let filter: [PlaceJob]
    let pick: Binding<String?>
    let all: Bool

    var body: some View {
        let store = host.store
        let pages = store.map { store in sectors.map { MessagesReads.list(store, sector: $0) } } ?? []
        let rows = Self.rows(pages)
        let ids = rows.map(\.id)
        WorkPlaceScreen(
            place: .messages,
            job: job,
            ids: ids,
            loading: Self.loading(host: host, pages: pages, rows: rows),
            empty: PlaceEmpty(title: "No Messages"),
            failure: Self.failure(host: host, pages: pages),
            retry: { await retry(pages) },
            jobs: filter,
            filter: filter.isEmpty ? nil : pick,
            refresh: { pages.forEach { $0.retryNow() } },
            pick: PlacePick(first: rows.filter(\.unread).map(\.id), rowOf: rowId) { id in
                if let route = route(rows.first { $0.id == id }) { navigator.open(route) }
            }
        ) {
            ForEach(rows) { row in
                ChatRowView(row: row, job: showsJob ? row.sector : nil, jobName: showsJob ? jobName(row.sector) : nil, selected: navigator.detailRoot != nil && navigator.detailRoot == route(row)) {
                    if let route = route(row) { navigator.open(route) }
                }
                .onAppear { if row.id == rows.last?.id { pages.forEach { $0.loadMore() } } }
                .swipeActions(edge: .leading) {
                    if let store {
                        Button(row.unread ? "Mark Read" : "Mark Unread", systemImage: row.unread ? "envelope.open" : "envelope.badge") {
                            let unread = row.unread
                            Task {
                                if unread { try? await MessagesReads.markRead(store, chatId: row.id) } else { try? await MessagesReads.markUnread(store, chatId: row.id) }
                            }
                        }
                        .tint(Color.accentColor)
                    }
                }
            }
        }
        .holdingChats(store, keys: pages.map(\.query.key))
        .task(id: ObjectIdentifier(host)) { await host.prepare() } // a fresh session from a parent redraw is asked for too
    }

    /// Where a conversation opens: on the host of the job that holds its sector, the signer's own first.
    private func route(_ row: ChatRow?) -> Route? {
        guard let row, let job = jobs.first(where: { $0.sector == row.sector }) else { return nil }
        return .chat(environmentId: job.environmentId, workspaceId: job.workspaceId, chatId: row.id)
    }

    /// A sector's job by its own name on this phone (the filter's), else the sector's.
    private func jobName(_ sector: String) -> String {
        filter.first { $0.sector == sector }?.name ?? TodayWords.sectorName(sector)
    }

    private func rowId(_ route: Route) -> String? {
        if case .chat(_, _, let chatId) = route { return chatId }
        return nil
    }

    private func retry(_ pages: [PagedQuery<ChatRow>]) async {
        if host.store == nil { return await host.prepare() }
        pages.forEach { $0.retryNow() }
    }

    static func rows(_ pages: [PagedQuery<ChatRow>]) -> [ChatRow] {
        #if DEBUG
        if MessagesFixtures.on { return MessagesRules.ordered(MessagesFixtures.rows) }
        #endif
        return MessagesRules.ordered(pages.flatMap(\.rows))
    }

    static func loading(host: WorkLifeHost, pages: [PagedQuery<ChatRow>], rows: [ChatRow]) -> Bool {
        #if DEBUG
        if MessagesFixtures.on { return false }
        #endif
        if case .unavailable = host.phase { return false }
        return host.store == nil || pages.contains(where: \.isLoading)
    }

    static func failure(host: WorkLifeHost, pages: [PagedQuery<ChatRow>]) -> String? {
        #if DEBUG
        if MessagesFixtures.on { return nil }
        #endif
        if case .unavailable(let why) = host.phase { return why }
        return pages.contains(where: \.hasFailed) ? "LifeOS did not answer." : nil
    }
}

/// One conversation's row: the job's dot on All Jobs, the route's glyph, who (semibold while unread), the last words
/// under it, and the time.
struct ChatRowView: View {
    /// The route glyph's column grows with the glyph it holds, so at the largest sizes it never runs into the name.
    @ScaledMetric(relativeTo: .footnote) private var glyph = Layout.glyphWidth
    @Environment(\.dynamicTypeSize) private var typeSize
    let row: ChatRow
    /// The job's sector, when the list holds every job's rows.
    let job: String?
    /// The job's name on All Jobs, said first to VoiceOver as Today and Review say it (the dot is hidden from it).
    var jobName: String? = nil
    let selected: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            // At accessibility sizes the words wrap and the time goes under them (Today's rule).
            let large = typeSize.isAccessibilitySize
            HStack(alignment: large ? .firstTextBaseline : .center, spacing: Layout.rowGap) {
                HStack(spacing: Layout.rowGap) {
                    Circle()
                        .fill(job.map { Tint.sector($0) } ?? .clear)
                        .frame(width: Layout.dotSize, height: Layout.dotSize)
                        .frame(width: Layout.markWidth)
                    Image(systemName: ChatGlyph.of(row.source))
                        .textStep(.meta)
                        .frame(width: glyph)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .textStep(.title, weight: row.unread ? .semibold : .regular)
                        .lineLimit(large ? 3 : 1)
                    Text(MessagesRules.rowLine(row))
                        .textStep(.meta)
                        .lineLimit(large ? 4 : 2)
                    if large { stamp }
                }
                if !large {
                    Spacer(minLength: Layout.rowGap)
                    stamp
                }
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + Layout.rowVertical)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .placeSelected(selected)
        .rowInitProbe(work: row.id)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityIdentifier("chat-row")
    }

    private var stamp: some View {
        Text(TimeFormat.stamp(Int(row.lastAt)))
            .textStep(.stamp, weight: row.unread ? .semibold : .regular, tint: row.unread ? Color.accentColor : nil)
            .lineLimit(1)
    }

    private var label: String { MessagesRules.rowLabel(row, job: jobName) }
}

/// A conversation's route glyph. No brand marks: a channel's number sign for Slack, the rest by what they are.
enum ChatGlyph {
    static func of(_ source: ChatSource) -> String {
        switch source {
        case .slack: "number"
        case .discord: "gamecontroller"
        case .imessage: "message"
        case .teams: "person.3"
        case .other: "bubble.left"
        }
    }
}
