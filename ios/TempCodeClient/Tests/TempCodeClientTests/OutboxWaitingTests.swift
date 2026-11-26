import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Waiting on the phone (Work/Outbox/OutboxWaiting.swift and `OutboxModel.needsHim`): the one count, prototype A's
/// order, a row's trailing word, the item's notes, Send later's choices, the thread's inline card and the request
/// sheet's rules, held to the desktop's waiting.ts and the shared `needsHim`.
@Suite struct OutboxWaitingTests {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        c.locale = Locale(identifier: "en_US")
        return c
    }

    /// Tuesday, Nov 24, 2026, 9:40 AM in Central.
    private var now: Date { calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 9, minute: 40))! }
    private func ms(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Int {
        Int(calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!.timeIntervalSince1970 * 1000)
    }

    /// src/shared/work/outboxCount.fixture.ts's `base`, field for field.
    private func base(_ n: Int, ref: HeldRef? = nil, kind: OutboxItem.Kind = .teamsPost, state: OutboxItem.State = .held, error: String? = nil, scheduledFor: Int? = nil, dismissedAt: Int? = nil, counted: Bool = true) -> OutboxItem {
        OutboxItem(ref: ref ?? .host(.init(id: "ha_\(n)")), kind: kind, workspaceId: "ws-purdue", sessionId: "t-work", sector: "purdue", summary: "Post \(n)", verb: "Post", account: nil, state: state,
                   payload: .object(["chat": .string("General"), "text": .string("hi \(n)")]), createdAt: 1_000 + n, decidedBy: nil, decidedAt: nil, n: counted ? n : nil, why: .pillar, grantId: nil, error: error, result: nil, routineRunId: nil,
                   scheduledFor: scheduledFor, dismissedAt: dismissedAt, updatedAt: 1_000 + n)
    }

    /// The desktop's COUNT_FIXTURE: one Outbox, every state.
    private var countFixture: [OutboxItem] {
        [
            base(1),
            base(2, state: .live),
            base(3, state: .failed, error: "Teams did not answer"),
            base(4, state: .stale, error: "The chat moved"),
            base(5, state: .stale, error: "The chat moved", dismissedAt: 2_000),
            base(6, state: .sending),
            base(7, ref: .lifeos(.init(table: .outbox, id: "o7")), kind: .mailSend, state: .sending, scheduledFor: 9_000, counted: false),
            base(8, ref: .lifeos(.init(table: .outbox, id: "o8")), kind: .mailSend, counted: false),
            base(9, state: .sent),
            base(10, state: .discarded)
        ]
    }

    @Test func thePhonesCountIsNeedsHimOnTheSharedFixture() {
        // COUNT_FIXTURE_WAITS: held, live, failed, out of date, and the LifeOS draft.
        #expect(countFixture.filter(OutboxModel.needsHim).count == 5)
        #expect(countFixture.filter(OutboxModel.needsHim).map(\.summary) == ["Post 1", "Post 2", "Post 3", "Post 4", "Post 8"])
        // A host's own scheduled state never counts, and an out-of-date item put away is done.
        #expect(!OutboxModel.needsHim(base(11, state: .scheduled, scheduledFor: 9_000)))
        #expect(!OutboxModel.needsHim(base(12, state: .scheduled)))
    }

    @Test func waitingListsWhatWaitsWhatIsOnItsWayAndWhatHeTimed() {
        let listed = countFixture.filter(OutboxModel.listed).map(\.summary)
        #expect(listed == ["Post 1", "Post 2", "Post 3", "Post 4", "Post 6", "Post 7", "Post 8"])
        #expect(OutboxModel.listed(base(11, state: .scheduled)))
        #expect(OutboxModel.isScheduled(base(7, state: .sending, scheduledFor: 9_000)))
    }

    // MARK: - the order

    private func item(_ id: String, kind: OutboxItem.Kind = .mailSend, session: String? = "t1", workspace: String = "w1", state: OutboxItem.State = .held, at: Int, payload: JSONValue? = nil, scheduledFor: Int? = nil, error: String? = nil, changed: OutboxItem.Changed? = nil, replied: OutboxItem.Replied? = nil) -> OutboxItem {
        OutboxItem(ref: .host(.init(id: id)), kind: kind, workspaceId: workspace, sessionId: session, sector: "purdue", summary: "Send to \(id)", verb: "Send", account: nil, state: state, payload: payload,
                   createdAt: at, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: error, result: nil, routineRunId: nil, scheduledFor: scheduledFor, changed: changed, replied: replied, updatedAt: at)
    }

    private var places: OutboxModel.Places {
        OutboxModel.Places(
            jobOrder: { _, ws in ["w1": 0, "w2": 1][ws ?? ""] ?? 9 },
            jobOf: { _, ws in ["w1": "Purdue Esports", "w2": "Cosmic"][ws ?? ""] ?? "Work Chats" },
            titleOf: { entry in ["t1": "Travel budget", "t2": "Spring LAN", "t3": "Patch notes"][entry.item.sessionId ?? ""] }
        )
    }

    private func request(_ id: String, rows: [OutboxRequestRow], at: Int = 5, state: OutboxRequest.State = .open, answeredAt: Int? = nil) -> OutboxRequest {
        OutboxRequest(id: id, n: 1, sessionId: "t1", workspaceId: "w1", sector: "purdue", quote: "send the roster mails", head: "Send \(rows.count) mails", state: state, createdAt: at, expiresAt: at + 86_400_000, answeredBy: nil, answeredAt: answeredAt, rows: rows)
    }

    /// A request's row; its receipt is "r-<id>" unless one is named (nil: none issued).
    private func row(_ item: OutboxItem, do action: OutboxRequestRow.Do = .send, changed: Bool = false, receipt: String? = "", open: Bool = true, at: Int? = nil, result: OutboxRequestRow.Result? = nil) -> OutboxRequestRow {
        let id = if case .host(let ref) = item.ref { ref.id } else { "x" }
        return OutboxRequestRow(ref: item.ref, do: action, at: at, item: item, changed: changed, open: open, receipt: receipt == "" ? "r-\(id)" : receipt, result: result)
    }

    @Test func waitingIsAskedNotSentStartsSoonThreadBandsByJobThenScheduled() {
        let invite: JSONValue = .object(["eventStartsAt": .number(Double(ms(24, 14)))])
        let later: JSONValue = .object(["eventStartsAt": .number(Double(ms(30, 14)))])
        let roster = item("roster", at: 3)
        let entries = [
            item("cosmic", session: "t3", workspace: "w2", at: 1),
            item("dana", at: 20),
            item("lan", session: "t2", at: 10),
            item("failed", state: .failed, at: 30),
            item("kickoff", kind: .calendarOp, at: 40, payload: invite),
            item("far", kind: .calendarOp, at: 41, payload: later),
            item("timed", state: .scheduled, at: 2, scheduledFor: ms(25, 8)),
            roster,
            item("stale", state: .stale, at: 50)
        ].map { OutboxModel.Entry(environmentId: "box", item: $0) }
        let asked = [OutboxModel.RequestEntry(environmentId: "box", request: request("q1", rows: [row(roster)]))]
        let sections = OutboxModel.waitingSections(entries, requests: asked, places: places, now: now, calendar: calendar)
        #expect(sections.map(\.kind) == [.asked, .failed, .soon, .thread, .thread, .thread, .scheduled])
        #expect(sections.map(\.title) == ["Asked in threads", "Not sent", "Starts soon", "Spring LAN", "Travel budget", "Patch notes", "Scheduled"])
        // Purdue's bands lead Cosmic's; within a job, the band whose oldest item came first.
        #expect(sections[3].job == "Purdue Esports")
        #expect(sections[5].job == "Cosmic")
        // An item a request lists is under its Asked row alone; an out-of-date one stays in its thread's band.
        #expect(sections[4].entries.map { OutboxModel.key($0.item.ref) } == ["host:dana", "host:far", "host:stale"])
        #expect(!sections.flatMap(\.entries).contains { $0.item.summary == "Send to roster" })
        #expect(sections[2].entries.map(\.item.summary) == ["Send to kickoff"])
    }

    @Test func anItemNoThreadMadeIsItsJobsOwnBand() {
        let sections = OutboxModel.waitingSections([OutboxModel.Entry(environmentId: "box", item: item("x", session: nil, workspace: "~work", at: 1))], requests: [], places: places, now: now, calendar: calendar)
        #expect(sections.map(\.title) == ["Work Chats"])
        #expect(sections[0].job == nil)
    }

    @Test func aRowsTrailingWord() {
        #expect(OutboxModel.rowSide(item("t", state: .scheduled, at: 1, scheduledFor: ms(25, 8)), in: .scheduled, now: now, calendar: calendar)?.text == "Wed 8:00 AM")
        let soon = OutboxModel.rowSide(item("k", kind: .calendarOp, at: 1, payload: .object(["eventStartsAt": .number(Double(ms(24, 14)))])), in: .soon, now: now, calendar: calendar)
        #expect(soon?.text == "2:00 PM")
        #expect(soon?.strong == true)
        #expect(OutboxModel.rowSide(item("s", state: .stale, at: 1), in: .thread, now: now)?.text == "Out of date")
        let rewritten = item("c", at: 1, changed: .init(at: 2, by: .thread))
        #expect(OutboxModel.rowSide(rewritten, in: .thread, now: now)?.text == "Changed")
        #expect(OutboxModel.rowSide(item("h", at: 1), in: .thread, now: now) == nil)
        #expect(OutboxModel.aheadTime(ms(8, 8) + 30 * 86_400_000, now: now, calendar: calendar) == "Dec 8, 8:00 AM")
    }

    // MARK: - the item screen

    @Test func theNotesSayWhyWhoseWordsAndWhoWroteBack() {
        let stale = item("s", state: .stale, at: 1, error: "The chat moved.", changed: .init(at: 5, by: .thread), replied: .init(from: "Dana Lee", at: 6, line: "Can we move it to 3?"))
        let notes = OutboxModel.notes(stale, held: { _ in "9:20 AM" })
        #expect(notes.map(\.text) == ["Out of date. The chat moved.", "The thread rewrote this at 9:20 AM.", "Dana Lee wrote back at 9:20 AM, after this was made: “Can we move it to 3?”"])
        let failed = item("f", state: .failed, at: 1, error: "Gmail refused it: over 25 MB", changed: .init(at: 5, by: .you))
        #expect(OutboxModel.notes(failed, held: { _ in "8:00 AM" }).map(\.text) == ["Not sent. Gmail refused it: over 25 MB", "You changed this at 8:00 AM."])
        #expect(OutboxModel.notes(item("h", at: 1), held: { _ in "" }).isEmpty)
        // One the host could not confirm says May have gone and what to check, never "Not sent".
        let unsure = OutboxItem(ref: .host(.init(id: "u")), kind: .mailSend, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "Send to u", verb: "Send", account: nil, state: .failed, payload: nil,
                                createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: "timed out", result: nil, routineRunId: nil, outcomeUnknown: true, updatedAt: 1)
        #expect(OutboxModel.notes(unsure, held: { _ in "" }).map(\.text) == ["May have gone. timed out. Check Sent first."])
    }

    @Test func sendLaterOffersAnHourTheAfternoonWhileTheMorningLastsAndTomorrowAtEight() {
        let choices = OutboxModel.laterChoices(now: now, calendar: calendar)
        #expect(choices.map(\.label) == ["In an hour", "This afternoon", "Tomorrow morning"])
        #expect(choices[0].at == ms(24, 10, 40))
        #expect(choices[1].at == ms(24, 13))
        #expect(choices[2].at == ms(25, 8))
        let afternoon = calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 15, minute: 2))!
        #expect(OutboxModel.laterChoices(now: afternoon, calendar: calendar).map(\.label) == ["In an hour", "Tomorrow morning"])
        #expect(OutboxModel.laterChoices(now: afternoon, calendar: calendar)[0].at == ms(24, 16, 5))
    }

    // MARK: - the thread's card and the sheet

    @Test func theCardReadsOnlyTheRequestToolsAnswer() {
        let text = #"{"outboxRequest":{"id":"rq_1","host":"env_box"},"message":"Asked: request 3 lists 10 items."}"#
        #expect(OutboxModel.requestOf(tool: "mcp__app__outbox_request", result: text)?.id == "rq_1")
        #expect(OutboxModel.requestOf(tool: "outbox_request", result: text)?.host == "env_box")
        #expect(OutboxModel.requestOf(tool: "Bash", result: text) == nil)
        #expect(OutboxModel.requestOf(tool: "outbox_request", result: "Refused: none of the owner's recent messages…") == nil)
    }

    @Test func aRowThatChangedSinceAskedStartsUnticked() {
        let a = item("a", at: 1), b = item("b", at: 2), c = item("c", at: 3), d = item("d", at: 4)
        let req = request("q", rows: [row(a), row(b, changed: true, receipt: nil), row(c, open: false), row(d, changed: true)])
        // A tick is a receipt: the changed row with a receipt (d) is pressable once opened, never ticked at the start.
        #expect(RequestSheetModel.initialTicks(req) == ["r-a"])
        #expect(RequestSheetModel.rowWords(req.rows[1]).line == "Changed since asked")
        #expect(RequestSheetModel.rowWords(req.rows[2]).line == "No longer waits")
        #expect(RequestSheetModel.pressable(req.rows[3]))
        #expect(!RequestSheetModel.pressable(req.rows[1]))
    }

    @Test func theSheetsWordsForItsPressItsWaitAndItsResults() {
        let a = item("Dana", at: 1), b = item("Sam", at: 2)
        let laterAt = ms(25, 8)
        let req = request("q", rows: [row(a), row(b, do: .later, at: laterAt)])
        #expect(RequestSheetModel.pressWord(req, ticked: ["r-Dana"]) == "Send 1")
        #expect(RequestSheetModel.pressWord(req, ticked: ["r-Dana", "r-Sam"]) == "Approve 2")
        // An item's key is not a tick.
        #expect(RequestSheetModel.pressWord(req, ticked: ["host:Dana"]) == "Approve 0")
        #expect(RequestSheetModel.rowWords(req.rows[1], now: now, calendar: calendar).line == "Goes Wed 8:00 AM")
        #expect(RequestSheetModel.pendingLines(req, ticked: ["r-Dana", "r-Sam"], now: now, calendar: calendar) == ["Sending to Dana now", "Sending to Sam Wed 8:00 AM"])
        let done = request("q", rows: [row(a, result: .init(ok: true, state: "sent")), row(b, do: .later, at: laterAt, result: .init(ok: false, error: "Teams did not answer"))], state: .answered, answeredAt: 1)
        // A LifeOS mail his press sent is queued in LifeOS (its undo time), never "sent".
        #expect(RequestSheetModel.resultsHead(done) == "Queued 1 in LifeOS, 1 not sent")
        #expect(RequestSheetModel.resultWords(done.rows[1])?.text == "Teams did not answer")
        // A row the host could not confirm: May have gone in its line and in the head, never "not sent".
        let unsure = request("q", rows: [row(a, result: .init(ok: true, state: "sent")), row(b, result: .init(ok: false, error: "timed out", unknown: true))], state: .answered, answeredAt: 1)
        #expect(RequestSheetModel.resultWords(unsure.rows[1])?.text == "May have gone")
        #expect(RequestSheetModel.resultsHead(unsure) == "Queued 1 in LifeOS, 1 may have gone")
        // Off a closed sheet, a row that did not go or may have gone makes the answer a failure to read (sticky).
        #expect(RequestSheetModel.resultsMissed(done))
        #expect(RequestSheetModel.resultsMissed(unsure))
        #expect(RequestSheetModel.closedLine(done, time: { _ in "9:41 AM" }) == "By you at 9:41 AM")
    }

    // MARK: - ticks bound to receipts (the review's finding 3)

    @Test func aReloadThatChangesARowsReceiptOrMarksItChangedClearsItsTick() {
        let a = item("a", at: 1), b = item("b", at: 2), c = item("c", at: 3)
        let first = request("q", rows: [row(a), row(b), row(c)])
        let ticks = RequestSheetModel.initialTicks(first)
        #expect(ticks == ["r-a", "r-b", "r-c"])
        // The reload: a's receipt moved on (a fresh one for the same row), b changed and has none, c went elsewhere.
        let again = request("q", rows: [row(a, receipt: "r-a2"), row(b, changed: true, receipt: nil), row(c, open: false)])
        #expect(RequestSheetModel.reconcile(ticks, with: again).isEmpty)
        #expect(RequestSheetModel.freeze(again, ticks: ticks, environmentId: "box") == nil)
        #expect(RequestSheetModel.pressWord(again, ticked: ticks) == "Approve 0")
    }

    @Test func aRowOpenedThroughViewStartsUntickedUntilHeTicksIt() {
        let a = item("a", at: 1), b = item("b", at: 7)
        let req = request("q", rows: [row(a), row(b, changed: true, receipt: nil)])
        var ticks = RequestSheetModel.initialTicks(req)
        // He opens b: the host issues a fresh receipt at what he sees now; it is drawn, not ticked.
        let opened = ["host:b": row(b, receipt: "r-b-seen")]
        let drawn = RequestSheetModel.merged(req, opened: opened)
        #expect(drawn.rows[1].receipt == "r-b-seen")
        #expect(RequestSheetModel.pressable(drawn.rows[1]))
        #expect(!RequestSheetModel.ticked(drawn.rows[1], RequestSheetModel.reconcile(ticks, with: drawn)))
        #expect(RequestSheetModel.freeze(drawn, ticks: ticks, environmentId: "box")?.receipts == ["r-a"])
        // His own tick on it, then the press names both receipts in the request's order.
        ticks.insert("r-b-seen")
        #expect(RequestSheetModel.freeze(drawn, ticks: ticks, environmentId: "box")?.receipts == ["r-a", "r-b-seen"])
        // A reload that moved b again drops the opened form, its receipt and so its tick.
        let moved = request("q", rows: [row(a), row(item("b", at: 9), changed: true, receipt: nil)])
        let redrawn = RequestSheetModel.merged(moved, opened: opened)
        #expect(redrawn.rows[1].receipt == nil)
        #expect(RequestSheetModel.reconcile(ticks, with: redrawn) == ["r-a"])
    }

    @Test func thePressIsFrozenAtSendAndATickMovedDuringTheWaitChangesNothing() {
        let a = item("Dana", at: 1), b = item("Sam", at: 2)
        let req = request("q", rows: [row(a), row(b)])
        var ticks: Set<String> = ["r-Dana"]
        let press = RequestSheetModel.freeze(req, ticks: ticks, environmentId: "box", now: now, calendar: calendar)
        ticks.insert("r-Sam")
        #expect(press == RequestPress(environmentId: "box", requestId: "q", receipts: ["r-Dana"], word: "Send 1", lines: ["Sending to Dana now"], head: "Send 1 mail"))
        #expect(press?.waitingLine == "Sending 1 mail")
    }

    // MARK: - the council's round 1 (one head sentence, the results, left out)

    private func kinded(_ id: String, kind: OutboxItem.Kind, verb: String = "Send", payload: JSONValue? = nil) -> OutboxItem {
        OutboxItem(ref: .host(.init(id: id)), kind: kind, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "\(verb) \(id)", verb: verb, account: nil, state: .held, payload: payload,
                   createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: 1)
    }
    private func lifeosMail(_ id: String, to address: String) -> OutboxItem {
        kinded(id, kind: .mailSend, payload: .object(["message": .object(["to": .array([.object(["address": .string(address)])]), "cc": .array([]), "bcc": .array([])])]))
    }

    @Test func theHeadSaysWhatGoesInTheSharedWords() {
        // src/shared/work/outboxHead.ts's cases (waiting.test.ts and outboxCount.test.ts), word for word.
        let head = OutboxModel.summaryHead([lifeosMail("a", to: "a@x.edu"), lifeosMail("b", to: "b@x.edu"), lifeosMail("c", to: "a@x.edu"), kinded("p", kind: .teamsPost, verb: "Post"), kinded("i", kind: .calendarOp, verb: "Accept")])
        #expect(head == "Send 3 mails to 2 people, post 1 message and accept 1 invite")
        #expect(OutboxModel.summaryHead([kinded("i", kind: .calendarOp, verb: "Accept"), kinded("j", kind: .calendarOp, verb: "Decline")]) == "Answer 2 invites")
        #expect(OutboxModel.summaryHead([], discard: 3) == "Discard 3")
        #expect(OutboxModel.summaryHead([lifeosMail("a", to: "a@x.edu")], discarding: [lifeosMail("d", to: "d@x.edu")]) == "Send 1 mail to 1 person and discard 1 mail")
        #expect(OutboxModel.summaryHead([], discarding: [lifeosMail("d", to: "d@x.edu"), lifeosMail("e", to: "e@x.edu")]) == "Discard 2 mails")
        #expect(OutboxModel.summaryHead([], later: [lifeosMail("a", to: "a@x"), lifeosMail("b", to: "b@x")]) == "Send 2 mails to 2 people later")
        // An add-on's call by its own words and its add-on's name, counted in times.
        let echo = { (id: String) in self.kinded(id, kind: .addonCall, verb: "Echo", payload: .object(["addonId": .string("ad1"), "tool": .string("echo"), "words": .string("Echo"), "addon": .string("League")])) }
        #expect(OutboxModel.summaryHead([echo("e1"), echo("e2"), echo("e3")]) == "Echo with League, 3 times")
        #expect(OutboxModel.summaryHead([echo("e1")]) == "Echo with League")
    }

    @Test func anAddonsCallsThatNameTheirPeopleSayWhoTheyReachNeverHowManyTimes() {
        // outboxCount.test.ts's council-round-3 cases, word for word.
        let send = { (to: JSONValue?) -> OutboxItem in
            var arguments: [String: JSONValue] = ["subject": .string("Travel")]
            if let to { arguments["to"] = to }
            return self.kinded("s", kind: .addonCall, payload: .object(["addonId": .string("m1"), "tool": .string("send_mail"), "words": .string("Send mail"), "addon": .string("Purdue mail"), "arguments": .object(arguments)]))
        }
        #expect(OutboxModel.summaryHead([send(.string("alex@purdue.edu")), send(.array([.string("Jordan@purdue.edu")]))]) == "Send 2 mails to 2 people")
        #expect(OutboxModel.summaryHead([send(.array([.object(["address": .string("a@x")])])), send(.string("a@x"))]) == "Send 2 mails to 1 person")
        #expect(OutboxModel.summaryHead([send(.string("not an address")), send(nil)]) == "Send mail with Purdue mail, 2 times")
    }

    @Test func theSheetsHeadFollowsItsTicksAndAgreesWithItsButton() {
        let req = request("q", rows: [row(lifeosMail("a", to: "a@x.edu")), row(lifeosMail("b", to: "b@x.edu")), row(lifeosMail("c", to: "c@x.edu"), changed: true, receipt: nil)])
        let ticks = RequestSheetModel.initialTicks(req)
        // The request's own name is the host's (the list row, the card, the notice); the sheet's head is the ticked rows'.
        #expect(RequestSheetModel.askedHead(req) == req.head)
        #expect(RequestSheetModel.head(req, ticked: ticks) == "Send 2 mails to 2 people")
        #expect(RequestSheetModel.pressWord(req, ticked: ticks) == "Send 2")
        #expect(RequestSheetModel.head(req, ticked: ["r-a"]) == "Send 1 mail to 1 person")
        #expect(RequestSheetModel.head(req, ticked: []) == req.head)
        let mixed = request("m", rows: [row(lifeosMail("a", to: "a@x.edu")), row(lifeosMail("b", to: "b@x.edu"), do: .later, at: 5), row(lifeosMail("c", to: "c@x.edu"), do: .discard)])
        #expect(RequestSheetModel.head(mixed, ticked: RequestSheetModel.initialTicks(mixed)) == "Send 1 mail to 1 person, send 1 mail to 1 person later and discard 1 mail")
    }

    @Test func theWaitNamesWhatGoesAndNeverSaysNow() {
        let req = request("q", rows: [row(lifeosMail("a", to: "a@x.edu")), row(lifeosMail("b", to: "b@x.edu"))])
        let press = RequestSheetModel.freeze(req, ticks: RequestSheetModel.initialTicks(req), environmentId: "box")
        #expect(press?.waitingLine == "Sending 2 mails to 2 people")
        #expect(RequestPress(environmentId: "box", requestId: "q", receipts: ["a", "b", "c"], word: "Approve 3", lines: [], head: "Send 2 mails and discard 1").waitingLine == "Approving 3")
    }

    @Test func anItemHasOneNameAndItsSentenceIsTheHosts() {
        let post = OutboxItem(ref: .host(.init(id: "p")), kind: .teamsPost, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "Post in Esports staff", verb: "Post", account: nil, state: .held,
                              payload: .object(["chat": .string("Esports staff › General"), "text": .string("Practice is Wednesday at 7.")]), createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .pillar, grantId: nil, error: nil, result: nil, routineRunId: nil, effect: "Everyone in it sees it.", updatedAt: 1)
        // The screen's title is the row's act, never a second name ("Post in Teams").
        #expect(OutboxModel.title(post) == OutboxModel.rowWords(post).title)
        #expect(OutboxModel.title(post) == "Post in Esports staff")
        #expect(OutboxModel.effectLine(post) == "Everyone in it sees it.")
        let timed = OutboxItem(ref: .host(.init(id: "t")), kind: .officeMailSend, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "Send to Casey Wu", verb: "Send", account: nil, state: .scheduled,
                               payload: .object(["account": .string("landon@purdue.edu"), "to": .array([.string("cwu@purdue.edu")]), "subject": .string("Travel")]), createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .pillar, grantId: nil, error: nil, result: nil, routineRunId: nil, scheduledFor: 9_000, effect: "Sends as you.", updatedAt: 1)
        // A timed send says one line, its time: no sentence under it, whatever the host's says (an older host's
        // "as soon as you press" under "Scheduled for …" said the opposite).
        #expect(OutboxModel.effectLine(timed) == nil)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        cal.locale = Locale(identifier: "en_US")
        let monday = Date(timeIntervalSince1970: 1_794_827_200) // Monday Nov 16, 2026, 5:06 AM in Chicago
        let at = Int(cal.date(bySettingHour: 8, minute: 0, second: 0, of: cal.date(byAdding: .day, value: 2, to: monday)!)!.timeIntervalSince1970 * 1000)
        let wednesday = OutboxItem(ref: .host(.init(id: "w")), kind: .officeMailSend, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "Send to Casey Wu", verb: "Send", account: nil, state: .scheduled,
                                   payload: timed.payload, createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .pillar, grantId: nil, error: nil, result: nil, routineRunId: nil, scheduledFor: at, effect: "Goes from Outlook as soon as you press.", updatedAt: 1)
        #expect(OutboxModel.effectLine(wednesday) == nil)
        #expect(OutboxModel.scheduledLine(wednesday, now: monday, calendar: cal) == "Scheduled for Wed 8:00 AM")
        #expect(OutboxModel.scheduledLine(post) == nil)
        // An add-on's mail (w05): the head is the row's act alone, never the kind's heading with the body quoted
        // ("Send mail with Purdue mail: “Hello, I’d like…”"), which the body under it says whole.
        let addonMail = OutboxItem(ref: .host(.init(id: "m")), kind: .addonCall, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "Send to events booking", verb: "Send", account: nil, state: .held,
                                   payload: .object(["addon": .string("Purdue mail"), "tool": .string("send_mail"), "words": .string("Send mail"),
                                                     "arguments": .object(["to": .string("events@purdue.edu"), "subject": .string("Ballroom for Saturday, April 10"), "text": .string("Hello,\n\nI’d like to hold the ballroom on Saturday.")])]),
                                   createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, effect: "Uses Purdue mail to send mail as you.", updatedAt: 1)
        #expect(OutboxModel.title(addonMail) == "Send to events booking")
        #expect(!OutboxModel.title(addonMail).contains("Hello"))
        // An Outlook mail's fields run From, To, Subject, as the desktop's.
        #expect(OutboxModel.payloadView(timed.payload).fields.map(\.label) == ["From", "To", "Subject"])
    }

    @Test func overTheHeadSaysQueuedAndLeftOutAndALeftOutRowSaysSo() {
        var queued = lifeosMail("a", to: "a@x.edu")
        queued = OutboxItem(ref: queued.ref, kind: queued.kind, workspaceId: queued.workspaceId, sessionId: queued.sessionId, sector: queued.sector, summary: queued.summary, verb: queued.verb, account: nil, state: .sent, payload: queued.payload,
                            createdAt: 1, decidedBy: "owner:remote", decidedAt: 2, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, lifeos: .queued, updatedAt: 2)
        let posted = kinded("p", kind: .teamsPost, verb: "Post")
        let done = request("q", rows: [row(queued, result: .init(ok: true, state: "sent")), row(posted, result: .init(ok: true, state: "sent")), row(kinded("s", kind: .officeMailSend), result: .init(ok: true, state: "sent")), row(lifeosMail("c", to: "c@x.edu"), changed: true, receipt: nil)], state: .answered, answeredAt: 3)
        #expect(RequestSheetModel.resultsHead(done) == "Sent 2, queued 1 in LifeOS, 1 left out")
        // A row he left out is his own choice, not a failure: a plain note off the sheet.
        #expect(!RequestSheetModel.resultsMissed(done))
        #expect(RequestSheetModel.rowWords(done.rows[3], closed: true).line == "Left out")
        #expect(RequestSheetModel.head(done, ticked: []) == "Sent 2, queued 1 in LifeOS, 1 left out")
        // A row's result line only when it adds something: "Sent" beside its check would say it twice.
        #expect(RequestSheetModel.settledLine(done.rows[0]) == "Queued in LifeOS")
        #expect(RequestSheetModel.settledLine(done.rows[1]) == "Posted")
        #expect(RequestSheetModel.settledLine(done.rows[2]) == RequestSheetModel.rowWords(done.rows[2]).line)
    }

    @Test func anAddonCallOrAPostSaysWhatTellsItApart() {
        let post = kinded("p", kind: .teamsPost, verb: "Post", payload: .object(["chat": .string("General"), "text": .string("Practice is Thursday at 7.\nBring your pass.")]))
        #expect(OutboxModel.rowWords(post).line == "Practice is Thursday at 7.")
        let mail = kinded("m", kind: .addonCall, payload: .object(["arguments": .object(["to": .string("a@x.edu"), "subject": .string("Nationals travel"), "text": .string("Hi")])]))
        #expect(OutboxModel.rowWords(mail).line == "Nationals travel")
    }
}

/// A gate a test opens: the wait's stand-in for its five seconds.
private actor Gate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        open = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

@Suite(.serialized) @MainActor struct RequestPressWaitTests {
    private let press = RequestPress(environmentId: "box", requestId: "q", receipts: ["r-a", "r-b"], word: "Send 2", lines: [])
    private func answered() -> OutboxRequest {
        OutboxRequest(id: "q", n: 1, sessionId: "t1", workspaceId: "w1", sector: "purdue", quote: "send them", head: "Send 2 mails", state: .answered, createdAt: 1, expiresAt: 2, answeredBy: "owner:remote", answeredAt: 3, rows: [])
    }

    private func settle(_ until: () -> Bool) async {
        for _ in 0..<500 where !until() { try? await Task.sleep(for: .milliseconds(2)) }
    }

    @Test func nothingReachesTheHostUntilTheSecondsEndAndThenExactlyTheFrozenReceipts() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var sent: [[String]] = []
        wait.start(press, check: { _ in nil }) { p in sent.append(p.receipts); return self.answered() }
        // The sheet closing or the app leaving the screen has no way to send it early: nothing goes while it waits.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent.isEmpty)
        #expect(wait.pending["q"] == press)
        // A second press on the same request meanwhile is ignored.
        wait.start(RequestPress(environmentId: "box", requestId: "q", receipts: ["r-c"], word: "Send 1", lines: []), check: { _ in nil }) { p in sent.append(p.receipts); return self.answered() }
        await gate.release()
        await settle { wait.outcomes["q"] != nil }
        #expect(sent == [["r-a", "r-b"]])
        #expect(wait.pending["q"] == nil)
        #expect(wait.outcomes["q"] == .answered(answered()))
    }

    @Test func undoDropsThePressAndTheHostNeverHearsIt() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var sent = 0
        wait.start(press, check: { _ in nil }) { _ in sent += 1; return self.answered() }
        wait.undo("q")
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent == 0)
        #expect(wait.pending.isEmpty)
        #expect(wait.outcomes.isEmpty)
    }

    @Test func aRefusalIsKeptForTheSheetThatShowsIt() async {
        let wait = RequestPressWait(sleep: {})
        wait.start(press, check: { _ in nil }) { _ in throw ActionError.refused(message: "refused: that receipt is not this request's", forbidden: false) }
        await settle { wait.outcomes["q"] != nil }
        #expect(wait.outcomes["q"] == .failed("Not sent: refused: that receipt is not this request's"))
        wait.clear("q")
        #expect(wait.outcomes.isEmpty)
    }

    @Test func aClosedSheetsPressKeepsItsUndoAtTheFootAndItsOutcomeIsSaidOffIt() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var told: [RequestPressWait.Outcome] = []
        wait.toldOff = { told.append($0) }
        var sent = 0
        wait.start(macPress, check: { _ in nil }) { _ in sent += 1; return self.answered() }
        // The sheet is open: its own capsule has the Undo, the foot has none.
        wait.sheetOpened("q")
        #expect(wait.offScreen.isEmpty)
        // He closes it while it counts: the press is the foot's, Undo bound to this request.
        wait.sheetClosed("q")
        #expect(wait.showing["q"] == nil)
        #expect(wait.offScreen.map(\.requestId) == ["q"])
        // The link drops after closing: the line is said off the sheet, not only kept for it.
        wait.linkLost(host: "mac")
        #expect(told == [.failed(SendWait<RequestPress>.line(.linkLost, hostName: "Mac"))])
        #expect(wait.offScreen.isEmpty)
        // An Undo that lands after it no longer waits reports nothing came back.
        #expect(!wait.undo("q"))
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent == 0)
    }

    @Test func aClosedRequestsUndoStaysReachableWhileAnotherRequestsSheetIsUp() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var sent: [String] = []
        let a = RequestPress(environmentId: "mac", requestId: "a", receipts: ["r-a"], word: "Send 1", lines: [], hostName: "Mac")
        wait.start(a, check: { _ in nil }) { p in sent.append(p.requestId); return self.answered() }
        // A's sheet closed; B's sheet is open over the tab: A is off screen, B is not.
        wait.sheetOpened("b")
        #expect(wait.offScreen.map(\.requestId) == ["a"])
        // Undo of A from B's sheet: bound to A, and A's decide is never sent.
        #expect(wait.undo("a"))
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent.isEmpty)
        wait.sheetClosed("b")
    }

    private var macPress: RequestPress {
        RequestPress(environmentId: "mac", requestId: "q", receipts: ["r-a"], word: "Send 1", lines: [], hostName: "Mac", key: "k1|approve")
    }

    @Test func goingToTheBackgroundAtFourSecondsCancelsThePressAndSaysSo() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var sent = 0
        wait.start(macPress, check: { _ in nil }) { _ in sent += 1; return self.answered() }
        wait.leftScreen()
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent == 0)
        #expect(wait.pending.isEmpty)
        #expect(wait.outcomes["q"] == .failed("Not sent: Docket left the screen"))
    }

    @Test func aLostLinkCancelsOnlyThatHostsPress() async {
        let gate = Gate()
        let wait = RequestPressWait(sleep: { await gate.wait() })
        var sent = 0
        wait.start(macPress, check: { _ in nil }) { _ in sent += 1; return self.answered() }
        wait.linkLost(host: "box")
        #expect(wait.pending["q"] != nil)
        wait.linkLost(host: "mac")
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent == 0)
        #expect(wait.outcomes["q"] == .failed("Not sent: lost the link to Mac"))
    }

    @Test func atTheEndOfTheSecondsAnotherKeyOnTheHostSendsNothing() async {
        let wait = RequestPressWait(sleep: {})
        var sent = 0
        // The client was replaced under the same capability: the check compares the key he pressed under.
        let live = SendWait<RequestPress>.Check(linked: true, maySend: true, rev: 0, key: "k2|approve")
        wait.start(macPress, check: { p in SendWait<RequestPress>.why(live, rev: 0, key: p.key) }) { _ in sent += 1; return self.answered() }
        await settle { wait.outcomes["q"] != nil }
        #expect(sent == 0)
        #expect(wait.outcomes["q"] == .failed("Not sent: this iPhone’s key can’t send on Mac"))
    }

    @Test func aDisconnectAfterTheHostClaimedTheRequestIsCheckingAndReadBack() async {
        let wait = RequestPressWait(sleep: {})
        var sent = 0
        wait.start(macPress, check: { _ in nil }) { _ in sent += 1; throw PressLedger.Unknown(host: "mac", ref: "request:q") }
        await settle { wait.outcomes["q"] != nil }
        #expect(wait.outcomes["q"] == .checking)
        // Checking is never "Not sent", the sheet's clear keeps it, and no second press starts on it.
        wait.clear("q")
        #expect(wait.outcomes["q"] == .checking)
        wait.start(macPress, check: { _ in nil }) { _ in sent += 1; return self.answered() }
        #expect(wait.pending.isEmpty)
        // The next link reads the request: the host had answered it.
        wait.heard(answered())
        #expect(wait.outcomes["q"] == .answered(answered()))
        #expect(sent == 1)
    }

    @Test func aRequestStillRunningStaysCheckingUntilItsEnd() async {
        let wait = RequestPressWait(sleep: {})
        wait.start(macPress, check: { _ in nil }) { _ in throw PressLedger.Unknown(host: "mac", ref: "request:q") }
        await settle { wait.outcomes["q"] != nil }
        let running = OutboxRequest(id: "q", n: 1, sessionId: "t1", workspaceId: "w1", sector: "purdue", quote: "send them", head: "Send 2 mails", state: .answered, createdAt: 1, expiresAt: 2, answeredBy: "owner:remote", answeredAt: 3, rows: [], running: true)
        wait.heard(running)
        #expect(wait.outcomes["q"] == .checking)
        wait.heard(answered())
        #expect(wait.outcomes["q"] == .answered(answered()))
    }

    @Test func aReadBackThatFindsTheRequestStillOpenSaysNotSent() async {
        let wait = RequestPressWait(sleep: {})
        wait.start(macPress, check: { _ in nil }) { _ in throw PressLedger.Unknown(host: "mac", ref: "request:q") }
        await settle { wait.outcomes["q"] != nil }
        wait.heard(requestId: "q", state: .stillWaiting)
        #expect(wait.outcomes["q"] == .failed("Not sent"))
    }
}
