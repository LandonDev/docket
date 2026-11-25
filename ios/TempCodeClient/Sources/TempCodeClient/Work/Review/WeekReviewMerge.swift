import Foundation
import TempCodeContract

/// One review from every host's part (review.ts `mergeReview` and the rules it calls). The window and the phone
/// ask each host for its part of a week (`work.review.week`, a `ReviewBody`) and merge them here.
extension WeekReview {
    // MARK: - what each part read

    /// LifeOS's lists, as a host reads them one at a time. `meetings`: the meetings judged.
    public enum ListKey: String, CaseIterable, Hashable, Sendable {
        case events, sent, answered, done, due, waits, meetings
    }

    /// The moment each list a body holds whole stands as of.
    public typealias Reads = [ListKey: Double]

    /// What a slipped row is.
    public enum SlippedKind: String, CaseIterable, Hashable, Sendable {
        case task, mail, held, meeting
    }

    public static func kindOf(_ ref: ReviewBody.Slipped.Row.Ref) -> SlippedKind? {
        switch ref {
        case .task: .task
        case .mail: .mail
        case .held: .held
        case .meeting: .meeting
        case .unknown: nil
        }
    }

    /// The lists a body holds whole (`ReviewBody.read`). A body from before that field is read by its lines: a list
    /// counts as read, as of the body's own read, while no line says its source failed or was cut or stood in.
    public static func readsOf(_ body: ReviewBody) -> Reads {
        if let r = body.read {
            var out: Reads = [:]
            let pairs: [(ListKey, Int?)] = [(.events, r.events), (.sent, r.sent), (.answered, r.answered), (.done, r.done), (.due, r.due), (.waits, r.waits), (.meetings, r.meetings)]
            for (k, v) in pairs { if let v { out[k] = Double(v) } }
            return out
        }
        func left(_ lines: String...) -> Bool { lines.contains { body.left.contains($0) } }
        if body.lifeos == nil || left(Left.lifeos, Left.lifeosKept) { return [:] }
        let at = Double(body.madeAt)
        var out: Reads = [:]
        if !left(Left.calendar, Left.calendarKept) { out[.events] = at }
        if !left(Left.mail, Left.mailKept) {
            out[.sent] = at
            out[.answered] = at
        }
        if !left(Left.mail, Left.mailKept, Left.mailPart) { out[.waits] = at }
        if !left(Left.tasks, Left.tasksKept) {
            out[.done] = at
            out[.due] = at
        }
        if out[.events] != nil && out[.sent] != nil && !left(Left.selfAddresses, Left.carried) { out[.meetings] = at }
        return out
    }

    /// The list a slipped row of a kind is read in.
    static func rowList(_ kind: SlippedKind) -> ListKey? {
        switch kind {
        case .task: .due
        case .mail: .waits
        case .meeting: .meetings
        case .held: nil
        }
    }

    /// Whether a body's read could say anything of a slipped row: false when the row's own list was not read whole
    /// in it. A meeting stands as last known too while this host's Prep did not answer.
    public static func uncheckedIn(_ body: ReviewBody, _ ref: ReviewBody.Slipped.Row.Ref) -> Bool {
        guard let kind = kindOf(ref) else { return true }
        if kind == .held { return body.left.contains(Left.held) || body.left.contains(Left.heldPart) }
        if kind == .meeting && body.left.contains(Left.prep) { return true }
        guard let list = rowList(kind) else { return true }
        return readsOf(body)[list] != Double(body.madeAt)
    }

    /// A waiting mail's key: its thread and the moment the wait began.
    public static func waitKey(_ threadId: String, since: Double) -> String { "mail:\(threadId):\(num(since))" }

    /// A slipped row's one identity across makes: a mail by its wait.
    static func rowId(_ r: ReviewBody.Slipped.Row) -> String {
        if case .mail(let m) = r.ref { return waitKey(m.threadId, since: Double(m.since)) }
        return r.key
    }

    // MARK: - one review from every host's part

    /// One host's part of the week. `stale`: the host did not answer this time, and this is what it answered before.
    public struct Part: Hashable, Sendable {
        public var environmentId: String
        public var body: ReviewBody
        public var stale: Bool
        public init(environmentId: String, body: ReviewBody, stale: Bool = false) {
            self.environmentId = environmentId
            self.body = body
            self.stale = stale
        }
    }

    /// Where one of a job's workspaces is.
    public struct Place: Hashable, Sendable {
        public var environmentId: String
        public var workspaceId: String
        public init(environmentId: String, workspaceId: String) {
            self.environmentId = environmentId
            self.workspaceId = workspaceId
        }
    }

    public struct MergedJob: Hashable, Sendable {
        public var key: String
        public var sector: String?
        public var name: String
        /// where the job's workspaces are, the first one first
        public var at: [Place]
        public init(key: String, sector: String?, name: String, at: [Place] = []) {
            self.key = key
            self.sector = sector
            self.name = name
            self.at = at
        }
    }

    /// A shipped row, filed under its job and the host a press goes to.
    public struct PlacedShipped: Hashable, Sendable {
        public var key: String
        public var kind: ReviewBody.Shipped.Kind
        public var sector: String?
        public var workspaceId: String?
        /// the mail's subject, the task's title, the held item's summary
        public var title: String
        /// whom it went to, or who answered
        public var who: String?
        public var at: Double
        /// what a press opens
        public var open: ReviewBody.Shipped.Open?
        public var job: String
        public var environmentId: String
    }

    /// A slipped row, filed under its job and the host a press goes to.
    public struct PlacedSlipped: Hashable, Sendable {
        public var key: String
        public var ref: ReviewBody.Slipped.Row.Ref
        public var sector: String?
        public var workspaceId: String?
        public var title: String
        /// what the detail is said from: when it was due, sent, held or began
        public var at: Double
        public var people: [String]
        public var others: Int
        /// still open when last read; false: dealt with since
        public var open: Bool
        /// its source did not answer this time, so it stands as last known and its presses wait
        public var unchecked: Bool
        public var job: String
        public var environmentId: String
        public var kind: SlippedKind? { WeekReview.kindOf(ref) }
    }

    /// A host that left LifeOS out while its line stands, and why.
    public struct LifeosDown: Hashable, Sendable {
        public var environmentId: String
        /// nil from a host a build behind
        public var state: ReviewBody.LifeosState?
        /// a kept read stands in (`Left.lifeosKept`)
        public var kept: Bool
        public var stale: Bool
    }

    /// What an empty list means: true only where every source of it answered, so "nothing" is known.
    public struct Known: Hashable, Sendable {
        public var calendar: Bool
        public var calendarCounted: Bool
        public var desk: Bool
        public var shipped: Bool
        public var slipped: Bool
        public init(calendar: Bool, calendarCounted: Bool, desk: Bool, shipped: Bool, slipped: Bool) {
            self.calendar = calendar
            self.calendarCounted = calendarCounted
            self.desk = desk
            self.shipped = shipped
            self.slipped = slipped
        }
    }

    public struct Merged: Hashable, Sendable {
        public var from: Double
        public var to: Double
        public var tz: String
        public var madeAt: Double
        public var by: ReviewBody.By
        public var over: Bool
        public var jobs: [MergedJob]
        public var hours: [JobHours]
        public var compare: [Comparison]
        public var shipped: [PlacedShipped]
        public var slipped: [PlacedSlipped]
        /// when what slipped was read
        public var slippedAt: Double
        /// whether answers were kept for all of this week; false: none is no news
        public var answersKept: Bool
        /// the host LifeOS's facts were taken from; nil: no host had them
        public var lifeosFrom: String?
        public var left: [String]
        /// each host whose part left LifeOS out while its line stands; empty when none did
        public var lifeosDown: [LifeosDown]
        public var known: Known
        public var week: Week { Week(from: from, to: to) }
    }

    /// The job a host's row is filed under: its workspace's, when that workspace is of the row's own sector, else its
    /// sector's.
    public static func rowJob(_ body: ReviewBody, workspaceId: String?, sector: String?) -> String? {
        let j = (workspaceId?.isEmpty == false) ? body.jobs.first { $0.workspaceId == workspaceId && (sector?.isEmpty != false || $0.sector == sector) } : nil
        return j.map { jobKey(body.host, $0) } ?? sector
    }

    static func placePoints(_ part: Part, _ points: [HostPoint]) -> [Point] {
        points.compactMap { p in
            guard part.body.jobs.indices.contains(p.job) else { return nil }
            return Point(at: p.at, job: jobKey(part.body.host, part.body.jobs[p.job]), kind: p.kind)
        }
    }

    /// LifeOS's facts for the week, a list at a time from the parts that read each.
    struct LifeosFacts {
        var events: [ReviewBody.Lifeos.Event]
        var sent: [ReviewBody.Lifeos.Sent]
        var answered: [ReviewBody.Lifeos.Answered]
        var answeredSince: Double?
        var done: [ReviewBody.Lifeos.Done]
    }

    /// One review from each host's part. LifeOS's facts are the same from every host, so they are taken once, a list
    /// at a time, each from the part that read it best. Each host adds its own points, run time, held rows and what
    /// went out on his press there. Jobs are one per sector; a job is listed whether or not anything was seen.
    ///
    /// `home`: the host whose LifeOS rows and marks win. `names`: a sector's job name where no workspace names it.
    /// `order`: job keys in the order to list them. `jobs`: every job this window knows of, listed though nothing of
    /// it was read. `fresh`: false when a host asked did not answer this time. `whole`: false when that, or a host
    /// with Work on is off.
    public static func merge(_ parts: [Part], now: Double, home: String? = nil, names: (@Sendable (String) -> String)? = nil, order: [String]? = nil,
                             jobs extra: [MergedJob]? = nil, fresh freshOpt: Bool? = nil, whole wholeOpt: Bool? = nil) -> Merged? {
        guard let first = parts.first else { return nil }
        let from = Double(first.body.from)
        let to = Double(first.body.to)
        let over = now >= to
        let all = Array(parts.indices)
        let reads = parts.map { readsOf($0.body) }
        func made(_ i: Int) -> Double { Double(parts[i].body.madeAt) }
        func own(_ i: Int, _ k: ListKey) -> Bool { reads[i][k] == made(i) }
        func isHome(_ i: Int) -> Bool { home != nil && parts[i].environmentId == home }
        func flag(_ b: Bool) -> Double { b ? 1 : 0 }
        // The calendar carries no marks, so its newest whole read comes before the home's.
        func rank(_ k: ListKey) -> (Int) -> [Double] {
            { i in
                let p = parts[i]
                let newest = -(reads[i][k] ?? 0)
                return k == .events
                    ? [flag(p.stale), own(i, k) ? 0 : 1, newest, isHome(i) ? 0 : 1]
                    : [flag(p.stale), own(i, k) ? 0 : 1, isHome(i) ? 0 : 1, newest]
            }
        }
        func before(_ a: [Double], _ b: [Double]) -> Bool {
            for i in a.indices where a[i] != b[i] { return a[i] < b[i] }
            return false
        }
        func bestBy(_ ps: [Int], _ key: (Int) -> [Double]) -> Int? {
            ps.reduce(nil as Int?) { b, p in
                guard let b else { return p }
                return before(key(p), key(b)) ? p : b
            }
        }
        let homeFirst = { (i: Int) -> [Double] in [flag(parts[i].stale), isHome(i) ? 0 : 1] }
        let source = bestBy(all.filter { parts[$0].body.lifeos != nil }, homeFirst)
        var at: [ListKey: Int] = [:]
        for k in ListKey.allCases {
            if let p = bestBy(all.filter { reads[$0][k] != nil }, rank(k)) { at[k] = p }
        }
        /// Read whole this time, by a part that answered now: what "nothing" may stand on.
        func readNow(_ k: ListKey) -> Bool { all.contains { !parts[$0].stale && own($0, k) } }
        func lifeosOf(_ k: ListKey) -> ReviewBody.Lifeos? { (at[k] ?? source).flatMap { parts[$0].body.lifeos } }
        let lifeos: LifeosFacts? = source == nil ? nil : LifeosFacts(
            events: lifeosOf(.events)?.events ?? [],
            sent: lifeosOf(.sent)?.sent ?? [],
            answered: lifeosOf(.answered)?.answered ?? [],
            answeredSince: lifeosOf(.answered)?.answeredSince.map(Double.init),
            done: lifeosOf(.done)?.done ?? []
        )

        var jobs: [MergedJob] = []
        var jobAt: [String: Int] = [:]
        for part in parts {
            for j in part.body.jobs {
                let key = jobKey(part.body.host, j)
                let place = Place(environmentId: part.environmentId, workspaceId: j.workspaceId)
                if let i = jobAt[key] {
                    jobs[i].at.append(place)
                } else {
                    jobAt[key] = jobs.count
                    jobs.append(MergedJob(key: key, sector: j.sector, name: j.name, at: [place]))
                }
            }
        }
        // A sector with something to show and no workspace on a host that answered is still a job.
        func seen(_ sector: String) {
            guard jobAt[sector] == nil else { return }
            jobAt[sector] = jobs.count
            jobs.append(MergedJob(key: sector, sector: sector, name: names?(sector) ?? sector))
        }
        if let lifeos {
            for e in lifeos.events where countedSpan(e) != nil { seen(e.sector) }
            for x in lifeos.sent { seen(x.sector) }
            for x in lifeos.done { seen(x.sector) }
            for x in lifeos.answered { seen(x.sector) }
        }
        // LifeOS's slipped rows are taken once, each kind from one part, and keep that part's host, which a press
        // goes to: meetings from the home's part; tasks and waits, once the week is over, from the newest list kept
        // inside it; otherwise each from the part its list came from, else the home's, else the first with any.
        func ofKind(_ kind: SlippedKind) -> (Int) -> Bool { { i in parts[i].body.slipped.rows.contains { kindOf($0.ref) == kind } } }
        func keptIn(_ i: Int) -> Bool { Double(parts[i].body.slipped.at) < to }
        let homePart = all.first(where: isHome)
        func rowsOf(_ kind: SlippedKind) -> Int? {
            let k = rowList(kind)!
            if kind == .meeting, let homePart { return homePart }
            if kind != .meeting && over {
                // The newest list kept inside the week stands, whoever read now; current reads only check its rows.
                let baseline = bestBy(all.filter(keptIn)) { i in [-Double(parts[i].body.slipped.at), flag(parts[i].stale), own(i, k) ? 0 : 1, isHome(i) ? 0 : 1] }
                if let baseline { return baseline }
            }
            return at[k] ?? all.first { isHome($0) && ofKind(kind)($0) } ?? all.first(where: ofKind(kind))
        }
        let rowsFrom: [SlippedKind: Int?] = [.task: rowsOf(.task), .mail: rowsOf(.mail), .meeting: rowsOf(.meeting)]
        func rowsPart(_ kind: SlippedKind) -> Int? { rowsFrom[kind] ?? nil }
        func slippedFrom(_ i: Int) -> [ReviewBody.Slipped.Row] {
            parts[i].body.slipped.rows.filter { r in
                guard let kind = kindOf(r.ref) else { return false }
                return kind == .held ? true : rowsPart(kind) == i
            }
        }
        /// A part that read a kind's list whole this time, other than the rows' own: its rows check the kept ones.
        func checker(_ kind: SlippedKind) -> Int? { all.first { $0 != rowsPart(kind) && !parts[$0].stale && own($0, rowList(kind)!) } }
        /// What a checking part says of a row: open or not, or nothing. A part whose rows are what is open now says a
        /// row it lacks is not open; a part that kept its own list says only of the rows in it.
        func verdictOf(_ i: Int) -> (ReviewBody.Slipped.Row) -> Bool? {
            let rows = Dictionary(parts[i].body.slipped.rows.map { (rowId($0), $0) }, uniquingKeysWith: { _, b in b })
            let openNow = !keptIn(i)
            return { r in
                if let there = rows[rowId(r)] { return there.open }
                return openNow ? false : nil
            }
        }
        for i in all {
            for r in slippedFrom(i) { if let s = r.sector, !s.isEmpty { seen(s) } }
        }
        for j in extra ?? [] where jobAt[j.key] == nil {
            jobAt[j.key] = jobs.count
            jobs.append(MergedJob(key: j.key, sector: j.sector, name: j.name))
        }

        var list = jobs
        if let order {
            let orderRank = Dictionary(order.enumerated().map { ($1, Double($0)) }, uniquingKeysWith: { _, b in b })
            list = stable(list.enumerated().map { (j: $1, r: orderRank[$1.key] ?? 1e6 + Double($0)) }, by: { $0.r < $1.r }).map(\.j)
        }
        let keys = list.map(\.key)

        // Each part is counted to its own read, not to the window's own clock; the span runs to the newest read, and
        // the calendar is cut to the read of the part it came from.
        func clamp(_ t: Double) -> Double { max(min(t, to), from) }
        func readOf(_ i: Int) -> Double { parts[i].body.over ? to : clamp(made(i)) }
        let partReads = all.map(readOf)
        let read = partReads.max()!
        let span = Span(from: from, to: max(min(now, read), from))
        // The calendar is counted to the moment it stands as of: its own read, or a kept read's.
        func calendarAt(_ p: Int?) -> Double {
            guard let p else { return span.to }
            return parts[p].body.over && own(p, .events) ? to : clamp(reads[p][.events] ?? made(p))
        }
        let calendarTo = calendarAt(at[.events] ?? source)
        func eventsOf(_ cut: Double) -> [Block] {
            (lifeos?.events ?? []).compactMap { e in
                guard let s = countedSpan(e) else { return nil }
                let end = min(s.to, cut)
                return end > s.from ? Block(job: e.sector, from: s.from, to: end) : nil
            }
        }
        var points: [Point] = (lifeos?.sent ?? []).map { Point(at: Double($0.at), job: $0.sector, kind: .sent) }
        var ran: [Ran] = []
        for part in parts {
            points += placePoints(part, hostPoints(part.body.points))
            for r in hostRan(part.body.ran) where part.body.jobs.indices.contains(r.job) {
                ran.append(Ran(job: jobKey(part.body.host, part.body.jobs[r.job]), ms: r.ms))
            }
        }
        let hours = hoursOf(HourFacts(jobs: keys, span: span, events: eventsOf(calendarTo), points: points, ran: ran))

        // A LifeOS line stays while a list it speaks of was not read whole this time by the part that list is taken
        // from (for meetings, the part whose rows are listed); every host's own lines stay.
        func readFor(_ k: ListKey) -> Bool {
            if k == .meetings {
                guard let m = rowsPart(.meeting) else { return false }
                return !parts[m].stale && own(m, .meetings)
            }
            return readNow(k)
        }
        var left: [String] = []
        for part in parts {
            for l in part.body.left where lineLists[l].map({ $0.contains { !readFor($0) } }) ?? true {
                if !left.contains(l) { left.append(l) }
            }
        }
        // The meetings listed are the home's; when it could not judge them and no line already says why, one does.
        if let m = rowsPart(.meeting), !parts[m].stale, !readFor(.meetings), !parts[m].body.left.contains(where: { left.contains($0) && lineMeets.contains($0) }) {
            left.append(Left.meetings)
        }
        func missing(_ lines: String...) -> Bool { lines.contains { left.contains($0) } }
        // Who left LifeOS out, and why, while the line stands.
        let lifeosDown: [LifeosDown] = parts.compactMap { p in
            guard let line = p.body.left.first(where: { ($0 == Left.lifeos || $0 == Left.lifeosKept) && left.contains($0) }) else { return nil }
            return LifeosDown(environmentId: p.environmentId, state: p.body.lifeosState, kept: line == Left.lifeosKept, stale: p.stale)
        }

        let fresh = freshOpt != false
        let whole = fresh && wholeOpt != false
        // The week before, from the same parts by the same rule, over the span both weeks cover. With anything
        // unread, in either week, or a host that did not answer this time, no comparison is drawn.
        var compare: [Comparison] = []
        let beforeFrom = ([at[.events]].compactMap { $0 } + all).first { parts[$0].body.before?.lifeos != nil }
        let befores = parts.compactMap(\.body.before)
        if let bf = beforeFrom, let bb = parts[bf].body.before, let was = bb.lifeos, fresh, left.isEmpty {
            let allOver = parts.allSatisfy(\.body.over)
            var cmpTo = max(min(now, partReads.min()!), from)
            var beforeTo = befores.map { Double($0.to) }.min()!
            // While the week runs both are cut to the same length of time: a week with a clock change in it is 167 or
            // 169 hours long. Two weeks that are over are compared whole.
            if !allOver {
                let elapsed = min(cmpTo - from, beforeTo - Double(bb.from))
                cmpTo = from + elapsed
                beforeTo = Double(bb.from) + elapsed
            }
            var past: [Point] = was.sent.map { Point(at: Double($0.at), job: $0.sector, kind: .sent) }
            for part in parts {
                if let b = part.body.before { past += placePoints(part, hostPoints(b.points)) }
            }
            let then = hoursOf(HourFacts(jobs: keys, span: Span(from: Double(bb.from), to: beforeTo), events: was.events.map { Block(job: $0.sector, from: Double($0.from), to: Double($0.to)) }, points: past))
            let nowCut = cmpTo == span.to && calendarTo == span.to ? hours : hoursOf(HourFacts(jobs: keys, span: Span(from: from, to: cmpTo), events: eventsOf(cmpTo), points: points))
            compare = compareWeeks(nowCut, then, running: !allOver)
        }

        let answersKept = lifeos.map { l in l.answeredSince.map { $0 <= from } ?? false } ?? false
        var shipped: [PlacedShipped] = []
        if let lifeos, let source {
            let sentEnv = parts[at[.sent] ?? source].environmentId
            let answerEnv = parts[at[.answered] ?? source].environmentId
            let taskEnv = parts[at[.done] ?? source].environmentId
            for m in lifeos.sent {
                shipped.append(PlacedShipped(key: "sent:\(m.id)", kind: .sent, sector: m.sector, workspaceId: nil, title: m.subject, who: peopleWords(m.to, total: m.to.count), at: Double(m.at),
                                             open: .mail(.init(threadId: m.threadId)), job: m.sector, environmentId: sentEnv))
            }
            for t in lifeos.done {
                shipped.append(PlacedShipped(key: "done:\(t.id)", kind: .finished, sector: t.sector, workspaceId: nil, title: t.title, who: nil, at: Double(t.at),
                                             open: .task(.init(id: t.id)), job: t.sector, environmentId: taskEnv))
            }
            for a in lifeos.answered {
                shipped.append(PlacedShipped(key: "answered:\(a.threadId):\(num(Double(a.at)))", kind: .answered, sector: a.sector, workspaceId: nil, title: a.subject, who: a.by, at: Double(a.at),
                                             open: .mail(.init(threadId: a.threadId)), job: a.sector, environmentId: answerEnv))
            }
        }
        var slipped: [PlacedSlipped] = []
        var has: Set<String> = []
        // A meeting followed up in Prep on any host: in a week still running it is gone; in one that is over it reads
        // as dealt with since.
        let prepped = Set(parts.flatMap { $0.body.prepped ?? [] })
        let checkers: [SlippedKind: Int?] = [.task: checker(.task), .mail: checker(.mail)]
        let checks = checkers.compactMapValues { $0 }
        let verdicts = checks.mapValues(verdictOf)
        let prepFailed = parts.contains { $0.body.left.contains(Left.prep) }
        for i in all {
            let part = parts[i]
            for r in part.body.shipped {
                guard let job = rowJob(part.body, workspaceId: r.workspaceId, sector: r.sector), !job.isEmpty, jobAt[job] != nil else { continue }
                shipped.append(PlacedShipped(key: "\(part.environmentId):\(r.key)", kind: r.kind, sector: r.sector, workspaceId: r.workspaceId, title: r.title, who: r.who, at: Double(r.at),
                                             open: r.open, job: job, environmentId: part.environmentId))
            }
            for r in slippedFrom(i) {
                let job = rowJob(part.body, workspaceId: r.workspaceId, sector: r.sector)
                var key = r.key
                if case .held(let h) = r.ref, case .host = h.ref { key = "\(part.environmentId):\(r.key)" }
                guard let job, !job.isEmpty, jobAt[job] != nil, !has.contains(key) else { continue }
                has.insert(key)
                var followed = false
                if case .meeting(let m) = r.ref { followed = prepped.contains(m.eventId) }
                if followed && !over { continue }
                // A meeting is judged on one host's read but followed up in Prep on any: it stands as last known while
                // any host's Prep did not answer, or a host asked has not answered this time.
                let prepUnread = kindOf(r.ref) == .meeting && (freshOpt == false || prepFailed)
                let unchecked = part.stale || uncheckedIn(part.body, r.ref) || prepUnread
                // A kept task or wait its own host could not check, read whole this time on another host: that read
                // says whether it is still open, and a press goes to the host whose read said so.
                let kind: SlippedKind? = kindOf(r.ref).flatMap { $0 == .task || $0 == .mail ? $0 : nil }
                if let kind, unchecked, over, let said = verdicts[kind]?(r) {
                    slipped.append(placed(r, key: key, job: job, environmentId: parts[checks[kind]!].environmentId, open: said, unchecked: false))
                    continue
                }
                slipped.append(placed(r, key: key, job: job, environmentId: part.environmentId, open: followed ? false : r.open, unchecked: !followed && unchecked))
            }
        }
        shipped = stable(shipped, by: { $0.at > $1.at })
        slipped = stable(slipped, by: { $0.at > $1.at })

        let madeBy = rowsPart(.task) ?? rowsPart(.mail) ?? rowsPart(.meeting) ?? 0
        return Merged(
            from: from,
            to: to,
            tz: first.body.tz,
            // A running week's "So far, made" names the moment its hours are counted to; a week that is over, its newest read.
            madeAt: now < to ? span.to : all.map(made).max()!,
            by: parts[madeBy].body.by,
            over: now >= to,
            jobs: list,
            hours: hours,
            compare: compare,
            shipped: shipped,
            slipped: slipped,
            slippedAt: Double(parts[madeBy].body.slipped.at),
            answersKept: answersKept,
            lifeosFrom: source.map { parts[$0].environmentId },
            left: left,
            lifeosDown: lifeosDown,
            // An answer kept from before is no read of now: "nothing" stands only on LifeOS's facts read this time.
            known: Known(
                calendar: at[.events].map { !parts[$0].stale && own($0, .events) && calendarTo >= span.to } ?? false,
                calendarCounted: at[.events] != nil,
                desk: whole && readNow(.sent) && !missing(Left.threads, Left.held, Left.heldPart, Left.files, Left.filesPart),
                shipped: whole && readNow(.sent) && readNow(.answered) && readNow(.done) && !missing(Left.held, Left.heldPart),
                slipped: whole && readNow(.due) && readNow(.waits) && readFor(.meetings) && !missing(Left.prep, Left.meetings, Left.held, Left.heldPart)
            )
        )
    }

    static func placed(_ r: ReviewBody.Slipped.Row, key: String, job: String, environmentId: String, open: Bool, unchecked: Bool) -> PlacedSlipped {
        PlacedSlipped(key: key, ref: r.ref, sector: r.sector, workspaceId: r.workspaceId, title: r.title, at: Double(r.at), people: r.people, others: r.others,
                      open: open, unchecked: unchecked, job: job, environmentId: environmentId)
    }
}
