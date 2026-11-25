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

private let hour = 3_600_000.0
/// Tue Nov 24 2026, 00:00 UTC.
private let day = 1_795_478_400_000.0

/// A mail as the Outbox lists it: `ref` a LifeOS mail unless named, on its way with a time when `at` is given.
private func mail(_ state: String = "sending", at: Int? = 1_795_500_000_000, host: Bool = false, kind: String = "mail.send", unknown: Bool = false, error: String? = nil) -> OutboxItem {
    var json: [String: Any] = [
        "ref": host ? ["at": "host", "id": "h1"] : ["at": "lifeos", "table": "outbox", "id": "o1"],
        "kind": kind, "summary": "Send to Dana", "verb": "Send", "state": state, "createdAt": 1, "why": "lifeos", "updatedAt": 5,
    ]
    if let at { json["scheduledFor"] = at }
    if unknown { json["outcomeUnknown"] = true }
    if let error { json["error"] = error }
    return try! JSONDecoder().decode(OutboxItem.self, from: JSONSerialization.data(withJSONObject: json))
}

private func clash(_ json: String) -> ClashPhoneRow {
    try! JSONDecoder().decode(ClashPhoneRow.self, from: Data(json.utf8))
}

/// Staff meeting 2:00 to 3:00 PM (Purdue), Varsity game 3:15 PM (Ref), 23 minutes short.
private func drive(measured: Bool = true, b: String = "e2", bStart: Double = day + 15.25 * hour) -> ClashPhoneRow {
    clash("""
    {"id":"e1-\(b)","kind":"drive",
     "a":{"eventId":"e1","sector":"purdue","title":"Staff meeting","startsAt":\(day + 14 * hour),"endsAt":\(day + 15 * hour)},
     "b":{"eventId":"\(b)","sector":"ref","title":"Varsity game","startsAt":\(bStart),"endsAt":\(bStart + 2 * hour)},
     "minutes":38,"measured":\(measured),"shortBy":23}
    """)
}

/// Two Purdue things at once: a 2:00 PM sync and a 2:30 PM review.
private func overlap() -> ClashPhoneRow {
    clash("""
    {"id":"e1-e3","kind":"overlap",
     "a":{"eventId":"e1","sector":"purdue","title":"Staff meeting","startsAt":\(day + 14 * hour),"endsAt":\(day + 15 * hour)},
     "b":{"eventId":"e3","sector":"purdue","title":"Budget review","startsAt":\(day + 14.5 * hour),"endsAt":\(day + 15.5 * hour)}}
    """)
}

private func names(_ sector: String) -> String { ["ref": "Ref", "purdue": "Purdue"][sector] ?? sector.capitalized }

@Suite struct MailRulesTests {
    @Test func `a mail he timed in Mail is LifeOS's to move; a timed send of the hold keeps the Outbox's verbs`() {
        #expect(MailRules.timedInMail(mail()) == "o1")
        // The hold's own timed send, a held draft with no time, a host item and another kind: none.
        #expect(MailRules.timedInMail(mail("scheduled")) == nil)
        #expect(MailRules.timedInMail(mail("held", at: nil)) == nil)
        #expect(MailRules.timedInMail(mail(host: true)) == nil)
        #expect(MailRules.timedInMail(mail(kind: "calendar.op")) == nil)
    }

    @Test func `reschedule leaves out the time it already has`() {
        let now = Date(timeIntervalSince1970: (day + 9 * hour) / 1000)
        let all = OutboxModel.laterChoices(now: now, calendar: utc)
        var item = mail(at: all[0].at)
        #expect(MailRules.rescheduleChoices(item, now: now, calendar: utc).map(\.label) == all.dropFirst().map(\.label))
        item = mail(at: 1)
        #expect(MailRules.rescheduleChoices(item, now: now, calendar: utc).count == all.count)
    }

    @Test func `a lost send now is read back by the mail's time`() {
        let seen = "1795500000000"
        // Gone from the list, or sent: it went.
        #expect(MailRules.sendNowTruth(nil, rev: seen) == .done)
        #expect(MailRules.sendNowTruth(mail("sent", at: nil), rev: seen) == .done)
        // Timed earlier than he saw: LifeOS took the press.
        #expect(MailRules.sendNowTruth(mail(at: 1_795_400_000_000), rev: seen) == .done)
        // Still the time he saw: it never landed, and it waits as he saw it.
        let still = MailRules.sendNowTruth(mail(), rev: seen)
        #expect(still == .waiting(rev: seen))
        // On its way with no time: nothing known yet.
        #expect(MailRules.sendNowTruth(mail(at: nil), rev: seen) == nil)
        #expect(MailRules.sendNowTruth(mail("failed", at: nil, error: " Route down "), rev: seen) == .failed("Route down"))
        #expect(MailRules.sendNowTruth(mail("failed", at: nil, unknown: true), rev: seen) == .mayHaveGone)
    }

    @MainActor @Test func `the ledger reads a send now by its time, and a time he saw is still waiting`() {
        var out = PendingPresses()
        let press = PendingPress(host: "h", kind: .mailSendNow, ref: "lifeos:outbox:o1", rev: "1795500000000", at: 1)
        _ = out.leaving(press, linked: true)
        #expect(PressLedger.truth(mail(), for: press) == .waiting(rev: "1795500000000"))
        #expect(out.resolve(press.id, truth: PressLedger.truth(mail(), for: press)) == .stillWaiting)
        #expect(PendingPress.Kind.mailSendNow.readsBack && PendingPress.Kind.mailSendNow.readsItem)
    }

    @Test func `ask needs a key that may adopt, a sector not withheld and a job of it`() {
        #expect(MailRules.askIn(sector: "purdue", mayAdopt: true, workspaceId: nil, jobs: ["purdue": "w-p"]) == "w-p")
        #expect(MailRules.askIn(sector: "purdue", mayAdopt: true, workspaceId: "w-own", jobs: [:]) == "w-own")
        #expect(MailRules.askIn(sector: "purdue", mayAdopt: false, workspaceId: "w-own", jobs: [:]) == nil)
        #expect(MailRules.askIn(sector: "ref", mayAdopt: true, workspaceId: nil, jobs: ["purdue": "w-p"]) == nil)
        #expect(MailRules.askIn(sector: nil, mayAdopt: true, workspaceId: nil, jobs: ["purdue": "w-p"]) == nil)
    }

    @Test func `ask opens a known chat first, else the host's newest, else starts one`() throws {
        #expect(MailRules.chatToOpen(found: ["s2", "s1"], known: ["s1"]) == "s1")
        #expect(MailRules.chatToOpen(found: ["s2", "s1"], known: []) == "s2")
        #expect(MailRules.chatToOpen(found: [], known: ["s1"]) == nil)
        let adopt = MailRules.adopt(workspaceId: "w-p", mailThreadId: "th3")
        let json = String(decoding: try JSONEncoder().encode(adopt), as: UTF8.self)
        #expect(json.contains(#""kind":"mail""#) && json.contains(#""mailThreadId":"th3""#) && json.contains(#""workspaceId":"w-p""#))
    }

    @Test func `a mail's file is fetched first, and its share shows once the size is known`() {
        let attachment = CanvasItem(id: "i1", sessionId: "s1", workspaceId: "w1", kind: .pdf, title: "Bracket.pdf", source: .mail(MailSource(threadId: "th3", messageId: "m1", partId: "p1", name: "Bracket.pdf")), state: .open, position: 0, rev: 1, createdAt: 1, updatedAt: 1)
        let file = CanvasItem(id: "i2", sessionId: "s1", workspaceId: "w1", kind: .pdf, title: "Rules", source: .file(.init(host: "h1", path: "/w/Rules.pdf")), state: .open, position: 0, rev: 1, createdAt: 0, updatedAt: 0)
        #expect(MailRules.fetches(attachment) && !MailRules.fetches(file))
        #expect(MailRules.keeps(attachment, mayKeep: true) && !MailRules.keeps(attachment, mayKeep: false) && !MailRules.keeps(file, mayKeep: true))
        #expect(MailRules.fetchShare(received: 50, total: nil) == nil)
        #expect(MailRules.fetchShare(received: 50, total: 200) == 0.25)
        #expect(MailRules.fetchShare(received: 300, total: 200) == 1)
        #expect(MailRules.keptLine("Budget (1).xlsx") == "Saved to the workspace as Budget (1).xlsx")
    }

    @Test func `save to workspace is in more for a mail's file alone, before close`() {
        let attachment = CanvasItem(id: "i1", sessionId: "s1", workspaceId: "w1", kind: .pdf, title: "Bracket.pdf", source: .mail(MailSource(threadId: "th3", messageId: "m1", partId: "p1", name: "Bracket.pdf")), state: .open, position: 0, rev: 1, createdAt: 1, updatedAt: 1)
        let file = CanvasItem(id: "i2", sessionId: "s1", workspaceId: "w1", kind: .pdf, title: "Rules", source: .file(.init(host: "h1", path: "/w/Rules.pdf")), state: .open, position: 0, rev: 1, createdAt: 0, updatedAt: 0)
        #expect(ReaderVerbs.of(attachment, ReaderFacts(mayClose: true, inThread: true, mayKeep: true)) == [.find, .print, .keep, .close])
        #expect(!ReaderVerbs.of(attachment, ReaderFacts(mayKeep: false)).contains(.keep))
        #expect(!ReaderVerbs.of(file, ReaderFacts(mayKeep: true)).contains(.keep))
        #expect(ReaderVerb.keep.title == "Save to Workspace")
    }

    @Test func `an event's clash lines read from its own side, naming another job`() {
        #expect(MailRules.line(drive(), eventId: "e1", jobName: names, calendar: utc) == "23 min short before Varsity game (Ref)")
        #expect(MailRules.line(drive(), eventId: "e2", jobName: names, calendar: utc) == "23 min short after Staff meeting (Purdue)")
        #expect(MailRules.line(drive(measured: false), eventId: "e2", jobName: names, calendar: utc) == "About 25 min short after Staff meeting (Purdue)")
        // The same job is not named; the other's start is said.
        #expect(MailRules.line(overlap(), eventId: "e1", jobName: names, calendar: utc) == "Overlaps Budget review, 2:30 PM")
        #expect(MailRules.line(overlap(), eventId: "e3", jobName: names, calendar: utc) == "Overlaps Staff meeting, 2:00 PM")
    }

    @Test func `two drive lines that read alike each take the other's start`() {
        let lines = MailRules.lines([drive(), drive(b: "e4", bStart: day + 39.25 * hour)], eventId: "e1", jobName: names, calendar: utc)
        #expect(lines == ["23 min short before Varsity game (Ref), 3:15 PM", "23 min short before Varsity game (Ref), Wed 3:15 PM"])
    }

    @Test func `marks carry each event's lines and the host's leave time`() throws {
        let leave = try JSONDecoder().decode(ClashLeaveRow.self, from: Data(#"{"leaveAt":\#(day + 14.5 * hour),"from":"event","measured":true,"eventId":"e2"}"#.utf8))
        let marks = MailRules.marks(clashes: [drive(), overlap()], leaves: [leave], jobName: names, calendar: utc)
        #expect(marks["e1"]?.lines.count == 2)
        #expect(marks["e1"]?.leave == nil)
        #expect(marks["e2"]?.leave == Date(timeIntervalSince1970: (day + 14.5 * hour) / 1000))
        #expect(marks["e2"]?.lines == ["23 min short after Staff meeting (Purdue)"])
        #expect(marks["e3"]?.lines == ["Overlaps Staff meeting, 2:00 PM"])
        #expect(marks["e9"] == nil)
    }

    @Test func `a composer Send that was Checking says what became of it once heard, and asks for his eye when it did not go`() {
        #expect(MailRules.heardLate(.checking) == nil)
        #expect(MailRules.heardLate(.sending) == nil)
        #expect(MailRules.heardLate(.done, scheduled: false)?.line == "Sent")
        #expect(MailRules.heardLate(.done, scheduled: true)?.line == "Scheduled")
        // After a relaunch the phone no longer knows whether it had a time: a success names neither.
        #expect(MailRules.heardLate(.done)?.line == "LifeOS has your mail")
        #expect(MailRules.heardLate(.done)?.tell == false)
        #expect(MailRules.heardLate(.stillWaiting)?.line == "Not sent: the mail is still in Drafts")
        #expect(MailRules.heardLate(.failed("LifeOS refused it"))?.line == "Not sent: LifeOS refused it")
        #expect(MailRules.heardLate(.mayHaveGone)?.tell == true)
        #expect(MailRules.heardLate(.gone)?.tell == true)
    }

    @Test func `a Mail outcome goes to the capsule only while it shows, and a success to the plain notice only when none does`() {
        // Mail on screen: a success in its capsule alone; a refusal there and as the sticky notice.
        #expect(MailRules.outcomePlaces(sticky: false, capsuleShown: true) == (true, nil))
        #expect(MailRules.outcomePlaces(sticky: true, capsuleShown: true) == (true, .sticky))
        // A person's page, or a job he left whose scene is kept: nothing to a hidden capsule.
        #expect(MailRules.outcomePlaces(sticky: false, capsuleShown: false) == (false, .plain))
        #expect(MailRules.outcomePlaces(sticky: true, capsuleShown: false) == (false, .sticky))
    }
}
