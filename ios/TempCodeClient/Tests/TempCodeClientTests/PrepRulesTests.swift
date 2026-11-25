import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    calendar.locale = Locale(identifier: "en_US")
    return calendar
}()

private let minute = 60_000.0
private let hour = 60 * minute
/// Tue Nov 24 2026, 00:00 UTC.
private let day = 1_795_478_400_000.0

/// A page for Budget sync, 2:00 to 2:45 PM, with the parts given as JSON.
private func page(doc: String = #"{"brief":null,"notes":null,"after":null}"#, event: String? = nil) -> PrepPagePhone {
    let ev = event ?? #"{"id":"e1","title":"Budget sync","startsAt":\#(day + 14 * hour),"endsAt":\#(day + 14.75 * hour),"allDay":false,"location":"RecWell 204","leaveAt":\#(day + 13.5 * hour)}"#
    let json = """
    {"workspaceId":"w","sector":"purdue","event":\(ev),"people":[],"morePeople":0,"tasks":[],"files":[],"last":null,
     "doc":\(doc),"rev":1,"state":"none","briefSessionId":null,"followSessionId":null,"briefUntil":null,"followUntil":null,
     "briefStartedAt":null,"followStartedAt":null,"drafts":[],"notesFile":null,"problems":[]}
    """
    return try! JSONDecoder().decode(PrepPagePhone.self, from: Data(json.utf8))
}

private func suggestion(_ id: String, _ state: String = "proposed") -> String {
    #"{"id":"\#(id)","title":"Task \#(id)","state":"\#(state)"}"#
}

@Suite struct PrepRulesTests {
    @Test func `before the meeting the page leads with Prepare, then Preparing while its thread works, then nothing`() {
        let before = day + 9 * hour
        #expect(PrepRules.verb(page(), now: before, calendar: utc) == .prepare)
        let started = try! JSONDecoder().decode(PrepPagePhone.self, from: Data(#"""
        {"workspaceId":"w","sector":"purdue","event":{"id":"e1","title":"Budget sync","startsAt":\#(day + 14 * hour),"endsAt":\#(day + 14.75 * hour),"allDay":false},
         "people":[],"morePeople":0,"tasks":[],"files":[],"last":null,"doc":{"brief":null,"notes":null,"after":null},"rev":1,"state":"working",
         "briefSessionId":"s1","followSessionId":null,"briefUntil":\#(before + 20 * minute),"followUntil":null,"briefStartedAt":\#(before),"followStartedAt":null,
         "drafts":[],"notesFile":null,"problems":[]}
        """#.utf8))
        #expect(PrepRules.verb(started, now: before + minute, calendar: utc) == .preparing)
        // The host's bound runs out on the phone's own clock, with no push.
        #expect(PrepRules.verb(started, now: before + 21 * minute, calendar: utc) == .prepare)
        // The phone's own row says the thread stopped.
        #expect(PrepRules.verb(started, now: before + minute, brief: "idle", calendar: utc) == .prepare)
        let briefed = page(doc: #"{"brief":{"matters":[{"text":"Budget is 5% over"}],"agreed":[],"files":[],"at":\#(before)},"notes":null,"after":null}"#)
        #expect(PrepRules.verb(briefed, now: before, calendar: utc) == nil)
        #expect(PrepRules.label(.preparing) == "Preparing")
    }

    @Test func `after the meeting it asks for notes, then Follow Up, then nothing once an outcome stands`() {
        let after = day + 15 * hour
        #expect(PrepRules.verb(page(), now: after, calendar: utc) == .addNotes)
        let noted = page(doc: #"{"brief":null,"notes":{"text":"Ship Friday","at":\#(after)},"after":null}"#)
        #expect(PrepRules.verb(noted, now: after, calendar: utc) == .followUp)
        // Notes kept early lead with Follow Up before the end too.
        #expect(PrepRules.verb(noted, now: day + 9 * hour, calendar: utc) == .followUp)
        let blank = page(doc: #"{"brief":null,"notes":{"text":"  ","at":\#(after)},"after":null}"#)
        #expect(PrepRules.verb(blank, now: after, calendar: utc) == .addNotes)
        let done = page(doc: #"{"brief":null,"notes":{"text":"Ship","at":\#(after)},"after":{"summary":[],"decisions":[],"questions":[],"tasks":[],"at":\#(after)}}"#)
        #expect(PrepRules.verb(done, now: after, calendar: utc) == nil)
    }

    @Test func `the line under the title says when, where and when to leave while that is ahead`() {
        let p = page()
        #expect(PrepRules.whenLine(p.event, now: day + 9 * hour, calendar: utc) == "Today, 2:00 to 2:45 PM, RecWell 204, leave 1:30 PM")
        #expect(PrepRules.whenLine(p.event, now: day + 14.5 * hour, calendar: utc) == "Today, 2:00 to 2:45 PM, RecWell 204")
        #expect(PrepRules.whenLine(p.event, now: day - 9 * hour, calendar: utc).hasPrefix("Tomorrow, "))
        let link = page(event: #"{"id":"e","title":"Call","startsAt":\#(day + 11.5 * hour),"endsAt":\#(day + 12.25 * hour),"allDay":false,"location":"https://teams.example/x"}"#)
        #expect(PrepRules.whenLine(link.event, now: day, calendar: utc) == "Today, 11:30 AM to 12:15 PM")
        let allDay = page(event: #"{"id":"e","title":"Offsite","startsAt":\#(day),"allDay":true}"#)
        #expect(PrepRules.timeWords(allDay.event, calendar: utc) == "all day")
        #expect(PrepRules.isOver(allDay.event, now: day + 23 * hour, calendar: utc) == false)
        #expect(PrepRules.isOver(allDay.event, now: day + 24 * hour, calendar: utc))
    }

    @Test func `rows say why they are there, once`() {
        #expect(PrepRules.problemWords([.people]) == "People’s mail and tasks did not load")
        #expect(PrepRules.problemWords([.tasks, .last]) == "Parts of this page did not load")
        #expect(PrepRules.problemWords([]) == nil)
        #expect(PrepRules.moreWords(3) == "and 3 more")
        #expect(PrepRules.moreWords(0) == nil)
        #expect(PrepRules.addLabel(1) == "Add 1 Task")
        #expect(PrepRules.addLabel(3) == "Add 3 Tasks")
        let draft = try! JSONDecoder().decode(PrepPagePhone.Draft.self, from: Data(#"{"outboxId":"o","subject":"Notes","to":["Maya Chen","Tom Beck","Ana Ruiz"]}"#.utf8))
        #expect(PrepRules.draftLine(draft) == "Follow-up to Maya Chen, Tom Beck and 1 more")
        let task = try! JSONDecoder().decode(PrepTask.self, from: Data(#"{"id":"t","title":"Quote","why":"waiting","who":"Tom Beck"}"#.utf8))
        #expect(PrepRules.taskLine(task) == "Waiting on Tom Beck")
    }

    @Test func `ticks start empty, Tick All takes what may be filed, and the answer keeps a failure with why`() {
        let p = page(doc: #"{"brief":null,"notes":null,"after":{"summary":[],"decisions":[],"questions":[],"tasks":[\#(suggestion("a")),\#(suggestion("b")),\#(suggestion("c", "filed")),\#(suggestion("d", "rejected"))],"at":1}}"#)
        let tasks = PrepRules.shownTasks(p)
        #expect(tasks.map(\.id) == ["a", "b", "c"])
        var ticks = PrepTicks()
        #expect(ticks.toFile(tasks).isEmpty)
        ticks.tickAll(tasks)
        #expect(ticks.toFile(tasks) == ["a", "b"])
        ticks.begin()
        // A filing in flight holds the ticks still.
        ticks.toggle("a")
        #expect(ticks.isTicked("a"))
        ticks.answered(["a", "b"], failed: [(id: "b", error: "LifeOS said no")])
        #expect(!ticks.isTicked("a"))
        #expect(ticks.failed == ["b": "LifeOS said no"])
        // A failed task is Retry's: no tick takes it.
        ticks.toggle("b")
        ticks.tickAll(tasks)
        #expect(!ticks.isTicked("b"))
        #expect(ticks.retrying == ["b"])
        #expect(PrepRules.failedWords(ticks.failed, tasks: tasks) == "“Task b” was not added")
        // The page read again: a task no longer proposed leaves.
        ticks.keep([])
        #expect(ticks.failed.isEmpty)
    }

    @Test func `his notes go after half a second of quiet, at once on leaving, and another window's words are never written over unseen`() {
        var desk = PrepNotesDesk(kept: "old")
        #expect(desk.take(now: 0) == nil)
        desk.edit("old and new", at: 10)
        #expect(desk.take(now: 10.2) == nil)
        let sent = desk.take(now: 10.5)
        #expect(sent?.text == "old and new")
        #expect(sent?.base == "old")
        // One save at a time.
        desk.edit("old and newer", at: 10.6)
        #expect(desk.take(now: 20, force: true) == nil)
        desk.answered(sent: "old and new", kept: "old and new", conflict: false, now: 11)
        #expect(desk.due == 11.5)
        let second = desk.take(now: 11, force: true)
        #expect(second?.base == "old and new")
        // Another window kept other words meanwhile: nothing written, his words stay, the line says so.
        desk.answered(sent: "old and newer", kept: "theirs", conflict: true, now: 12)
        #expect(desk.text == "old and newer")
        #expect(desk.line == PrepNotesDesk.changedLine)
        #expect(desk.due == nil)
        // Keep Mine sends his words over the ones he has now seen.
        #expect(desk.take(now: 13, force: true)?.base == "theirs")
    }

    @Test func `a page read again follows the host's words he has not changed`() {
        var desk = PrepNotesDesk(kept: "a")
        desk.heard("b")
        #expect(desk.text == "b")
        desk.edit("mine", at: 0)
        desk.heard("c")
        #expect(desk.text == "mine")
        #expect(desk.base == "c")
    }
}
