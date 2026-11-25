import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The weekly review's Swift port against Fixtures/review, which src/renderer/src/work/review/phoneFixtures.test.ts
/// writes from review.ts itself: each case's parts decode as the contract's `ReviewBody`, go through
/// `WeekReview.merge` and the words, and must give the window's review, field for field. A desktop change to the
/// rules that is not carried here fails this suite, and the failure names the case and the path.
struct WeekReviewParityTests {
    // MARK: - the files

    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/review")
    static let names: [String] = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    static func load(_ name: String) throws -> Case { try JSONDecoder().decode(Case.self, from: Data(contentsOf: dir.appendingPathComponent(name))) }

    struct PartJSON: Decodable { var environmentId: String; var body: ReviewBody; var stale: Bool? }
    struct JobJSON: Decodable { var key: String; var sector: String?; var name: String }
    struct Opts: Decodable {
        var home: String?
        var names: [String: String]?
        var order: [String]?
        var jobs: [JobJSON]?
        var fresh: Bool?
        var whole: Bool?
    }
    struct Ask: Decodable { var at: Double; var named: Double }
    struct WeekJSON: Decodable, Equatable { var from: Double; var to: Double }
    struct CalendarJSON: Decodable, Equatable {
        var weekOf: WeekJSON
        var hours: Double
        var prev, next, named: WeekJSON
        var isWeek, isNotWeek: Bool
        var dayStart, dayAfter, dayBefore: Double
        var localDay: String
        var knownZone: Bool
    }
    struct LengthJSON: Decodable, Equatable { var ms: Double; var quarter: Double; var measured: String; var estimate: String }
    struct FactsJSON: Decodable, Equatable { var calendar: String; var calendarDetail, desk, deskDetail, ran: String? }
    struct JobWords: Decodable, Equatable {
        var job: String
        var total, stands: String?
        var facts: FactsJSON
        var compare: String?
        var lead, older: [String]
    }
    struct ShippedJSON: Decodable, Equatable { var key, lead, title, tail: String }
    struct SlippedJSON: Decodable, Equatable { var key, detail: String; var settle, settled: [String] }
    struct Words: Decodable {
        var week, made, nothing, hostOff: String
        var days: [String]
        var jobs: [JobWords]
        var shipped: [ShippedJSON]
        var slipped: [SlippedJSON]
    }
    struct Expect: Decodable { var merged: JSONValue; var calendar: CalendarJSON; var lengths: [LengthJSON]; var words: Words? }
    struct Case: Decodable {
        var name: String
        var tz: String
        var now: Double
        var parts: [PartJSON]
        var opts: Opts
        var calendar: Ask
        var days: [Double]
        var expect: Expect
    }

    // MARK: - the merged review as the fixtures write it

    static func str(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
    static func num(_ d: Double) -> JSONValue { .number(d) }

    static func json(_ m: WeekReview.Merged) throws -> JSONValue {
        var o: [String: JSONValue] = [
            "from": num(m.from), "to": num(m.to), "tz": .string(m.tz), "madeAt": num(m.madeAt), "by": .string(m.by.rawValue), "over": .bool(m.over),
            "jobs": .array(m.jobs.map { j in
                .object(["key": .string(j.key), "sector": str(j.sector), "name": .string(j.name),
                         "at": .array(j.at.map { .object(["environmentId": .string($0.environmentId), "workspaceId": .string($0.workspaceId)]) })])
            }),
            "hours": .array(m.hours.map { h in
                .object(["job": .string(h.job), "calendarMs": num(h.calendarMs), "deskMs": num(h.deskMs), "ranMs": num(h.ranMs), "events": num(Double(h.events)),
                         "stands": .object(["said": num(Double(h.stands.said)), "sent": num(Double(h.stands.sent)), "pressed": num(Double(h.stands.pressed)), "edited": num(Double(h.stands.edited))])])
            }),
            "compare": .array(m.compare.map { .object(["job": .string($0.job), "words": .string($0.words)]) }),
            "shipped": .array(try m.shipped.map { r in
                .object(["key": .string(r.key), "kind": .string(r.kind.rawValue), "sector": str(r.sector), "workspaceId": str(r.workspaceId), "title": .string(r.title),
                         "who": str(r.who), "at": num(r.at), "open": try r.open.map { try JSONValue($0) } ?? .null, "job": .string(r.job), "environmentId": .string(r.environmentId)])
            }),
            "slipped": .array(try m.slipped.map { r in
                var row: [String: JSONValue] = ["key": .string(r.key), "ref": try JSONValue(r.ref), "sector": str(r.sector), "workspaceId": str(r.workspaceId), "title": .string(r.title),
                                                "at": num(r.at), "people": .array(r.people.map(JSONValue.string)), "others": num(Double(r.others)), "open": .bool(r.open),
                                                "job": .string(r.job), "environmentId": .string(r.environmentId)]
                if r.unchecked { row["unchecked"] = .bool(true) }
                return .object(row)
            }),
            "slippedAt": num(m.slippedAt), "answersKept": .bool(m.answersKept), "lifeosFrom": str(m.lifeosFrom), "left": .array(m.left.map(JSONValue.string)),
            "known": .object(["calendar": .bool(m.known.calendar), "calendarCounted": .bool(m.known.calendarCounted), "desk": .bool(m.known.desk),
                              "shipped": .bool(m.known.shipped), "slipped": .bool(m.known.slipped)]),
        ]
        if !m.lifeosDown.isEmpty {
            o["lifeosDown"] = .array(m.lifeosDown.map { .object(["environmentId": .string($0.environmentId), "state": str($0.state?.rawValue), "kept": .bool($0.kept), "stale": .bool($0.stale)]) })
        }
        return .object(o)
    }

    /// The first place two trees differ, by its path; nil when they agree.
    static func diff(_ got: JSONValue, _ want: JSONValue, _ path: String) -> String? {
        switch (got, want) {
        case let (.object(g), .object(w)):
            for k in Set(g.keys).union(w.keys).sorted() {
                guard let gv = g[k], let wv = w[k] else { return "\(path).\(k): got \(g[k].map { $0.canonicalJSON() } ?? "nothing"), want \(w[k].map { $0.canonicalJSON() } ?? "nothing")" }
                if let d = diff(gv, wv, "\(path).\(k)") { return d }
            }
            return nil
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items, want \(w.count): got \(got.canonicalJSON()), want \(want.canonicalJSON())" }
            for (i, (gv, wv)) in zip(g, w).enumerated() {
                if let d = diff(gv, wv, "\(path)[\(i)]") { return d }
            }
            return nil
        default:
            return got == want ? nil : "\(path): got \(got.canonicalJSON()), want \(want.canonicalJSON())"
        }
    }

    // MARK: - the port over a case

    static func merge(_ c: Case) -> WeekReview.Merged? {
        var names: (@Sendable (String) -> String)?
        if let map = c.opts.names {
            names = { (sector: String) -> String in map[sector] ?? sector }
        }
        let parts: [WeekReview.Part] = c.parts.map { WeekReview.Part(environmentId: $0.environmentId, body: $0.body, stale: $0.stale ?? false) }
        let jobs: [WeekReview.MergedJob]? = c.opts.jobs?.map { WeekReview.MergedJob(key: $0.key, sector: $0.sector, name: $0.name) }
        return WeekReview.merge(parts, now: c.now, home: c.opts.home, names: names, order: c.opts.order, jobs: jobs, fresh: c.opts.fresh, whole: c.opts.whole)
    }

    static func words(_ m: WeekReview.Merged, _ c: Case) -> (jobs: [JobWords], shipped: [ShippedJSON], slipped: [SlippedJSON]) {
        let week = m.week
        let jobs = m.hours.map { h in
            let split = WeekReview.splitOlder(m.slipped.filter { $0.job == h.job }, week: week)
            let f = WeekReview.factsOf(h)
            return JobWords(job: h.job, total: WeekReview.totalWords(h), stands: WeekReview.standsWords(h.stands),
                            facts: FactsJSON(calendar: f.calendar, calendarDetail: f.calendarDetail, desk: f.desk, deskDetail: f.deskDetail, ran: f.ran),
                            compare: m.compare.first { $0.job == h.job }?.words, lead: split.lead.map(\.key), older: split.older.map(\.key))
        }
        let shipped = m.shipped.map { r in
            let w = WeekReview.shippedWords(r)
            return ShippedJSON(key: r.key, lead: w.lead, title: w.title, tail: w.tail)
        }
        let slipped = m.slipped.map { r in
            let kind = r.kind!
            return SlippedJSON(key: r.key, detail: WeekReview.slippedDetail(r, week: week, tz: m.tz),
                               settle: WeekReview.SettleHow.allCases.map { WeekReview.settleWords(kind, $0) },
                               settled: WeekReview.SettleHow.allCases.map { WeekReview.settledWords(kind, $0) })
        }
        return (jobs, shipped, slipped)
    }

    // MARK: - the tests

    @Test func `every case the desktop wrote is here`() {
        #expect(Self.names.count >= 24)
    }

    @Test(arguments: names) func `the calendar is the window's`(_ name: String) throws {
        let c = try Self.load(name)
        let want = c.expect.calendar
        let wk = WeekReview.weekOf(c.calendar.at, tz: c.tz)
        let w = { (x: WeekReview.Week) in WeekJSON(from: x.from, to: x.to) }
        let got = CalendarJSON(
            weekOf: w(wk), hours: (wk.to - wk.from) / 3_600_000,
            prev: w(WeekReview.stepWeek(wk, by: -1, tz: c.tz)), next: w(WeekReview.stepWeek(wk, by: 1, tz: c.tz)), named: w(WeekReview.weekNamed(c.calendar.named, tz: c.tz)),
            isWeek: WeekReview.isWeek(from: wk.from, to: wk.to, tz: c.tz), isNotWeek: WeekReview.isWeek(from: wk.from + 3_600_000, to: wk.to, tz: c.tz),
            dayStart: WeekReview.dayStart(c.calendar.at, tz: c.tz), dayAfter: WeekReview.dayStart(c.calendar.at, tz: c.tz, days: 1), dayBefore: WeekReview.dayStart(c.calendar.at, tz: c.tz, days: -1),
            localDay: WeekReview.localDay(c.calendar.at, tz: c.tz), knownZone: WeekReview.knownZone(c.tz))
        #expect(got == want, "\(name) calendar")
        for l in c.expect.lengths {
            #expect(LengthJSON(ms: l.ms, quarter: WeekReview.toQuarter(l.ms), measured: WeekReview.hoursWords(l.ms, .measured), estimate: WeekReview.hoursWords(l.ms, .estimate)) == l, "\(name) \(l.ms) ms")
        }
    }

    @Test(arguments: names) func `the merged review is the window's`(_ name: String) throws {
        let c = try Self.load(name)
        guard let m = Self.merge(c) else {
            #expect(c.expect.merged == .null, "\(name): no review")
            return
        }
        let d = Self.diff(try Self.json(m), c.expect.merged, "merged")
        #expect(d == nil, "\(name) \(d ?? "")")
    }

    @Test(arguments: names) func `the words are the window's`(_ name: String) throws {
        let c = try Self.load(name)
        let want = try #require(c.expect.words, "\(name) has no words")
        let m = try #require(Self.merge(c), "\(name): no review")
        #expect(WeekReview.weekWords(m.week, tz: m.tz) == want.week, "\(name) week")
        #expect(WeekReview.madeWords(m, now: c.now) == want.made, "\(name) made")
        #expect(WeekReview.nothingWords(m.known) == want.nothing, "\(name) nothing")
        #expect(WeekReview.hostOffWords("The Mac") == want.hostOff)
        #expect(c.days.map { WeekReview.dayWords($0, week: m.week, tz: m.tz) } == want.days, "\(name) days")
        let got = Self.words(m, c)
        #expect(got.jobs.count == want.jobs.count, "\(name) jobs")
        for (g, w) in zip(got.jobs, want.jobs) { #expect(g == w, "\(name) job \(w.job)") }
        #expect(got.shipped.count == want.shipped.count, "\(name) shipped")
        for (g, w) in zip(got.shipped, want.shipped) { #expect(g == w, "\(name) shipped \(w.key)") }
        #expect(got.slipped.count == want.slipped.count, "\(name) slipped")
        for (g, w) in zip(got.slipped, want.slipped) { #expect(g == w, "\(name) slipped \(w.key)") }
    }
}
