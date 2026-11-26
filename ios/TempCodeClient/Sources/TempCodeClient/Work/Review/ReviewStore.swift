import Foundation
import Observation
import TempCodeContract

/// The weekly review on the phone (docs/agents/work-review.md "The phone"): the desktop's review store
/// (src/renderer/src/work/review/store.ts) over `WeekHost`s. Every linked host with Work on is asked for its part of
/// the week; the parts are merged by the port of review.ts (`WeekReview.merge`); Money's sums ride beside. A press on
/// a slipped row goes to the host `ReviewDesk.settleHost` names, and the week is read again after it.
public struct ReviewHostInput: Sendable, Hashable {
    public struct Job: Sendable, Hashable {
        public var workspaceId: String
        public var sector: String?
        public var name: String

        public init(workspaceId: String, sector: String?, name: String) {
            self.workspaceId = workspaceId
            self.sector = sector
            self.name = name
        }
    }

    public var id: String
    public var name: String
    public var platform: String?
    /// Work is on here (a host that is off is still named, as off).
    public var workOn: Bool
    /// Its link is open now.
    public var linked: Bool
    /// The key may read the week here (`work.review.week`).
    public var may: Bool
    /// Its Work workspaces, in the Work list's order.
    public var jobs: [Job]

    public init(id: String, name: String, platform: String?, workOn: Bool, linked: Bool, may: Bool, jobs: [Job]) {
        self.id = id
        self.name = name
        self.platform = platform
        self.workOn = workOn
        self.linked = linked
        self.may = may
        self.jobs = jobs
    }
}

/// The pure rules of the page (tested in ReviewStoreTests).
public enum ReviewDesk {
    /// The host a press on a slipped row goes to. A held item's is the host that holds it. A nudge needs a workspace
    /// of the job, so it goes to one that has one. Everything else is LifeOS's, and goes to the host its rows were
    /// read from, which also keeps the marks (`settleHost`).
    public static func settleHost(_ merged: WeekReview.Merged, _ row: WeekReview.PlacedSlipped, _ how: WeekReview.SettleHow, linked: (String) -> Bool) -> String {
        if case .mail = row.ref, how == .now, let job = merged.jobs.first(where: { $0.key == row.job }) {
            if let at = job.at.first(where: { $0.environmentId == row.environmentId }) ?? job.at.first(where: { linked($0.environmentId) }) {
                return at.environmentId
            }
        }
        return row.environmentId
    }

    /// What a press does on the phone. A held item's Open is the Outbox's own (its press stays there); a meeting's
    /// Follow up opens its page in Prep; every other press is `work.review.settle`.
    public enum Press: Hashable, Sendable {
        case open(Route)
        case settle
    }

    public static func press(_ merged: WeekReview.Merged, _ row: WeekReview.PlacedSlipped, _ how: WeekReview.SettleHow) -> Press {
        guard how == .now else { return .settle }
        switch row.ref {
        case .held(let held):
            return .open(.outboxItem(environmentId: row.environmentId, ref: OutboxModel.key(held.ref)))
        case .meeting(let meeting):
            let job = merged.jobs.first { $0.key == row.job }
            let at = job?.at.first { $0.environmentId == row.environmentId } ?? job?.at.first
            return at.map { .open(.prep(environmentId: $0.environmentId, workspaceId: $0.workspaceId, eventId: meeting.eventId)) } ?? .settle
        default:
            return .settle
        }
    }

    /// Where a row's own press (a tap) opens it: a task in its job's Tasks, a mail in Mail, a held item in the Outbox,
    /// a meeting's page (the desktop's `go.ts`). Nil: no workspace of its job is on a host the phone reaches.
    public static func target(_ merged: WeekReview.Merged, job key: String, environmentId: String, slipped ref: ReviewBody.Slipped.Row.Ref) -> Route? {
        let at = place(merged, job: key, environmentId: environmentId)
        switch ref {
        case .task: return at.map { .workView(environmentId: $0.environmentId, workspaceId: $0.workspaceId, view: "tasks") }
        case .mail: return at.map { .workView(environmentId: $0.environmentId, workspaceId: $0.workspaceId, view: "mail") }
        case .held(let held): return .outboxItem(environmentId: environmentId, ref: OutboxModel.key(held.ref))
        case .meeting(let m): return at.map { .prep(environmentId: $0.environmentId, workspaceId: $0.workspaceId, eventId: m.eventId) }
        case .unknown: return nil
        }
    }

    public static func target(_ merged: WeekReview.Merged, _ row: WeekReview.PlacedShipped) -> Route? {
        let at = place(merged, job: row.job, environmentId: row.environmentId)
        switch row.open {
        case .task?: return at.map { .workView(environmentId: $0.environmentId, workspaceId: $0.workspaceId, view: "tasks") }
        case .mail?: return at.map { .workView(environmentId: $0.environmentId, workspaceId: $0.workspaceId, view: "mail") }
        case .held(let held)?: return .outboxItem(environmentId: row.environmentId, ref: OutboxModel.key(held.ref))
        default: return nil
        }
    }

    private static func place(_ merged: WeekReview.Merged, job key: String, environmentId: String) -> WeekReview.Place? {
        let job = merged.jobs.first { $0.key == key }
        return job?.at.first { $0.environmentId == environmentId } ?? job?.at.first
    }

    /// Rows a press settled stay away only while a read of their week still lists them as open (`stillAway`).
    public static func stillAway(_ keys: Set<String>, _ slipped: [WeekReview.PlacedSlipped]) -> Set<String> {
        let open = Set(slipped.filter(\.open).map(\.key))
        return keys.filter(open.contains)
    }

    /// Why a host's week did not come, as one sentence (`hostLine`): a wait that ran out is "<Host> did not answer.".
    public static func hostLine(_ words: String?, timedOut: Bool, name: String) -> String {
        let host = name.first.map { $0.uppercased() + name.dropFirst() } ?? name
        if timedOut { return "\(host) did not answer." }
        guard let words, !words.isEmpty else { return "\(host) could not read the week." }
        if words.range(of: "did not answer", options: .caseInsensitive) != nil { return "\(host) did not answer." }
        return words.last.map { ".!?".contains($0) } == true ? words : "\(words)."
    }

    /// Money's sums placed on the review's jobs: a job on two hosts is the two ledgers added; a job one of whose
    /// ledgers could not be read whole, or whose host's read failed, shows no sum (`moneyOf`).
    public static func money(_ sums: [String: [MoneySums.Row]], failed: Set<String>, parts: [WeekReview.Part], hosts: [ReviewHostInput]) -> [String: MoneyFigure] {
        var out: [String: MoneyFigure] = [:]
        var broken = Set<String>()
        let hostOf = Dictionary(parts.map { ($0.environmentId, $0.body.host) }, uniquingKeysWith: { a, _ in a })
        let counted = Set(hosts.filter { $0.workOn && $0.linked }.map(\.id))
        for (environmentId, rows) in sums where counted.contains(environmentId) {
            for row in rows {
                let key = WeekReview.jobKey(hostOf[environmentId] ?? environmentId, workspaceId: row.workspaceId, sector: row.sector)
                if row.problem == true { broken.insert(key) }
                if row.in == 0, row.out == 0 { continue }
                let have = out[key] ?? MoneyFigure(in: 0, out: 0)
                out[key] = MoneyFigure(in: have.in + row.in, out: have.out + row.out)
            }
        }
        for environmentId in failed where counted.contains(environmentId) {
            for job in hosts.first(where: { $0.id == environmentId })?.jobs ?? [] {
                broken.insert(WeekReview.jobKey(hostOf[environmentId] ?? environmentId, workspaceId: job.workspaceId, sector: job.sector))
            }
            for part in parts where part.environmentId == environmentId {
                for job in part.body.jobs { broken.insert(WeekReview.jobKey(part.body.host, job)) }
            }
        }
        for key in broken { out[key] = nil }
        return out
    }

    /// The page's lines over the sections, in the desktop's order: red (a host that did not answer, a source that
    /// feeds more than one section; the first carries Retry), muted (a list read in part), Hours' own, and whether
    /// Slipped stands as last known.
    public struct Lines: Hashable, Sendable {
        public var over: [String]
        public var part: [String]
        public var hours: [String]
        public var lastKnown: Bool
    }

    public static func lines(_ view: ReviewView) -> Lines {
        let left = Set(view.merged?.left ?? [])
        func of(_ keys: String...) -> [String] { keys.filter(left.contains) }
        typealias L = WeekReview.Left
        let over = view.errors.map { $0.kept ? "\($0.error) Its last answer is shown." : $0.error }
            + of(L.lifeos, L.lifeosKept, L.calendar, L.calendarKept, L.tasks, L.tasksKept, L.mail, L.mailKept, L.selfAddresses, L.carried, L.meetings, L.prep, L.held)
        let kept = Set(view.errors.filter(\.kept).map(\.environmentId))
        let lastKnown = view.merged?.slipped.contains { $0.unchecked && !kept.contains($0.environmentId) } ?? false
        return Lines(over: over, part: of(L.mailPart, L.heldPart, L.filesPart), hours: of(L.threads, L.files), lastKnown: lastKnown)
    }

    /// A first read that failed with no week to draw: the hosts' lines, for the place frame's failed-read row with Try
    /// Again in "No Week Yet"'s place. Nil once a week merged: its head carries the lines (`lines`).
    public static func firstFailure(_ view: ReviewView) -> String? {
        guard view.merged == nil, !view.errors.isEmpty else { return nil }
        return view.errors.map(\.error).joined(separator: " ")
    }

    /// "This week", "Last week", else "Week of Nov 10": the picker's words for a week.
    public static func weekName(_ week: WeekReview.Week, now: Double, tz: String) -> String {
        let this = WeekReview.weekOf(now, tz: tz)
        if week.from == this.from { return "This Week" }
        if week.from == WeekReview.stepWeek(this, by: -1, tz: tz).from { return "Last Week" }
        return WeekReview.weekWords(week, tz: tz)
    }
}

/// What a job's ledger took in and paid out in the week, in cents.
public struct MoneyFigure: Hashable, Sendable {
    public var `in`: Double
    public var out: Double

    public init(in cin: Double, out: Double) {
        self.in = cin
        self.out = out
    }
}

/// The week as the page shows it (`ReviewView`).
public struct ReviewView: Sendable {
    public struct HostError: Hashable, Sendable {
        public var environmentId: String
        public var name: String
        public var error: String
        /// what it answered before still counts
        public var kept: Bool
    }

    public var week: WeekReview.Week
    public var tz: String
    /// nil until a host has answered
    public var merged: WeekReview.Merged?
    /// every linked host has answered, or failed to
    public var settled: Bool
    /// hosts with Work on that are not linked, each its one line
    public var off: [String]
    public var errors: [HostError]
    public var money: [String: MoneyFigure]
    /// rows a press settled, kept away until a read no longer lists them
    public var gone: Set<String>
}

/// What a press on a slipped row did, and where to take it back.
public struct ReviewSettledPress: Hashable, Sendable {
    public var undo: String?
    public var sessionId: String?
    public var environmentId: String
    public var key: String
    public var week: WeekReview.Week
}

@MainActor @Observable
public final class ReviewStore {
    struct HostWeek: Sendable {
        var body: ReviewBody?
        var loaded = false
        var error: String?
        var asked = 0
    }

    public private(set) var week: WeekReview.Week
    public private(set) var tz: String
    /// The weeks the hosts kept, newest first (the picker's list past this week and last).
    public private(set) var kept: [WeekReview.Week] = []
    private var hosts: [ReviewHostInput] = []
    private var answers: [Double: [String: HostWeek]] = [:]
    private var sums: [Double: [String: [MoneySums.Row]]] = [:]
    private var sumsFailed: [Double: Set<String>] = [:]
    private var away: [Double: Set<String>] = [:]
    @ObservationIgnored private var seenTold = Set<Double>()
    @ObservationIgnored private var zoneAsked = false
    @ObservationIgnored private let link: @MainActor (String) -> WeekHost?
    @ObservationIgnored private let words: @MainActor (any Error) -> (words: String?, timedOut: Bool)
    @ObservationIgnored public var now: @MainActor () -> Double

    public init(tz: String = TimeZone.current.identifier,
                now: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 },
                link: @escaping @MainActor (String) -> WeekHost?,
                words: @escaping @MainActor (any Error) -> (words: String?, timedOut: Bool) = { _ in (nil, false) }) {
        self.tz = tz
        self.now = now
        self.link = link
        self.words = words
        week = WeekReview.weekOf(now(), tz: tz)
    }

    // MARK: - the hosts and the week shown

    /// The hosts as they stand. True when a host is new or its link opened again: the caller reads the week afresh,
    /// and that host's last answer stands as from before until it lands (`stale`).
    @discardableResult
    public func update(hosts next: [ReviewHostInput]) -> Bool {
        let before = Dictionary(hosts.map { ($0.id, $0.linked) }, uniquingKeysWith: { a, _ in a })
        hosts = next
        let back = next.filter { $0.linked && before[$0.id] != true }
        for host in back { answers[week.from]?[host.id]?.loaded = false }
        return !back.isEmpty
    }

    /// Shows a week; the page reads it.
    public func show(_ next: WeekReview.Week) {
        week = next
    }

    public func step(by: Int) {
        week = WeekReview.stepWeek(week, by: by, tz: tz)
    }

    /// A week a host names by its first moment (Today's row, a tell): found from its middle (`weekNamed`).
    public func show(named from: Double) {
        week = WeekReview.weekNamed(from, tz: tz)
    }

    /// The Work home: the box, else the first host with Work on that is linked.
    private var home: String? {
        let on = hosts.filter { $0.workOn && $0.linked && $0.may }
        return (on.first { $0.platform == "linux" } ?? on.first)?.id
    }

    private var asked: [ReviewHostInput] { hosts.filter { $0.workOn && $0.linked && $0.may } }

    /// The zone weeks are cut in and the weeks kept, from the home (`work.review.list`); the phone's own zone until it answers.
    public func loadZone() async {
        guard !zoneAsked, let id = home, let host = link(id) else { return }
        zoneAsked = true
        guard let list = try? await host.reviewWeeks() else {
            zoneAsked = false
            return
        }
        kept = list.weeks.map { WeekReview.Week(from: Double($0.from), to: Double($0.to)) }
        if list.tz != tz, WeekReview.knownZone(list.tz) {
            let middle = week.from + (week.to - week.from) / 2
            tz = list.tz
            week = WeekReview.weekOf(middle, tz: tz)
        }
    }

    /// Asks every linked host for its part of the shown week, and its Money sums. `after`: a read that starts after a
    /// press, never one already on its way.
    public func load() async {
        await loadZone()
        let week = week
        let tz = tz
        let from = WeekReview.localDay(week.from, tz: tz)
        let to = WeekReview.localDay(week.to, tz: tz)
        var tasks: [Task<Void, Never>] = []
        for input in asked {
            guard let host = link(input.id) else { continue }
            let id = input.id
            let name = input.name
            var entry = answers[week.from]?[id] ?? HostWeek()
            entry.asked += 1
            let ask = entry.asked
            answers[week.from, default: [:]][id] = entry
            tasks.append(Task {
                do {
                    let body = try await host.reviewWeek(from: Int(week.from), to: Int(week.to), tz: tz)
                    land(week, id, ask) { $0.body = body; $0.error = nil }
                } catch {
                    let said = words(error)
                    land(week, id, ask) { $0.error = ReviewDesk.hostLine(said.words, timedOut: said.timedOut, name: name) }
                }
            })
            tasks.append(Task {
                do {
                    sums[week.from, default: [:]][id] = try await host.moneySums(from: from, to: to).rows
                    sumsFailed[week.from]?.remove(id)
                } catch {
                    sums[week.from]?[id] = nil
                    sumsFailed[week.from, default: []].insert(id)
                }
            })
        }
        for task in tasks { await task.value }
    }

    private func land(_ week: WeekReview.Week, _ id: String, _ ask: Int, _ change: (inout HostWeek) -> Void) {
        guard var entry = answers[week.from]?[id], entry.asked == ask else { return }
        change(&entry)
        entry.loaded = true
        answers[week.from]?[id] = entry
        if let keys = away[week.from], let merged = merged(week) {
            away[week.from] = ReviewDesk.stillAway(keys, merged.slipped)
        }
    }

    private func parts(_ week: WeekReview.Week) -> [WeekReview.Part] {
        let got = answers[week.from] ?? [:]
        return hosts.filter { $0.workOn && $0.linked }.compactMap { host in
            guard let entry = got[host.id], let body = entry.body else { return nil }
            return WeekReview.Part(environmentId: host.id, body: body, stale: entry.error != nil || !entry.loaded)
        }
    }

    private func merged(_ week: WeekReview.Week) -> WeekReview.Merged? {
        let parts = parts(week)
        let hostOf = Dictionary(parts.map { ($0.environmentId, $0.body.host) }, uniquingKeysWith: { a, _ in a })
        let on = hosts.filter(\.workOn)
        let known = on.flatMap { host in
            host.jobs.map { WeekReview.MergedJob(key: WeekReview.jobKey(hostOf[host.id] ?? host.id, workspaceId: $0.workspaceId, sector: $0.sector), sector: $0.sector, name: $0.name) }
        }
        var seen = Set<String>()
        let order = known.map(\.key).filter { seen.insert($0).inserted }
        let live = on.filter(\.linked)
        let got = answers[week.from] ?? [:]
        let fresh = live.allSatisfy { got[$0.id]?.loaded == true && got[$0.id]?.error == nil }
        return WeekReview.merge(parts, now: now(), home: home, names: { TodayWords.sectorName($0) }, order: order, jobs: known, fresh: fresh, whole: live.count == on.count)
    }

    /// The shown week, as the page draws it.
    public var view: ReviewView {
        let got = answers[week.from] ?? [:]
        let on = hosts.filter(\.workOn)
        let live = on.filter(\.linked)
        return ReviewView(
            week: week,
            tz: tz,
            merged: merged(week),
            settled: live.allSatisfy { got[$0.id]?.loaded == true || !$0.may },
            off: on.filter { !$0.linked }.map { WeekReview.hostOffWords($0.name) },
            errors: live.compactMap { host in
                guard let entry = got[host.id], let error = entry.error else { return nil }
                return ReviewView.HostError(environmentId: host.id, name: host.name, error: error, kept: entry.body != nil)
            },
            money: ReviewDesk.money(sums[week.from] ?? [:], failed: sumsFailed[week.from] ?? [], parts: parts(week), hosts: hosts),
            gone: away[week.from] ?? []
        )
    }

    /// He saw the week: each host hears once a run, so Today's row and the digest's line go (`markSeen`).
    public func markSeen() {
        guard seenTold.insert(week.from).inserted else { return }
        let from = Int(week.from)
        for input in asked {
            guard let host = link(input.id) else { continue }
            Task { try? await host.reviewSeen(from: from) }
        }
    }

    // MARK: - presses

    /// His press on a slipped row, on the host that keeps it; the row leaves at once (unless a nudge started a thread),
    /// and the week is read again after.
    public func settle(_ row: WeekReview.PlacedSlipped, how: WeekReview.SettleHow) async throws -> ReviewSettledPress {
        guard let merged = merged(week) else { throw ReviewStoreError.noWeek }
        let week = week
        let environmentId = ReviewDesk.settleHost(merged, row, how) { id in self.hosts.contains { $0.id == id && $0.linked } }
        guard let host = link(environmentId) else { throw ReviewStoreError.noHost }
        defer { Task { await self.load() } }
        let done = try await host.settle(row.ref, how: how, tz: merged.tz, sector: row.sector)
        if done.sessionId == nil { away[week.from, default: []].insert(row.key) }
        return ReviewSettledPress(undo: done.undo, sessionId: done.sessionId, environmentId: environmentId, key: row.key, week: week)
    }

    /// Takes a press back while its host holds the token; the row comes back and the week is read again.
    public func undo(_ press: ReviewSettledPress) async throws {
        away[press.week.from]?.remove(press.key)
        guard let token = press.undo, let host = link(press.environmentId) else { return }
        defer { Task { await self.load() } }
        try await host.undoSettle(token: token)
    }
}

public enum ReviewStoreError: Error {
    case noWeek
    case noHost
}
