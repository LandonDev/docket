import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Tasks or Agenda for every job: a place of the Work tab (M1c). LifeKitUI's own screen, as a job's page
/// draws it, on the whole LifeOS session the Work home (else the first open host that holds a job) signs,
/// with the job filter in the bar narrowing it by sector. Where no host will sign the whole session the place
/// reads per job, one job at a time, and the filter has no All Jobs; with no host that can sign at all, one
/// line says why. Which host and which sectors is the client package's `LifeReach`.
struct LifePlaceScreen: View {
    @Environment(AppModel.self) private var model
    let view: LifeViewScreen.Kind
    /// The filter's pick: a job's entry key, nil for All Jobs. Starts at the route's job.
    @State private var pick: String?
    /// Hosts that would not sign the whole session this run.
    @State private var refused: Set<String> = []

    init(view: LifeViewScreen.Kind, job: String?) {
        self.view = view
        _pick = State(initialValue: job)
    }

    var body: some View {
        let clients = model.registry.ordered.filter(\.work.isOn)
        let jobs = clients.flatMap { LifeReach.jobs(environmentId: $0.environment.id, workspaces: $0.workspaces) }
        let hosts = clients.map { LifeReach.Host(environmentId: $0.environment.id, open: $0.work.linked, mayToken: $0.work.may(.lifeosJwt)) }
        let reach = LifeReach.reach(jobs: jobs, hosts: hosts, refused: refused)
        let offered = LifeReach.offered(reach, jobs: jobs)
        let all = LifeReach.offersAll(reach)
        let shown = LifeReach.pick(pick, jobs: jobs, offered: offered, all: all)
        Group {
            switch reach {
            case .unavailable(let why):
                ContentUnavailableView(view.title, systemImage: view.symbol, description: Text(why))
                    .navigationTitle(view.title)
                    .navigationBarTitleDisplayMode(.inline)
            case .whole(let environmentId):
                if let client = model.registry.client(environmentId) {
                    let host = WorkLifeHost.every(client)
                    let narrowing = Narrowing(
                        sectors: LifeReach.sectors(pick: shown, offered: offered),
                        jobs: Dictionary(jobs.filter { $0.environmentId == environmentId }.map { ($0.sector, $0.workspaceId) }, uniquingKeysWith: { first, _ in first })
                    )
                    LifeViewScreen(host: host, view: view)
                        // Before the store is made, so the first one already shows the pick.
                        .onChange(of: narrowing, initial: true) {
                            host.jobs = narrowing.jobs
                            host.narrow(to: narrowing.sectors.compactMap(Sector.init(rawValue:)))
                        }
                        .onChange(of: host.refusedWhole, initial: true) {
                            if host.refusedWhole { refused.insert(environmentId) }
                        }
                }
            case .perJob:
                if let job = offered.first(where: { $0.id == shown }),
                   let client = model.registry.client(job.environmentId),
                   let workspace = client.workspaces.first(where: { $0.id == job.workspaceId }) {
                    LifeViewScreen(host: WorkLifeHost.of(client, workspace: workspace), view: view)
                        .id(job.id)
                }
            }
        }
        .toolbar {
            // One job to show needs no filter.
            if offered.count > 1 {
                ToolbarItem(placement: .primaryAction) {
                    JobFilter(
                        jobs: offered.map { PlaceJob(id: $0.id, name: $0.name, sector: $0.sector) },
                        pick: Binding(get: { shown }, set: { pick = $0 }),
                        all: all
                    )
                }
            }
        }
        .accessibilityIdentifier("place-\(view.rawValue)")
    }

    /// What the every-job host shows and where its threads start, as one value the screen follows.
    private struct Narrowing: Equatable {
        var sectors: [String]
        var jobs: [String: String]
    }
}
