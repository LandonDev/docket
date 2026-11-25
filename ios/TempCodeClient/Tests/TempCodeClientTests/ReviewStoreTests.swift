import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@MainActor
private final class StandInWeek: WeekHost {
    let hostId: String
    var body: ReviewBody?
    var fails: (any Error)?
    var sums: [MoneySums.Row] = []
    var sumsFail = false
    var tz = "America/Chicago"
    private(set) var weeksAsked = 0
    private(set) var settled: [(ref: ReviewBody.Slipped.Row.Ref, how: WeekReview.SettleHow, sector: String?)] = []
    private(set) var undone: [String] = []
    private(set) var seen: [Int] = []

    init(_ id: String) { hostId = id }

    func reviewWeek(from: Int, to: Int, tz: String) async throws -> ReviewBody {
        weeksAsked += 1
        if let fails { throw fails }
        return body!
    }

    func reviewWeeks() async throws -> ReviewKeptList {
        try JSONDecoder().decode(ReviewKeptList.self, from: Data(#"{"weeks":[],"tz":"\#(tz)"}"#.utf8))
    }

    func settle(_ ref: ReviewBody.Slipped.Row.Ref, how: WeekReview.SettleHow, tz: String, sector: String?) async throws -> ReviewSettled {
        settled.append((ref, how, sector))
        return try JSONDecoder().decode(ReviewSettled.self, from: Data(#"{"undo":"tok1"}"#.utf8))
    }

    func undoSettle(token: String) async throws { undone.append(token) }
    func reviewSeen(from: Int) async throws { seen.append(from) }

    func moneySums(from: String, to: String) async throws -> MoneySums {
        if sumsFail { throw ReviewStoreError.noHost }
        return MoneySums(rows: sums)
    }
}

private struct Down: Error {}

@MainActor
@Suite struct ReviewStoreTests {
    static let tz = "America/Chicago"
    // Wed Nov 25 2026, 10:00 AM in Chicago.
    static let now = 1_795_586_400_000.0 + 10 * 3_600_000
    static var week: WeekReview.Week { WeekReview.weekOf(now, tz: tz) }

    static func body(host: String, jobs: [(String, String?)], slipped: [String] = [], left: [String] = []) -> ReviewBody {
        let w = week
        let jobsJSON = jobs.map { #"{"workspaceId":"\#($0.0)","sector":\#($0.1.map { "\"\($0)\"" } ?? "null"),"name":"\#($0.0)"}"# }.joined(separator: ",")
        let rows = slipped.joined(separator: ",")
        let leftJSON = left.map { "\"\($0)\"" }.joined(separator: ",")
        let json = """
        {"host":"\(host)","from":\(Int(w.from)),"to":\(Int(w.to)),"tz":"\(tz)","madeAt":\(Int(now)),"by":"owner","over":false,
         "jobs":[\(jobsJSON)],"lifeos":null,"points":[],"ran":[],"slipped":{"at":\(Int(now)),"rows":[\(rows)]},"shipped":[],"before":null,"left":[\(leftJSON)]}
        """
        return try! JSONDecoder().decode(ReviewBody.self, from: Data(json.utf8))
    }

    static func task(_ id: String, sector: String = "purdue") -> String {
        #"{"key":"task:\#(id)","ref":{"kind":"task","id":"\#(id)","dueAt":\#(Int(now) - 86_400_000)},"sector":"\#(sector)","workspaceId":null,"title":"Book the bus","at":\#(Int(now) - 86_400_000),"people":[],"others":0,"open":true}"#
    }

    static func mail(_ thread: String) -> String {
        #"{"key":"mail:\#(thread):1","ref":{"kind":"mail","threadId":"\#(thread)","since":1},"sector":"purdue","workspaceId":null,"title":"Travel budget","at":1,"people":["Dana Lee"],"others":0,"open":true}"#
    }

    static func input(_ id: String, platform: String? = nil, linked: Bool = true, may: Bool = true, jobs: [(String, String?)]) -> ReviewHostInput {
        ReviewHostInput(id: id, name: id == "box" ? "The box" : "The Mac", platform: platform, workOn: true, linked: linked, may: may,
                        jobs: jobs.map { .init(workspaceId: $0.0, sector: $0.1, name: $0.0) })
    }

    private func store(_ hosts: [StandInWeek]) -> ReviewStore {
        let byId = Dictionary(uniqueKeysWithValues: hosts.map { ($0.hostId, $0) })
        return ReviewStore(tz: Self.tz, now: { Self.now }, link: { byId[$0] }, words: { _ in ("Work is off on the host", false) })
    }

    private func sum(_ workspaceId: String, sector: String?, in cin: Double, out: Double, problem: Bool = false) -> MoneySums.Row {
        try! JSONDecoder().decode(MoneySums.Row.self, from: Data(#"{"workspaceId":"\#(workspaceId)","sector":\#(sector.map { "\"\($0)\"" } ?? "null"),"in":\#(cin),"out":\#(out),"owedToHim":0,"heOwes":0,"miles":0,"currency":"USD"\#(problem ? #","problem":true"# : "")}"#.utf8))
    }

    @Test func eachLinkedHostIsAskedAndTheWeekIsMerged() async {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [("b1", "purdue")], slipped: [Self.task("t1")])
        box.sums = [sum("b1", sector: "purdue", in: 240_000, out: 31_250)]
        let mac = StandInWeek("mac")
        let s = store([box, mac])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [("b1", "purdue")]), Self.input("mac", linked: false, jobs: [("m1", "ref")])])
        await s.load()
        let view = s.view
        #expect(box.weeksAsked == 1)
        #expect(mac.weeksAsked == 0) // off: never asked
        #expect(view.off == ["The Mac is off. Its threads and held items are not counted."])
        #expect(view.settled)
        #expect(view.merged?.slipped.map(\.key) == ["task:t1"])
        // Every job is listed, the one whose only host is off too.
        #expect(Set(view.merged?.jobs.map(\.key) ?? []) == ["purdue", "ref"])
        #expect(view.money["purdue"] == MoneyFigure(in: 240_000, out: 31_250))
    }

    @Test func aHostThatFailedIsOneLineAndItsLastAnswerStillCounts() async {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [("b1", "purdue")])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [("b1", "purdue")])])
        await s.load()
        box.fails = Down()
        await s.load()
        let view = s.view
        #expect(view.errors.map(\.error) == ["Work is off on the host."])
        #expect(view.errors.first?.kept == true)
        #expect(ReviewDesk.lines(view).over == ["Work is off on the host. Its last answer is shown."])
        #expect(view.merged != nil)
    }

    @Test func aPressGoesToItsHostTheRowLeavesAndUndoBringsItBack() async throws {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [("b1", "purdue")], slipped: [Self.task("t1")])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [("b1", "purdue")])])
        await s.load()
        let row = try #require(s.view.merged?.slipped.first)
        let done = try await s.settle(row, how: .later)
        #expect(box.settled.first?.how == .later)
        #expect(box.settled.first?.sector == "purdue")
        #expect(done.undo == "tok1")
        // Still listed open by the host, so it stays away until a read no longer lists it.
        #expect(s.view.gone == ["task:t1"])
        try await s.undo(done)
        #expect(s.view.gone.isEmpty)
        #expect(box.undone == ["tok1"])
    }

    @Test func aRowStaysAwayOnlyWhileItsWeekStillListsItOpen() async throws {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [("b1", "purdue")], slipped: [Self.task("t1")])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [("b1", "purdue")])])
        await s.load()
        _ = try await s.settle(try #require(s.view.merged?.slipped.first), how: .now)
        box.body = Self.body(host: "box", jobs: [("b1", "purdue")])
        await s.load()
        #expect(s.view.gone.isEmpty)
    }

    @Test func aNudgeGoesToAHostWithAWorkspaceOfTheJob() async throws {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [], slipped: [Self.mail("th1")])
        let mac = StandInWeek("mac")
        mac.body = Self.body(host: "mac", jobs: [("m1", "purdue")])
        let s = store([box, mac])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: []), Self.input("mac", jobs: [("m1", "purdue")])])
        await s.load()
        let merged = try #require(s.view.merged)
        let row = try #require(merged.slipped.first)
        #expect(row.environmentId == "box")
        #expect(ReviewDesk.settleHost(merged, row, .now) { _ in true } == "mac")
        #expect(ReviewDesk.settleHost(merged, row, .later) { _ in true } == "box")
        #expect(ReviewDesk.press(merged, row, .now) == .settle)
        #expect(ReviewDesk.target(merged, job: row.job, environmentId: row.environmentId, slipped: row.ref) == .workView(environmentId: "mac", workspaceId: "m1", view: "mail"))
    }

    @Test func seenIsToldOnceAWeek() async {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [])])
        s.markSeen()
        s.markSeen()
        for _ in 0..<5 { await Task.yield() }
        #expect(box.seen == [Int(Self.week.from)])
    }

    @Test func aKeyThatMayNotReadTheWeekAsksNothing() async {
        let box = StandInWeek("box")
        box.body = Self.body(host: "box", jobs: [])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", may: false, jobs: [])])
        await s.load()
        #expect(box.weeksAsked == 0)
        #expect(s.view.merged == nil)
    }

    @Test func theZoneIsTheHomesAndTheWeekFollowsIt() async {
        let box = StandInWeek("box")
        box.tz = "Asia/Tokyo"
        box.body = Self.body(host: "box", jobs: [])
        let s = store([box])
        s.update(hosts: [Self.input("box", platform: "linux", jobs: [])])
        await s.loadZone()
        #expect(s.tz == "Asia/Tokyo")
        #expect(s.week == WeekReview.weekOf(Self.week.from + (Self.week.to - Self.week.from) / 2, tz: "Asia/Tokyo"))
    }

    @Test func moneyIsAddedAcrossHostsAndABrokenLedgerShowsNoSum() {
        let parts: [WeekReview.Part] = []
        let hosts = [Self.input("box", jobs: [("b1", "purdue")]), Self.input("mac", jobs: [("m1", "purdue"), ("m2", "ref")])]
        let both = ReviewDesk.money(["box": [sum("b1", sector: "purdue", in: 100, out: 0)], "mac": [sum("m1", sector: "purdue", in: 50, out: 25), sum("m2", sector: "ref", in: 7, out: 0, problem: true)]],
                                    failed: [], parts: parts, hosts: hosts)
        #expect(both == ["purdue": MoneyFigure(in: 150, out: 25)])
        let failed = ReviewDesk.money(["box": [sum("b1", sector: "purdue", in: 100, out: 0)]], failed: ["mac"], parts: parts, hosts: hosts)
        #expect(failed.isEmpty) // the Mac holds Purdue too: the box's share is not the job's
    }

    @Test func wordsForAHostThatDidNotAnswer() {
        #expect(ReviewDesk.hostLine(nil, timedOut: true, name: "the box") == "The box did not answer.")
        #expect(ReviewDesk.hostLine(nil, timedOut: false, name: "The Mac") == "The Mac could not read the week.")
        #expect(ReviewDesk.hostLine("The Mac did not answer in time", timedOut: false, name: "The Mac") == "The Mac did not answer.")
        #expect(ReviewDesk.hostLine("Work is off on The Mac. Turn it on in Settings, Work.", timedOut: false, name: "The Mac") == "Work is off on The Mac. Turn it on in Settings, Work.")
    }

    @Test func weekNamesInThePicker() {
        let w = Self.week
        #expect(ReviewDesk.weekName(w, now: Self.now, tz: Self.tz) == "This Week")
        #expect(ReviewDesk.weekName(WeekReview.stepWeek(w, by: -1, tz: Self.tz), now: Self.now, tz: Self.tz) == "Last Week")
        #expect(ReviewDesk.weekName(WeekReview.stepWeek(w, by: -2, tz: Self.tz), now: Self.now, tz: Self.tz) == "Week of Nov 9")
    }
}
