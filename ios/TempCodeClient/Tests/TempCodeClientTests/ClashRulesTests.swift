import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}()

private let minute = 60_000.0
private let hour = 60 * minute
/// Tue Nov 24 2026, 00:00 UTC.
private let day = 1_795_478_400_000.0

private func clash(_ json: String) -> ClashPhoneRow {
    try! JSONDecoder().decode(ClashPhoneRow.self, from: Data(json.utf8))
}

/// Staff meeting 2:00 to 3:00 PM (Purdue, an invitation), Varsity game 3:15 PM (Ref, his own), 38 minutes apart.
private func drive(shortBy: Double = 23, measured: Bool = true) -> ClashPhoneRow {
    clash("""
    {"id":"e1-e2","kind":"drive",
     "a":{"eventId":"e1","sector":"purdue","workspaceId":"w-p","title":"Staff meeting","startsAt":\(day + 14 * hour),"endsAt":\(day + 15 * hour),"location":"RecWell 204","can":["decline","propose"]},
     "b":{"eventId":"e2","sector":"ref","title":"Varsity game","startsAt":\(day + 15.25 * hour),"endsAt":\(day + 17 * hour),"location":"North gym","guests":true,"can":["move","late"]},
     "minutes":38,"miles":24,"measured":\(measured),"shortBy":\(shortBy)}
    """)
}

@Suite struct ClashRulesTests {
    @Test func `a route finds its clash by id, else the first live clash of the event a tell names`() {
        let list = [drive()]
        #expect(ClashRules.find("e1-e2", in: list, now: day)?.id == "e1-e2")
        #expect(ClashRules.find("e2", in: list, now: day)?.id == "e1-e2")
        // Once the later event is over the clash is settled: a tell's event finds nothing.
        #expect(ClashRules.find("e2", in: list, now: day + 18 * hour) == nil)
        #expect(ClashRules.find("gone", in: list, now: day) == nil)
    }

    @Test func `the title says what is wrong, as the desktop's dialog does`() {
        #expect(ClashRules.title(drive()) == "23 minutes short")
        #expect(ClashRules.title(drive(shortBy: 1)) == "1 minute short")
        #expect(ClashRules.title(drive(shortBy: 12, measured: false)) == "About 10 minutes short")
        let overlap = clash(#"{"id":"x","kind":"overlap","a":{"eventId":"a","sector":"ref","title":"A","startsAt":0,"endsAt":1},"b":{"eventId":"b","sector":"ref","title":"B","startsAt":0,"endsAt":1}}"#)
        #expect(ClashRules.title(overlap) == "Two things at once")
    }

    @Test func `the drive line is measured or about, and absent with no minutes`() {
        #expect(ClashRules.driveLine(minutes: 38, miles: 24, measured: true) == "38 min drive, 24 mi")
        #expect(ClashRules.driveLine(minutes: 38, miles: 2.5, measured: false) == "About 40 min, 2.5 mi")
        #expect(ClashRules.driveLine(minutes: 65, miles: nil, measured: nil) == "1 hr 5 min drive")
        #expect(ClashRules.driveLine(minutes: nil, miles: 24, measured: true) == nil)
    }

    @Test func `the sheet offers decline and propose only where LifeOS says the event allows them`() {
        let c = drive()
        #expect(ClashRules.ways(c.a) == [.decline, .propose])
        // His own event offers a move and Running late, which stay the desktop's.
        #expect(ClashRules.ways(c.b).isEmpty)
        #expect(ClashRules.Way.decline.wire == .decline)
        #expect(ClashRules.Way.propose.done("Staff meeting") == "Proposing a new time for Staff meeting…")
    }

    @Test func `a proposal starts filled with the latest quarter hour that still makes the drive, or the first after the other event`() {
        let c = drive()
        // The earlier event: it must end 38 minutes before 3:15 less the 0 minutes the later one asks him early.
        let early = ClashRules.freeAfter(c, eventId: "e1", now: day + 8 * hour, calendar: utc)
        #expect(early.start == day + 13.5 * hour)
        #expect(early.end - early.start == hour)
        // The later event: the first quarter hour after 3:00 PM plus the drive.
        let late = ClashRules.freeAfter(c, eventId: "e2", now: day + 8 * hour, calendar: utc)
        #expect(late.start == day + 15.75 * hour)
        #expect(late.end - late.start == 1.75 * hour)
        // Once that time is gone the earlier event is offered the first quarter hour after the later one and the drive.
        let gone = ClashRules.freeAfter(c, eventId: "e1", now: day + 16 * hour, calendar: utc)
        #expect(gone.start == day + 17.75 * hour)
        // Never a time already gone.
        let past = ClashRules.freeAfter(c, eventId: "e2", now: day + 16.1 * hour, calendar: utc)
        #expect(past.start == day + 16.25 * hour)
    }

    @Test func `a proposal's time must end after it starts and not be gone`() {
        #expect(ClashRules.timeProblem(start: day + hour, end: day + hour, now: day) == "It must end after it starts.")
        #expect(ClashRules.timeProblem(start: day - hour, end: day, now: day) == "That time has passed.")
        #expect(ClashRules.timeProblem(start: day + hour, end: day + 2 * hour, now: day) == nil)
    }

    @Test func `the pair goes back as the sheet showed it`() {
        let seen = ClashRules.seen(drive())
        #expect(seen.map(\.eventId) == ["e1", "e2"])
        #expect(seen[1].location == "North gym")
        #expect(seen[1].guests == true)
        #expect(seen[0].startsAt == Int(day + 14 * hour))
    }

    @Test func `an answer is recorded by its clash, and read back by the clash list`() {
        let c = drive()
        let ref = ClashPress.ref(c.id)
        #expect(ref == "clash:e1-e2")
        #expect(ClashPress.clashId(ofRef: ref) == "e1-e2")
        #expect(ClashPress.clashId(ofRef: "host:h1") == nil)
        let span = ClashPress.span(ofRev: ClashPress.rev(c))
        #expect(span?.from == Int(day + 14 * hour))
        #expect(span?.to == Int(day + 17 * hour))
        #expect(PressTruth.clash(listed: false) == .done)
        #expect(PressTruth.clash(listed: true) == .mayHaveGone)
        #expect(PendingPress.Kind.clashAnswer.readsBack)
        #expect(!PendingPress.Kind.clashAnswer.readsItem)
    }

    @Test func `the read that finds a clash runs a fortnight from the start of the day`() {
        let range = ClashRules.window(around: nil, now: day + 9 * hour, calendar: utc)
        #expect(range.from == Int(day))
        #expect(range.to == Int(day + 15 * 24 * hour))
    }
}
