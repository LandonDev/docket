import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Today's Swift port against Fixtures/today, which src/renderer/src/work/today/phoneFixtures.test.ts writes from
/// the window's own model and sources: each case's inputs go through `TodaySources` and `TodayModel`, and the page
/// must be the window's, field for field. A desktop change to Today that is not carried here fails this suite.
struct TodayParityTests {
    // MARK: - the files

    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/today")
    static let names: [String] = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    static func load(_ name: String) throws -> Case { try JSONDecoder().decode(Case.self, from: Data(contentsOf: dir.appendingPathComponent(name))) }

    struct Ref: Decodable, Hashable { var environmentId: String; var workspaceId: String }
    struct Named: Decodable { var environmentId: String; var workspaceId: String; var name: String }
    struct Read: Decodable {
        var error: String?
        var pending: Bool?
        var lost: [TodaySources.Lost]?
        var built: Bool
        var lifeos: TodaySources.LifeosRead { .init(error: error, pending: pending ?? false, lost: lost ?? []) }
    }
    struct JobValue<V: Decodable>: Decodable { var environmentId: String; var workspaceId: String; var value: V }
    struct Each<V: Decodable>: Decodable {
        var answers: [JobValue<V>]
        var loading: Bool?
        var stale: Bool?
        var away: Bool?
        var failed: [TodaySources.HostError]?
        var state: TodayReadState {
            .init(loading: loading ?? false, stale: stale ?? false, away: away ?? false, failed: (failed ?? []).map { TodayFailure(environmentId: $0.environmentId, error: $0.error, retry: .host($0.environmentId)) })
        }
    }
    struct Held: Decodable { var items: [TodaySources.HeldItem]; var requests: [TodaySources.HeldRequest]?; var names: [Named]; var loaded: Bool; var errors: [TodaySources.HostError] }
    struct Meetings: Decodable { var events: [TodaySources.Event]; var people: [String: [TodaySources.Person]]; var read: Read }
    struct Due: Decodable { var tasks: [TodaySources.Task]; var read: Read }
    struct Waiting: Decodable { var waits: [TodaySources.Wait]; var read: Read; var beyond: Bool? }
    struct Clashes: Decodable { var range: TodaySources.ClashRange?; var loading: Bool?; var error: String? }
    struct Review: Decodable { var asked: [String]; var answered: [String: TodaySources.ReviewReady?] }
    struct Prep: Decodable { var answers: [JobValue<PrepValue>] }
    struct PrepValue: Decodable, Hashable, Sendable { var meetings: [TodaySources.PrepMeeting] }
    struct Forms: Decodable, Hashable, Sendable { var forms: [TodaySources.Form] }
    struct Digest: Decodable { var rows: [TellRow]; var loaded: Bool; var errors: [TodaySources.HostError] }
    struct Extra: Decodable { var rows: [ExtraRow] }
    struct ExtraRow: Decodable { var key: String; var section: String; var title: String; var sector: String? }
    struct Sources: Decodable {
        var held: Held?
        var meetings: Meetings?
        var due: Due?
        var waiting: Waiting?
        var messages: Each<[TodaySources.Chat]>?
        var clashes: Clashes?
        var money: Each<TodaySources.Owed>?
        var review: Review?
        var prep: Prep?
        var msforms: Each<Forms>?
        var digest: Digest?
        var extra: Extra?
    }
    struct Span: Decodable { var from: Double; var to: Double }
    struct FoldsJSON: Decodable { var more: [String]; var earlier: [String] }
    struct StableSide: Decodable { var tasks: [TodaySources.Task]; var now: Double }
    struct Stable: Decodable { var before: StableSide; var after: StableSide }
    struct StableWant: Decodable, Equatable { var keys: [String]; var kept: [String]; var same: Bool }
    struct Expect: Decodable { var page: PageJSON?; var marks: [MarkJSON]?; var stable: StableWant? }
    struct Case: Decodable {
        var name: String
        var now: Double
        var timeZone: String
        var day: Span
        var jobs: [TodayWorkspace]
        var home: String?
        var lifeos: String
        var lifeosHost: String
        var sessionDown: Bool?
        var open: [String]?
        var folds: FoldsJSON?
        var gone: [String]?
        var sources: Sources
        var stable: Stable?
        var expect: Expect
    }

    // MARK: - the page as the fixtures write it

    struct RowJSON: Decodable, Equatable {
        var key, section: String
        var sector, job: String?
        var title: String
        var detail: String?
        var detailLate: Bool?
        var at: Double?
        var when, whenLine: String?
        var late, past: Bool?
        var lead, workspace, opens: String?
        var acts: [String]
    }
    struct LeftJSON: Decodable, Equatable { var job: String?; var what: String }
    struct FailureJSON: Decodable, Equatable {
        var environmentId, error: String
        var said, down: String?
        var left: LeftJSON?
        var sector: String?
        var waits: Bool?
        var retry: Bool?
    }
    struct SectionJSON: Decodable, Equatable {
        var id, title, state: String
        var pending, partial: Bool
        var bones: String?
        var empty: String
        var earlier, more: Int
        var away: Bool
        var left: Bool?
        var note: String?
        var failed: [FailureJSON]
        var rows: [RowJSON]
    }
    struct BlockJSON: Decodable, Equatable { var kind: String; var reach: String?; var failure: FailureJSON?; var section: SectionJSON? }
    struct PageJSON: Decodable, Equatable { var kind: String; var line: String?; var offline: [String]?; var keys: [String]?; var blocks: [BlockJSON]? }
    struct MarkJSON: Decodable, Equatable { var source, key: String; var note, whenLine: String?; var late: Bool?; var opens, act: String? }

    /// Spaces compare as spaces: ICU may put a narrow no-break space before AM and PM where Node wrote a plain one.
    static func plain(_ s: String?) -> String? { s?.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ") }
    static func flag(_ b: Bool) -> Bool? { b ? true : nil }

    static func json(_ r: TodayRow) -> RowJSON {
        RowJSON(key: r.key, section: r.section, sector: r.sector, job: r.job, title: plain(r.title)!, detail: plain(r.detail), detailLate: flag(r.detailLate), at: r.at,
                when: plain(r.when), whenLine: plain(r.whenLine), late: flag(r.late), past: flag(r.past), lead: r.lead?.kind,
                workspace: r.workspace.map { "\($0.environmentId)/\($0.workspaceId)" }, opens: r.open?.name, acts: r.acts.map(\.label))
    }
    static func json(_ f: TodayFailure) -> FailureJSON {
        FailureJSON(environmentId: f.environmentId, error: f.error, said: plain(f.said), down: f.down?.rawValue, left: f.left.map { LeftJSON(job: $0.job, what: $0.what) }, sector: f.sector, waits: flag(f.waits), retry: flag(f.retry != nil))
    }
    static func json(_ s: TodayModel.ShownSection) -> SectionJSON {
        SectionJSON(id: s.id, title: s.title, state: s.state.rawValue, pending: s.pending, partial: s.partial, bones: s.bones?.rawValue, empty: s.empty, earlier: s.earlier,
                    more: s.more, away: s.away, left: flag(s.left), note: plain(s.note), failed: s.failed.map(json), rows: s.rows.map(json))
    }
    static func json(_ p: TodayModel.Page) -> PageJSON {
        switch p {
        case .noJobs: return PageJSON(kind: "no-jobs")
        case .clear(let line): return PageJSON(kind: "clear", line: plain(line))
        case .day(let blocks, let offline, let keys):
            return PageJSON(kind: "day", offline: offline, keys: keys, blocks: blocks.map { block in
                switch block {
                case .lifeos(let down): BlockJSON(kind: "lifeos", reach: down.rawValue)
                case .connecting: BlockJSON(kind: "lifeos", reach: "connecting")
                case .refused(let hosts): BlockJSON(kind: "refused", reach: hosts.joined(separator: ","))
                case .lost(let f): BlockJSON(kind: "lost", failure: json(f))
                case .section(let s): BlockJSON(kind: "section", section: json(s))
                }
            })
        }
    }

    // MARK: - the port over a case

    static func calendar(_ c: Case) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: c.timeZone)!
        cal.locale = Locale(identifier: "en_US")
        return cal
    }

    /// A reach the port does not know fails the case rather than the run.
    static func reach(_ s: String) throws -> TodayModel.LifeosReach {
        switch s {
        case "ok": return .ok
        case "waiting": return .waiting
        case "connecting": return .connecting
        case "offline": return .offline
        default: return .down(try #require(TodayDown(rawValue: s), "a reach the port does not know: \(s)"))
        }
    }

    static func fed(_ c: Case) -> [TodayFed] {
        let cal = calendar(c)
        let s = c.sources
        let day = (from: c.day.from, to: c.day.to)
        let jobs = TodayJobs(c.jobs, home: c.home)
        let down = c.sessionDown ?? false
        func job(_ environmentId: String, _ workspaceId: String) -> TodayWorkspace { c.jobs.first { $0.environmentId == environmentId && $0.workspaceId == workspaceId }! }
        func answers<V: Hashable & Sendable>(_ list: [JobValue<V>]) -> [TodaySources.JobAnswer<V>] { list.map { .init(job($0.environmentId, $0.workspaceId), $0.value) } }
        var fed: [TodayFed] = []
        func add(_ id: String, _ answer: TodayAnswer) { fed.append(TodayFed(source: id, section: TodaySources.section(of: id), answer: answer)) }
        if let h = s.held {
            let names = Dictionary(h.names.map { (TodayPlace(environmentId: $0.environmentId, workspaceId: $0.workspaceId), $0.name) }, uniquingKeysWith: { a, _ in a })
            add("held", TodaySources.heldAnswer(h.items, requests: h.requests ?? [], loaded: h.loaded, errors: h.errors, now: c.now, names: names, calendar: cal))
        }
        if let m = s.meetings {
            let built = m.read.built ? TodaySources.meetingRows(m.events, day: day, now: c.now, jobs: jobs, people: m.people, calendar: cal) : nil
            add("meetings", TodaySources.lifeosAnswer(m.read.lifeos, rows: built?.rows, sessionDown: down, host: c.lifeosHost, what: "meetings", note: built?.note, jobs: jobs))
        }
        if let d = s.due {
            let rows = d.read.built ? TodaySources.dueRows(d.tasks, now: c.now, jobs: jobs, calendar: cal) : nil
            add("due", TodaySources.lifeosAnswer(d.read.lifeos, rows: rows, sessionDown: down, host: c.lifeosHost, what: "tasks", jobs: jobs))
        }
        if let w = s.waiting {
            let rows = w.read.built ? TodaySources.waitingRows(w.waits, today: day.from, jobs: jobs, calendar: cal) : nil
            add("waiting", TodaySources.waitingAnswer(TodaySources.lifeosAnswer(w.read.lifeos, rows: rows, sessionDown: down, host: c.lifeosHost, what: "mail", jobs: jobs), beyond: w.beyond ?? false))
        }
        if let m = s.messages { add("messages", m.state.answer(rows: TodaySources.chatRows(answers(m.answers), now: c.now, calendar: cal))) }
        if let k = s.clashes {
            add("clashes", TodaySources.clashAnswer(k.range, loading: k.loading ?? false, error: k.error, sessionDown: down, workspaces: c.jobs, host: c.lifeosHost, day: day.from, now: c.now, calendar: cal))
        }
        if let m = s.money { add("money", m.state.answer(rows: TodaySources.owedRows(answers(m.answers), today: TodayWords.localDay(day.from, cal), calendar: cal))) }
        if let r = s.review { add("review", TodaySources.reviewAnswer(asked: r.asked, answered: r.answered, now: day.from, calendar: cal)) }
        if let p = s.prep { add("prep", TodayAnswer(marks: TodaySources.prepMarks(answers(p.answers).map { .init($0.workspace, $0.value.meetings) }))) }
        if let f = s.msforms { add("msforms", f.state.answer(rows: TodaySources.responseRows(answers(f.answers).map { .init($0.workspace, $0.value.forms) }))) }
        if let d = s.digest { add("digest", TodaySources.alsoAnswer(d.rows, loaded: d.loaded, errors: d.errors, day: day, now: c.now, calendar: cal)) }
        if let e = s.extra { add("extra", TodayAnswer(rows: e.rows.map { TodayRow(key: $0.key, section: $0.section, sector: $0.sector, title: $0.title) })) }
        return fed
    }

    static func page(_ c: Case) throws -> TodayModel.Page {
        TodayModel.page(fed(c), jobs: c.jobs, lifeos: try reach(c.lifeos), folds: TodayModel.Folds(more: Set(c.folds?.more ?? []), earlier: Set(c.folds?.earlier ?? [])),
                        gone: Set(c.gone ?? []), open: c.open.map(Set.init))
    }

    // MARK: - the tests

    @Test func `every case the desktop wrote is here`() {
        #expect(Self.names.count >= 20)
    }

    @Test(arguments: names) func `the page is the window's`(_ name: String) throws {
        let c = try Self.load(name)
        let cal = Self.calendar(c)
        let day = TodayModel.dayBounds(c.now, calendar: cal)
        #expect(day.from == c.day.from && day.to == c.day.to, "dayBounds")
        if let stable = c.stable, let want = c.expect.stable {
            let jobs = TodayJobs(c.jobs, home: c.home)
            let before = TodaySources.dueRows(stable.before.tasks, now: stable.before.now, jobs: jobs, calendar: cal)
            let after = TodaySources.dueRows(stable.after.tasks, now: stable.after.now, jobs: jobs, calendar: cal)
            let kept = TodayModel.keepRows(before, after)
            #expect(StableWant(keys: kept.rows.map(\.key), kept: kept.rows.map(\.key).filter(kept.kept.contains), same: kept.same) == want)
            return
        }
        let want = try #require(c.expect.page)
        let got = Self.json(try Self.page(c))
        #expect(got.kind == want.kind)
        #expect(got.line == want.line)
        #expect(got.offline == want.offline)
        #expect(got.keys == want.keys)
        #expect(got.blocks?.count == want.blocks?.count)
        for (g, w) in zip(got.blocks ?? [], want.blocks ?? []) {
            #expect(g.kind == w.kind)
            #expect(g.reach == w.reach)
            #expect(g.failure == w.failure)
            guard let gs = g.section, let ws = w.section else {
                #expect(g.section == w.section)
                continue
            }
            #expect(gs.rows.count == ws.rows.count, "\(name) \(ws.id) rows")
            for (gr, wr) in zip(gs.rows, ws.rows) { #expect(gr == wr, "\(name) \(wr.key)") }
            var gNoRows = gs, wNoRows = ws
            gNoRows.rows = []
            wNoRows.rows = []
            #expect(gNoRows == wNoRows, "\(name) section \(ws.id)")
        }
        // Each source's marks, before they are laid on a row.
        let marks = Self.fed(c).flatMap { f in
            f.answer.marks.map { MarkJSON(source: f.source, key: $0.key, note: Self.plain($0.note), whenLine: Self.plain($0.whenLine), late: Self.flag($0.late), opens: $0.open?.name, act: $0.act?.label) }
        }
        #expect(marks == (c.expect.marks ?? []))
    }
}
