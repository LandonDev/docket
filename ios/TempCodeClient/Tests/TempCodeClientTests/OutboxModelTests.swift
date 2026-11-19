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

    @Test func theHostThatHoldsAnActIsBookkeepingNotAField() {
        let call: JSONValue = .object(["host": .string("env_Q2gUxM8"), "channel": .string("#events"), "text": .string("Booked.\nSee you there.")])
        #expect(OutboxModel.payloadView(call).fields.map(\.label) == ["In"])
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
