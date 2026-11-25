import Foundation
import TempCodeContract

/// The weekly review's rules, ported line by line from src/shared/work/review.ts (docs/agents/work-review.md): what a
/// week is, how evidence becomes hours, when the week before is worth a line, how every host's part becomes one
/// review, and every word the page says about them. Pure: no clock of its own. Fixtures/review, written by
/// src/renderer/src/work/review/phoneFixtures.test.ts from the real rules, hold the two together.
///
/// Two kinds of time are never mixed. Calendar time is measured: an event's own length. Desk time is an estimate
/// from what he did in TempCode, and it always says "about". Times are `Double` ms since the epoch; the wire's `Int`s
/// are turned at the edge.
public nonisolated enum WeekReview {
    // MARK: - the rulings, each one constant

    /// The week's first day: 1 is Monday (0 would be Sunday), so a weekend of games stays whole.
    public static let weekStarts = 1
    /// Things he did less than this apart are one sitting.
    public static let sittingGapMs: Double = 20 * 60_000
    /// A sitting is taken to have begun this long before its first sign.
    public static let leadMs: Double = 5 * 60_000
    /// An estimate is said to the quarter hour.
    public static let quarterMs: Double = 15 * 60_000
    /// The week before is worth a line only when the hours moved by this share and by this much.
    public static let compareShare = 0.25
    public static let compareMs: Double = 2 * 60 * 60_000
    /// A held item has slipped once it has waited this long.
    public static let heldSlipsMs: Double = 24 * 60 * 60_000
    /// Rows a job shows in Shipped before "Show all".
    public static let shippedShown = 5

    static let minute: Double = 60_000
    static let hour: Double = 60 * minute
    static let day: Double = 24 * hour

    // MARK: - the week

    /// One week, `[from, to)` in epoch ms, cut at midnight on the wall clock of a time zone.
    public struct Week: Hashable, Sendable, Codable {
        public var from: Double
        public var to: Double
        public init(from: Double, to: Double) {
            self.from = from
            self.to = to
        }
    }

    /// The zone by its name; one this runtime does not know reads as UTC.
    static func zone(_ tz: String) -> TimeZone { TimeZone(identifier: tz) ?? TimeZone(secondsFromGMT: 0)! }

    /// The wall clock of `tz` at `at`, as if it were UTC, to the second (as `Intl` reads it).
    static func wall(_ tz: TimeZone, _ at: Double) -> Double {
        let offset = Double(tz.secondsFromGMT(for: Date(timeIntervalSince1970: at / 1000))) * 1000
        return ((at + offset) / 1000).rounded(.down) * 1000
    }

    /// The instant the wall clock of `tz` reads `local` (a wall time written as UTC); a time a clock change skips
    /// lands just past the gap.
    static func instant(_ tz: TimeZone, _ local: Double) -> Double {
        let a = local - (wall(tz, local) - local)
        let b = local - (wall(tz, a) - a)
        for at in [b, a] where wall(tz, at) == local { return at }
        return max(a, b)
    }

    /// The day of the week of a UTC moment, 0 for Sunday (`getUTCDay`).
    static func utcWeekday(_ ms: Double) -> Int {
        let days = Int((ms / day).rounded(.down))
        return ((days % 7) + 7 + 4) % 7
    }

    /// Whether this runtime knows the zone.
    public static func knownZone(_ tz: String) -> Bool { TimeZone(identifier: tz) != nil }

    /// The week that holds `at`, in `tz`. A week with a clock change in it is 167 or 169 hours long.
    public static func weekOf(_ at: Double, tz: String) -> Week {
        let z = zone(tz)
        let local = wall(z, at)
        let midnight = (local / day).rounded(.down) * day
        let back = (utcWeekday(midnight) - weekStarts + 7) % 7
        let first = midnight - Double(back) * day
        return Week(from: instant(z, first), to: instant(z, first + 7 * day))
    }

    /// The week `by` weeks after (or, negative, before) `week`.
    public static func stepWeek(_ week: Week, by: Int, tz: String) -> Week {
        let z = zone(tz)
        let first = (wall(z, week.from) / day).rounded(.down) * day + Double(by) * 7 * day
        return Week(from: instant(z, first), to: instant(z, first + 7 * day))
    }

    /// The week a host names by its first moment, in `tz`. A host cuts weeks in its own zone: Monday midnight in
    /// Tokyo is still Sunday in New York, so the week is found from the middle of the one named.
    public static func weekNamed(_ from: Double, tz: String) -> Week { weekOf(from + 3.5 * day, tz: tz) }

    /// Whether `[from, to)` is a whole week of `tz`: the only span a host keeps.
    public static func isWeek(from: Double, to: Double, tz: String) -> Bool {
        let w = weekOf(from, tz: tz)
        return w.from == from && w.to == to
    }

    /// The first moment of the day `days` after the day that holds `at`.
    public static func dayStart(_ at: Double, tz: String, days: Int = 0) -> Double {
        let z = zone(tz)
        return instant(z, (wall(z, at) / day).rounded(.down) * day + Double(days) * day)
    }

    /// The local day that holds `at`, as "2026-11-16".
    public static func localDay(_ at: Double, tz: String) -> String {
        let midnight = (wall(zone(tz), at) / day).rounded(.down) * day
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = utc.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: midnight / 1000))
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    // MARK: - the facts a host answers

    /// What a point is a sign of: a message he wrote, a mail he sent, a held item he pressed, a document he changed.
    public enum PointKind: String, CaseIterable, Hashable, Sendable, Codable {
        case said, sent, pressed, edited
    }

    /// One sign that he was at the desk, as a host sends it: when, which of the body's `jobs` (its index), and what.
    public struct HostPoint: Hashable, Sendable {
        public var at: Double
        public var job: Int
        public var kind: PointKind
        public init(at: Double, job: Int, kind: PointKind) {
            self.at = at
            self.job = job
            self.kind = kind
        }
    }

    /// A body's points off the wire (`[at, job, kind]`); a malformed one is skipped.
    public static func hostPoints(_ rows: [[JSONValue]]) -> [HostPoint] {
        rows.compactMap { r in
            guard r.count >= 3, let at = r[0].doubleValue, let job = r[1].intValue, let kind = r[2].stringValue.flatMap(PointKind.init(rawValue:)) else { return nil }
            return HostPoint(at: at, job: job, kind: kind)
        }
    }

    /// A body's run time off the wire (`[job, ms]`).
    public static func hostRan(_ rows: [[JSONValue]]) -> [(job: Int, ms: Double)] {
        rows.compactMap { r in
            guard r.count >= 2, let job = r[0].intValue, let ms = r[1].doubleValue else { return nil }
            return (job, ms)
        }
    }

    // MARK: - hours

    /// A job across hosts: a sector, or, for a workspace with none, a key of its own.
    public static func jobKey(_ host: String, workspaceId: String, sector: String?) -> String { sector ?? "~\(host):\(workspaceId)" }
    public static func jobKey(_ host: String, _ job: ReviewBody.Job) -> String { jobKey(host, workspaceId: job.workspaceId, sector: job.sector) }

    public struct Span: Hashable, Sendable {
        public var from: Double
        public var to: Double
        public init(from: Double, to: Double) {
            self.from = from
            self.to = to
        }
    }

    /// A span under a job: a counted event, or a block of desk time.
    public struct Block: Hashable, Sendable {
        public var job: String
        public var from: Double
        public var to: Double
        public init(job: String, from: Double, to: Double) {
            self.job = job
            self.from = from
            self.to = to
        }
        var span: Span { Span(from: from, to: to) }
    }

    public struct Point: Hashable, Sendable {
        public var at: Double
        public var job: String
        public var kind: PointKind
        public init(at: Double, job: String, kind: PointKind) {
            self.at = at
            self.job = job
            self.kind = kind
        }
    }

    /// The part of an event that counts as calendar time: none when he declined it, hid it, or it lasts all day or
    /// has no end.
    public static func countedSpan(startsAt: Double, endsAt: Double?, allDay: Bool, declined: Bool, hidden: Bool) -> Span? {
        guard !(declined || allDay || hidden), let endsAt, endsAt > startsAt else { return nil }
        return Span(from: startsAt, to: endsAt)
    }

    public static func countedSpan(_ e: ReviewBody.Lifeos.Event) -> Span? {
        countedSpan(startsAt: Double(e.startsAt), endsAt: e.endsAt.map(Double.init), allDay: e.allDay, declined: e.declined, hidden: e.hidden)
    }

    static func clip(_ s: Span, _ within: Span) -> Span? {
        let from = max(s.from, within.from)
        let to = min(s.to, within.to)
        return to > from ? Span(from: from, to: to) : nil
    }

    /// Spans joined where they touch or overlap, in order.
    public static func joinSpans(_ spans: [Span]) -> [Span] {
        var out: [Span] = []
        for s in stable(spans, by: { $0.from < $1.from }) {
            if let last = out.last, s.from <= last.to {
                out[out.count - 1].to = max(last.to, s.to)
            } else {
                out.append(s)
            }
        }
        return out
    }

    static func lengthOf(_ spans: [Span]) -> Double { spans.reduce(0) { $0 + ($1.to - $1.from) } }

    /// `span` less every part of it that lies under one of `under` (joined, in order).
    static func less(_ span: Span, _ under: [Span]) -> [Span] {
        var out: [Span] = []
        var from = span.from
        for u in under {
            if u.to <= from { continue }
            if u.from >= span.to { break }
            if u.from > from { out.append(Span(from: from, to: u.from)) }
            from = max(from, u.to)
            if from >= span.to { break }
        }
        if from < span.to { out.append(Span(from: from, to: span.to)) }
        return out
    }

    /// The estimate's blocks. Points less than `sittingGapMs` apart, whatever their jobs, are one sitting. Each gap
    /// inside a sitting goes to the job of its later point, and `leadMs` leads the sitting's first point. So one
    /// point alone is five minutes.
    public static func deskBlocks(_ points: [Point]) -> [Block] {
        var out: [Block] = []
        var last: Double?
        for p in stable(points, by: { $0.at < $1.at }) {
            if let l = last, p.at - l < sittingGapMs {
                if p.at > l { out.append(Block(job: p.job, from: l, to: p.at)) }
            } else {
                out.append(Block(job: p.job, from: p.at - leadMs, to: p.at))
            }
            last = p.at
        }
        return out
    }

    /// What the estimate stands on, by kind.
    public struct Stands: Hashable, Sendable {
        public var said = 0
        public var sent = 0
        public var pressed = 0
        public var edited = 0
        public init(said: Int = 0, sent: Int = 0, pressed: Int = 0, edited: Int = 0) {
            self.said = said
            self.sent = sent
            self.pressed = pressed
            self.edited = edited
        }
        public subscript(kind: PointKind) -> Int {
            get {
                switch kind {
                case .said: said
                case .sent: sent
                case .pressed: pressed
                case .edited: edited
                }
            }
            set {
                switch kind {
                case .said: said = newValue
                case .sent: sent = newValue
                case .pressed: pressed = newValue
                case .edited: edited = newValue
                }
            }
        }
    }

    public struct Ran: Hashable, Sendable {
        public var job: String
        public var ms: Double
        public init(job: String, ms: Double) {
            self.job = job
            self.ms = ms
        }
    }

    public struct HourFacts: Sendable {
        /// every job, in the order they are listed: a job with nothing is still a row
        public var jobs: [String]
        /// the span that counts: the week, cut to now while it runs
        public var span: Span
        /// counted calendar spans, each under its job; one whose job is not listed counts for no job but still hides desk time
        public var events: [Block]
        public var points: [Point]
        public var ran: [Ran]
        public init(jobs: [String], span: Span, events: [Block] = [], points: [Point] = [], ran: [Ran] = []) {
            self.jobs = jobs
            self.span = span
            self.events = events
            self.points = points
            self.ran = ran
        }
    }

    public struct JobHours: Hashable, Sendable {
        public var job: String
        /// measured: his events' own length, overlaps inside the job counted once
        public var calendarMs: Double = 0
        /// estimated: sittings, less what a counted event already covers
        public var deskMs: Double = 0
        /// measured, and never part of his hours: how long the job's threads worked
        public var ranMs: Double = 0
        /// how many events were counted
        public var events = 0
        /// what the estimate stands on
        public var stands = Stands()
        public init(job: String, calendarMs: Double = 0, deskMs: Double = 0, ranMs: Double = 0, events: Int = 0, stands: Stands = Stands()) {
            self.job = job
            self.calendarMs = calendarMs
            self.deskMs = deskMs
            self.ranMs = ranMs
            self.events = events
            self.stands = stands
        }
    }

    /// A job's hours from the merged facts. The one place a number on the page is worked out.
    public static func hoursOf(_ f: HourFacts) -> [JobHours] {
        var rows: [JobHours] = []
        var index: [String: Int] = [:]
        for job in f.jobs {
            if let i = index[job] {
                rows[i] = JobHours(job: job)
            } else {
                index[job] = rows.count
                rows.append(JobHours(job: job))
            }
        }

        var byJob: [String: [Span]] = [:]
        var all: [Span] = []
        for e in f.events {
            guard let cut = clip(e.span, f.span) else { continue }
            all.append(cut)
            guard let i = index[e.job] else { continue }
            rows[i].events += 1
            byJob[e.job, default: []].append(cut)
        }
        for (job, spans) in byJob { rows[index[job]!].calendarMs = lengthOf(joinSpans(spans)) }

        // No hour counts twice: desk time under any counted event, of any job, is dropped.
        let covered = joinSpans(all)
        let inSpan = f.points.filter { $0.at >= f.span.from && $0.at < f.span.to }
        for p in inSpan {
            if let i = index[p.job] { rows[i].stands[p.kind] += 1 }
        }
        for block in deskBlocks(inSpan) {
            guard let i = index[block.job], let cut = clip(block.span, f.span) else { continue }
            rows[i].deskMs += lengthOf(less(cut, covered))
        }
        for r in f.ran {
            if let i = index[r.job] { rows[i].ranMs += r.ms }
        }
        return rows
    }

    /// His hours in a job: calendar plus desk. Threads' run time is never added.
    public static func totalMs(_ h: JobHours) -> Double { h.calendarMs + h.deskMs }

    // MARK: - the week before

    public struct Comparison: Hashable, Sendable {
        public var job: String
        public var words: String
        public init(job: String, words: String) {
            self.job = job
            self.words = words
        }
    }

    /// The week before, said only where it says something: a job whose hours moved by a quarter and by two hours, or
    /// one with two hours or more then and nothing now. `running`: this week is not over, so `before` holds the same
    /// span of last week and the words say so. A week that is over is compared with "the week before".
    public static func compareWeeks(_ now: [JobHours], _ before: [JobHours], running: Bool) -> [Comparison] {
        let then = Dictionary(before.map { ($0.job, $0) }, uniquingKeysWith: { _, b in b })
        let tail = running ? " by this point last week" : " the week before"
        var out: [Comparison] = []
        for h in now {
            guard let b = then[h.job] else { continue }
            let cur = totalMs(h)
            let was = totalMs(b)
            let said = totalWords(b)
            if cur <= 0 {
                if was >= compareMs, let said { out.append(Comparison(job: h.job, words: "\(said)\(tail)")) }
                continue
            }
            let moved = abs(cur - was)
            if moved < compareMs || moved < was * compareShare { continue }
            if let said {
                out.append(Comparison(job: h.job, words: "\(cur > was ? "up" : "down") from \(said)\(running ? tail : "")"))
            } else {
                out.append(Comparison(job: h.job, words: "nothing\(tail)"))
            }
        }
        return out
    }

    // MARK: - helpers

    /// A sort that keeps equal items in the order they came, as JavaScript's does.
    static func stable<T>(_ items: [T], by less: (T, T) -> Bool) -> [T] {
        items.enumerated().sorted { a, b in
            if less(a.element, b.element) { return true }
            if less(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// A number as JavaScript writes it in a string: whole ms with no fraction.
    static func num(_ d: Double) -> String {
        if d.rounded() == d, abs(d) < 9_007_199_254_740_992 { return String(Int(d)) }
        return String(d)
    }
}
