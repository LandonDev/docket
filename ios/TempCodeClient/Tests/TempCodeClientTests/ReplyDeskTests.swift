import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// His reply in one conversation (Work/Messages/ReplyDesk.swift): his words are never lost and never sent twice.
@Suite struct ReplyDeskTests {
    private func pressed(_ words: String, attempt: String = "a1") -> ReplyDesk {
        var desk = ReplyDesk(field: words)
        _ = desk.press(attempt: attempt)
        return desk
    }

    @Test func `Send empties the field at the press and a second press waits`() {
        var desk = ReplyDesk(field: "  On it.  ")
        let out = desk.press(attempt: "a1")
        #expect(out?.words == "On it." && out?.attempt == "a1" && out?.phase == .counting)
        #expect(desk.field.isEmpty)
        desk.type("And more")
        #expect(desk.press(attempt: "a2") == nil)
        #expect(desk.out?.attempt == "a1")
    }

    @Test func `nothing to send, or past LifeOS's limit, presses nothing`() {
        var empty = ReplyDesk(field: " \n ")
        #expect(empty.press(attempt: "a") == nil)
        var long = ReplyDesk(field: String(repeating: "x", count: MessagesRules.replyMax + 1))
        #expect(!long.canSend && long.press(attempt: "a") == nil)
    }

    @Test func `Undo inside the five seconds puts the words back before what he typed since`() {
        var desk = pressed("On it.")
        desk.type("Also")
        desk.undo()
        #expect(desk.out == nil && desk.field == "On it.\nAlso")
        // Once it has gone, Undo is LifeOS's (its row's Undo), not the desk's.
        var gone = pressed("On it.")
        gone.dispatched()
        gone.undo()
        #expect(gone.out?.phase == .sending && gone.field.isEmpty)
    }

    @Test func `a reply taken back in LifeOS's undo time comes back before what he typed since`() {
        var desk = ReplyDesk(field: "typed")
        desk.takeBack("On it.")
        #expect(desk.field == "On it.\ntyped")
        desk.takeBack("")
        #expect(desk.field == "On it.\ntyped")
    }

    @Test func `a lost link before the five seconds end puts it back and says why`() {
        var desk = pressed("On it.")
        desk.putBack("Not sent: lost the link to Mac")
        #expect(desk.field == "On it." && desk.line == "Not sent: lost the link to Mac")
        desk.type("On it!")
        #expect(desk.line == nil)
    }

    @Test func `sent: the words go, LifeOS's row shows them`() {
        var desk = pressed("On it.")
        #expect(desk.line == nil)
        desk.dispatched()
        #expect(desk.line == "Sending…")
        desk.answered(.sent)
        #expect(desk.out == nil && desk.field.isEmpty && desk.line == nil && desk.aside.isEmpty)
    }

    @Test func `a refusal puts his words back before what he typed since, with LifeOS's words`() {
        var desk = pressed("On it.")
        desk.dispatched()
        desk.type("More")
        desk.answered(.refused("LifeOS can't reply in discord yet"))
        #expect(desk.field == "On it.\nMore" && desk.line == "LifeOS can't reply in discord yet")
    }

    @Test func `may have gone keeps the words aside, never under a plain Send, until Use Words`() {
        var desk = pressed("On it.")
        desk.dispatched()
        desk.answered(.mayHaveGone("It may have gone: socket hang up"))
        #expect(desk.field.isEmpty && desk.aside == ["On it."])
        #expect(desk.line == "May have gone. Check above before sending it again.")
        desk.type("Second")
        _ = desk.press(attempt: "a2")
        desk.dispatched()
        desk.answered(.mayHaveGone("It may have gone"))
        desk.type("now")
        desk.useWords()
        #expect(desk.field == "On it.\nSecond\nnow" && desk.aside.isEmpty && desk.line == nil)
    }

    @Test func `no answer is Checking, read back by its key: sent, never got, refused, may have gone`() {
        func checking() -> ReplyDesk {
            var desk = pressed("On it.")
            desk.dispatched()
            desk.answered(.unknown)
            return desk
        }
        var desk = checking()
        #expect(desk.line == "Checking…" && !desk.canSend)
        // Another press's read-back is not this one's.
        desk.readBack(attempt: "other", state: .done)
        #expect(desk.out?.phase == .checking)
        desk.readBack(attempt: "a1", state: .done)
        #expect(desk.out == nil && desk.field.isEmpty)

        var never = checking()
        never.type("typed")
        never.readBack(attempt: "a1", state: .stillWaiting)
        #expect(never.field == "On it.\ntyped" && never.line == "Not sent")

        var refused = checking()
        refused.readBack(attempt: "a1", state: .failed("Too long"))
        #expect(refused.field == "On it." && refused.line == "Not sent: Too long")

        var unsure = checking()
        unsure.readBack(attempt: "a1", state: .mayHaveGone)
        #expect(unsure.aside == ["On it."] && unsure.field.isEmpty)

        var still = checking()
        still.readBack(attempt: "a1", state: .checking)
        #expect(still.out?.phase == .checking)
    }

    @Test @MainActor func `the desks hear a read-back by its attempt key`() {
        let desks = MessagesDesks()
        let key = MessagesDesks.key(environmentId: "box", workspaceId: "w1", chatId: "c1")
        let other = MessagesDesks.key(environmentId: "box", workspaceId: "w1", chatId: "c2")
        desks.update(key) { $0.type("On it.") }
        _ = desks.update(key) { $0.press(attempt: "a1") }
        desks.update(key) {
            $0.dispatched()
            $0.answered(.unknown)
        }
        desks.update(other) { $0.type("Untouched") }
        desks.readBack(attempt: "a1", state: .stillWaiting)
        #expect(desks.desk(key).field == "On it." && desks.desk(key).out == nil)
        #expect(desks.desk(other).field == "Untouched")
        #expect(desks.desk("nobody").field.isEmpty)
    }

    @Test @MainActor func `a reply read back after a relaunch, with no desk holding it, is said on its conversation`() {
        let desks = MessagesDesks()
        desks.readBack(attempt: "phone-a", state: .stillWaiting, host: "mac", ref: ChatPress.ref(workspaceId: "w1", chatId: "c1"))
        let key = MessagesDesks.key(environmentId: "mac", workspaceId: "w1", chatId: "c1")
        #expect(desks.desk(key).line == ReplyDesk.wordsLostLine)
        desks.readBack(attempt: "phone-b", state: .done, host: "mac", ref: ChatPress.ref(workspaceId: "w1", chatId: "c2"))
        #expect(desks.desk(MessagesDesks.key(environmentId: "mac", workspaceId: "w1", chatId: "c2")).line == nil)
        #expect(ChatPress.chat(ofRef: "chat:w1:c1") == "c1")
    }
}
