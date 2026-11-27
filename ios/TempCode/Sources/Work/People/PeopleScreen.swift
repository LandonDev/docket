import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// People for every job: a place of the Work tab (docs/IOS-DESIGN.md "Work on the phone", ### People). One row a
/// person, newest contact first: the job's dot (All Jobs), the name, their first address. LifeOS's
/// `people:directory`, one live query a sector, on the whole LifeOS session (`LifeReach`), else the picked job's
/// own; held only while the list is on screen. Search keeps the people every typed word is in. A row opens their
/// page in the detail (`Route.person`).
struct PeopleScreen: View {
    @Environment(AppModel.self) private var model
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
        let picked = Binding(get: { shown }, set: { pick = $0 })
        Group {
            switch reach {
            case .unavailable(let why):
                ContentUnavailableView(WorkPlace.people.title, systemImage: WorkPlace.people.glyph, description: Text(why))
                    .navigationTitle(WorkPlace.people.title)
            case .whole(let environmentId):
                if let client = model.registry.client(environmentId) {
                    PeopleList(host: WorkLifeHost.every(client), sectors: LifeReach.sectors(pick: shown, offered: offered), jobs: offered,
                               showsJob: shown == nil, job: job, filter: filter, pick: picked)
                        .onChange(of: WorkLifeHost.every(client).refusedWhole, initial: true) { _, refusedNow in
                            if refusedNow { refused.insert(environmentId) }
                        }
                }
            case .perJob:
                if let chosen = offered.first(where: { $0.id == shown }),
                   let client = model.registry.client(chosen.environmentId),
                   let workspace = client.workspaces.first(where: { $0.id == chosen.workspaceId }) {
                    PeopleList(host: WorkLifeHost.of(client, workspace: workspace), sectors: [chosen.sector], jobs: [chosen],
                               showsJob: false, job: job, filter: filter, pick: picked)
                        .id(chosen.id)
                }
            }
        }
        .accessibilityIdentifier("place-people")
    }
}

/// The list on one LifeOS session: each sector's directory, joined, each person once.
private struct PeopleList: View {
    @Environment(ShellNavigator.self) private var navigator
    let host: WorkLifeHost
    let sectors: [String]
    let jobs: [LifeReach.Job]
    let showsJob: Bool
    let job: String?
    let filter: [PlaceJob]
    let pick: Binding<String?>
    @State private var query = ""

    var body: some View {
        let store = host.store
        let pages = store.map { store in sectors.map { (sector: $0, query: PeopleReads.directory(store, sector: $0)) } } ?? []
        let everyone = Self.people(pages)
        let rows = PeopleRules.find(everyone, query)
        let failed = LifeosDownPress(host: host).row(Self.failure(host: host, pages: pages.map(\.query))) { await retry(pages.map(\.query)) }
        WorkPlaceScreen(
            place: .people,
            job: job,
            ids: rows.map(\.id),
            loading: Self.loading(host: host, pages: pages.map(\.query)),
            empty: query.isEmpty ? PlaceEmpty(title: "No People") : PlaceEmpty(title: "No Results", line: "No one here is called “\(query)”."),
            failure: failed.words,
            // Try Again only where asking again can help; a sign-in opens Connections on the job's computer, as Mail's does.
            retry: failed.retry,
            press: failed.press,
            jobs: filter,
            filter: filter.isEmpty ? nil : pick,
            search: $query,
            refresh: { pages.forEach { $0.query.retryNow() } }
        ) {
            ForEach(rows) { person in
                let route = route(person)
                PersonRow(person: person, job: showsJob ? person.sector : nil, selected: route != nil && navigator.detailRoot == route) {
                    if let route { navigator.open(route) }
                }
            }
        }
        .holdingChats(store, keys: pages.map(\.query.key))
        .task(id: ObjectIdentifier(host)) { await host.prepare() } // a fresh session from a parent redraw is asked for too
    }

    /// A person opens in the job that holds their sector, the signer's own first.
    private func route(_ person: DirectoryPerson) -> Route? {
        guard let job = jobs.first(where: { $0.sector == person.sector }) else { return nil }
        return .person(environmentId: job.environmentId, workspaceId: job.workspaceId, personId: person.id)
    }

    private func retry(_ queries: [LiveQuery<[DirectoryPerson]>]) async {
        if host.store == nil { return await host.prepare() }
        queries.forEach { $0.retryNow() }
    }

    static func people(_ pages: [(sector: String, query: LiveQuery<[DirectoryPerson]>)]) -> [DirectoryPerson] {
        #if DEBUG
        if PeopleFixtures.on { return PeopleRules.directory([("", PeopleFixtures.people)]) }
        #endif
        return PeopleRules.directory(pages.map { ($0.sector, $0.query.value ?? []) })
    }

    static func loading(host: WorkLifeHost, pages: [LiveQuery<[DirectoryPerson]>]) -> Bool {
        #if DEBUG
        if PeopleFixtures.on { return false }
        #endif
        if case .unavailable = host.phase { return false }
        return host.store == nil || pages.contains(where: \.isLoading)
    }

    static func failure(host: WorkLifeHost, pages: [LiveQuery<[DirectoryPerson]>]) -> String? {
        #if DEBUG
        if PeopleFixtures.on { return nil }
        #endif
        if case .unavailable(let why) = host.phase { return why }
        return pages.contains(where: \.hasFailed) ? "LifeOS did not answer." : nil
    }
}

/// One person: the job's dot on All Jobs, the name, their first address under it.
private struct PersonRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let person: DirectoryPerson
    let job: String?
    let selected: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            // The job's dot in the mark column, on the name's line, where Today, the Outbox and the Digest draw it.
            HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                FirstLineMark {
                    if let job { SectorDot(sector: job) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    // At accessibility sizes the name wraps, so two people stay told apart. The address keeps one line,
                    // never hyphenated inside it ("dana@cos-micgames"): it shrinks to fit whole, to half its size, and
                    // past that gives up its middle, as a person's page says it.
                    Text(person.name)
                        .textStep(.title)
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    if let line = PeopleRules.rowLine(person) {
                        Text(line)
                            .textStep(.meta)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .minimumScaleFactor(typeSize.isAccessibilitySize ? 0.5 : 1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        // At the name: the dot's hidden line is the row's first text, which the list would start it at.
        .separatorAtTextEdge(Layout.glyphWidth + Layout.markWidth + Layout.rowGap)
        .placeSelected(selected)
        // Dragged onto a Work thread's box on the open Duo, the person is its chip there.
        .modifier(ChipDragSource(chip: RowChips.person(id: person.id, name: person.name)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel([person.name, PeopleRules.rowLine(person)].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("person-row")
    }
}
