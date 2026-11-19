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
        #expect(made[4].value == "Agenda & notes")

        let answer: JSONValue = .object(["op": .string("answer"), "id": .string("x"), "subject": .string("Board"), "start": .string("2026-11-20T09:00:00-05:00"),
                                         "organizer": .string("boss@purdue.edu"), "answer": .string("tentative"), "comment": .string("Running late")])
        let reply = OutboxModel.calendarFields(kind: .officeCalendarOp, payload: answer, locale: us, timeZone: utc) ?? []
        #expect(reply.map(\.label) == ["Event", "When", "From", "Reply", "Note"])
        #expect(reply[1].value.hasPrefix("Fri, Nov 20, 2:00"))
        #expect(reply[3].value == "Maybe")
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
        #expect(form.fields.map(\.label) == ["Form", "Questions"])
        #expect(form.fields.map(\.value) == ["LAN sign-up", "6"])
        #expect(form.body?.text == "Name (short answer, required)")
        #expect(form.body?.readOnly == true)

        let share = OutboxModel.actView(item("g1", kind: .shareGoogle, payload: .object(["account": .string("a@b.edu"), "fileId": .string("1AbC"), "name": .string("Budget.xlsx"), "email": .string("dana@purdue.edu"), "role": .string("writer"), "notify": .bool(true)])))
        #expect(share.fields.map(\.label) == ["Person", "Access", "Notice"])
        #expect(share.fields.map(\.value) == ["dana@purdue.edu", "Can edit", "Tells them by mail"])
        let quiet = OutboxModel.actView(item("g2", kind: .shareGoogle, payload: .object(["email": .string("dana@purdue.edu"), "role": .string("reader"), "notify": .bool(false)])))
        #expect(quiet.fields.map(\.value) == ["dana@purdue.edu", "Can view"])

        let comment = OutboxModel.actView(item("p1", kind: .frameioPost, payload: .object(["what": .string("comment"), "account": .string("acc_1"), "fileId": .string("f_1"), "fileName": .string("cut.mp4"), "text": .string("Tighten the open"), "clock": .string("0:12"), "durationFrames": .number(48), "pin": .object(["x": .number(0.31), "y": .number(0.62)]), "shapes": .array([.object(["kind": .string("arrow")]), .object(["kind": .string("box")])]), "height": .number(1080)])))
        #expect(comment.fields.map(\.label) == ["File", "At", "Marks"])
        #expect(comment.fields.map(\.value) == ["cut.mp4", "0:12", "2 shapes"])
        #expect(comment.body?.text == "Tighten the open")

        let version = OutboxModel.actView(item("p2", kind: .frameioPost, payload: .object(["what": .string("version"), "account": .string("acc_1"), "onto": .string("stk_1"), "ontoName": .string("cut.mp4"), "from": .string("~/Movies/cut v2.mp4"), "path": .string("/Users/l/Library/Application Support/TempCode/work-frameio/held/x"), "name": .string("cut v2.mp4"), "size": .number(734_003_200)])))
        #expect(version.fields.map(\.label) == ["On top of", "File", "Size", "From"])
        #expect(version.fields.map(\.value) == ["cut.mp4", "cut v2.mp4", "700 MB", "~/Movies/cut v2.mp4"])
        #expect(OutboxModel.megabytes(1.5 * 1024 * 1024) == "1.5 MB")
    }

    @Test func aComputerActDropsItsToolWordAndSaysURL() {
        let act = OutboxModel.actView(item("c1", kind: .computerAct, payload: .object(["args": .object(["action": .string("left_click"), "url": .string("https://concur.example/expense")])])))
        #expect(act.fields.map(\.label) == ["URL"])
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
