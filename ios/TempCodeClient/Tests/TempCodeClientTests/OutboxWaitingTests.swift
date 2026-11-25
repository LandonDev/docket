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
        #expect(RequestSheetModel.resultsHead(done) == "Sent 1, 1 not sent")
        #expect(RequestSheetModel.resultWords(done.rows[1])?.text == "Teams did not answer")
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
        #expect(press == RequestPress(environmentId: "box", requestId: "q", receipts: ["r-Dana"], word: "Send 1", lines: ["Sending to Dana now"]))
        #expect(press?.waitingLine == "Sending 1")
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
        wait.start(press) { p in sent.append(p.receipts); return self.answered() }
        // The sheet closing or the app leaving the screen has no way to send it early: nothing goes while it waits.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent.isEmpty)
        #expect(wait.pending["q"] == press)
        // A second press on the same request meanwhile is ignored.
        wait.start(RequestPress(environmentId: "box", requestId: "q", receipts: ["r-c"], word: "Send 1", lines: [])) { p in sent.append(p.receipts); return self.answered() }
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
        wait.start(press) { _ in sent += 1; return self.answered() }
        wait.undo("q")
        await gate.release()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(sent == 0)
        #expect(wait.pending.isEmpty)
        #expect(wait.outcomes.isEmpty)
    }

    @Test func aRefusalIsKeptForTheSheetThatShowsIt() async {
        let wait = RequestPressWait(sleep: {})
        wait.start(press) { _ in throw ActionError.refused(message: "refused: that receipt is not this request's", forbidden: false) }
        await settle { wait.outcomes["q"] != nil }
        #expect(wait.outcomes["q"] == .failed("refused: that receipt is not this request's"))
        wait.clear("q")
        #expect(wait.outcomes.isEmpty)
    }
}
