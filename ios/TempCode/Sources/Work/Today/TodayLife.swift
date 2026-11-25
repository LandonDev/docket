import Foundation
import LifeKit
import TempCodeClient
import TempCodeContract

/// LifeOS's part of Today, read through LifeKit (docs/IOS-DESIGN.md "Today"): one session for every job, where the
/// places for every job read (`LifeReach.reach`: the Work home's whole-session token, else the next open host
/// that holds a job, `WorkLifeHost.every`). A sector that session does not cover (`auth:caller`, `lackingOf`) is
/// read through its job's own narrowed session on another host (`WorkLifeHost.of`), and one nothing covers is
/// said (`uncoveredOf`). A key the whole session is refused to reads each job through its own session.
///
/// Tasks and events are the stores' own lists (kept for the session, shared with Tasks and Agenda). The rest
/// (mail waits, the session's cover, the people of each sector) are Today's own live queries, held only while
/// Today is on screen (`hold`/`releaseAll`) and dropped by LifeKit half a minute after: no poll, ever.
@MainActor
enum TodayLife {
    /// One session Today reads through.
    private struct Reader {
        var environmentId: String
        var host: WorkLifeHost
        /// The sectors this reader gives rows for; nil: every sector the session covers.
        var sectors: Set<String>?
        /// Its host said its LifeOS is still connecting (`work.lifeos.status`).
        var connecting = false
    }

    /// The hosts passed over for the whole session while another reads the day.
    private static var passed = LifeReach.PassedOver()

    /// The queries Today holds now, by registry and key.
    private static var held: [(live: LiveRegistry, key: String)] = []
    private static var onScreen = false

    /// What Today's rest proof counts: its own live queries now, and how many it needs.
    static var queriesAlive: [String] { held.map(\.key) }
    private(set) static var queriesNeeded = 0

    /// Today came on screen (true) or left it: its own queries are held or let go.
    static func onScreen(_ on: Bool) {
        onScreen = on
        guard !on else { return }
        for (live, key) in held { live.release(key) }
        held = []
    }

    /// LifeOS's lists for the jobs as they stand; nil while Today is off screen (the store keeps what it had).
    static func input(_ clients: [EnvironmentClient]) -> TodayLifeInput? {
        guard onScreen else { return nil }
        let workClients = clients.filter(\.work.isOn)
        let jobs = workClients.flatMap { LifeReach.jobs(environmentId: $0.environment.id, workspaces: $0.workspaces) }
        let hosts = workClients.map { LifeReach.Host(environmentId: $0.environment.id, open: $0.work.linked, mayToken: $0.work.may(.lifeosJwt)) }
        let refused = Set(workClients.filter { WorkLifeHost.every($0).refusedWhole }.map(\.environment.id))
        // A whole session known down gives way to the next host's (the desktop's `pickHost`). It is made again here when
        // its host says LifeOS connected (`prepared`), but takes the day back only once the host read in its place is
        // down (`passed`, the desktop's `tried`).
        let downNow = Set(workClients.filter { client in
            let host = WorkLifeHost.every(client)
            guard case .unavailable = host.phase, self.down(host) != nil else { return false }
            _ = prepared(host, client)
            return true
        }.map(\.environment.id))
        let holding = Set(jobs.map(\.environmentId))
        let signers = hosts.filter { $0.open && $0.mayToken && holding.contains($0.environmentId) && !refused.contains($0.environmentId) }.map(\.environmentId)
        let down = passed.update(signers: signers, down: downNow)
        var needed = 0
        defer { queriesNeeded = needed }
        switch LifeReach.reach(jobs: jobs, hosts: hosts, refused: refused, down: down) {
        case .unavailable:
            // No host linked yet, but one is on its first try (a cold launch, a return from the background): the store
            // keeps what LifeOS last gave, so no section blanks while it links.
            if workClients.contains(where: { !$0.work.linked && TodayFeed.open($0) }) { return nil }
            let anyOpen = hosts.contains { host in host.open && jobs.contains { $0.environmentId == host.environmentId } }
            return TodayLifeInput(host: "", reach: anyOpen ? .down(.withheld) : .offline)
        case .whole(let environmentId):
            guard let client = workClients.first(where: { $0.environment.id == environmentId }) else { return nil }
            let main = Reader(environmentId: environmentId, host: prepared(WorkLifeHost.every(client), client), sectors: nil, connecting: connecting(client))
            var input = TodayLifeInput(host: environmentId, reach: reach(of: main))
            guard input.reach == .ok, let store = main.host.store else { return input }
            let (cover, coverPending) = coverOf(store)
            needed += store.isFixture ? 0 : 1
            let today = todayJobs(jobs, hosts: hosts)
            var readers = [main]
            for lacking in TodayModel.lackingOf(cover, today, host: environmentId) {
                guard let job = jobs.first(where: { $0.environmentId == lacking.environmentId && $0.sector == lacking.sector }),
                      let other = workClients.first(where: { $0.environment.id == job.environmentId }),
                      let workspace = other.workspaces.first(where: { $0.id == job.workspaceId }) else { continue }
                readers.append(Reader(environmentId: job.environmentId, host: prepared(WorkLifeHost.of(other, workspace: workspace), other), sectors: [job.sector], connecting: connecting(other)))
            }
            let uncovered = TodayModel.uncoveredOf(cover, today, host: environmentId)
            fill(&input, readers: readers, coverPending: coverPending, cover: cover, jobSectors: today.map(\.sector), uncovered: uncovered, host: environmentId, needed: &needed)
            return input
        case .perJob(let able):
            var readers: [Reader] = []
            for job in able {
                guard let client = workClients.first(where: { $0.environment.id == job.environmentId }),
                      let workspace = client.workspaces.first(where: { $0.id == job.workspaceId }) else { continue }
                readers.append(Reader(environmentId: job.environmentId, host: prepared(WorkLifeHost.of(client, workspace: workspace), client), sectors: [job.sector], connecting: connecting(client)))
            }
            // A job whose session is ready leads: a down first job never hides a healthy one's day, and is said in its
            // own scoped line (`fill`'s lost reads). With none ready, the first says the reach, never bones for good.
            if let ready = readers.firstIndex(where: { reach(of: $0) == .ok }), ready > 0 { readers.insert(readers.remove(at: ready), at: 0) }
            guard let first = readers.first else { return TodayLifeInput(host: "", reach: .offline) }
            var input = TodayLifeInput(host: first.environmentId, reach: reach(of: first))
            guard input.reach == .ok else { return input }
            let covered = Set(able.map(\.sector))
            let uncovered = Array(Set(jobs.map(\.sector)).subtracting(covered)).sorted()
            fill(&input, readers: readers, coverPending: false, cover: nil, jobSectors: jobs.map(\.sector), uncovered: uncovered, host: first.environmentId, needed: &needed)
            return input
        }
    }

    /// The session a LifeOS row's writes go through: the one that read it (`TodaySources.sessionOf`), on the host that
    /// supplied it; nil while that session is not up, never another host's. A row with no supplier (a chat, an older
    /// kept row) goes by its sector.
    static func store(for row: TodayRow, _ clients: [EnvironmentClient]) -> LifeStore? {
        guard let session = TodaySources.sessionOf(row) else { return store(for: row.sector, clients) }
        guard let client = clients.first(where: { $0.environment.id == session.environmentId && $0.work.isOn }) else { return nil }
        if let sector = session.sector {
            guard let workspace = client.workspaces.first(where: { $0.kind == .work && $0.sector == sector }) else { return nil }
            return WorkLifeHost.of(client, workspace: workspace).store
        }
        return WorkLifeHost.every(client).store
    }

    /// The session a row of `sector` is written through: its job's own, where one is up, else the whole session's.
    static func store(for sector: String?, _ clients: [EnvironmentClient]) -> LifeStore? {
        let workClients = clients.filter(\.work.isOn)
        if let sector {
            for client in workClients {
                guard let workspace = client.workspaces.first(where: { $0.kind == .work && $0.sector == sector }) else { continue }
                if let store = WorkLifeHost.of(client, workspace: workspace).store { return store }
            }
        }
        return workClients.lazy.compactMap { WorkLifeHost.every($0).store }.first
    }

    // MARK: - reading

    /// Each session made again once per time its host said LifeOS connected, by that connect's moment.
    private static var retriedAt: [ObjectIdentifier: Double] = [:]

    /// The session, being made where it is not yet. A refusal stands until the host says its LifeOS is connected
    /// (a Mac that woke with LifeOS still connecting): then it is made again, once for that connect.
    private static func prepared(_ host: WorkLifeHost, _ client: EnvironmentClient) -> WorkLifeHost {
        if host.store == nil, host.phase == .loading { Task { await host.prepare() } }
        if case .unavailable = host.phase, case .connected(let up)? = client.work.lifeos?.lifeos, retriedAt[ObjectIdentifier(host)] != up.since {
            retriedAt[ObjectIdentifier(host)] = up.since
            Task { await host.prepare() }
        }
        return host
    }

    /// A refused session in the desktop's words (`downOf`), by the state the host refused with; nil for a wait (its
    /// LifeOS still connecting). The host's own silence, or a state this build does not know, is unanswered.
    private static func down(_ host: WorkLifeHost) -> TodayDown? {
        switch host.refusedState {
        case "connecting"?: nil
        case "signed-out"?: .signedOut
        case "pairing"?: .pairing
        case "refused"?: .refused
        case "off"?: .off
        case "unreachable"?: .unreachable
        default: .unanswered
        }
    }

    /// A LifeOS failure's Retry: every Work host's whole session asks its queries again (`.lifeos`), or the one job's
    /// own session on its host (`.lost`), made again where it is down.
    static func retry(_ retry: TodayRetry, _ clients: [EnvironmentClient]) async {
        let workClients = clients.filter(\.work.isOn)
        switch retry {
        case .lifeos:
            // The whole session and each job's own, as the per-job reach reads through those.
            for client in workClients {
                await again(WorkLifeHost.every(client))
                for workspace in client.workspaces where workspace.kind == .work && workspace.sector != nil {
                    WorkLifeHost.of(client, workspace: workspace).store?.live.retryAll()
                }
            }
        case .lost(let environmentId, let sector, _):
            guard let client = workClients.first(where: { $0.environment.id == environmentId }) else { return }
            if let sector, let workspace = client.workspaces.first(where: { $0.kind == .work && $0.sector == sector }) {
                await again(WorkLifeHost.of(client, workspace: workspace))
            } else {
                await again(WorkLifeHost.every(client))
            }
        case .each(let all):
            for one in all { await self.retry(one, clients) }
        case .host:
            break
        }
    }

    /// One session asked again: its queries, or the session made again where it never came up.
    private static func again(_ host: WorkLifeHost) async {
        if let store = host.store { store.live.retryAll() } else { await host.prepare() }
    }

    private static func connecting(_ client: EnvironmentClient) -> Bool {
        if case .connecting? = client.work.lifeos?.lifeos { return true }
        return false
    }

    private static func reach(of reader: Reader) -> TodayModel.LifeosReach {
        switch reader.host.phase {
        case .loading: return reader.connecting ? .connecting : .waiting
        case .ready: return .ok
        // Its true state: a wait while the host's LifeOS is connecting, else the state it refused with.
        case .unavailable:
            guard let state = down(reader.host) else { return .connecting }
            return .down(state)
        }
    }

    /// The jobs as Today's model names them.
    private static func todayJobs(_ jobs: [LifeReach.Job], hosts: [LifeReach.Host]) -> [TodayWorkspace] {
        jobs.map { job in TodayWorkspace(environmentId: job.environmentId, workspaceId: job.workspaceId, sector: job.sector, name: job.name, open: hosts.first { $0.environmentId == job.environmentId }?.open == true) }
    }

    /// The session's cover: every sector, or these; nil while `auth:caller` is out.
    private static func coverOf(_ store: LifeStore) -> (TodayCover?, pending: Bool) {
        #if DEBUG
        if store.isFixture { return (.all, false) }
        #endif
        let caller = hold(store.live, store.live.query("auth:caller", as: JSONValue.self))
        guard case .object(let fields)? = caller.value else { return (nil, caller.failure == nil) }
        switch fields["sectors"] {
        case .string("all")?: return (.all, false)
        case .array(let list)?: return (.sectors(list.compactMap { if case .string(let s) = $0 { s } else { nil } }), false)
        default: return (.all, false)
        }
    }

    /// Every reader's events, tasks and mail waits merged by id into `input`, with what is still out and what failed.
    private static func fill(_ input: inout TodayLifeInput, readers: [Reader], coverPending: Bool, cover: TodayCover?, jobSectors: [String], uncovered: [String], host: String, needed: inout Int) {
        var events: [TodaySources.Event] = [], tasks: [TodaySources.Task] = [], waits: [TodaySources.Wait] = []
        var seen = (events: Set<String>(), tasks: Set<String>(), waits: Set<String>())
        var eventsRead = TodaySources.LifeosRead(), tasksRead = TodaySources.LifeosRead(), waitsRead = TodaySources.LifeosRead()
        // Each list's leading answer, and whether another reader answered it: a lead's failure never hides those rows.
        var leadEvents = TodaySources.LeadAnswer.pending, leadTasks = TodaySources.LeadAnswer.pending, leadWaits = TodaySources.LeadAnswer.pending
        var otherEvents = false, otherTasks = false, otherWaits = false
        // The projects' names, for Due's second line, merged from every reader whose names came; which sectors came
        // whole follows the desktop's `known` (`TodaySources.namesKnown`).
        var projects: [TodaySources.Project]?, projectsFailed = false
        var wholeNames = false, namesCame = Set<String>(), namesUnsure = Set(uncovered)
        // The whole session's sectors, once its cover is in: its display filter starts empty, so it is never read.
        let covered: [String]? = switch cover {
        case .all?: jobSectors
        case .sectors(let list)?: list
        case nil: nil
        }
        var lost: [TodaySources.Lost] = uncovered.map { TodaySources.Lost(environmentId: host, sector: $0, error: TodaySources.notCovered) }
        var people: [String: [TodaySources.Person]] = [:]
        for (index, reader) in readers.enumerated() {
            let first = index == 0
            let keeps = { (sector: String?) in reader.sectors.map { $0.contains(sector ?? "") } ?? true }
            guard let store = reader.host.store else {
                if case .unavailable = reader.host.phase, !first, let state = down(reader.host) {
                    lost.append(TodaySources.Lost(environmentId: reader.environmentId, sector: reader.sectors?.first, error: "down", down: state))
                } else if !first, reader.connecting || reader.host.refusedState == "connecting" {
                    // A known wait on that host's LifeOS: said once for the page with what it leaves out, no press.
                    lost.append(TodaySources.Lost(environmentId: reader.environmentId, sector: reader.sectors?.first, error: "", waits: true))
                } else {
                    eventsRead.pending = true
                    tasksRead.pending = true
                    waitsRead.pending = true
                }
                if !first { namesUnsure.formUnion(reader.sectors ?? []) }
                continue
            }
            // The sectors this host's own narrowed session reads: its sign-out takes those alone (`lifeosSignedOut`).
            if let sectors = reader.sectors { input.narrowed[reader.environmentId, default: []] += sectors.sorted() }
            // Events: the store's own window, a week back to the end of tomorrow.
            let eventsQuery = store.events
            if let value = eventsQuery.value {
                if first { leadEvents = .answered } else { otherEvents = true }
                for e in recode([TodaySources.Event].self, value) ?? [] where keeps(e.sector) && seen.events.insert(e.id).inserted { events.append(e) }
            } else if let failure = eventsQuery.failure {
                if first { leadEvents = .failed(String(describing: failure)) } else { lost.append(TodaySources.Lost(environmentId: reader.environmentId, sector: reader.sectors?.first, error: String(describing: failure))) }
            } else if !first { eventsRead.pending = true }
            let tasksQuery = store.tasks
            if let value = tasksQuery.value {
                if first { leadTasks = .answered } else { otherTasks = true }
                for t in recode([TodaySources.Task].self, value) ?? [] where keeps(t.sector) && seen.tasks.insert(t.id).inserted { tasks.append(t) }
            } else if let failure = tasksQuery.failure {
                if first { leadTasks = .failed(String(describing: failure)) } else { lost.append(TodaySources.Lost(environmentId: reader.environmentId, sector: reader.sectors?.first, error: String(describing: failure))) }
            } else if !first { tasksRead.pending = true }
            let projectsQuery = store.projects
            if let value = projectsQuery.value {
                let read = (recode([TodaySources.Project].self, value) ?? []).filter { keeps($0.sector) }
                projects = (projects ?? []) + read.filter { one in !(projects ?? []).contains { $0.id == one.id } }
                if let sectors = reader.sectors { namesCame.formUnion(sectors) } else { wholeNames = true }
            } else {
                if projectsQuery.failure != nil { projectsFailed = true }
                if !first { namesUnsure.formUnion(reader.sectors ?? []) }
            }
            // Mail no one answered: one page of up to a hundred; more past it is `beyond`.
            let (page, failure) = waitsOf(store, needed: &needed)
            if let page {
                if first { leadWaits = .answered } else { otherWaits = true }
                for w in page.rows where keeps(w.sector ?? w.ownSector) && seen.waits.insert(w.id).inserted { waits.append(w) }
                if page.more { input.beyond = true }
            } else if let failure {
                if first { leadWaits = .failed(failure) } else { lost.append(TodaySources.Lost(environmentId: reader.environmentId, sector: reader.sectors?.first, error: failure)) }
            } else if !first { waitsRead.pending = true }
            for sector in reader.sectors.map(Array.init) ?? covered ?? Array(Set(store.sectors.map(\.rawValue))) {
                people[sector, default: []] += peopleOf(store, sector: sector, needed: &needed)
            }
        }
        if coverPending { eventsRead.pending = true; tasksRead.pending = true; waitsRead.pending = true }
        eventsRead.lost = lost
        tasksRead.lost = lost
        waitsRead.lost = lost
        // The leading reader's own lost read names its job, where it has one.
        let lead = readers.first
        let leadLost = { (error: String) in TodaySources.Lost(environmentId: lead?.environmentId ?? host, sector: lead?.sectors?.first, error: error) }
        let haveEvents = TodaySources.settle(lead: leadEvents, othersAnswered: otherEvents, read: &eventsRead, leadLost: leadLost)
        let haveTasks = TodaySources.settle(lead: leadTasks, othersAnswered: otherTasks, read: &tasksRead, leadLost: leadLost)
        let haveWaits = TodaySources.settle(lead: leadWaits, othersAnswered: otherWaits, read: &waitsRead, leadLost: leadLost)
        input.events = haveEvents ? events : nil
        input.tasks = haveTasks ? tasks : nil
        input.waits = haveWaits ? waits : nil
        input.eventsRead = eventsRead
        input.tasksRead = tasksRead
        let known = TodaySources.namesKnown(whole: wholeNames, cover: coverPending ? nil : cover, jobs: jobSectors, unsure: namesUnsure, came: namesCame)
        input.projects = TodaySources.ProjectNames(rows: projects, known: known, failed: projectsFailed)
        input.waitsRead = waitsRead
        input.people = people
    }

    nonisolated private struct WaitPage: Codable, Equatable, Sendable {
        var page: [JSONValue]
        var isDone: Bool
    }

    private static func waitsOf(_ store: LifeStore, needed: inout Int) -> (page: (rows: [TodaySources.Wait], more: Bool)?, failure: String?) {
        #if DEBUG
        if store.isFixture { return ((TodayFixtures.waits(now: store.clock.now), false), nil) }
        #endif
        needed += 1
        let args: Args = ["paginationOpts": .object(["numItems": .number(100), "cursor": .null])]
        let query = hold(store.live, store.live.query("mailWaits:list", args, as: WaitPage.self))
        if let value = query.value { return ((recode([TodaySources.Wait].self, value.page) ?? [], !value.isDone), nil) }
        return (nil, query.failure.map { String(describing: $0) })
    }

    private static func peopleOf(_ store: LifeStore, sector: String, needed: inout Int) -> [TodaySources.Person] {
        #if DEBUG
        if store.isFixture { return [] }
        #endif
        needed += 1
        let query = hold(store.live, store.live.query("people:directory", ["sector": .string(sector)], as: [JSONValue].self))
        return query.value.flatMap { recode([TodaySources.Person].self, $0) } ?? []
    }

    /// Holds a query of Today's own while Today is on screen, once.
    private static func hold<Value>(_ live: LiveRegistry, _ query: LiveQuery<Value>) -> LiveQuery<Value> {
        if !held.contains(where: { $0.live === live && $0.key == query.key }) {
            live.hold(query.key)
            held.append((live, query.key))
        }
        return query
    }

    /// A LifeKit value read as the port's input (the same JSON the desktop reads).
    private static func recode<Out: Decodable>(_ type: Out.Type, _ value: some Encodable) -> Out? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(Out.self, from: data)
    }
}

#if DEBUG
/// LifeKit's fixture day answers no mail waits: Today's proof gets one of its own, on the same day.
enum TodayFixtures {
    static func waits(now: Date) -> [TodaySources.Wait] {
        let json = """
        [{"_id": "fx-wait-1", "subject": "Travel budget for nationals", "sector": "purdue",
          "waiting": {"since": \(now.addingTimeInterval(-6 * 86_400).timeIntervalSince1970 * 1000), "dueAt": \(now.addingTimeInterval(-86_400).timeIntervalSince1970 * 1000),
                      "asked": true, "to": [{"name": "Dana Lee", "address": "dana@example.com"}]}}]
        """
        return (try? JSONDecoder().decode([TodaySources.Wait].self, from: Data(json.utf8))) ?? []
    }
}
#endif
