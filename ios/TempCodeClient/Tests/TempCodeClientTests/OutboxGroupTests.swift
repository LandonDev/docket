import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Select, ticks and one press on many on the phone's Outbox, the open Duo's next pick, the one count and the kept
/// rows (Work/Outbox/OutboxGroup.swift, Work/Cache/OutboxRowsCache.swift; docs/IOS-DESIGN.md "Work on the phone").
@Suite @MainActor struct OutboxGroupTests {
    private func item(
        _ id: String, kind: OutboxItem.Kind = .addonCall, verb: String = "Send", state: OutboxItem.State = .held, at: Int = 10,
        payload: JSONValue? = nil, outcomeUnknown: Bool? = nil, scheduledFor: Int? = nil, lifeos: OutboxItem.Lifeos? = nil, dismissedAt: Int? = nil
    ) -> OutboxItem {
        OutboxItem(ref: .host(.init(id: id)), kind: kind, workspaceId: "w1", sessionId: "t1", sector: "purdue", summary: "\(verb) \(id)", verb: verb, account: nil, state: state, payload: payload,
                   createdAt: at, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil,
                   outcomeUnknown: outcomeUnknown, scheduledFor: scheduledFor, lifeos: lifeos, dismissedAt: dismissedAt, updatedAt: at)
    }

    private func mail(_ id: String, to address: String, at: Int = 10) -> OutboxItem {
        item(id, kind: .mailSend, at: at, payload: .object(["message": .object(["to": .array([.object(["address": .string(address)])])])]))
    }

    private func entry(_ item: OutboxItem, host: String = "mac") -> OutboxModel.Entry {
        OutboxModel.Entry(environmentId: host, item: item)
    }

    // MARK: - what takes a tick

    @Test func `only a plain held row takes a tick`() {
        #expect(OutboxModel.tickable(item("a")))
        #expect(!OutboxModel.tickable(item("b", state: .failed)))
        #expect(!OutboxModel.tickable(item("c", state: .stale)))
        #expect(!OutboxModel.tickable(item("d", state: .live)))
        #expect(!OutboxModel.tickable(item("e", state: .sending)))
        #expect(!OutboxModel.tickable(item("f", kind: .computerAct)))
        #expect(!OutboxModel.tickable(item("g", scheduledFor: 99)))
        #expect(!OutboxModel.tickable(item("h", state: .scheduled)))
        #expect(!OutboxModel.tickable(item("i", outcomeUnknown: true)))
    }

    @Test func `a LifeOS reply that quotes its mail is sent from its own page alone`() {
        let reply = item("r", kind: .mailSend, payload: .object(["quote": .string("<p>Can you hold the ballroom?</p>")]))
        #expect(OutboxModel.quotesItsMail(reply))
        #expect(!OutboxModel.quotesItsMail(item("m", kind: .mailSend, payload: .object(["quote": .string("  ")]))))
        #expect(!OutboxModel.quotesItsMail(item("o", kind: .officeMailSend, payload: .object(["quote": .string("x")]))))
    }

    // MARK: - the ticks

    @Test func `a tick in the list adds and removes; one in the summary keeps the row listed`() {
        var selection = OutboxSelection()
        selection.toggle("mac:host:a")
        selection.toggle("mac:host:b")
        #expect(selection.listed == ["mac:host:a", "mac:host:b"])
        selection.toggleInSummary("mac:host:a")
        #expect(!selection.contains("mac:host:a"))
        #expect(selection.listed == ["mac:host:a", "mac:host:b"])
        #expect(selection.count == 1)
        selection.toggleInSummary("mac:host:a")
        #expect(selection.contains("mac:host:a"))
        selection.toggle("mac:host:b")
        #expect(selection.listed == ["mac:host:a"])
        // A row the summary never listed is not ticked from it.
        selection.toggleInSummary("mac:host:z")
        #expect(!selection.contains("mac:host:z"))
    }

    @Test func `Select All on a heading ticks its rows, and with all ticked it clears them`() {
        var selection = OutboxSelection()
        selection.toggle("b")
        selection.toggleAll(["a", "b", "c"])
        #expect(selection.allTicked(["a", "b", "c"]))
        #expect(selection.listed == ["b", "a", "c"])
        selection.toggleAll(["a", "b", "c"])
        #expect(selection.isEmpty)
        #expect(selection.listed.isEmpty)
        #expect(!selection.allTicked([]))
    }

    @Test func `a row that left or no longer takes a tick loses it`() {
        var selection = OutboxSelection()
        selection.toggleAll(["a", "b", "c"])
        selection.keep(["a", "c"])
        #expect(selection.ticked == ["a", "c"])
        #expect(selection.listed == ["a", "c"])
    }

    // MARK: - the press on many

    @Test func `the summary says in one sentence what will go, and the capsule says it going`() throws {
        let press = try #require(GroupPress([entry(mail("a", to: "a@x.com")), entry(mail("b", to: "b@x.com")), entry(item("p", kind: .teamsPost, verb: "Post"))], act: .send))
        #expect(press.head == "Send 2 mails to 2 people and post 1 message")
        #expect(press.waitingLine == "Sending 2 mails to 2 people and posting 1 message")
        let discard = try #require(GroupPress([entry(item("a")), entry(item("b")), entry(item("c"))], act: .discard(reason: nil)))
        #expect(discard.head == "Discard 3")
        #expect(discard.waitingLine == "Discarding 3")
    }

    @Test func `each host hears its own items at the revision he saw, never again and never a grant`() throws {
        let unknownOne = item("u", at: 40, outcomeUnknown: true)
        let press = try #require(GroupPress([entry(item("a", at: 20)), entry(item("b", at: 30), host: "box"), entry(unknownOne)], act: .send))
        let mac = press.decisions(host: "mac")
        #expect(mac.map(\.ref) == [.host(.init(id: "a")), .host(.init(id: "u"))])
        #expect(mac.map(\.rev) == [20, 40])
        #expect(mac.allSatisfy { $0.do == .send && $0.again == nil && $0.reason == nil })
        #expect(press.decisions(host: "box").map(\.rev) == [30])
        #expect(press.hosts == ["mac", "box"])
        #expect(press.presses.allSatisfy { $0.grant == nil && !$0.again })
        // Even a group of one item that may have gone is not his Send Again.
        let one = try #require(GroupPress([entry(unknownOne)], act: .send))
        #expect(one.decisions(host: "mac").first?.again == nil)
    }

    @Test func `a group Discard carries his reason once, trimmed; an empty one is left out`() throws {
        let press = try #require(GroupPress([entry(item("a")), entry(item("b"))], act: .discard(reason: "  not this week  ")))
        #expect(press.decisions(host: "mac").map(\.reason) == ["not this week", "not this week"])
        #expect(press.decisions(host: "mac").allSatisfy { $0.do == .discard })
        let quiet = try #require(GroupPress([entry(item("a"))], act: .discard(reason: " ")))
        #expect(quiet.decisions(host: "mac").first?.reason == nil)
    }

    @Test func `what only its own page sends stays out of Send and still goes with Discard`() throws {
        let rows = [entry(item("a")), entry(item("r", kind: .mailSend))]
        let send = try #require(GroupPress(rows, act: .send, openOnly: ["mac:host:r"]))
        #expect(send.entries.map(\.id) == ["mac:host:a"])
        let discard = try #require(GroupPress(rows, act: .discard(reason: nil), openOnly: ["mac:host:r"]))
        #expect(discard.entries.count == 2)
        #expect(GroupPress([entry(item("r"))], act: .send, openOnly: ["mac:host:r"]) == nil)
        #expect(GroupPress([], act: .discard(reason: nil)) == nil)
    }

    @Test func `the owner's check is bound to every item and the revision he saw of each`() throws {
        let press = try #require(GroupPress([entry(item("b", at: 30)), entry(item("a", at: 20))], act: .send))
        #expect(press.gateRef == "host:a,host:b")
        #expect(press.gateRev == "20,30")
        #expect(press.id == "group:mac:host:a,mac:host:b")
    }

    @Test func `each item's result lands as its host answers, and the head sums them`() throws {
        let a = mail("a", to: "a@x.com")
        let p = item("p", kind: .teamsPost, verb: "Post")
        let c = item("c")
        let press = try #require(GroupPress([entry(a), entry(p), entry(c, host: "box")], act: .send))
        var outcome = GroupOutcome(did: press.act)
        outcome.take(host: "mac", [
            DecisionResult(ref: a.ref, ok: true, item: item("a", kind: .mailSend, state: .sent, lifeos: .queued)),
            DecisionResult(ref: p.ref, ok: true, item: item("p", kind: .teamsPost, verb: "Post", state: .sent)),
        ], of: press)
        #expect(outcome.results["mac:host:a"] == .done("Queued in LifeOS"))
        #expect(outcome.results["mac:host:p"] == .done("Posted"))
        #expect(outcome.head == "Sent 1, queued 1 in LifeOS")
        outcome.fail(host: "box", "Not connected to Box", of: press)
        #expect(outcome.reason("box:host:c") == "Not connected to Box")
        #expect(outcome.head == "Sent 1, queued 1 in LifeOS, 1 not sent")
        // A host's answer for a ref it was not asked about changes nothing.
        outcome.take(host: "box", [DecisionResult(ref: .host(.init(id: "zz")), ok: true)], of: press)
        #expect(outcome.results.count == 3)
    }

    @Test func `an item that did not go keeps the host's reason, or plain words when it gave none`() throws {
        let a = item("a"), b = item("b")
        let press = try #require(GroupPress([entry(a), entry(b)], act: .discard(reason: nil)))
        var outcome = GroupOutcome(did: press.act)
        outcome.take(host: "mac", [DecisionResult(ref: a.ref, ok: true), DecisionResult(ref: b.ref, ok: false, error: " ")], of: press)
        #expect(outcome.results["mac:host:a"] == .done("Discarded"))
        #expect(outcome.reason("mac:host:b") == "It was not discarded")
        #expect(outcome.head == "Discarded 1, 1 not discarded")
        let sent = GroupOutcome.doneWord(item("x", state: .sent), did: .send)
        #expect(sent.isEmpty)
    }

    @Test func `an item the host could not confirm is "May have gone", never "not sent", on time as late`() throws {
        let a = item("a"), b = item("b")
        let press = try #require(GroupPress([entry(a), entry(b)], act: .send))
        let answer = [
            DecisionResult(ref: a.ref, ok: true, item: item("a", state: .sent)),
            DecisionResult(ref: b.ref, ok: false, item: item("b", state: .failed, outcomeUnknown: true), error: "timed out"),
        ]
        var outcome = GroupOutcome(did: press.act)
        outcome.take(host: "mac", answer, of: press)
        #expect(outcome.results["mac:host:b"] == .mayHaveGone)
        #expect(outcome.reason("mac:host:b") == "May have gone")
        #expect(outcome.head == "Sent 1, 1 may have gone")
        // The same answer after fifteen seconds reads the same.
        #expect(DecisionResult.states(.init(results: answer))["host:b"] == .mayHaveGone)
    }

    @Test func `a press on many waits in the same line, and a link lost to any of its hosts puts it all back`() throws {
        let press = try #require(GroupPress([entry(item("a")), entry(item("b"), host: "box")], act: .send))
        var wait = SendWait<OutboxPress>()
        let payload = OutboxPress.group(press)
        wait.press(.init(id: press.id, host: "mac", hostName: "Mac", rev: 0, line: payload.line, payload: payload, also: ["box"]), now: 0)
        #expect(wait.counting?.payload.entries.count == 2)
        wait.linkLost(host: "box", now: 1)
        #expect(wait.counting == nil)
        #expect(wait.notice?.why == .linkLost)
    }

    // MARK: - the next pick on the open Duo

    @Test func `with nothing shown, or the shown row still there, the list's own order`() {
        #expect(OutboxModel.pickOrder(now: ["a", "b"], seen: [], shown: nil) == ["a", "b"])
        #expect(OutboxModel.pickOrder(now: ["a", "b"], seen: ["a", "b"], shown: "b") == ["a", "b"])
    }

    @Test func `the shown row left: the next one he saw after it takes the detail`() {
        #expect(OutboxModel.pickOrder(now: ["a", "c", "d"], seen: ["a", "b", "c", "d"], shown: "b") == ["c"])
        // A row that arrived since is never the next: he did not see it.
        #expect(OutboxModel.pickOrder(now: ["new", "a", "c"], seen: ["a", "b", "c"], shown: "b") == ["c"])
        // One still waiting its five seconds is not in `now`, so it is skipped.
        #expect(OutboxModel.pickOrder(now: ["a", "d"], seen: ["a", "b", "c", "d"], shown: "b") == ["d"])
    }

    @Test func `at the end of the list the nearest one before it; with none he saw left, nothing`() {
        #expect(OutboxModel.pickOrder(now: ["a", "b"], seen: ["a", "b", "c"], shown: "c") == ["b"])
        #expect(OutboxModel.pickOrder(now: ["new"], seen: ["a"], shown: "a") == [])
        #expect(OutboxModel.pickOrder(now: [], seen: ["a"], shown: "a") == [])
    }

    @Test func `the pick turns into the shell's decision: the row that left opens the next, else the detail clears`() {
        let tiled = ShellPose.split(sidebar: .tiled)
        let first = OutboxModel.pickOrder(now: ["a", "c"], seen: ["a", "b", "c"], shown: "b")
        #expect(ShellSelection.decide(first: first, present: ["a", "c"], detail: .row("b"), pose: tiled, onScreen: true) == .open("c"))
        let none = OutboxModel.pickOrder(now: ["new"], seen: ["b"], shown: "b")
        #expect(ShellSelection.decide(first: none, present: ["new"], detail: .row("b"), pose: tiled, onScreen: true) == .clear)
        // At compact width nothing is picked: the detail went back to the list.
        #expect(ShellSelection.decide(first: first, present: ["a", "c"], detail: .row("b"), pose: .stack(short: false), onScreen: true) == .keep)
    }

    // MARK: - one count

    @Test func `one count: what waits on him, less what a Send holds back`() {
        let entries = [entry(item("a")), entry(item("b", state: .failed)), entry(item("c", state: .stale)), entry(item("d", state: .stale, dismissedAt: 5)),
                       entry(item("e", state: .sending)), entry(item("f", scheduledFor: 9)), entry(item("g", state: .live))]
        #expect(OutboxModel.waitingCount(entries, holds: { _ in false }) == 4)
        #expect(OutboxModel.waitingCount(entries, holds: { $0.item.ref == .host(.init(id: "a")) }) == 3)
    }

    @Test func `a host whose list has not answered counts the rows the phone kept`() {
        let hosts = [OutboxModel.CountedHost(listed: true, entries: [entry(item("a")), entry(item("b"))], kept: 9),
                     OutboxModel.CountedHost(listed: false, entries: [], kept: 3)]
        #expect(OutboxModel.waitingCount(hosts, holds: { _ in false }) == 5)
    }

    @Test func `the Work list's count, Today's held rows and the kept rows agree`() {
        let all = [item("a"), item("b", state: .failed), item("c", state: .stale), item("d", state: .sending), item("e", scheduledFor: 9), item("f", state: .live), item("g", state: .stale, dismissedAt: 1)]
        for one in all { #expect(TodaySources.needsHim(one) == OutboxModel.needsHim(one)) }
        let holds: (OutboxModel.Entry) -> Bool = { $0.item.ref == .host(.init(id: "b")) }
        let entries = all.map { entry($0) }
        // Today is handed the items less what a Send holds back (TodayFeed), as the count leaves them out.
        let today = TodaySources.heldRows(entries.filter { !holds($0) }.map { .init(environmentId: $0.environmentId, item: $0.item) }, now: 0, names: [:], calendar: .current)
        #expect(today.count == OutboxModel.waitingCount(entries, holds: holds))
        let kept = WorkCache.waiting(entries.map { .init(environmentId: $0.environmentId, item: $0.item) }, names: [:])
        #expect(kept.count == OutboxModel.waitingCount(entries, holds: { _ in false }))
    }

    // MARK: - the kept rows

    @Test func `kept rows are read once and written only when they changed`() {
        let cache = OutboxBookCache()
        let kept = OutboxKept(cache: cache)
        let key = WorkCache.Key(host: "mac", account: "k1", keyGeneration: 1, scope: .outbox)
        #expect(kept.rows(key).isEmpty)
        let rows = WorkCache.waiting([.init(environmentId: "mac", item: item("a"))], names: [:])
        kept.keep(rows, at: key)
        kept.keep(rows, at: key)
        #expect(cache.writes == 1)
        #expect(cache.waitingRows(key) == rows)
        // A new kept store over the same cache paints the rows at once (a cold launch).
        #expect(OutboxKept(cache: cache).rows(key) == rows)
        kept.drop(.workOff(host: "mac"))
        #expect(cache.waitingRows(key).isEmpty)
        #expect(kept.rows(key).isEmpty)
    }

    @Test func `a replaced key never reads the old key's rows`() {
        let cache = OutboxBookCache()
        let old = WorkCache.Key(host: "mac", account: "k1", keyGeneration: 1, scope: .outbox)
        let new = WorkCache.Key(host: "mac", account: "k2", keyGeneration: 2, scope: .outbox)
        cache.keepWaiting(WorkCache.waiting([.init(environmentId: "mac", item: item("a"))], names: [:]), at: old)
        #expect(cache.waitingRows(new).isEmpty)
        cache.keepWaiting([], at: new)
        #expect(cache.waitingRows(old).isEmpty)
    }

    @Test func `kept rows draw one band per place, oldest first`() {
        func row(_ id: String, place: String?, at: Int) -> WorkCache.WaitingRow {
            WorkCache.WaitingRow(environmentId: "mac", ref: "host:\(id)", kind: "addon.call", act: "Send \(id)", about: nil, place: place, at: at)
        }
        let bands = WorkCache.keptBands([row("b", place: "Unify", at: 5), row("a", place: "Purdue", at: 1), row("c", place: "Purdue", at: 9), row("d", place: nil, at: 7)])
        #expect(bands.map(\.place) == ["Purdue", "Unify", "Work"])
        #expect(bands[0].rows.map(\.ref) == ["host:a", "host:c"])
    }

    // MARK: - the ledger

    @Test func `a press on many writes each item down before it leaves, and the answer clears them all`() async throws {
        let ledger = PressLedger(file: nil, now: { 100 }, wait: { _ in try? await Task.sleep(for: .seconds(3600)) })
        let out = try await ledger.runMany(.outboxSend, host: "mac", hostName: "Mac", items: [("host:a", "1"), ("host:b", "2")], linked: true) {
            #expect(ledger.pending.presses.map(\.ref) == ["host:a", "host:b"])
            #expect(ledger.busy(host: "mac", ref: "host:b"))
            return 7
        }
        #expect(out == 7)
        #expect(ledger.pending.presses.isEmpty)
        #expect(ledger.state(host: "mac", ref: "host:a") == nil)
    }

    @Test func `a lost answer leaves every item Checking; a second press on one of them sends nothing`() async throws {
        let ledger = PressLedger(file: nil, now: { 100 }, wait: { _ in try? await Task.sleep(for: .seconds(3600)) })
        await #expect(throws: PressLedger.Unknown(host: "mac", ref: "host:a")) {
            try await ledger.runMany(.outboxSend, host: "mac", hostName: "Mac", items: [("host:a", "1"), ("host:b", "2")], linked: true) { () async throws -> Int in
                throw TransportError.cancelled
            }
        }
        #expect(ledger.state(host: "mac", ref: "host:a") == .checking)
        #expect(ledger.state(host: "mac", ref: "host:b") == .checking)
        do {
            _ = try await ledger.runMany(.outboxSend, host: "mac", hostName: "Mac", items: [("host:c", nil), ("host:b", "2")], linked: true) { 1 }
            Issue.record("a second press on an item still out went")
        } catch {
            #expect(ActionError.wrap(error).message == "Checking…")
        }
        #expect(!ledger.busy(host: "mac", ref: "host:c"))
    }

    @Test func `with no link a press on many is refused at once and writes nothing`() async throws {
        let ledger = PressLedger(file: nil, now: { 100 }, wait: { _ in })
        do {
            _ = try await ledger.runMany(.outboxDiscard, host: "box", hostName: "Box", items: [("host:a", "1")], linked: false) { 1 }
            Issue.record("a press with no link went")
        } catch {
            #expect(ActionError.wrap(error).message == "Not connected to Box")
        }
        #expect(ledger.pending.presses.isEmpty)
    }

    @Test func `a host whose answer was lost counts as checking in the sum, never left out`() throws {
        let a = item("a"), c = item("c")
        let press = try #require(GroupPress([entry(a), entry(c, host: "box")], act: .send))
        var outcome = GroupOutcome(did: press.act)
        outcome.take(host: "mac", [DecisionResult(ref: a.ref, ok: true, item: item("a", state: .sent))], of: press)
        outcome.lost(host: "box", of: press)
        #expect(outcome.head == "Sent 1, checking 1")
        // Its row's own line is the press record's Checking…, not a reason kept after the read-back.
        #expect(outcome.reason("box:host:c") == nil)
    }
}
