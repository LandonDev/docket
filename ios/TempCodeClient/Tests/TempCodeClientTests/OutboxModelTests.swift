import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's Outbox model (Work/Outbox/OutboxModel.swift), held to what the
/// desktop's model.ts draws and sends.
@Suite struct OutboxModelTests {
    private func item(_ id: String, kind: OutboxItem.Kind = .mailSend, workspaceId: String? = "w1", sector: String? = "purdue", state: OutboxItem.State = .held, at: Int = 1, summary: String = "Send to events booking", payload: JSONValue? = nil) -> OutboxItem {
        OutboxItem(ref: .host(.init(id: id)), kind: kind, workspaceId: workspaceId, sessionId: "s1", sector: sector, summary: summary, verb: "Send", account: nil, state: state, payload: payload, createdAt: at, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: at)
    }

    private let mail: JSONValue = .object([
        "accountId": .string("acct_1"),
        "message": .object([
            "subject": .string("Ballroom for April 10"),
            "to": .array([.object(["name": .string("Events booking"), "address": .string("events@purdue.edu")])]),
            "from": .object(["name": .string("Landon"), "address": .string("landon@purdue.edu")]),
            "text": .string("Hello,\n\nCould you confirm it is free?"),
            "html": .string("<p>Hello,</p><p>Could you confirm it is free?</p>")
        ])
    ])

    @Test func aMailReadsAsTheActInAMailsOrderWithItsBodyApart() {
        let view = OutboxModel.payloadView(mail)
        #expect(view.fields.map(\.label) == ["From", "To", "Subject"])
        #expect(view.fields[0].value == "Landon")
        #expect(view.fields[0].detail == "landon@purdue.edu")
        #expect(view.fields[1].value == "Events booking <events@purdue.edu>")
        #expect(view.fields[1].edit == .addresses)
        #expect(view.body?.text == "Hello,\n\nCould you confirm it is free?")
        #expect(view.body?.path == ["message", "text"])
    }

    @Test func theUndoLineNamesAMailsRecipientsFromItsPayload() {
        let lifeos = item("m1", summary: "Send to events booking: Ballroom for April 10", payload: mail)
        #expect(OutboxModel.pendingLine(lifeos) == "Sending to Events booking")

        let office = OutboxItem(ref: .host(.init(id: "o1")), kind: .officeMailSend, workspaceId: "w1", sessionId: "s1", sector: "purdue", summary: "Reply to dlee@purdue.edu: Re: Ballroom", verb: "Reply", account: nil, state: .held, payload: .object(["host": .string("env_1"), "to": .array([.string("dlee@purdue.edu")]), "cc": .array([.string("a@b.edu"), .string("c@d.edu")]), "subject": .string("Re: Ballroom")]), createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: 1)
        #expect(OutboxModel.pendingLine(office) == "Replying to dlee@purdue.edu, a@b.edu and 1 more")
    }

    @Test func theHostThatHoldsAnActIsBookkeepingNotAField() {
        let call: JSONValue = .object(["host": .string("env_Q2gUxM8"), "channel": .string("#events"), "text": .string("Booked.\nSee you there.")])
        #expect(OutboxModel.payloadView(call).fields.map(\.label) == ["In"])
    }

    @Test func theToolDigestTheHoldSealsIsBookkeepingNotAField() {
        let call: JSONValue = .object(["addonId": .string("slack"), "toolDigest": .string(String(repeating: "4d73", count: 16)), "arguments": .object(["channel": .string("#events"), "text": .string("Booked.\nSee you there.")])])
        let view = OutboxModel.payloadView(call)
        #expect(view.fields.map(\.label) == ["In"])
        #expect(!view.fields.contains { $0.key == "toolDigest" })
    }

    private let us = Locale(identifier: "en_US")
    private let utc = TimeZone(identifier: "UTC")!
    /// Friday, November 20, 2026, 2:00 PM UTC, in milliseconds as the host keeps it.
    private let friday2pm = 1_795_183_200_000.0

    @Test func aKindsRowsEachHaveTheirOwnIdThoughTheirLabelsRepeat() {
        let fields = typing([.object(["action": .string("type"), "text": .string("one")]), .object(["action": .string("type"), "text": .string("two")])], [])
        #expect(fields.filter { $0.label == "Types" }.count == 2)
        #expect(Set(fields.map(\.id)).count == fields.count)
    }

    @Test func aLifeosCalendarActReadsAsTheActWithItsBoundEventNeverItsRow() {
        let row: JSONValue = .object([
            "id": .string("op_1"), "kind": .string("accept"), "account": .string("landon@purdue.edu"), "calendarId": .string("landon@purdue.edu"),
            "eventId": .string("ev_1"), "eventTitle": .string("Esports budget"), "eventStartsAt": .number(friday2pm), "eventEndsAt": .number(friday2pm + 1_800_000),
            "eventLocation": .string("Room 210"), "editedAt": .number(1_763_000_000_000), "plain": .bool(true), "route": .string("x"), "sector": .string("purdue"),
        ])
        let fields = OutboxModel.calendarFields(kind: .calendarOp, payload: row, locale: us, timeZone: utc) ?? []
        #expect(fields.map(\.label) == ["Event", "When", "Where", "Reply", "Calendar"])
        #expect(fields[1].value.hasPrefix("Fri, Nov 20, 2:00 to 2:30"))
        #expect(fields[1].value.hasSuffix("PM"))
        #expect(fields.map(\.value).contains("Room 210"))
        #expect(!fields.contains { $0.value.contains("1763") || $0.value.contains("{") })

        let create: JSONValue = .object(["kind": .string("create"), "account": .string("a@b.edu"), "calendarId": .string("team"),
                                         "payload": .object(["title": .string("Scrim"), "startsAt": .number(friday2pm), "attendees": .array([.object(["name": .string("Dana Lee"), "address": .string("dlee@purdue.edu")])])])])
        let made = OutboxModel.calendarFields(kind: .calendarOp, payload: create, locale: us, timeZone: utc) ?? []
        #expect(made.map(\.label) == ["Event", "When", "Invites", "Calendar"])
        #expect(made[2].value == "Dana Lee <dlee@purdue.edu>")
        #expect(made[3].value == "team, a@b.edu")
        #expect(OutboxModel.calendarFields(kind: .mailSend, payload: create) == nil)
    }

    @Test func anOutlookCalendarActReadsItsInviteAndItsAnswer() {
        let invite: JSONValue = .object(["host": .string("env_1"), "op": .string("create"), "event": .object([
            "subject": .string("Sync"), "start": .string("2026-11-20T14:00:00Z"), "end": .string("2026-11-20T15:30:00.000Z"),
            "location": .string("Teams"), "attendees": .array([.string("a@b.edu")]), "body": .string("<p>Agenda &amp; notes</p>"),
        ])])
        let made = OutboxModel.calendarFields(kind: .officeCalendarOp, payload: invite, locale: us, timeZone: utc) ?? []
        #expect(made.map(\.label) == ["Event", "When", "Where", "Invites", "Details"])
        #expect(made[1].value.hasPrefix("Fri, Nov 20, 2:00 to 3:30"))
        #expect(made[4].value == "<p>Agenda &amp; notes</p>")

        let answer: JSONValue = .object(["op": .string("answer"), "id": .string("x"), "subject": .string("Board"), "start": .string("2026-11-20T09:00:00-05:00"),
                                         "organizer": .string("boss@purdue.edu"), "answer": .string("tentative"), "comment": .string("Running late")])
        let reply = OutboxModel.calendarFields(kind: .officeCalendarOp, payload: answer, locale: us, timeZone: utc) ?? []
        #expect(reply.map(\.label) == ["Event", "When", "From", "Reply", "Note"])
        #expect(reply[1].value.hasPrefix("Fri, Nov 20, 2:00"))
        #expect(reply[3].value == "Maybe")
    }

    @Test func `shows an invitation's body exactly as it goes, plain text with nothing stripped`() {
        func details(_ body: String) -> String? {
            let invite: JSONValue = .object(["op": .string("create"), "event": .object(["subject": .string("Sync"), "start": .string("2026-11-20T14:00:00Z"), "body": .string(body)])])
            return OutboxModel.calendarFields(kind: .officeCalendarOp, payload: invite, locale: us, timeZone: utc)?.first { $0.label == "Details" }?.value
        }
        let body = "<title>I approve the payment.</title><p>Meet at 3</p>\n  second line "
        #expect(details(body) == body)
        // A body of spaces alone still goes, so it still shows.
        #expect(details("   ") == "   ")
        #expect(details("") == nil)
    }

    @Test func whenWordsSayADayPeriodOnceAndADayItemAsItsDay() {
        #expect(OutboxModel.whenWords(friday2pm, nil, allDay: true, locale: us, timeZone: utc) == "Fri, Nov 20")
        let morning = OutboxModel.whenWords(friday2pm - 4 * 3_600_000, friday2pm + 3_600_000, locale: us, timeZone: utc)
        #expect(morning.hasPrefix("Fri, Nov 20, 10:00"))
        #expect(morning.contains("AM to 3:00"))
    }

    @Test func anOutlookMailsBodyIsItsHtmlAsReadOnlyWords() {
        let office: JSONValue = .object(["host": .string("env_1"), "to": .array([.string("dlee@purdue.edu")]), "subject": .string("Ballroom"),
                                         "html": .string("<p>See <a href=\"https://rooms.purdue.edu\">rooms</a></p><img src=\"https://x/logo.png\" alt=\"Logo\">")])
        let view = OutboxModel.payloadView(office)
        #expect(view.body?.text == "See rooms (https://rooms.purdue.edu)\n\n[image Logo: https://x/logo.png]")
        #expect(view.body?.readOnly == true)
        #expect(view.body?.path == ["html"])
        // The edit leaves a read-only body alone.
        #expect(OutboxModel.applyEdits(office, ["html": "Hi"]).payload == office)
        // A LifeOS mail's text beside its html stays the body he edits.
        #expect(OutboxModel.payloadView(mail).body?.readOnly == false)
    }

    @Test func anAddonCallsArgumentsAreShownWholeWithNoFilterInside() {
        let call: JSONValue = .object(["addonId": .string("slack"), "toolDigest": .string("4d73"), "tool": .string("post"), "arguments": .object([
            "id": .string("x1"), "status": .null, "notes": .string(""), "channel": .object(["name": .string("#events"), "id": .string("C1")]),
            "tags": .array([]), "text": .string("Booked.\nSee you there."),
        ])])
        let view = OutboxModel.payloadView(call)
        #expect(view.fields.map(\.label) == ["In", "Id", "Notes", "Status", "Tags"])
        #expect(view.fields.map(\.value) == [##"{"id":"C1","name":"#events"}"##, "x1", #""""#, "null", "[]"])
        #expect(view.body?.text == "Booked.\nSee you there.")
    }

    @Test func aTeamsPostReadsInAndItsWordsAsTheBodyAtAnyLength() {
        let view = OutboxModel.payloadView(.object(["chat": .string("Esports staff"), "text": .string("Spring LAN is set")]))
        #expect(view.fields.map(\.label) == ["In"])
        #expect(view.body?.text == "Spring LAN is set")
        #expect(view.body?.path == ["text"])
        #expect(view.body?.readOnly == false)
    }

    @Test func aFormAShareAndAFrameioPostReadAsTheirOwnRows() {
        let form = OutboxModel.actView(item("f1", kind: .formPublish, payload: .object(["itemId": .string("itm_1"), "title": .string("LAN sign-up"), "rev": .number(4), "questions": .number(6), "content": .string("Name (short answer, required)")])))
        #expect(form.fields.map(\.label) == ["Questions"])
        #expect(form.fields.map(\.value) == ["6"])
        #expect(form.body?.text == "Name (short answer, required)")
        #expect(form.body?.readOnly == true)

        let share = OutboxModel.actView(item("g1", kind: .shareGoogle, payload: .object(["account": .string("a@b.edu"), "fileId": .string("1AbC"), "name": .string("Budget.xlsx"), "email": .string("dana@purdue.edu"), "role": .string("writer"), "notify": .bool(true)])))
        #expect(share.fields.map(\.label) == ["Person", "Access", "Account", "Notice"])
        #expect(share.fields.map(\.value) == ["dana@purdue.edu", "Can edit", "a@b.edu", "Tells them by mail"])
        let quiet = OutboxModel.actView(item("g2", kind: .shareGoogle, payload: .object(["email": .string("dana@purdue.edu"), "role": .string("reader"), "notify": .bool(false)])))
        #expect(quiet.fields.map(\.value) == ["dana@purdue.edu", "Can view"])

        let comment = OutboxModel.actView(item("p1", kind: .frameioPost, payload: .object(["what": .string("comment"), "account": .string("acc_1"), "fileId": .string("f_1"), "fileName": .string("cut.mp4"), "text": .string("Tighten the open"), "clock": .string("0:12"), "durationFrames": .number(48), "pin": .object(["x": .number(0.31), "y": .number(0.62)]), "shapes": .array([
            .object(["tool": .string("arrow"), "color": .string("#ff0000"), "x1": .number(0.1), "y1": .number(0.2), "x2": .number(0.5), "y2": .number(0.6)]),
            .object(["tool": .string("rect"), "color": .string("#ffffff"), "x": .number(0.2), "y": .number(0.3), "w": .number(0.25), "h": .number(0.1)]),
        ]), "height": .number(1080)])))
        #expect(comment.fields.map(\.label) == ["File", "At", "Pin", "Mark", "Mark"])
        #expect(comment.fields.map(\.value) == ["cut.mp4", "0:12, for 48 frames", "at 31% across, 62% down",
                                                "An arrow from 10% across, 20% down to 50% across, 60% down, red",
                                                "A box at 20% across, 30% down, 25% wide and 10% high, white"])
        let drawn = OutboxModel.marksWords(pin: nil, shapes: .array([.object(["tool": .string("ellipse")]), .object(["tool": .string("rect")]), .object(["tool": .string("rect")]), .object(["tool": .string("pen")])]))
        #expect(drawn.words == "An oval, 2 boxes and a drawn line")
        #expect(drawn.changes == "An oval as its box; a drawn line as straight lines")
        #expect(comment.body?.text == "Tighten the open")

        let version = OutboxModel.actView(item("p2", kind: .frameioPost, payload: .object(["what": .string("version"), "account": .string("acc_1"), "onto": .string("stk_1"), "ontoName": .string("cut.mp4"), "from": .string("~/Movies/cut v2.mp4"), "path": .string("/Users/l/Library/Application Support/TempCode/work-frameio/held/x"), "name": .string("cut v2.mp4"), "size": .number(734_003_200)])))
        #expect(version.fields.map(\.label) == ["On top of", "File", "Size", "From"])
        #expect(version.fields.map(\.value) == ["cut.mp4", "cut v2.mp4", "700 MB", "~/Movies/cut v2.mp4"])
        #expect(OutboxModel.megabytes(1.5 * 1024 * 1024) == "1.5 MB")
    }

    @Test func anOutlookReplyOffersNothingTheHostKeepsSoEditHides() {
        let reply: JSONValue = .object(["host": .string("env_1"), "account": .string("landon@purdue.edu"), "to": .array([.string("events@purdue.edu")]),
                                        "subject": .string("Re: Ballroom"), "replyTo": .string("AAMkAGI2NGVh"), "outlookAdds": .string("The mail from events@purdue.edu, under this one"),
                                        "html": .string("<p>Yes, thanks.</p>")])
        let view = OutboxModel.payloadView(reply)
        #expect(view.fields.map(\.label) == ["To", "Subject", "From", "Also goes"])
        #expect(view.fields.allSatisfy { $0.edit == nil })
        #expect(view.body?.readOnly == true)
        #expect(!view.fields.contains { $0.value.contains("AAMk") })

        var fresh = reply
        if case .object(var o) = fresh { o["replyTo"] = nil; o["outlookAdds"] = nil; fresh = .object(o) }
        #expect(OutboxModel.payloadView(fresh).fields.filter { $0.edit != nil }.map(\.label) == ["Subject"])
        // Inside an add-on call's arguments nothing is kept by the host: an account there is what goes.
        let call = OutboxModel.payloadView(.object(["arguments": .object(["account": .string("ops")])]))
        #expect(call.fields.first?.edit == .text)
    }

    @Test func aComputerActReadsAppWindowURLAndOnAlone() {
        let act = OutboxModel.actView(item("c2", kind: .computerAct, payload: .object([
            "tool": .string("computer"), "title": .string("Submit booking in Chromium"), "label": .string("Submit booking"),
            "app": .object(["name": .string("Chromium"), "bundleId": .null]), "window": .string("Arena booking"),
            "args": .object(["action": .string("left_click"), "element": .number(14), "url": .string("https://arena.example/book"), "app": .string("Chromium")]),
            "read": .object(["step": .number(0), "why": .string("control"), "label": .string("Submit booking"), "on": .string("button \"Submit booking\"")]),
        ])))
        #expect(act.fields.map(\.label) == ["App", "Window", "URL", "On", "Clicks"])
        #expect(act.fields.map(\.value) == ["Chromium", "Arena booking", "https://arena.example/book", "button \"Submit booking\"", "element 14"])
    }

    /// The desktop's list (model.test.ts), word for word, then the same words as the undo capsule's progressive.
    @Test(arguments: [("Make link", "Made link"), ("Reply", "Replied"), ("Pay", "Paid"), ("Answer maybe", "Answered maybe"), ("Move or rename files", "Moved or renamed files"),
                      ("Send invite", "Sent invite"), ("Upload", "Uploaded"), ("Drop class", "Dropped class"), ("Transfer", "Transferred"), ("Ship order", "Shipped order"),
                      ("Commit", "Committed"), ("Sell", "Sold"), ("Leave meeting", "Left meeting"), ("Withdraw", "Withdrew"), ("Stop", "Stopped"), ("Open", "Opened"),
                      ("Visit", "Visited"), ("Fix", "Fixed"), ("Show", "Showed"), ("Sign", "Signed"), ("Join", "Joined")])
    func thePastMatchesTheDesktops(verb: String, past: String) {
        #expect(OutboxModel.pastOf(verb) == past)
    }

    @Test(arguments: [("Stop", "Stopping"), ("Transfer", "Transferring"), ("Drop class", "Dropping class"), ("Ship order", "Shipping order"), ("Commit", "Committing"),
                      ("Run", "Running"), ("Quit", "Quitting"), ("Begin", "Beginning"), ("Open", "Opening"), ("Visit", "Visiting"), ("Fix", "Fixing"),
                      ("Show", "Showing"), ("Leave meeting", "Leaving meeting"), ("Pay", "Paying"), ("Reply", "Replying")])
    func theProgressiveDoublesAsThePastDoes(verb: String, progressive: String) {
        #expect(OutboxModel.progressive(verb) == progressive)
    }

    @Test func pastAndProgressiveTurnEveryVerbOfALabel() {
        #expect(OutboxModel.pastOf("Reply") == "Replied")
        #expect(OutboxModel.pastOf("Pay") == "Paid")
        #expect(OutboxModel.pastOf("Answer maybe") == "Answered maybe")
        #expect(OutboxModel.pastOf("Maybe") == "Answered maybe")
        #expect(OutboxModel.pastOf("Move or rename files") == "Moved or renamed files")
        #expect(OutboxModel.pastOf("Copy") == "Copied")
        #expect(OutboxModel.pastOf("Play") == "Played")
        #expect(OutboxModel.pastOf("Send invite") == "Sent invite")
        #expect(OutboxModel.progressive("Answer maybe") == "Answering maybe")
        #expect(OutboxModel.progressive("Maybe") == "Answering maybe")
        #expect(OutboxModel.progressive("Move or rename files") == "Moving or renaming files")
        #expect(OutboxModel.progressive("Submit") == "Submitting")
        #expect(OutboxModel.progressive("Make link") == "Making link")
        #expect(OutboxModel.progressive("Reply") == "Replying")
    }

    @Test func htmlWordsReadATagWholeWhereverItsQuotesPutAnAngle() {
        #expect(HtmlWords.of(#"<a title="><span" href="https://actual.test/private">Open</a>"#) == "Open (https://actual.test/private)")
        #expect(HtmlWords.of(#"<img alt="x>y" src="https://s.example/i.png">"#) == "[image x>y: https://s.example/i.png]")
        #expect(HtmlWords.of(#"<a title="x href='https://fake.example'" href="https://real.example">Go</a>"#) == "Go (https://real.example)")
        #expect(HtmlWords.attr(#"<a/href="https://a.example">"#, "href") == "https://a.example")
    }

    @Test func awayWritesAreTheStretchsWritesNeverASendOrLater() {
        func result(_ id: String, at: Int, held: Bool = false) -> WorkResult {
            WorkResult(id: id, sessionId: "s1", rootId: "s1", workspaceId: "w1", kind: "docs.edit", summary: id, account: nil, ref: held ? .object(["held": .object(["at": .string("host"), "id": .string("h1")])]) : nil, undo: nil, undoneAt: nil, createdAt: at)
        }
        let kept = OutboxModel.awayWrites([result("write", at: 50), result("send", at: 60, held: true), result("after", at: 200)], until: 100)
        #expect(kept.map(\.id) == ["write"])
        #expect(OutboxModel.unreadLine(["Box"]) == "Box did not answer")
        #expect(OutboxModel.unreadLine(["Box", "Mac"]) == "2 hosts did not answer")
        #expect(OutboxModel.unreadLine([]) == nil)
    }

    @Test func anOutlookAnswerSaysTheEndAndPlaceItKept() {
        let answer: JSONValue = .object(["op": .string("answer"), "subject": .string("Board"), "start": .string("2026-11-20T14:00:00Z"), "end": .string("2026-11-20T15:00:00Z"),
                                         "location": .string("Room 210"), "answer": .string("accept")])
        let rows = OutboxModel.calendarFields(kind: .officeCalendarOp, payload: answer, locale: us, timeZone: utc) ?? []
        #expect(rows.map(\.label) == ["Event", "When", "Where", "Reply"])
        #expect(rows[1].value.hasPrefix("Fri, Nov 20, 2:00 to 3:00"))
    }

    @Test func aComputerBatchShowsEveryStepAndEveryTypedTextInFull() {
        let long = String(repeating: "Dear Dana, the ballroom is booked. ", count: 6) + "Signed, Landon"
        let args: [String: JSONValue] = ["actions": .array([
            .object(["action": .string("type"), "text": .string(long)]),
            .object(["action": .string("left_click"), "element": .number(4)]),
            .object(["action": .string("key"), "text": .string("Return"), "repeat": .number(2)]),
            .object(["action": .string("screenshot")]),
            .object(["action": .string("scroll"), "scroll_direction": .string("up"), "scroll_amount": .number(3), "coordinate": .array([.number(10), .number(20)])]),
            .object(["action": .string("set_value"), "element": .number(9), "value": .string("Room 210")]),
        ])]
        let targets: JSONValue = .array([.object(["step": .number(1), "param": .string("element"), "sig": .string("button:Send < group:Compose"), "ordinal": .number(0), "count": .number(1)])])
        let rows = OutboxModel.stepRows(args: args, targets: targets)
        #expect(rows.map(\.0) == ["Types", "Clicks", "Presses", "Scrolls", "Sets"])
        #expect(rows[0].1 == "into the focus: " + long)
        #expect(rows[1].1 == #"button "Send""#)
        // The click put the focus on Send: the key goes there.
        #expect(rows[2].1 == #"Return, 2 times, in button "Send""#)
        #expect(rows[3].1 == "up 3 at the point 10,20")
        #expect(rows[4].1 == #"element 9 to "Room 210""#)
    }

    private func typing(_ steps: [JSONValue], _ targets: [JSONValue]) -> [OutboxModel.Field] {
        Array(OutboxModel.actView(item("c9", kind: .computerAct, payload: .object([
            "args": .object(["actions": .array(steps)]), "app": .object(["name": .string("Mail")]), "window": .string("New Message"), "targets": .array(targets),
        ]))).fields.dropFirst(2))
    }

    @Test func `names the field a typed text, a paste or a key goes to, so Bcc and Body never read the same`() {
        let click: JSONValue = .object(["action": .string("left_click"), "element": .number(9)])
        let send: JSONValue = .object(["step": .number(1), "param": .string("element"), "sig": .string("button:Send")])
        let bcc = typing([.object(["action": .string("type"), "element": .number(7), "text": .string("dana@purdue.edu")]), click],
                         [.object(["step": .number(0), "param": .string("element"), "sig": .string("textbox:Bcc < window:New Message")]), send])
        let body = typing([.object(["action": .string("type"), "element": .number(8), "text": .string("dana@purdue.edu")]), click],
                          [.object(["step": .number(0), "param": .string("element"), "sig": .string("textbox:Body < window:New Message")]), send])
        #expect(bcc[0].label == "Types")
        #expect(bcc[0].value == #"into textbox "Bcc": dana@purdue.edu"#)
        #expect(body[0].value == #"into textbox "Body": dana@purdue.edu"#)
        #expect(bcc.map(\.value) != body.map(\.value))
    }

    @Test func `sends a step with no target of its own to the focus the host bound, and says the focus once a Tab moves it`() {
        let rows = typing([.object(["action": .string("paste"), "text": .string("Hello")]), .object(["action": .string("key"), "text": .string("tab")]), .object(["action": .string("type"), "text": .string("Dana")])],
                          [.object(["step": .number(0), "param": .string("focus"), "sig": .string("textbox:Subject < window:New Message")])])
        #expect(rows.map(\.label) == ["Pastes", "Presses", "Types"])
        #expect(rows.map(\.value) == [#"into textbox "Subject": Hello"#, #"tab, in textbox "Subject""#, "into the focus: Dana"])
    }

    @Test func `says what a selection finds, in which field, and whether it selects it or puts the caret beside it`() {
        // In "Pay $100": select Pay then paste OK sends "OK $100"; the caret after Pay then paste OK sends "PayOK $100".
        func held(_ place: String? = nil) -> [OutboxModel.Field] {
            var select: [String: JSONValue] = ["action": .string("select_text"), "named": .string("Message"), "text": .string("Pay")]
            if let place { select["place"] = .string(place) }
            return typing([.object(select), .object(["action": .string("paste"), "text": .string("OK")]), .object(["action": .string("left_click"), "element": .number(9)])],
                          [.object(["step": .number(0), "param": .string("point"), "sig": .string("text area:Message < window:New Message")]),
                           .object(["step": .number(2), "param": .string("element"), "sig": .string("button:Send")])])
        }
        #expect(held().map(\.label) == ["Selects", "Pastes", "Clicks"])
        #expect(held().map(\.value) == [#"the first "Pay" in text area "Message""#, #"into text area "Message": OK"#, #"button "Send""#])
        #expect(held("after")[0].label == "Puts the caret")
        #expect(held("after")[0].value == #"after the first "Pay" in text area "Message""#)
        #expect(held("before")[0].value == #"before the first "Pay" in text area "Message""#)
        #expect(held("select").map(\.value) == held().map(\.value))
        #expect(held("after").map(\.value) != held().map(\.value))
        func one(_ step: [String: JSONValue]) -> OutboxModel.Field {
            typing([.object(step)], [.object(["step": .number(0), "param": .string("element"), "sig": .string("text area:Message < window:New Message")])])[0]
        }
        let narrowed = one(["action": .string("select_text"), "element": .number(4), "text": .string("Pay"), "prefix": .string("Total: "), "suffix": .string(" now")])
        #expect(narrowed.label == "Selects")
        #expect(narrowed.value == #"the first "Pay" right after "Total: " and right before " now" in text area "Message""#)
        let span = one(["action": .string("select_text"), "element": .number(4), "range": .array([.number(4), .number(9)]), "place": .string("after")])
        #expect(span.label == "Puts the caret")
        #expect(span.value == #"after characters 4 to 9 in text area "Message""#)
    }

    @Test func `shows every prefix and suffix given, spaces alone included, quoted with what cannot be seen escaped`() {
        func caret(_ more: [String: JSONValue]) -> String {
            var step: [String: JSONValue] = ["action": .string("select_text"), "element": .number(4), "text": .string("Pay"), "place": .string("after")]
            step.merge(more) { _, new in new }
            return typing([.object(step)], [.object(["step": .number(0), "param": .string("element"), "sig": .string("text area:Message < window:New Message")])])[0].value
        }
        // "Pay" with a space before it is another occurrence than the first "Pay": the rows must differ.
        #expect(caret([:]) == #"after the first "Pay" in text area "Message""#)
        #expect(caret(["prefix": .string(" ")]) == #"after the first "Pay" right after " " in text area "Message""#)
        #expect(caret(["suffix": .string("  ")]) == #"after the first "Pay" right before "  " in text area "Message""#)
        #expect(caret(["prefix": .string("\t"), "suffix": .string("\n")]) == #"after the first "Pay" right after "\t" and right before "\n" in text area "Message""#)
        // A no-break space looks like a space and is not one.
        #expect(caret(["prefix": .string("\u{00A0}")]) == #"after the first "Pay" right after "\u00a0" in text area "Message""#)
        #expect(caret(["prefix": .string("\u{00A0}")]) != caret(["prefix": .string(" ")]))
        #expect(caret(["prefix": .string(#"say ""#)]) == #"after the first "Pay" right after "say \"" in text area "Message""#)
    }

    @Test func `keeps the field in every row of a long batch, whatever the title cuts`() {
        let fields = ["To", "Cc", "Subject", "Message"]
        let steps: [JSONValue] = fields.enumerated().flatMap { i, name in
            [JSONValue.object(["action": .string("select_text"), "named": .string(name), "text": .string("x")]), .object(["action": .string("paste"), "text": .string("line \(i)")])]
        }
        let targets: [JSONValue] = fields.enumerated().map { i, name in .object(["step": .number(Double(i * 2)), "param": .string("point"), "sig": .string("text area:\(name) < window:New Message")]) }
        let rows = typing(steps, targets)
        #expect(rows.count == 8)
        for (i, row) in rows.enumerated() { #expect(row.value.contains(#"text area ""# + fields[i / 2] + #"""#)) }
    }

    @Test func `a Frame.io drawn line draws every point of its path in order, exactly, with its thickness`() {
        func pen(_ mid: [Double]) -> String {
            let shape: JSONValue = .object(["tool": .string("pen"), "color": .string("#ff3b30"), "width": .number(0.003), "points": .array([[0.1, 0.1], mid, [0.5, 0.5]].map { .array($0.map(JSONValue.number)) })])
            let view = OutboxModel.actView(item("p9", kind: .frameioPost, payload: .object(["what": .string("comment"), "fileName": .string("a.mp4"), "text": .string("Here"), "clock": .string("0:01"), "height": .number(1080), "shapes": .array([shape])])))
            return view.fields.first { $0.label == "Mark" }?.value ?? ""
        }
        #expect(pen([0.2, 0.3]) == "A drawn line through 10% across, 10% down; 20% across, 30% down; 50% across, 50% down, red, 3 px thick")
        // Same ends, another middle: another path, another row.
        #expect(pen([0.155, 0.3]) != pen([0.2, 0.3]))
        #expect(pen([0.155, 0.3]).contains("15.5% across"))
        let dot = OutboxModel.markRows(pin: nil, shapes: .array([.object(["tool": .string("pen"), "color": .string("#ffffff"), "width": .number(0.004), "points": .array([.array([.number(0.25), .number(0.5)])])])]))
        #expect(dot.map(\.1) == ["A single point at 25% across, 50% down, which Frame.io does not draw, white, 4 px thick"])
    }

    @Test func aMarksColourIsAWord() {
        #expect(OutboxModel.colourWord(.string("#ff0000")) == "red")
        #expect(OutboxModel.colourWord(.string("#2f6fe0")) == "blue")
        #expect(OutboxModel.colourWord(.string("#808080")) == "grey")
        #expect(OutboxModel.colourWord(.string("red")) == "")
        let oval = OutboxModel.markRows(pin: nil, shapes: .array([.object(["tool": .string("ellipse"), "cx": .number(0.5), "cy": .number(0.5), "rx": .number(0.1), "ry": .number(0.05)])]))
        #expect(oval.map(\.1) == ["An oval centred 50% across, 50% down, 20% wide and 10% high"])
    }

    @Test func `a computer act's word the past table does not know reads as the press it was`() {
        for (verb, past) in [("Reset", "Pressed Reset"), ("Read", "Pressed Read"), ("Bid", "Pressed Bid"), ("Send", "Sent"), ("Submit order", "Submitted order")] {
            #expect(OutboxModel.pastOf(verb, kind: .computerAct) == past)
        }
        for (verb, now) in [("Reset", "Pressing Reset"), ("Bid", "Pressing Bid"), ("Send", "Sending"), ("Submit order", "Submitting order")] {
            #expect(OutboxModel.progressive(verb, kind: .computerAct) == now)
        }
        // Any other kind keeps the rule.
        #expect(OutboxModel.pastOf("Stop", kind: .addonCall) == "Stopped")
    }

    @Test func `a head's paragraph reads, as the outgoing html keeps it; its title does not`() {
        #expect(HtmlWords.of("<head><title>Quote</title><p>I accept the revised price of $9000</p></head><p>Thanks.</p>") == "I accept the revised price of $9000\n\nThanks.")
        #expect(HtmlWords.of("<head><p>I accept the revised price of $9000</p></head><p>Thanks.</p>") == "I accept the revised price of $9000\n\nThanks.")
        // Only a whole script, style or title name is stripped (the desktop's cases, word for word).
        #expect(HtmlWords.of("<head><title-note>Extra words</title-note><title>Subject</title></head><p>Approved</p>") == "Extra wordsApproved")
        #expect(HtmlWords.of("<p>Hi</p><style-x>Shown</style-x><script type=x>gone</script>") == "Hi\n\nShown")
    }

    @Test func anUnclosedLinkStillNamesWhereItGoes() {
        #expect(HtmlWords.of(#"<p>See <a href="https://outside.example/secret">the report</p>"#) == "See [link: https://outside.example/secret] the report")
        // A link's words never run across another link's start (the desktop's test, word for word).
        #expect(HtmlWords.of(#"<a href="https://good.example">OK<a href="https://other.example">Pay here</a>"#) == "[link: https://good.example] OKPay here (https://other.example)")
    }

    @Test func aHeldMailListsItsFilesAndTheForwardedParts() {
        let held: JSONValue = .object(["message": .object([
            "subject": .string("Pay review"), "text": .string("Attached.\nThanks"),
            "attachments": .array([.object(["storageId": .string("st_1"), "name": .string("budget.xlsx"), "contentType": .string("x"), "size": .number(10)])]),
            "forwardParts": .array([.object(["partId": .string("2"), "name": .string("salary.csv")])]),
        ])])
        let view = OutboxModel.payloadView(held)
        #expect(view.fields.map(\.label) == ["Subject", "Files"])
        #expect(view.fields[1].value == "budget.xlsx, salary.csv")
        // JSON keeps an address's slashes, as the desktop writes it.
        let call = OutboxModel.payloadView(.object(["arguments": .object(["link": .object(["url": .string("https://a.example/b")])])]))
        #expect(call.fields.first?.value == #"{"url":"https://a.example/b"}"#)
    }

    @Test func aFormAShareAndATeamsPostSayInTheirHeadingOnlyWhatTheirRowsDoNot() {
        #expect(OutboxModel.kindHeading(kind: .formPublish, payload: .object(["title": .string("Spring LAN signup")]), sent: false) == "Publish Spring LAN signup")
        #expect(OutboxModel.kindHeading(kind: .formPublish, payload: .object(["title": .string("Spring LAN signup")]), sent: true) == "Published Spring LAN signup")
        #expect(OutboxModel.kindHeading(kind: .shareGoogle, payload: .object(["name": .string("Budget.xlsx"), "email": .string("dana@purdue.edu"), "role": .string("writer")]), sent: false) == "Share Budget.xlsx")
        #expect(OutboxModel.kindHeading(kind: .shareGoogle, payload: .object(["name": .string("Budget.xlsx")]), sent: true) == "Shared Budget.xlsx")
        #expect(OutboxModel.kindHeading(kind: .teamsPost, payload: .object(["chat": .string("Esports staff"), "text": .string("Hi")]), sent: false) == "Post in Teams")
        #expect(OutboxModel.kindHeading(kind: .teamsPost, payload: .object(["chat": .string("Esports staff"), "text": .string("Hi")]), sent: true) == "Posted in Teams")
        #expect(OutboxModel.kindHeading(kind: .mailSend, payload: .object([:]), sent: false) == nil)
    }

    @Test func aComputerActDropsItsToolWordAndSaysURL() {
        let act = OutboxModel.actView(item("c1", kind: .computerAct, payload: .object(["args": .object(["action": .string("left_click"), "url": .string("https://concur.example/expense")])])))
        #expect(act.fields.map(\.label) == ["URL", "Clicks"])
    }

    @Test func `keeps a Google share's person in its list title however long the file's name, the file on the line under it`() {
        let name = "Spring LAN budget, final, with every vendor quote attached.xlsx"
        let share = OutboxItem(ref: .host(.init(id: "g9")), kind: .shareGoogle, workspaceId: "w1", sessionId: "s1", sector: "purdue",
                               summary: "Share \(name) with dana@purdue.edu (can edit)", verb: "Share", account: nil, state: .held,
                               payload: .object(["name": .string(name), "email": .string("dana@purdue.edu"), "role": .string("writer")]),
                               createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: 1)
        #expect(OutboxModel.rowWords(share) == (title: "Share with dana@purdue.edu (can edit)", line: name))
        // Every other kind splits its summary at the colon, as before.
        #expect(OutboxModel.rowWords(item("m2", summary: "Send to Dana Lee: Budget")) == (title: "Send to Dana Lee", line: "Budget"))
    }

    @Test func `a host whose read failed is named above the bands whatever the others hold`() {
        let reads = OutboxModel.failedReads([(id: "box", name: "Box", error: "The host did not answer"), (id: "mac", name: "Mac", error: nil)])
        #expect(reads.map(\.id) == ["box"])
        #expect(reads[0].line == "Box did not answer")
        #expect(reads[0].error == "The host did not answer")
        // Rows from another host never hide a failed read, and a failed read never shows as empty.
        #expect(OutboxModel.emptyState(bandsEmpty: false, anyReading: false, anyFailed: true) == nil)
        #expect(OutboxModel.emptyState(bandsEmpty: true, anyReading: false, anyFailed: true) == nil)
        #expect(OutboxModel.emptyState(bandsEmpty: true, anyReading: true, anyFailed: false) == .reading)
        #expect(OutboxModel.emptyState(bandsEmpty: true, anyReading: false, anyFailed: false) == .nothingHeld)
        #expect(OutboxModel.emptyState(bandsEmpty: false, anyReading: true, anyFailed: false) == nil)
    }

    @Test func aRowsTitleIsTheActAndItsLineTheWordsAfterIt() {
        let post = OutboxModel.rowWords(item("p1", kind: .frameioPost, summary: "Comment on cut.mp4 at 0:12: Tighten the open", payload: .object(["account": .string("acc_1")])))
        #expect(post.title == "Comment on cut.mp4 at 0:12")
        #expect(post.line == "Tighten the open")
        let share = OutboxModel.rowWords(item("g1", kind: .shareGoogle, summary: "Share Budget.xlsx with dana@purdue.edu (can edit)", payload: .object(["account": .string("a@b.edu")])))
        #expect(share.line == nil)
        let failed = OutboxModel.rowWords(item("p2", kind: .frameioPost, state: .failed, summary: "Post: x"))
        #expect(failed.line == "Didn’t send")
        let mailRow = OutboxModel.rowWords(item("m1", summary: "Send to events booking", payload: mail))
        #expect(mailRow == (title: "Send to events booking", line: "Ballroom for April 10"))
    }

    @Test func anEventAcrossDaysNamesBothDays() {
        let late = OutboxModel.whenWords(friday2pm + 7 * 3_600_000, friday2pm + 12 * 3_600_000, locale: us, timeZone: utc)
        #expect(late.hasPrefix("Fri, Nov 20, 9:00"))
        #expect(late.contains("to Sat, Nov 21, 2:00"))
        let midnight = friday2pm - 14 * 3_600_000
        #expect(OutboxModel.whenWords(midnight, midnight + 3 * 86_400_000, allDay: true, locale: us, timeZone: utc) == "Fri, Nov 20 to Sun, Nov 22")
        #expect(OutboxModel.whenWords(midnight, midnight + 86_400_000, allDay: true, locale: us, timeZone: utc) == "Fri, Nov 20")
    }

    @Test func aRepliesQuoteIsMutedWordsUnderTheBodyNeverAnEditableField() {
        var payload = mail
        if case .object(var o) = payload {
            o["quote"] = .string("<p>Is the <a href=\"https://rooms.purdue.edu/b\">ballroom</a> free?</p><img src=\"cid:logo\" alt=\"Logo\">")
            payload = .object(o)
        }
        let view = OutboxModel.payloadView(payload)
        #expect(!view.fields.contains { $0.key == "quote" })
        #expect(view.quote == "Is the ballroom (https://rooms.purdue.edu/b) free?\n\n[image Logo: cid:logo]")
        #expect(OutboxModel.payloadView(mail).quote == nil)
    }

    @Test func aListOrACardOpensWhatOnlyItsDetailShows() {
        #expect(OutboxModel.sendsFromDetailOnly(.mailSend))
        #expect(OutboxModel.sendsFromDetailOnly(.computerAct))
        #expect(OutboxModel.sendsFromDetailOnly(.officeMailSend))
        #expect(!OutboxModel.sendsFromDetailOnly(.addonCall))
    }

    @Test func theDetailSendsOnlyOnceTheWholeReadAndItsPictureHaveCome() {
        let act = item("c1", kind: .computerAct, payload: .object(["picture": .object(["width": .number(1280), "height": .number(800)])]))
        let drawn = item("c1", kind: .computerAct, payload: .object(["picture": .object(["data": .string(Data([1, 2, 3]).base64EncodedString()), "width": .number(1280), "height": .number(800)])]))
        let none = item("c2", kind: .computerAct, payload: .object(["steps": .array([])]))
        #expect(!OutboxModel.detailReady(.computerAct, whole: nil))
        #expect(!OutboxModel.detailReady(.computerAct, whole: act))
        #expect(OutboxModel.detailReady(.computerAct, whole: drawn))
        #expect(OutboxModel.detailReady(.computerAct, whole: none))
        #expect(OutboxModel.keptPicture(drawn.payload) == .bytes(Data([1, 2, 3]), width: 1280, height: 800))
        #expect(OutboxModel.keptPicture(act.payload) == .missing)
        #expect(!OutboxModel.detailReady(.mailSend, whole: nil))
        #expect(OutboxModel.detailReady(.mailSend, whole: item("m1", payload: mail)))
        #expect(OutboxModel.detailReady(.addonCall, whole: nil))
    }

    @Test func htmlWordsKeepEveryTargetAndSourceAndReadThroughReferences() {
        #expect(HtmlWords.of("<div style=\"background:u&#114;l(https://t.example/p.png)\">Hi&nbsp;there<br>Line</div>") == "Hi there\nLine\n[background image: https://t.example/p.png]")
        #expect(HtmlWords.of("<a href=\"mailto:a@b.edu\">a@b.edu</a><script>x()</script>") == "a@b.edu")
        #expect(HtmlWords.of("<ul><li>One</li><li>Two</li></ul>") == "- One\n- Two")
    }

    @Test func anEditRewritesTheHtmlBesideTheTextAndChecksAddresses() {
        let edited = OutboxModel.applyEdits(mail, ["message.text": "Hi,\n\nIs it free?", "message.to": "Sam Ortiz <sortiz@purdue.edu>, a@b.edu"])
        #expect(edited.error == nil)
        guard case .object(let root)? = edited.payload, case .object(let message)? = root["message"] else { Issue.record("no message"); return }
        #expect(message["text"] == .string("Hi,\n\nIs it free?"))
        #expect(message["html"] == .string("<p>Hi,</p><p>Is it free?</p>"))
        #expect(message["to"] == .array([.object(["name": .string("Sam Ortiz"), "address": .string("sortiz@purdue.edu")]), .object(["address": .string("a@b.edu")])]))
        #expect(root["accountId"] == .string("acct_1"))
        let refused = OutboxModel.applyEdits(mail, ["message.to": "not an address"])
        #expect(refused.error == "To: one of these is not an address")
        #expect(refused.payload == mail)
    }

    @Test func bandsGroupByWorkspaceAndHostNewestFirstWithWorkChatsAsOne() {
        let entries = [
            OutboxModel.Entry(environmentId: "box", item: item("a", workspaceId: "w1", at: 10)),
            OutboxModel.Entry(environmentId: "box", item: item("b", workspaceId: "w2", sector: "unify", at: 30)),
            OutboxModel.Entry(environmentId: "box", item: item("c", workspaceId: "w1", at: 20)),
            OutboxModel.Entry(environmentId: "box", item: item("d", workspaceId: "~work", sector: nil, at: 5)),
            OutboxModel.Entry(environmentId: "mac", item: item("e", workspaceId: "w1", at: 1))
        ]
        let bands = OutboxModel.bands(entries)
        #expect(bands.map(\.id) == ["box:w2", "box:w1", "box:~work", "mac:w1"])
        #expect(bands[1].entries.map { OutboxModel.key($0.item.ref) } == ["host:c", "host:a"])
        #expect(bands[2].workspaceId == nil)
    }

    @Test func onlyHeldLiveSendingAndFailedWait() {
        #expect([OutboxItem.State.held, .live, .sending, .failed].allSatisfy(OutboxModel.waits))
        #expect(![OutboxItem.State.sent, .discarded, .stale].contains(where: OutboxModel.waits))
        #expect(OutboxModel.editable(.mailSend))
        #expect(!OutboxModel.editable(.computerAct))
    }

    @Test func theWordsOfAPress() {
        #expect(OutboxModel.pastOf("Send") == "Sent")
        #expect(OutboxModel.pastOf("Make link") == "Made link")
        #expect(OutboxModel.pastOf("Archive") == "Archived")
        #expect(OutboxModel.pendingLine(item("a")) == "Sending to events booking")
        #expect(OutboxModel.key(.lifeos(.init(table: .outbox, id: "ob_1"))) == "lifeos:outbox:ob_1")
        for ref in [HeldRef.host(.init(id: "h:1")), .lifeos(.init(table: .calendarOps, id: "op_2"))] {
            #expect(OutboxModel.ref(OutboxModel.key(ref)) == ref)
        }
        #expect(OutboxModel.ref("nonsense") == nil)
    }

    @Test func awaysNoticeAndSectionsInTheOrderHeMustAct() {
        let counts = OutboxModel.AwayCounts(held: 7, failed: 1, decided: 4, written: 2)
        #expect(OutboxModel.awayLine(counts) == "7 held, 4 decided without you, 1 failed")
        #expect(OutboxModel.awaySections(counts) == [.held, .failed, .decided, .written])
        #expect(OutboxModel.awayLine(.init(written: 1)) == "Wrote on 1 file while you were away")
        #expect(OutboxModel.awayLine(.init()) == nil)
        #expect(OutboxModel.awaySections(.init(decided: 2)) == [.decided])
    }

    @Test func grantsAreNarrowAMailsFixItsAccountAndEveryRecipient() {
        let grant = OutboxModel.grantFor(.mailSend, payload: .object(["message": .object([
            "accountId": .string("acct_1"),
            "to": .array([.object(["name": .string("Dana Lee"), "address": .string("DLee@purdue.edu")])]),
            "cc": .array([.object(["address": .string("sam@purdue.edu")])])
        ])]))
        #expect(grant?.label == "Mail to Dana Lee and sam@purdue.edu")
        #expect(grant?.matcher == .object(["accountId": .string("acct_1"), "recipients": .array([.string("dlee@purdue.edu"), .string("sam@purdue.edu")])]))
        let call = OutboxModel.grantFor(.addonCall, payload: .object(["addonId": .string("ad_1"), "tool": .string("send_mail"), "words": .string("Send mail"), "addon": .string("Purdue mail")]))
        #expect(call?.label == "Send mail with Purdue mail")
        #expect(call?.matcher == .object(["addonId": .string("ad_1"), "tool": .string("send_mail")]))
        #expect(OutboxModel.grantFor(.computerAct, payload: .object([:])) == nil)
        #expect(OutboxModel.grantFor(.mailSend, payload: .object(["message": .object([:])])) == nil)
    }

    @Test func theHeldLineIsReadOffTheHostsAnswerOnlyForACallTheHoldAnswers() {
        let answer = "Held as item 12: Send to Dana Lee: Re: budget. It waits for the owner's press. This is a finished step, not a failure."
        let held = OutboxModel.heldOf(tool: "mcp__app__purdue-mail__send_mail", result: answer)
        #expect(held?.n == 12)
        #expect(held?.act == "Send to Dana Lee: Re: budget")
        #expect(OutboxModel.heldOf(tool: "addon_call", result: answer)?.n == 12)
        #expect(OutboxModel.heldOf(tool: "Bash", result: answer) == nil)
        #expect(OutboxModel.heldOf(tool: "mcp__x__y", result: "Sent.") == nil)
    }

    @Test func aSendThatMayHaveGoneAsksHimToCheckFirst() {
        let unknown = OutboxItem(ref: .host(.init(id: "u1")), kind: .mailSend, workspaceId: "w1", sessionId: "s1", sector: "purdue", summary: "Send to events booking", verb: "Send", account: nil, state: .failed, createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: "The connection dropped", result: nil, routineRunId: nil, outcomeUnknown: true, updatedAt: 1)
        #expect(OutboxModel.checkFirst(unknown) == "Check Sent first")
        #expect(OutboxModel.failureLine(unknown) == "The connection dropped. Check Sent first.")
        let post = OutboxItem(ref: .host(.init(id: "u2")), kind: .addonCall, workspaceId: "w1", sessionId: "s1", sector: nil, summary: "Post", verb: "Post", account: nil, state: .failed, createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, outcomeUnknown: true, updatedAt: 1)
        #expect(OutboxModel.failureLine(post) == "It may have gone. Check whether it went first.")
        let failed = item("f1", state: .failed)
        #expect(OutboxModel.checkFirst(failed) == nil)
        #expect(OutboxModel.failureLine(failed) == "Didn’t send.")
    }
}
