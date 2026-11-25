import Foundation
import Testing
@testable import TempCodeClient

/// A few of the weekly review's rules checked directly, beside the fixtures: the week's bounds across a clock
/// change, stepping weeks, and how a length is said.
struct WeekReviewTests {
    static let chicago = "America/Chicago"
    static let minute = 60_000.0
    static let hour = 60 * minute
    static func at(_ iso: String) -> Double { ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970 * 1000 }

    @Test func `a week runs Monday to Monday on the wall clock of its zone`() {
        let week = WeekReview.weekOf(Self.at("2026-11-19T20:00:00Z"), tz: Self.chicago)
        #expect(week == WeekReview.Week(from: Self.at("2026-11-16T06:00:00Z"), to: Self.at("2026-11-23T06:00:00Z")))
        // Sunday evening in Chicago is already Monday in UTC: the zone decides.
        #expect(WeekReview.weekOf(Self.at("2026-11-23T03:00:00Z"), tz: Self.chicago) == week)
        #expect(WeekReview.weekOf(week.to, tz: Self.chicago).from == week.to)
        #expect(WeekReview.weekWords(week, tz: Self.chicago) == "Week of Nov 16")
        #expect(WeekReview.localDay(week.to - 1, tz: Self.chicago) == "2026-11-22")
    }

    @Test func `a week with a clock change is 169 or 167 hours`() {
        let fall = WeekReview.weekOf(Self.at("2026-10-28T12:00:00Z"), tz: Self.chicago)
        #expect(fall.from == Self.at("2026-10-26T05:00:00Z"))
        #expect(fall.to == Self.at("2026-11-02T06:00:00Z"))
        #expect((fall.to - fall.from) / Self.hour == 169)
        let spring = WeekReview.weekOf(Self.at("2026-03-04T12:00:00Z"), tz: Self.chicago)
        #expect((spring.to - spring.from) / Self.hour == 167)
    }

    @Test func `stepping a week keeps midnight`() {
        let fall = WeekReview.weekOf(Self.at("2026-10-28T12:00:00Z"), tz: Self.chicago)
        let next = WeekReview.stepWeek(fall, by: 1, tz: Self.chicago)
        #expect(next == WeekReview.Week(from: fall.to, to: fall.to + 7 * 24 * Self.hour))
        #expect(WeekReview.stepWeek(next, by: -1, tz: Self.chicago) == fall)
        #expect(WeekReview.isWeek(from: fall.from, to: fall.to, tz: Self.chicago))
        #expect(!WeekReview.isWeek(from: fall.from, to: fall.to, tz: "UTC"))
        // A Tokyo host's Monday midnight is Sunday in Chicago: the week it names is still found.
        let tokyo = WeekReview.weekOf(Self.at("2026-11-18T12:00:00Z"), tz: "Asia/Tokyo")
        #expect(WeekReview.weekNamed(tokyo.from, tz: Self.chicago) == WeekReview.weekOf(Self.at("2026-11-18T12:00:00Z"), tz: Self.chicago))
    }

    @Test func `an estimate says about and keeps to the quarter hour`() {
        #expect(WeekReview.toQuarter(0) == 0)
        #expect(WeekReview.toQuarter(Self.minute) == 15 * Self.minute)
        #expect(WeekReview.toQuarter(22.5 * Self.minute) == 30 * Self.minute)
        #expect(WeekReview.toQuarter(22 * Self.minute) == 15 * Self.minute)
        #expect(WeekReview.hoursWords(4 * Self.hour + 37 * Self.minute, .estimate) == "about 4 hr 30 min")
        #expect(WeekReview.hoursWords(4 * Self.hour + 37 * Self.minute, .measured) == "4 hr 37 min")
        #expect(WeekReview.hoursWords(2 * Self.hour, .measured) == "2 hr")
        #expect(WeekReview.hoursWords(Self.minute, .estimate) == "about 15 min")
        #expect(WeekReview.totalWords(WeekReview.JobHours(job: "x", calendarMs: Self.hour, deskMs: Self.minute)) == "about 1 hr")
        #expect(WeekReview.totalWords(WeekReview.JobHours(job: "x", calendarMs: Self.hour)) == "1 hr")
        #expect(WeekReview.totalWords(WeekReview.JobHours(job: "x", ranMs: Self.hour)) == nil)
    }

    @Test func `desk time under an event is dropped`() {
        let mon = Self.at("2026-11-16T06:00:00Z")
        let p = { (m: Double) in WeekReview.Point(at: mon + 10 * Self.hour + m * Self.minute, job: "cosmic", kind: .said) }
        let rows = WeekReview.hoursOf(.init(jobs: ["cosmic", "purdue"], span: .init(from: mon, to: mon + 7 * 24 * Self.hour),
                                            events: [.init(job: "purdue", from: mon + 10 * Self.hour, to: mon + 11 * Self.hour)], points: [p(-10), p(5), p(20), p(55), p(65)]))
        #expect(rows[0].deskMs == 20 * Self.minute)
        #expect(rows[1].calendarMs == Self.hour)
        #expect(rows[0].stands.said == 5)
    }
}
