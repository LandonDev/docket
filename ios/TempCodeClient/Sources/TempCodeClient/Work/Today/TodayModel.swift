import Foundation

/// Today's page worked out from what its sources answered, with no view: a port, function for function, of the
/// desktop's src/renderer/src/work/today/model.ts and stable.ts. Fixtures the desktop writes
/// (Tests/TempCodeClientTests/Fixtures/today, scripts in src/renderer/src/work/today/phoneFixtures.test.ts) hold the
/// two to one answer.
public enum TodayModel {
    /// Today's own section for what no other section reads.
    public static let also = TodaySection(id: "also", title: "Also", order: 90, empty: "")

    // MARK: - days and jobs

    /// Today in local time: this midnight to the next, by the calendar, so a day of 23 or 25 hours is one day.
    public static func dayBounds(_ now: Double, calendar: Calendar) -> (from: Double, to: Double) {
        let from = calendar.startOfDay(for: date(now))
        return (ms(from), dayAfter(ms(from), 1, calendar: calendar))
    }

    /// The local midnight `days` days after the one that starts `from`.
    public static func dayAfter(_ from: Double, _ days: Int, calendar: Calendar) -> Double {
        let start = calendar.startOfDay(for: date(from))
        return ms(calendar.date(byAdding: .day, value: days, to: start) ?? start)
    }

    /// A workspace as the catalog lists it.
    public struct CatalogRow: Hashable, Sendable {
        public var id, environmentId, name, path: String
        public var kind: String?
        public var sector: String?

        public init(id: String, environmentId: String, name: String, path: String = "", kind: String?, sector: String?) {
            self.id = id
            self.environmentId = environmentId
            self.name = name
            self.path = path
            self.kind = kind
            self.sector = sector
        }
    }

    /// The jobs: every Work workspace with a sector on a host with Work on, in the catalog's order.
    public static func jobsOf(_ catalog: [CatalogRow], workHosts: Set<String>, openHosts: Set<String>) -> [TodayWorkspace] {
        catalog.compactMap { w in
            guard w.kind == "work", let sector = w.sector, !sector.isEmpty, workHosts.contains(w.environmentId) else { return nil }
            return TodayWorkspace(environmentId: w.environmentId, workspaceId: w.id, sector: sector, name: w.name, path: w.path, open: openHosts.contains(w.environmentId))
        }
    }

    /// The job a LifeOS row of `sector` opens in: matched by sector, never by link; where two hosts hold one, the one
    /// on the Work home, else the first whose link is open, else the first.
    public static func workspaceFor(_ sector: String, _ jobs: [TodayWorkspace], home: String?) -> TodayWorkspace? {
        let held = jobs.filter { $0.sector == sector }
        return held.first { $0.environmentId == home } ?? held.first { $0.open } ?? held.first
    }

    /// The hosts that hold a job and whose link is not open: each is named once at the page's foot.
    public static func offlineHosts(_ jobs: [TodayWorkspace]) -> [String] {
        unique(jobs.filter { !$0.open }.map(\.environmentId))
    }

    /// The hosts whose LifeOS session Today may read, in the order it tries them: the Work home, then each open host
    /// that holds a job (the desktop's lifeos.ts `lifeosHosts`).
    public static func lifeosHosts(_ jobs: [TodayWorkspace], home: String?) -> [String] {
        let open = unique(jobs.filter(\.open).map(\.environmentId))
        guard let home, open.contains(home) else { return open }
        return [home] + open.filter { $0 != home }
    }

    /// The host to read now: the first not found wanting; when all were, the first, whose state the page then says.
    public static func pickHost(_ hosts: [String], wanting: Set<String>) -> String? {
        hosts.first { !wanting.contains($0) } ?? hosts.first
    }

    /// The sectors the all-sector session lacks that some job needs, each with an open host other than the session's
    /// that holds that job. `cover` nil: not known yet; `["all"]`-like is passed as `.all`.
    public static func lackingOf(_ cover: TodayCover?, _ jobs: [TodayWorkspace], host: String) -> [(sector: String, environmentId: String)] {
        guard case .some(.sectors(let cover)) = cover else { return [] }
        var out: [(sector: String, environmentId: String)] = []
        for job in jobs where !cover.contains(job.sector) && !out.contains(where: { $0.sector == job.sector }) && job.open && job.environmentId != host {
            out.append((job.sector, job.environmentId))
        }
        return out
    }

    /// The jobs' sectors the all-sector session lacks and no other open host holds: nothing can read them.
    public static func uncoveredOf(_ cover: TodayCover?, _ jobs: [TodayWorkspace], host: String) -> [String] {
        guard case .some(.sectors(let list)) = cover else { return [] }
        let read = Set(lackingOf(cover, jobs, host: host).map(\.sector))
        return unique(jobs.map(\.sector).filter { !list.contains($0) && !read.contains($0) })
    }

    // MARK: - merge

    /// A section with its rows merged from every source.
    public struct MergedSection: Hashable, Sendable {
        public var def: TodaySection
        public var rows: [TodayRow] = []
        public var loading = false
        public var waiting = false
        public var partial = false
        public var failed: [TodayFailure] = []
        public var away = false
        public var left = false
        public var note: String?
    }

    /// A row with its marks laid on.
    static func lay(_ row: TodayRow, _ marks: [TodayMark]) -> TodayRow {
        guard !marks.isEmpty else { return row }
        var out = row
        // A fault's note (a clash) is said before a plain one (prep is ready).
        if let noted = marks.first(where: { $0.note != nil && $0.late }) ?? marks.first(where: { $0.note != nil }) {
            out.detail = noted.note
            out.detailLate = noted.late
        }
        if let lined = marks.first(where: { $0.whenLine != nil }) { out.whenLine = lined.whenLine }
        if let opened = marks.first(where: { $0.open != nil }) { out.open = opened.open }
        let acts = Array((marks.compactMap(\.act) + row.acts).prefix(2))
        if !acts.isEmpty { out.acts = acts }
        return out
    }

    /// Every source's answer as sections of rows: one row per key, the first source to give it winning; marks laid
    /// on; a row whose section no source declares left out; a failure of a source with no section said under Also.
    public static func merge(_ fed: [TodayFed], gone: Set<String> = []) -> [MergedSection] {
        var order: [String] = []
        var sections: [String: MergedSection] = [:]
        func add(_ def: TodaySection) {
            guard sections[def.id] == nil else { return }
            order.append(def.id)
            sections[def.id] = MergedSection(def: def)
        }
        for one in fed { if let section = one.section { add(section) } }
        add(also)
        var marks: [String: [TodayMark]] = [:]
        for one in fed { for mark in one.answer.marks { marks[mark.key, default: []].append(mark) } }
        var seen = Set<String>()
        for one in fed {
            for row in one.answer.rows ?? [] {
                guard sections[row.section] != nil, !seen.contains(row.key), !gone.contains(row.key) else { continue }
                seen.insert(row.key)
                sections[row.section]!.rows.append(lay(row, marks[row.key] ?? []))
            }
            let own = one.section.map(\.id).flatMap { sections[$0] != nil ? $0 : nil }
            let into = own ?? also.id
            for f in one.answer.failed where !sections[into]!.failed.contains(where: { same($0, f) }) { sections[into]!.failed.append(f) }
            if one.away || one.answer.away { sections[into]!.away = true }
            guard let own else { continue }
            let a = one.answer
            if a.loading { sections[own]!.loading = true }
            if a.loading && !a.stale { sections[own]!.waiting = true }
            if a.loading && a.rows != nil && !one.kept && !a.stale { sections[own]!.partial = true }
            if let note = a.note { sections[own]!.note = note }
        }
        // Stable sort by order: sections declared first keep their place on a tie.
        let indexed: [(index: Int, section: MergedSection)] = order.enumerated().map { (index: $0.offset, section: sections[$0.element]!) }
        let ordered: [MergedSection] = indexed.sorted { a, b in
            a.section.def.order != b.section.def.order ? a.section.def.order < b.section.def.order : a.index < b.index
        }.map { $0.section }
        return ordered.map { section in
            var s = section
            // Rows with no `at` keep their source's order after those with one.
            let rows: [(offset: Int, element: TodayRow)] = s.rows.enumerated().map { (offset: $0.offset, element: $0.element) }
            s.rows = rows.sorted { a, b in
                let x: Double = a.element.at ?? .infinity, y: Double = b.element.at ?? .infinity
                return x != y ? x < y : a.offset < b.offset
            }.map { $0.element }
            return s
        }.filter { !$0.def.empty.isEmpty || !$0.rows.isEmpty || !$0.failed.isEmpty }
    }

    /// Two failures that say one thing of one host (the desktop's dedupe).
    private static func same(_ a: TodayFailure, _ b: TodayFailure) -> Bool {
        a.environmentId == b.environmentId && a.said == b.said && a.error == b.error && a.down == b.down && a.waits == b.waits && a.sector == b.sector
    }

    // MARK: - fold

    /// What he has unfolded, by section id.
    public struct Folds: Hashable, Sendable {
        public var more: Set<String> = []
        public var earlier: Set<String> = []
        public init(more: Set<String> = [], earlier: Set<String> = []) {
            self.more = more
            self.earlier = earlier
        }
    }

    public struct ShownSection: Hashable, Sendable, Identifiable {
        public enum State: String, Hashable, Sendable { case bones, rows, empty }
        public var id: String
        public var title: String
        public var state: State
        public var pending: Bool
        public var partial: Bool
        public var bones: TodaySection.Bones?
        public var empty: String
        /// Rows that are over, folded at the head: how many, 0 once unfolded or with none.
        public var earlier: Int
        public var rows: [TodayRow]
        /// Rows under the fold: how many.
        public var more: Int
        /// Every late row, folded or not: what the Work list's line counts.
        public var late: Int
        public var failed: [TodayFailure]
        public var away: Bool
        public var left: Bool
        public var note: String?
    }

    /// A section as the page draws it: its past rows folded at the head, then its first `fold` rows and how many more.
    public static func fold(_ section: MergedSection, _ folds: Folds = Folds()) -> ShownSection {
        let def = section.def
        let past = section.rows.filter(\.past)
        let ahead = section.rows.filter { !$0.past }
        let showEarlier = folds.earlier.contains(def.id)
        let cap = def.fold.flatMap { !folds.more.contains(def.id) && ahead.count > $0 ? $0 : nil } ?? ahead.count
        let state: ShownSection.State = !section.rows.isEmpty ? .rows : section.waiting ? .bones : .empty
        return ShownSection(
            id: def.id, title: def.title, state: state, pending: section.loading, partial: section.partial && !section.rows.isEmpty,
            bones: def.bones, empty: def.empty, earlier: showEarlier ? 0 : past.count, rows: (showEarlier ? past : []) + ahead.prefix(cap),
            more: ahead.count - cap, late: section.rows.filter(\.late).count, failed: section.failed, away: section.away, left: section.left, note: section.note)
    }

    // MARK: - the page

    /// Whether the one LifeOS session can be read: `waiting` while it is on its way and its host's status is not heard
    /// yet; `connecting` while that host says its LifeOS is connecting, a wait the page's one line names; `offline`
    /// while no host that holds a job is linked; else the true state of a session that is down.
    public enum LifeosReach: Hashable, Sendable {
        case ok, waiting, connecting, offline
        case down(TodayDown)
    }

    public enum Block: Hashable, Sendable {
        case section(ShownSection)
        /// No host can read LifeOS: one line in the first LifeOS section's place.
        case lifeos(TodayDown)
        /// The host LifeOS is read through says it is still connecting: one line, a wait, no press, in the same place.
        case connecting
        /// Hosts that refused this key, at the foot in their own words (the phone's; the desktop has no refused key).
        case refused([String])
        /// A job's session on another host is down: one line for the page.
        case lost(TodayFailure)
    }

    public enum Page: Hashable, Sendable {
        case noJobs
        /// Everything answered, nothing left; `line` is what tomorrow starts with, when a section said it.
        case clear(line: String?)
        /// `keys`: every stop in page order, the rows and the fold lines between them.
        case day(blocks: [Block], offline: [String], keys: [String])
    }

    public enum FoldWhich: String, Hashable, Sendable { case more, earlier }
    public static func foldKey(_ which: FoldWhich, _ section: String) -> String { "fold:\(which.rawValue):\(section)" }
    public static func foldOf(_ key: String) -> (which: FoldWhich, section: String)? {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, parts[0] == "fold", let which = FoldWhich(rawValue: parts[1]) else { return nil }
        return (which, parts.dropFirst(2).joined(separator: ":"))
    }

    /// A section with nothing left in it: answered whole, no read failed, and no row but those that are over.
    static func done(_ s: ShownSection) -> Bool {
        s.failed.isEmpty && !s.pending && !s.away && !s.left && (s.state == .empty || (s.state == .rows && s.more == 0 && s.rows.allSatisfy(\.past)))
    }

    /// A failure from a host whose link is not open is taken out of its section; the host is named at the foot.
    static func apart(_ fed: [TodayFed], open: Set<String>) -> (fed: [TodayFed], away: [String]) {
        var away: [String] = []
        let closed = { (f: TodayFailure) in !f.environmentId.isEmpty && !open.contains(f.environmentId) }
        let out = fed.map { one -> TodayFed in
            guard one.answer.failed.contains(where: closed) else { return one }
            for f in one.answer.failed where closed(f) { away.append(f.environmentId) }
            var next = one
            next.answer.failed = one.answer.failed.filter { !closed($0) }
            next.away = true
            return next
        }
        return (out, away)
    }

    /// Kept rows of a sector no job holds now, or built for a workspace that is no longer a job, are left out.
    static func jobsOnly(_ fed: [TodayFed], _ jobs: [TodayWorkspace]) -> [TodayFed] {
        let held = Set(jobs.map(\.sector))
        let left = { (row: TodayRow) -> Bool in
            if let sector = row.sector, !held.contains(sector) { return true }
            if let w = row.workspace { return !jobs.contains { $0.environmentId == w.environmentId && $0.workspaceId == w.workspaceId } }
            return false
        }
        return fed.map { one in
            guard one.kept, let rows = one.answer.rows, rows.contains(where: left) else { return one }
            var next = one
            next.answer.rows = rows.filter { !left($0) }
            return next
        }
    }

    /// The whole page. "All clear" only when every source answered whole, none failed, no host is offline and nothing
    /// is left: a meeting that ended is not left.
    public static func page(_ fed: [TodayFed], jobs: [TodayWorkspace], lifeos: LifeosReach, folds: Folds = Folds(), gone: Set<String> = [], open: Set<String>? = nil) -> Page {
        guard !jobs.isEmpty else { return .noJobs }
        let down: TodayDown? = if case .down(let d) = lifeos { d } else { nil }
        // A down session and a known wait alike: one line for every section that reads LifeOS.
        let gives = down != nil || lifeos == .connecting
        let (apartFed, away) = open.map { apart(fed, open: $0) } ?? (fed, [])
        let reached = jobsOnly(apartFed, jobs)
        var blocks: [Block] = []
        var said = false
        var lostOrder: [String] = []
        var lostAt: [String: [TodayFailure]] = [:]
        // The hosts the foot names: a section whose only read was lost to one of them is left out (below).
        let offline = unique(offlineHosts(jobs) + away)
        // A section left out of the page held a read that did not come back: the page is never clear over it.
        var leftOut = false
        let lostKey = { (f: TodayFailure) in "\(f.environmentId)|\(f.down?.rawValue ?? (f.waits ? "connecting" : ""))" }
        // A read lost to a job's session on another host, said once for the page: down, or waiting on that host's LifeOS.
        let lostTo = { (f: TodayFailure) in f.down != nil || f.waits }
        for merged in merge(reached, gone: gone) {
            var section = merged
            if gives && section.def.lifeos {
                if !said { blocks.append(down.map(Block.lifeos) ?? .connecting) }
                said = true
                continue
            }
            if lifeos == .offline && section.def.lifeos {
                said = true
                continue
            }
            let lost = section.failed.filter(lostTo)
            if !lost.isEmpty {
                for f in lost {
                    let key = lostKey(f)
                    if lostAt[key] == nil {
                        blocks.append(.lost(f))
                        lostOrder.append(key)
                    }
                    lostAt[key, default: []].append(f)
                }
                section.failed = section.failed.filter { !lostTo($0) }
                section.left = true
            }
            if lifeos == .waiting && section.def.lifeos {
                section.loading = true
                section.waiting = true
            }
            let shownSection = fold(section, folds)
            // All it would draw is its heading: what it lost is said once already, by the page's line for a down
            // session or the foot for an offline host, so a bare heading is left out (DESIGN.md "Today", States).
            if bare(shownSection, footNames: !offline.isEmpty) {
                leftOut = true
                continue
            }
            blocks.append(.section(shownSection))
        }
        blocks = blocks.map { block in
            guard case .lost(let f) = block, let all = lostAt[lostKey(f)] else { return block }
            return .lost(lostLine(all))
        }
        let shown = blocks.compactMap { block -> ShownSection? in if case .section(let s) = block { s } else { nil } }
        let drawn = Set(shown.map(\.id))
        let out = reached.contains { one in one.answer.loading && !(one.section.map { drawn.contains($0.id) } ?? false) }
        if !said && !leftOut && !out && offline.isEmpty && shown.allSatisfy(done) {
            return .clear(line: shown.first { $0.note != nil }?.note)
        }
        let keys = shown.flatMap { s -> [String] in
            guard s.state == .rows else { return [] }
            return (s.earlier > 0 ? [foldKey(.earlier, s.id)] : []) + s.rows.map(\.key) + (s.more > 0 ? [foldKey(.more, s.id)] : [])
        }
        return .day(blocks: blocks, offline: offline, keys: keys)
    }

    /// A section that would draw its heading and nothing under it: no row, no line of its own, no note, and a read
    /// lost to a down session (`left`, said by the page's line) or to an offline host the foot names (`away`).
    static func bare(_ s: ShownSection, footNames: Bool) -> Bool {
        s.state == .empty && s.failed.isEmpty && s.note == nil && (s.left || (s.away && footNames))
    }

    /// "a", "a and b", "a, b and c".
    static func listed(_ items: [String]) -> String {
        items.count < 2 ? (items.first ?? "") : "\(items.dropLast().joined(separator: ", ")) and \(items.last!)"
    }

    /// One down session's line for the page: what every section lost to it, named once ("Ref's meetings, tasks and
    /// mail left out"), and one Retry that asks that host again for each of its sessions that is down, once each.
    public static func lostLine(_ failures: [TodayFailure]) -> TodayFailure {
        let first = failures[0]
        let jobs = unique(failures.compactMap { $0.left?.job })
        let whats = unique(failures.compactMap { $0.left?.what })
        let of = jobs.isEmpty ? listed(whats) : "\(listed(jobs.map { "\($0)'s" })) \(listed(whats))"
        let said = whats.isEmpty ? first.said : "\(of.prefix(1).uppercased())\(of.dropFirst()) left out"
        var sectors: [String] = []
        var retries: [TodayRetry] = []
        for f in failures {
            guard let retry = f.retry, !sectors.contains(f.sector ?? "") else { continue }
            sectors.append(f.sector ?? "")
            retries.append(retry)
        }
        return TodayFailure(environmentId: first.environmentId, error: first.error, said: said, down: first.down, waits: first.waits, retry: retries.isEmpty ? nil : .each(retries))
    }

    // MARK: - the store's rules (today/store.ts)

    /// What the store keeps of a source's answer: one with no rows at all that is reading again keeps the rows,
    /// marks and note it had (`putAnswer`). `kept` says the rows are that earlier whole answer.
    public static func kept(had: TodayAnswer?, answer: TodayAnswer) -> (answer: TodayAnswer, kept: Bool) {
        guard answer.loading, answer.rows == nil, let had, let rows = had.rows else { return (answer, false) }
        var out = answer
        out.rows = rows
        if !had.marks.isEmpty { out.marks = had.marks }
        if let note = had.note { out.note = note }
        return (out, true)
    }

    /// The keys his acts took off that some source still gives: a key no source gives is forgotten.
    public static func stillGiven(_ gone: Set<String>, _ answers: [TodayAnswer]) -> Set<String> {
        let given = Set(answers.flatMap { $0.rows ?? [] }.map(\.key))
        return gone.intersection(given)
    }

    /// What a source that threw answers from then on: one line that says so (`brokenAnswer`).
    public static func broken(_ source: String, ownSection: Bool) -> TodayAnswer {
        let what = ownSection ? "this" : (sourceWhat[source] ?? "everything")
        return TodayAnswer(rows: [], failed: [TodayFailure(environmentId: "", error: source, said: "Today could not show \(what)")])
    }

    /// The registry's order and words (today/sources.ts `TODAY_SOURCES`): the first source to give a key keeps it.
    public static let sources: [(id: String, what: String)] = [
        ("held", "what waits on your press"), ("meetings", "meetings"), ("due", "what is due"), ("waiting", "mail waiting on a reply"),
        ("messages", "messages"), ("clashes", "clashes"), ("money", "what is owed"), ("review", "the weekly review"),
        ("prep", "meeting prep"), ("msforms", "new form responses"), ("digest", "the digest"),
    ]
    static let sourceWhat = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0.what) })

    // MARK: - stable rows (stable.ts)

    /// What a row shows: two rows that agree here draw the same, whatever else they carry.
    static func sameFacts(_ a: TodayRow, _ b: TodayRow) -> Bool {
        a.key == b.key && a.section == b.section && a.sector == b.sector && a.title == b.title && a.detail == b.detail
            && a.detailLate == b.detailLate && a.at == b.at && a.when == b.when && a.whenLine == b.whenLine && a.late == b.late
            && a.past == b.past && a.lead == b.lead && a.acts.map(\.label) == b.acts.map(\.label) && a.suppliedBy == b.suppliedBy
    }

    /// `next`, with each row that shows what it showed before kept as the value it was, and which keys kept it. A row
    /// keeps its identity, not its place: a fresh answer that orders rows anew moves them (the desktop's `keepRows`).
    public static func keepRows(_ prev: [TodayRow], _ next: [TodayRow]) -> (rows: [TodayRow], kept: Set<String>, same: Bool) {
        let before = Dictionary(prev.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        var kept = Set<String>()
        let rows = next.map { row -> TodayRow in
            guard let was = before[row.key], sameFacts(was, row) else { return row }
            kept.insert(row.key)
            return was
        }
        let same = rows.count == prev.count && zip(rows, prev).allSatisfy { kept.contains($0.key) && $0.key == $1.key }
        return (same ? prev : rows, kept, same)
    }

    // MARK: - the Work list's line

    /// The Work list's Today line: what the rows under it do not say. The Outbox's row beside it already counts
    /// what waits on him, so the line never does. The next meeting not over with its time ("Budget sync at 2:00
    /// PM", "Budget sync now"); else what is due ("Book the ballroom due at 3:00 PM", "Book the ballroom, late", "3
    /// due, 1 late"); else nil.
    public static func workListLine(_ page: Page, now: Double, calendar: Calendar) -> String? {
        guard case .day(let blocks, _, _) = page else { return nil }
        let sections = blocks.compactMap { block -> ShownSection? in if case .section(let s) = block { s } else { nil } }
        if let next = sections.first(where: { $0.id == "meetings" })?.rows.first(where: { !$0.past && $0.when != "All day" }), let when = next.when {
            return next.whenLine == "Now" ? "\(next.title) now" : "\(next.title) at \(when)"
        }
        guard let due = sections.first(where: { $0.id == "due" }), let first = due.rows.first else { return nil }
        // Every due row, folded or not: the fold hides rows from the page, not from the count.
        let count = due.rows.count + due.more + due.earlier
        if count > 1 {
            let late = due.late
            return late > 0 ? "\(count) due, \(late) late" : "\(count) due"
        }
        if first.late { return "\(first.title), late" }
        // Not late and due before tomorrow: its time is today's clock. A pinned task has no time.
        return first.when.map { "\(first.title) due at \($0)" } ?? "\(first.title) due today"
    }

    // MARK: - helpers

    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
    static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
    static func unique(_ items: [String]) -> [String] {
        var seen = Set<String>()
        return items.filter { seen.insert($0).inserted }
    }
}

/// What the all-sector session covers (`auth:caller`): every sector, or these.
public enum TodayCover: Hashable, Sendable {
    case all
    case sectors([String])
}
