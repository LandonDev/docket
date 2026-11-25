import Foundation
import Observation
import TempCodeContract

/// One host as Today reads it: what the phone already keeps of it (the Outbox's items, the digest's rows, the
/// catalog's workspaces, the push counters), taken whole each time it changes.
public struct TodayHostInput: Hashable, Sendable {
    /// The counters a Work push moves (`WorkHost`), by workspace where the push names one.
    public struct Revs: Hashable, Sendable {
        public var messages: [String: Int] = [:]
        public var money: [String: Int] = [:]
        public var prep: [String: Int] = [:]
        public var msforms: [String: Int] = [:]
        public var clashes = 0
        public var review = 0
        public init() {}
    }

    public var environmentId: String
    public var name: String
    public var workOn: Bool
    /// Its link is open, or its first one is still being made: no foot line says it is offline yet.
    public var open: Bool
    /// A live socket: only then does Today read it (nothing goes out before the first frame).
    public var linked: Bool
    public var workspaces: [WorkspaceMeta]
    public var held: [OutboxItem]
    /// The threads' open requests on this host: one Held row each, over the items it lists.
    public var requests: [OutboxRequest]
    /// The titles of the threads that asked, by session id, where the phone knows them.
    public var threads: [String: String]
    public var heldLoaded: Bool
    public var heldError: String?
    /// The digest's rows; nil until its ledger was read on this socket.
    public var tells: [TellRow]?
    public var tellsError: String?
    public var revs: Revs
    /// Where this host's Today rows are kept on the phone's disk.
    public var key: WorkCache.Key
    /// The host refused this key: nothing of it is read, shown or kept until it is paired again.
    public var revoked: Bool

    public init(environmentId: String, name: String, workOn: Bool, open: Bool, linked: Bool? = nil, workspaces: [WorkspaceMeta], held: [OutboxItem] = [], requests: [OutboxRequest] = [], threads: [String: String] = [:], heldLoaded: Bool = false, heldError: String? = nil, tells: [TellRow]? = nil, tellsError: String? = nil, revs: Revs = Revs(), key: WorkCache.Key, revoked: Bool = false) {
        self.environmentId = environmentId
        self.name = name
        self.workOn = workOn
        self.open = open
        self.linked = linked ?? open
        self.workspaces = workspaces
        self.held = held
        self.requests = requests
        self.threads = threads
        self.heldLoaded = heldLoaded
        self.heldError = heldError
        self.tells = tells
        self.tellsError = tellsError
        self.revs = revs
        self.key = key
        self.revoked = revoked
    }

    /// The Today key of a paired host: its key's id as the account, the pairing's moment as its generation, so a key
    /// paired again starts a new generation and the old rows go.
    public static func key(_ environment: PairedEnvironment) -> WorkCache.Key {
        WorkCache.Key(host: environment.id, account: environment.keyId, keyGeneration: Int(environment.addedAt), scope: .today)
    }
}

/// LifeOS's part of Today, read through LifeKit by the app (no LifeKit here): the one session's lists, already
/// merged with any narrowed session's, and their read states.
public struct TodayLifeInput: Hashable, Sendable {
    /// The host whose session it is ("" while none).
    public var host: String
    public var reach: TodayModel.LifeosReach
    public var events: [TodaySources.Event]?
    public var eventsRead = TodaySources.LifeosRead()
    public var tasks: [TodaySources.Task]?
    public var tasksRead = TodaySources.LifeosRead()
    /// The projects' names, for a Due row's second line: a row waits for none of them.
    public var projects = TodaySources.ProjectNames(rows: nil)
    public var waits: [TodaySources.Wait]?
    public var waitsRead = TodaySources.LifeosRead()
    /// Past the fifth page LifeOS still said there was more.
    public var beyond = false
    /// The sectors each host's own narrowed session read (a job's session beside the whole one, or every job's in
    /// the per-job reach), so a sign-out on that host takes those sectors alone.
    public var narrowed: [String: [String]] = [:]
    public var people: [String: [TodaySources.Person]] = [:]

    public init(host: String, reach: TodayModel.LifeosReach) {
        self.host = host
        self.reach = reach
    }

    /// The session is down: the page's one line says it, never a section.
    public var sessionDown: Bool {
        if case .down = reach { return true }
        return false
    }
}

/// The reads Today makes of a host, each one request; the app's `WorkHost` answers them.
@MainActor
public protocol TodayHostReads: AnyObject, Sendable {
    func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat]
    func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed
    func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form]
    func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting]
    func todayReview() async throws -> TodaySources.ReviewReady?
    func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange
    /// The digest's ledger, read once when nothing read it on this socket yet.
    func todayDigest() async
    /// The Outbox's list and the digest's ledger read again: a Retry on Held's or Also's line.
    func todayRelist() async
}

public extension TodayHostReads {
    func todayRelist() async {}
}

/// Today's reads and its page, one per app (docs/IOS-DESIGN.md "Today"). It takes what the phone already holds
/// (`update(hosts:)`, `update(life:)`), reads each host's own lists once and again on their pushes and at
/// midnight, and builds the page with `TodayModel.page`. The first page comes from the disk (`cache`) before any
/// read: each source shows its kept rows until it answers whole, and a read that fails keeps what shows. A fresh
/// page keeps every row whose facts did not change as the value it was (`keepRows`), so its row is not made again.
@MainActor @Observable
public final class TodayStore {
    /// The page the screen draws; nil before anything is known.
    public private(set) var page: TodayModel.Page?
    /// The Work list's line ("Budget sync at 2:00 PM", else what is due; `TodayModel.workListLine`).
    public private(set) var line: String?
    /// Every row on the page is from the disk: no source that shows a row has answered whole on this launch yet. A
    /// press on such a row opens its thing to read; its verbs wait for the fresh row (`isFresh`).
    public private(set) var cached = false
    public private(set) var folds = TodayModel.Folds()

    @ObservationIgnored public var readsOf: (String) -> TodayHostReads? = { _ in nil }
    /// How long a host's read may take before it fails with "It did not answer in time" (the desktop's six seconds).
    @ObservationIgnored public var deadline: Duration = .seconds(6)
    /// What a read that ran out of time fails with (the desktop's `TIMED_OUT`).
    public static let timedOut = "It did not answer in time"

    /// A LifeOS failure's Retry (`.lifeos`, `.lost`): the app asks LifeKit's queries again (no LifeKit here).
    @ObservationIgnored public var retryLife: @MainActor (TodayRetry) async -> Void = { _ in }
    @ObservationIgnored public var calendar: Calendar
    @ObservationIgnored public private(set) var now: Double
    /// Keys his acts took off the page (a ticked task) while their sources still give them.
    @ObservationIgnored public private(set) var gone: Set<String> = []
    /// The keys the last fresh page kept as the value they were.
    @ObservationIgnored public private(set) var keptKeys: Set<String> = []
    /// Each source's reads made, for a test and the rest proof: never a poll.
    @ObservationIgnored public private(set) var readsMade = 0

    @ObservationIgnored private let cache: TodayRowsCache
    /// The hosts as given, a revoked one among them.
    @ObservationIgnored private var given: [TodayHostInput] = []
    /// The hosts Today reads: those given whose key stands.
    @ObservationIgnored private var hosts: [TodayHostInput] = []
    /// Each host's purges: a read that left before the last one answers into nothing.
    @ObservationIgnored private var epoch: [String: Int] = [:]
    /// How far he read each chat from Today, by a Mark read that went through (the desktop's `readTo`): a host that
    /// is behind keeps an older copy of the chat, and that copy is not waiting on him.
    @ObservationIgnored private var readTo: [String: Double] = [:]
    @ObservationIgnored private var life: TodayLifeInput?
    @ObservationIgnored private var seeded = false
    /// Each source's last whole answer (the disk's rows until it answers on this launch).
    @ObservationIgnored private var whole: [String: TodayAnswer] = [:]
    /// The disk's rows of the sources a host's own socket feeds, by source. A host's rows of a source stay on the page
    /// until that host's own part of the source answers without error on this launch, whether it sleeps, connects or
    /// failed (a read that fails keeps what shows): no row leaves and comes back while it links.
    @ObservationIgnored private var disk: [String: [TodayRow]] = [:]
    /// The keys on the page that are an offline host's disk rows: they open to read and are pressed only once fresh.
    @ObservationIgnored private var diskKeys: Set<String> = []
    static let hostSources: Set<String> = ["held", "digest", "messages", "money", "msforms"]
    /// The sources that answered whole on this launch.
    @ObservationIgnored private var answered: Set<String> = []
    /// The sources whose rows on the page are still an earlier answer (the disk's, or one read again).
    @ObservationIgnored private var keptSources: Set<String> = []
    @ObservationIgnored private var chats = JobReads<[TodaySources.Chat]>()
    @ObservationIgnored private var owed = JobReads<TodaySources.Owed>()
    @ObservationIgnored private var forms = JobReads<[TodaySources.Form]>()
    @ObservationIgnored private var prep = JobReads<[TodaySources.PrepMeeting]>()
    @ObservationIgnored private var review = JobReads<TodaySources.ReviewReady?>()
    @ObservationIgnored private var clashes = JobReads<TodaySources.ClashRange>()
    /// The counter each read last ran at, by "<source>|<host>|<workspace>".
    @ObservationIgnored private var ranAt: [String: Int] = [:]
    @ObservationIgnored private var openBefore: Set<String> = []
    @ObservationIgnored private var digestAsked: Set<String> = []
    @ObservationIgnored private var written: [WorkCache.Key: [TodayRow]] = [:]
    @ObservationIgnored private var saidCached = false
    @ObservationIgnored private var saidFresh = false
    @ObservationIgnored private var day: (from: Double, to: Double)

    public init(cache: TodayRowsCache, calendar: Calendar = .autoupdatingCurrent, now: Double = Date().timeIntervalSince1970 * 1000) {
        self.cache = cache
        self.calendar = calendar
        self.now = now
        day = TodayModel.dayBounds(now, calendar: calendar)
    }

    // MARK: - inputs

    /// The hosts as the phone holds them now. The first call paints the disk's rows; each later one reads what a
    /// push or a link that opened asks for, drops the kept rows of a host whose Work went off or that left, and
    /// builds the page again.
    ///
    /// A host whose key was refused, that left, whose Work went off or whose key was replaced is purged: its rows and
    /// answers go from memory and disk, and a read of it still out answers into nothing (`purge`).
    public func update(hosts next: [TodayHostInput]) {
        guard next != given || !seeded else { return }
        let before = given
        given = next
        hosts = next.filter { !$0.revoked }
        var purges: [(String, WorkCacheDrop)] = []
        for was in before where !next.contains(where: { $0.environmentId == was.environmentId }) {
            purges.append((was.environmentId, .hostRemoved(host: was.environmentId)))
        }
        for host in next {
            let was = before.first { $0.environmentId == host.environmentId }
            if host.revoked {
                if was?.revoked != true { purges.append((host.environmentId, .capabilityLost(host: host.environmentId))) }
            } else if let was, was.workOn, !host.workOn {
                purges.append((host.environmentId, .workOff(host: host.environmentId)))
            } else if let was, was.key.keyGeneration != host.key.keyGeneration {
                purges.append((host.environmentId, .keyReplaced(host: host.environmentId, generation: host.key.keyGeneration)))
            }
        }
        for (host, reason) in purges { purge(host, reason) }
        if !seeded {
            seeded = true
            seed(hosts.filter(\.workOn).map(\.key))
        }
        readWhatChanged()
        rebuild()
    }

    /// Everything of one host goes: its kept rows on disk and in memory, its answers, what was written of it, and the
    /// reads of it still out (`epoch`).
    private func purge(_ host: String, _ reason: WorkCacheDrop) {
        epoch[host, default: 0] += 1
        cache.drop(reason)
        // The disk's drop rewrote other hosts' keys and refused every Today write queued before it: each linked host is
        // written again, not only this one.
        written = reason.supplier == nil ? written.filter { $0.key.host != host } : [:]
        chats.forget(host)
        owed.forget(host)
        forms.forget(host)
        prep.forget(host)
        review.forget(host)
        clashes.forget(host)
        // Its rows wherever they are, and the LifeOS rows its session supplied under any host's key: a refused,
        // removed, off or re-keyed host's reads are facts this key may no longer see (`WorkCacheDrop.supplier`).
        for (source, answer) in whole {
            var kept = answer
            kept.rows = answer.rows.map { rows in WorkCache.withoutLifeos(rows.filter { WorkCache.hostOf($0) != host }, suppliedBy: host) }
            whole[source] = kept
        }
        disk = disk.mapValues { WorkCache.withoutLifeos($0.filter { WorkCache.hostOf($0) != host }, suppliedBy: host) }
        forgetInput(of: host)
        ranAt = ranAt.filter { !$0.key.contains("|\(host)|") }
        openBefore.remove(host)
        digestAsked.remove(host)
    }

    /// What a host's LifeOS session gave the held input goes with the host: its whole session's input, or the sectors
    /// its narrowed session read. The app's next input reads through a host that still may.
    private func forgetInput(of host: String) {
        guard var next = life else { return }
        if next.host == host {
            life = nil
            return
        }
        guard let sectors = next.narrowed[host], !sectors.isEmpty else { return }
        let gone = Set(sectors)
        next.events = next.events?.filter { !gone.contains($0.sector) }
        next.tasks = next.tasks?.filter { !gone.contains($0.sector) }
        next.waits = next.waits?.filter { !gone.contains($0.sector ?? $0.ownSector ?? "") }
        next.narrowed[host] = nil
        life = next
    }

    /// LifeOS's lists as the app read them through LifeKit.
    public func update(life next: TodayLifeInput) {
        guard next != life else { return }
        let hostMoved = next.host != life?.host
        life = next
        if hostMoved { readClashes(force: true) }
        forgetSignedOut(next)
        rebuild()
    }

    /// The host said its LifeOS signed out, heard whether or not Today shows: what its sessions gave goes now, before
    /// any later input. A narrowed session's sectors go alone; the whole session's host takes every LifeOS row.
    public func lifeosSignedOut(host: String) {
        // What that host's session gave, kept under any host's key (a row opens where its job is, not where it was
        // read), and rows kept before a supplier was known: out of memory now, whatever input comes next.
        for source in Self.lifeosSources {
            guard var kept = whole[source], let rows = kept.rows else { continue }
            let left = WorkCache.withoutLifeos(rows, suppliedBy: host)
            guard left.count != rows.count else { continue }
            kept.rows = left
            whole[source] = kept
        }
        // The disk's drop refuses every Today write queued before it, whichever host it was for
        // (`WorkCacheStore.todayStamp`): every linked host is written again, with or without a row gone here.
        written = [:]
        guard let life else { return rebuild() }
        if let sectors = life.narrowed[host], !sectors.isEmpty {
            let gone = Set(sectors)
            var next = life
            next.events = life.events?.filter { !gone.contains($0.sector) }
            next.tasks = life.tasks?.filter { !gone.contains($0.sector) }
            next.waits = life.waits?.filter { !gone.contains($0.sector ?? $0.ownSector ?? "") }
            let lost = sectors.map { TodaySources.Lost(environmentId: host, sector: $0, error: "signed out", down: .signedOut) }
            next.eventsRead.lost += lost
            next.tasksRead.lost += lost
            next.waitsRead.lost += lost
            next.narrowed[host] = nil
            update(life: next)
        } else if life.host == host {
            update(life: TodayLifeInput(host: host, reach: .down(.signedOut)))
        } else {
            rebuild()
        }
    }

    /// Each LifeOS row stamped with the host whose session read it: a narrowed session's for its sectors, else the
    /// whole session's.
    private func supplied(_ answer: TodayAnswer, _ life: TodayLifeInput) -> TodayAnswer {
        guard let rows = answer.rows else { return answer }
        var out = answer
        out.rows = rows.map { row in
            var stamped = row
            let narrowed = row.sector.flatMap { sector in life.narrowed.first { $0.value.contains(sector) }?.key }
            stamped.suppliedBy = narrowed ?? life.host
            stamped.suppliedScope = narrowed == nil ? nil : row.sector
            return stamped
        }
        return out
    }

    /// The LifeOS sources, whose rows a signed-out session no longer stands behind.
    static let lifeosSources = ["meetings", "due", "waiting"]

    /// LifeOS says it is signed out, for every job (the page's line) or for some jobs (their lost reads), on any
    /// transition, one first heard at a link among them: what it gave of those jobs goes from memory, so a later load
    /// never paints it as kept, and every host is written again without it.
    private func forgetSignedOut(_ life: TodayLifeInput) {
        let everyJob = life.reach == .down(.signedOut)
        let lost = [life.eventsRead, life.tasksRead, life.waitsRead].flatMap(\.lost).filter { $0.down == .signedOut }
        let sectors = Set(lost.compactMap(\.sector))
        guard everyJob || !sectors.isEmpty else { return }
        var dropped = false
        for source in Self.lifeosSources {
            guard var kept = whole[source], let rows = kept.rows else { continue }
            let left = rows.filter { row in !everyJob && !(row.sector.map(sectors.contains) ?? false) }
            guard left.count != rows.count else { continue }
            kept.rows = left
            whole[source] = kept
            dropped = true
        }
        if dropped { written = [:] }
    }

    /// The minute moved: the rows' times are said again; past midnight the day's reads run again. `ifMoved`: nothing
    /// is built when the minute is the one the page was built at (the feed's tick on every change of its inputs).
    public func tick(now next: Double, ifMoved: Bool = false) {
        // Before the first page the day is set, so the disk's rows are read for the day it is.
        if !seeded {
            now = next
            day = TodayModel.dayBounds(next, calendar: calendar)
            return
        }
        if ifMoved, Int(next / 60_000) == Int(now / 60_000) { return }
        now = next
        let turned = TodayModel.dayBounds(next, calendar: calendar)
        if turned.from != day.from {
            day = turned
            ranAt = [:]
            // Kept rows of the day before (Also's tells) are not today's.
            disk = disk.mapValues { $0.filter { !WorkCache.ofTheDay.contains($0.section) } }
            readWhatChanged()
        }
        rebuild()
    }

    /// Pull to refresh: every host's lists asked again, and the answers waited for.
    public func refresh() async {
        ranAt = [:]
        await withDiscardingTaskGroup { group in
            for read in reads() { group.addTask { await read() } }
        }
    }

    /// A failure's Retry: that host's reads alone, or each of several.
    public func retry(_ retry: TodayRetry) async {
        switch retry {
        case .host(let environmentId):
            ranAt = ranAt.filter { !$0.key.contains("|\(environmentId)|") }
            // Held's and Also's own lists too, as the desktop's `loadHost`.
            if let reads = readsOf(environmentId) { await reads.todayRelist() }
            await withDiscardingTaskGroup { group in
                for read in reads(only: environmentId) { group.addTask { await read() } }
            }
        case .each(let all):
            for one in all { await self.retry(one) }
        case .lifeos, .lost:
            // LifeKit's own queries ask again (the app's `retryLife`); the app's reads hear them.
            await retryLife(retry)
        }
    }

    /// A Mark read from a row went through: an older copy of the chat from a host that is behind makes no row.
    public func markedRead(chatId: String, at: Double) {
        readTo[chatId] = max(at, readTo[chatId] ?? -.infinity)
        rebuild()
    }

    // MARK: - his acts on the page

    /// "N more" or "N earlier" opened; stays open for the launch.
    public func unfold(_ key: String) {
        guard let (which, section) = TodayModel.foldOf(key) else { return }
        switch which {
        case .more: folds.more.insert(section)
        case .earlier: folds.earlier.insert(section)
        }
        rebuild()
    }

    /// A row his act took off (a ticked task): it leaves now, before LifeOS says so.
    public func hide(_ key: String) {
        gone.insert(key)
        rebuild()
    }

    /// Undo: the row comes back.
    public func unhide(_ key: String) {
        gone.remove(key)
        rebuild()
    }

    /// The row was read on this launch, its source's answer is whole and on the page: its verbs may be pressed. A
    /// row from the disk (or from an answer being read again) opens its thing to read and is pressed only once fresh.
    public func isFresh(_ row: TodayRow) -> Bool {
        let source = Self.source(of: row)
        return answered.contains(source) && !keptSources.contains(source) && !diskKeys.contains(row.key)
    }

    /// The source that makes a row's section's rows.
    static func source(of row: TodayRow) -> String {
        row.section == TodayModel.also.id ? (row.key.hasPrefix("review:") ? "review" : "digest") : row.section
    }

    // MARK: - the page

    /// The jobs: every Work workspace with a sector on a host with Work on.
    public var jobs: [TodayWorkspace] {
        let catalog = hosts.flatMap { host in
            host.workspaces.map { TodayModel.CatalogRow(id: $0.id, environmentId: host.environmentId, name: $0.name, path: $0.path, kind: $0.kind?.rawValue, sector: $0.sector) }
        }
        return TodayModel.jobsOf(catalog, workHosts: Set(hosts.filter(\.workOn).map(\.environmentId)), openHosts: openHosts)
    }

    /// The host the one LifeOS session reads through ("" while none): the page's connecting line names it.
    public var lifeHost: String { life?.host ?? "" }

    private var openHosts: Set<String> { Set(hosts.filter(\.open).map(\.environmentId)) }
    private var linkedHosts: Set<String> { Set(hosts.filter(\.linked).map(\.environmentId)) }

    /// The page again from every source's answer now.
    private func rebuild() {
        let jobs = jobs
        var fed: [TodayFed] = []
        var keptNow = Set<String>()
        var allWhole = true
        var asleepKeys = Set<String>()
        for (id, _) in TodayModel.sources {
            var fresh = answer(id, jobs: jobs)
            // An offline host's kept rows stay with an answer the others gave: its foot line says why they are old.
            // Once a host's own part of the source answered, its kept rows of it are done with: a later failed read
            // keeps what that answer gave, never brings back a row the host has since let go.
            if var kept = disk[id] {
                kept.removeAll { row in rowAnswered(id, row, jobs: jobs) }
                disk[id] = kept
            }
            if let rows = fresh.rows, let kept = disk[id] {
                let have = Set(rows.map(\.key))
                // One row a conversation: a kept copy of a chat a fresh row gives, or one he read to, makes none.
                let chats = Set(rows.compactMap { if case .chat(_, let chatId)? = $0.open { chatId } else { nil } })
                let extra = kept.filter { row in
                    guard let host = WorkCache.hostOf(row), !have.contains(row.key) else { return false }
                    if case .chat(_, let chatId)? = row.open, chats.contains(chatId) || -(row.at ?? 0) <= (readTo[chatId] ?? -.infinity) { return false }
                    return hosts.contains { $0.environmentId == host && $0.workOn } && !rowAnswered(id, row, jobs: jobs)
                }.map(sayAgain)
                fresh.rows = rows + extra
                asleepKeys.formUnion(extra.map(\.key))
            }
            // Still out and never answered on this launch: no rows yet, so the kept ones show.
            if fresh.loading, !answered.contains(id), fresh.rows?.isEmpty != false { fresh.rows = nil }
            if !fresh.loading, fresh.rows != nil { answered.insert(id) }
            let (shown, kept) = TodayModel.kept(had: whole[id], answer: fresh)
            if kept { keptNow.insert(id) }
            if !fresh.loading, fresh.rows != nil { whole[id] = fresh }
            if fresh.loading { allWhole = false }
            fed.append(TodayFed(source: id, section: TodaySources.section(of: id), answer: shown, kept: kept))
        }
        keptSources = keptNow
        diskKeys = asleepKeys
        gone = TodayModel.stillGiven(gone, fed.map(\.answer))
        let reach = life?.reach ?? (jobs.contains(where: \.open) ? .waiting : .offline)
        let built = Self.namingRefused(TodayModel.page(fed, jobs: jobs, lifeos: reach, folds: folds, gone: gone, open: openHosts),
                                       given.filter { $0.revoked && $0.workOn }.map(\.environmentId))
        let (stable, kept) = Self.stable(built, previous: page)
        let fresh = !answered.isEmpty
        if fresh { keptKeys = kept }
        if stable != page { page = stable }
        let nextLine = TodayModel.workListLine(stable, now: now, calendar: calendar)
        if nextLine != line { line = nextLine }
        let shownRows = Self.rows(stable)
        let fromDisk = !shownRows.isEmpty && !shownRows.contains(where: isFresh)
        if fromDisk != cached { cached = fromDisk }
        if fromDisk, !saidCached {
            saidCached = true
            Signposts.list.event("today.cached")
        }
        if allWhole, !saidFresh {
            saidFresh = true
            Signposts.list.event("today.fresh")
        }
        if fresh { keep(fed) }
    }

    /// A host whose key was refused is named at the foot with the offline ones, and the page is never All Clear over
    /// what it may hold (the desktop names a closed link the same way).
    static func namingRefused(_ page: TodayModel.Page, _ refused: [String]) -> TodayModel.Page {
        guard !refused.isEmpty else { return page }
        // Said in its own words at the foot, never "offline"; and a host that held every job leaves the line, not
        // "No Jobs Yet".
        switch page {
        case .noJobs, .clear: return .day(blocks: [.refused(refused)], offline: [], keys: [])
        case .day(let blocks, let offline, let keys): return .day(blocks: blocks + [.refused(refused)], offline: offline.filter { !refused.contains($0) }, keys: keys)
        }
    }

    /// Each section's rows of `next`, with every row that shows what it showed before kept as the value it was.
    static func stable(_ next: TodayModel.Page, previous: TodayModel.Page?) -> (page: TodayModel.Page, kept: Set<String>) {
        let before = previous.map(rows) ?? []
        guard case .day(let blocks, let offline, let keys) = next else { return (next, []) }
        var kept = Set<String>()
        let out = blocks.map { block -> TodayModel.Block in
            guard case .section(var s) = block else { return block }
            let held = TodayModel.keepRows(before, s.rows)
            kept.formUnion(held.kept)
            s.rows = held.rows
            return .section(s)
        }
        return (.day(blocks: out, offline: offline, keys: keys), kept)
    }

    /// Every row a page shows.
    public static func rows(_ page: TodayModel.Page?) -> [TodayRow] {
        guard case .day(let blocks, _, _)? = page else { return [] }
        return blocks.flatMap { block -> [TodayRow] in
            if case .section(let s) = block { s.rows } else { [] }
        }
    }

    /// The disk's rows, each into the source that makes its section's rows, as that source's last whole answer.
    private func seed(_ keys: [WorkCache.Key]) {
        let rows = cache.todayRows(keys, day: TodayWords.localDay(now, calendar))
        guard !rows.isEmpty else { return }
        var bySource: [String: [TodayRow]] = [:]
        for row in rows { bySource[Self.source(of: row), default: []].append(row) }
        for (source, list) in bySource {
            whole[source] = TodayAnswer(rows: list)
            if Self.hostSources.contains(source) { disk[source] = list }
        }
    }

    /// Whether `host`'s own part of `source` answered whole, without error, on this launch.
    private func hostAnswered(_ source: String, _ host: String, jobs: [TodayWorkspace]) -> Bool {
        guard let input = hosts.first(where: { $0.environmentId == host }) else { return false }
        func each<V>(_ reads: JobReads<V>) -> Bool {
            let mine = jobs.filter { $0.environmentId == host }
            // No job known yet (a cold launch before the catalog lands) is not an answer.
            return !mine.isEmpty && mine.allSatisfy { reads.values[$0.place] != nil && reads.failed[$0.place] == nil }
        }
        switch source {
        case "held": return input.heldLoaded && input.heldError == nil
        case "digest": return input.tells != nil && input.tellsError == nil
        case "messages": return each(chats)
        case "money": return each(owed)
        case "msforms": return each(forms)
        default: return true
        }
    }

    /// Whether the read that gives this kept row answered without error on this launch: a job's read by the row's own
    /// job (one job of a host that failed never brings back a row another job let go), Held and Also by its host.
    private func rowAnswered(_ source: String, _ row: TodayRow, jobs: [TodayWorkspace]) -> Bool {
        func answered<V>(_ reads: JobReads<V>, _ place: TodayPlace) -> Bool { reads.values[place] != nil && reads.failed[place] == nil }
        switch (source, row.open) {
        case ("messages", .chat(let place, _)?): return answered(chats, place)
        case ("money", .money(let place)?): return answered(owed, place)
        case ("msforms", .form(let place, _, _)?): return answered(forms, place)
        default: return WorkCache.hostOf(row).map { hostAnswered(source, $0, jobs: jobs) } ?? false
        }
    }

    /// A kept row's time said again from its moment, so a row kept this morning never reads a frozen clock.
    private func sayAgain(_ row: TodayRow) -> TodayRow {
        var out = row
        guard let at = row.at else { return out }
        switch row.section {
        case TodaySources.held.id: out.when = TodayWords.heldWhen(at, now: now, calendar)
        case TodaySources.messages.id: out.when = TodayWords.chatTime(-at, now: now, calendar)
        default: break
        }
        return out
    }

    /// Writes each host's rows to the disk when they changed: the merged rows of every source, folded or not.
    private func keep(_ fed: [TodayFed]) {
        let lifeosHost = life?.host ?? ""
        let rows = TodayModel.merge(fed, gone: gone).flatMap(\.rows)
        let byHost = WorkCache.todayByHost(rows, lifeosHost: lifeosHost)
        var out: [WorkCache.Key: [TodayRow]] = [:]
        // Only a host linked on this launch, source by source: what answered is written fresh, and a source that has
        // not answered (or fails) carries the kept rows laid on the page, so one list that always fails never stops
        // the rest being written, and an asleep host's rows on disk are what the next cold launch paints.
        for host in hosts where host.workOn && host.linked {
            let list = byHost[host.environmentId] ?? []
            if written[host.key] != list { out[host.key] = list }
        }
        guard !out.isEmpty else { return }
        for (key, list) in out { written[key] = list }
        cache.keepToday(out, day: TodayWords.localDay(now, calendar))
    }

    // MARK: - each source's answer

    private func answer(_ source: String, jobs: [TodayWorkspace]) -> TodayAnswer {
        let workHosts = hosts.filter(\.workOn)
        let names = Dictionary(hosts.flatMap { host in host.workspaces.map { (TodayPlace(environmentId: host.environmentId, workspaceId: $0.id), $0.name) } }, uniquingKeysWith: { a, _ in a })
        let byJobs = TodayJobs(jobs)
        switch source {
        case "held":
            let items = workHosts.flatMap { host in host.held.map { TodaySources.HeldItem(environmentId: host.environmentId, item: $0) } }
            let requests = workHosts.flatMap { host in
                host.requests.filter { $0.state == .open }.map { TodaySources.HeldRequest(environmentId: host.environmentId, request: $0, thread: host.threads[$0.sessionId]) }
            }
            let (loaded, errors) = Self.listRead(workHosts) { ($0.heldLoaded, $0.heldError) }
            return TodaySources.heldAnswer(items, requests: requests, loaded: loaded, errors: errors, now: now, names: names, calendar: calendar)
        case "digest":
            // One tell told by two hosts is one row, as the digest merges it: the one told already, else the newest.
            let tells = DigestModel.mergeRows(workHosts.map { ($0.environmentId, $0.tells ?? []) }).map(\.row)
            let (loaded, errors) = Self.listRead(workHosts) { ($0.tells != nil, $0.tellsError) }
            return TodaySources.alsoAnswer(tells, loaded: loaded, errors: errors, day: day, now: now, calendar: calendar)
        case "meetings":
            guard let life else { return TodayAnswer(loading: true) }
            let built = life.events.map { TodaySources.meetingRows($0, day: day, now: now, jobs: byJobs, people: life.people, calendar: calendar) }
            return supplied(TodaySources.lifeosAnswer(life.eventsRead, rows: built?.rows, sessionDown: life.sessionDown, host: life.host, what: "meetings", note: built?.note, jobs: byJobs), life)
        case "due":
            guard let life else { return TodayAnswer(loading: true) }
            let rows = life.tasks.map { TodaySources.dueRows($0, now: now, jobs: byJobs, names: life.projects, calendar: calendar) }
            let note = TodaySources.namesNote(life.projects, rows: rows)
            return supplied(TodaySources.lifeosAnswer(life.tasksRead, rows: rows, sessionDown: life.sessionDown, host: life.host, what: "tasks", note: note, jobs: byJobs), life)
        case "waiting":
            guard let life else { return TodayAnswer(loading: true) }
            let rows = life.waits.map { TodaySources.waitingRows($0, today: day.from, jobs: byJobs, calendar: calendar) }
            return supplied(TodaySources.waitingAnswer(TodaySources.lifeosAnswer(life.waitsRead, rows: rows, sessionDown: life.sessionDown, host: life.host, what: "mail", jobs: byJobs), beyond: life.beyond), life)
        case "messages":
            return chats.answer(jobs) { [readTo] in TodaySources.chatRows($0, now: now, readTo: readTo, calendar: calendar) }
        case "money":
            return owed.answer(jobs) { TodaySources.owedRows($0, today: TodayWords.localDay(now, calendar), calendar: calendar) }
        case "msforms":
            return forms.answer(jobs) { TodaySources.responseRows($0) }
        case "prep":
            // Marks alone, as the desktop's: a mark is only ever an extra, so a host that does not answer adds no line
            // and keeps nothing from settling.
            return TodayAnswer(marks: TodaySources.prepMarks(jobs.compactMap { job in prep.values[TodayPlace(environmentId: job.environmentId, workspaceId: "")].map { TodaySources.JobAnswer(job, $0) } }))
        case "review":
            let asked = Self.byHost(jobs).filter(\.open).map(\.environmentId)
            var answeredBy: [String: TodaySources.ReviewReady?] = [:]
            for env in asked {
                let place = TodayPlace(environmentId: env, workspaceId: "")
                if let value = review.values[place] { answeredBy[env] = value } else if review.failed[place] != nil { answeredBy[env] = .some(nil) }
            }
            return TodaySources.reviewAnswer(asked: asked, answered: answeredBy, now: day.from, calendar: calendar)
        case "clashes":
            let host = clashHost
            guard let host else { return TodayAnswer() }
            let place = TodayPlace(environmentId: host, workspaceId: "")
            let waiting = clashes.values[place] == nil && clashes.failed[place] == nil && (clashes.out.contains(place) || openHosts.contains(host))
            return TodaySources.clashAnswer(clashes.values[place], loading: waiting, error: clashes.failed[place], sessionDown: life?.sessionDown ?? false, workspaces: jobs, host: host, day: day.from, now: now, calendar: calendar)
        default:
            return TodayAnswer()
        }
    }

    /// A list only a host's socket reads (the Outbox's, the digest's), over every Work host: loaded once each host
    /// listed, failed or is not linked; a host that is not linked and has not listed on this launch fails with "Not
    /// connected", as the desktop's closed link refuses at once, so the page settles and names it at its foot.
    static func listRead(_ hosts: [TodayHostInput], _ read: (TodayHostInput) -> (listed: Bool, error: String?)) -> (loaded: Bool, errors: [TodaySources.HostError]) {
        var errors: [TodaySources.HostError] = []
        for host in hosts {
            let (listed, error) = read(host)
            if let error {
                errors.append(.init(environmentId: host.environmentId, error: error))
            } else if !listed, !host.open {
                errors.append(.init(environmentId: host.environmentId, error: TodaySources.notConnected))
            }
        }
        let loaded = hosts.allSatisfy { read($0).listed || read($0).error != nil || !$0.open }
        return (loaded, errors)
    }

    /// One stand-in job a host that holds a job: a read the host answers for all its jobs at once.
    private static func byHost(_ jobs: [TodayWorkspace]) -> [TodayWorkspace] {
        var seen = Set<String>()
        return jobs.filter { seen.insert($0.environmentId).inserted }.map { job in
            var one = job
            one.workspaceId = ""
            return one
        }
    }

    /// The host whose clashes Today reads: the LifeOS session's, else the first open host that holds a job.
    private var clashHost: String? {
        if let host = life?.host, !host.isEmpty { return host }
        return jobs.first(where: \.open)?.environmentId
    }

    // MARK: - reads

    /// Every read a counter, an opened link or the day asks for now.
    private func readWhatChanged() {
        let open = linkedHosts
        let opened = open.subtracting(openBefore)
        openBefore = open
        for env in opened {
            ranAt = ranAt.filter { !$0.key.contains("|\(env)|") }
            digestAsked.remove(env)
        }
        for read in reads(onlyDue: true) { Task { await read() } }
        for host in hosts where host.workOn && host.linked && host.tells == nil && host.tellsError == nil && !digestAsked.contains(host.environmentId) {
            digestAsked.insert(host.environmentId)
            if let reads = readsOf(host.environmentId) { Task { await reads.todayDigest() } }
        }
    }

    private func readClashes(force: Bool) {
        if force { ranAt = ranAt.filter { !$0.key.hasPrefix("clashes|") } }
        for read in reads(onlyDue: true) { Task { await read() } }
    }

    /// The reads to make: each job's and each host's, on open hosts with Work on. `onlyDue`: only those whose
    /// counter moved since they last ran (or never ran).
    private func reads(only environmentId: String? = nil, onlyDue: Bool = false) -> [@MainActor @Sendable () async -> Void] {
        var out: [@MainActor @Sendable () async -> Void] = []
        let linked = linkedHosts
        let jobs = jobs.filter { linked.contains($0.environmentId) && (environmentId == nil || $0.environmentId == environmentId) }
        func due(_ name: String, _ env: String, _ ws: String, _ rev: Int) -> Bool {
            let key = "\(name)|\(env)|\(ws)"
            if onlyDue, ranAt[key] == rev { return false }
            ranAt[key] = rev
            return true
        }
        for job in jobs {
            guard let host = hosts.first(where: { $0.environmentId == job.environmentId }), let reads = readsOf(job.environmentId) else { continue }
            let place = job.place, ws = job.workspaceId
            if due("messages", job.environmentId, ws, host.revs.messages[ws] ?? 0) {
                out.append { [weak self] in await self?.run(\.chats, place) { try await reads.todayChats(ws) } }
            }
            if due("money", job.environmentId, ws, host.revs.money[ws] ?? 0) {
                out.append { [weak self] in await self?.run(\.owed, place) { try await reads.todayOwed(ws) } }
            }
            if due("msforms", job.environmentId, ws, host.revs.msforms[ws] ?? 0) {
                out.append { [weak self] in await self?.run(\.forms, place) { try await reads.todayForms(ws) } }
            }
        }
        let (from, to) = (day.from, TodayModel.dayAfter(day.from, 2, calendar: calendar))
        for env in Set(jobs.map(\.environmentId)).sorted() {
            guard let host = hosts.first(where: { $0.environmentId == env }), let reads = readsOf(env) else { continue }
            let place = TodayPlace(environmentId: env, workspaceId: "")
            if due("prep", env, "", host.revs.prep.values.reduce(0, +)) {
                out.append { [weak self] in await self?.run(\.prep, place) { try await reads.todayPrep(from: from, to: to) } }
            }
            if due("review", env, "", host.revs.review) {
                // A refusal counts as no review waiting (the desktop's).
                out.append { [weak self] in await self?.run(\.review, place) { (try? await reads.todayReview()) ?? nil } }
            }
            if env == clashHost, due("clashes", env, "", host.revs.clashes) {
                let (dayFrom, dayTo) = day
                out.append { [weak self] in await self?.run(\.clashes, place) { try await reads.todayClashes(from: dayFrom, to: dayTo) } }
            }
        }
        return out
    }

    /// One read: marked out, then its value or its failure kept, then the page again. A failure keeps the value it
    /// had, so what shows stays.
    private func run<V: Hashable & Sendable>(_ path: ReferenceWritableKeyPath<TodayStore, JobReads<V>>, _ place: TodayPlace, _ body: @MainActor () async throws -> V) async {
        readsMade += 1
        let asked = epoch[place.environmentId, default: 0]
        // Each ask of a slot is numbered, as the desktop's `seq`: an older answer that lands after a newer ask is dropped.
        let seq = (self[keyPath: path].seq[place] ?? 0) + 1
        self[keyPath: path].seq[place] = seq
        self[keyPath: path].out.insert(place)
        // The desktop's six seconds: a read that has not answered by then fails with its words, the rows it had stay,
        // and its answer, if it ever lands, is dropped (the slot's number moves on).
        let timer = Task { @MainActor [weak self, deadline] in
            try? await Task.sleep(for: deadline)
            guard let self, !Task.isCancelled, self.epoch[place.environmentId, default: 0] == asked, self[keyPath: path].seq[place] == seq else { return }
            self[keyPath: path].seq[place] = seq + 1
            self[keyPath: path].failed[place] = Self.timedOut
            self[keyPath: path].out.remove(place)
            self.rebuild()
        }
        defer { timer.cancel() }
        let result: Result<V, any Error>
        do { result = .success(try await body()) } catch { result = .failure(error) }
        // The host was purged while this was out (its key refused, Work off, removed, replaced): the answer is dropped.
        guard epoch[place.environmentId, default: 0] == asked, self[keyPath: path].seq[place] == seq else { return }
        switch result {
        case .success(let value):
            self[keyPath: path].values[place] = value
            self[keyPath: path].failed[place] = nil
        case .failure(let error):
            self[keyPath: path].failed[place] = ActionError.wrap(error).message
        }
        self[keyPath: path].out.remove(place)
        rebuild()
    }
}

/// One read on each job (or each host, under a stand-in job with no workspace), and the state the page needs of it.
struct JobReads<Value: Hashable & Sendable>: Hashable, Sendable {
    var values: [TodayPlace: Value] = [:]
    var out: Set<TodayPlace> = []
    /// The newest ask of each slot.
    var seq: [TodayPlace: Int] = [:]
    var failed: [TodayPlace: String] = [:]

    /// The answer over `jobs`, the desktop's `snapshot()` (today/read.ts): rows from every job that has a value; out
    /// is an open job not answered on this launch (asked or still to be asked), or one whose failed read is asked
    /// again: a value read again on a push is not out, it shows until the new one lands. Loading while any job is
    /// out; stale when every job out has a value; away while any job's host is not open; each failed read on an open
    /// host, not being asked again, once per host with Retry.
    func answer(_ jobs: [TodayWorkspace], rows: ([TodaySources.JobAnswer<Value>]) -> [TodayRow]) -> TodayAnswer {
        let answers = jobs.compactMap { job in values[job.place].map { TodaySources.JobAnswer(job, $0) } }
        let outJobs = jobs.filter { job in
            let place = job.place
            let pending = out.contains(place) || (values[place] == nil && failed[place] == nil)
            return job.open && pending && (values[place] == nil || failed[place] != nil)
        }
        let loading = !outJobs.isEmpty
        var failures: [TodayFailure] = []
        for job in jobs where job.open && !out.contains(job.place) {
            guard let error = failed[job.place], !failures.contains(where: { $0.environmentId == job.environmentId }) else { continue }
            failures.append(TodayFailure(environmentId: job.environmentId, error: error, retry: .host(job.environmentId)))
        }
        let nothing = answers.isEmpty && loading
        return TodayAnswer(rows: nothing ? nil : rows(answers), loading: loading, stale: loading && outJobs.allSatisfy { values[$0.place] != nil },
                           away: jobs.contains { !$0.open }, failed: failures)
    }

    /// Everything read of one host goes (a purge).
    mutating func forget(_ host: String) {
        values = values.filter { $0.key.environmentId != host }
        failed = failed.filter { $0.key.environmentId != host }
        out = out.filter { $0.environmentId != host }
    }
}

/// A wire value read again as the port's input.
enum TodayRecode {
    static func `as`<Out: Decodable>(_ type: Out.Type, _ value: some Encodable) throws -> Out {
        try JSONDecoder().decode(Out.self, from: JSONEncoder().encode(value))
    }
}
