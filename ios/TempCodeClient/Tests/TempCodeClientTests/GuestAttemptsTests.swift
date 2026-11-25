import Testing
@testable import TempCodeClient

/// One item's Create link across presses and sheets (Work/Guests/GuestAttempts.swift): never a second link after
/// a lost answer.
@Suite @MainActor struct GuestAttemptsTests {
    @Test func `the key survives a lost answer, a busy refusal and the sheet opened again`() {
        let attempts = GuestAttempts()
        let first = attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [])
        attempts.lost(host: "box", ref: "guest:docs:d1")
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == .checking)
        // He presses Create again while the ledger still checks: refused as busy, the key stays.
        attempts.lost(host: "box", ref: "guest:docs:d1")
        // The sheet is closed and opened again: the same key.
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) == first)
        // Another item, or another host, has its own.
        #expect(attempts.attempt(host: "mac", ref: "guest:docs:d1", pending: []) != first)
    }

    @Test func `after a relaunch the press record's key is the one sent`() {
        let attempts = GuestAttempts()
        let out = PendingPress(host: "box", kind: .guestLink, ref: "guest:docs:d1", at: 1, attempt: "phone-kept")
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [out]) == "phone-kept")
    }

    @Test func `a read-back that finds the link made keeps the key until New Link`() {
        let attempts = GuestAttempts()
        let first = attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [])
        attempts.lost(host: "box", ref: "guest:docs:d1")
        attempts.heard(host: "box", ref: "guest:docs:d1", state: .done)
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == .made)
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) == first)
        attempts.newLink(host: "box", ref: "guest:docs:d1")
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == nil)
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) != first)
    }

    @Test func `a confirmed absence or the host's answer frees the next Create`() {
        let attempts = GuestAttempts()
        let first = attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [])
        attempts.lost(host: "box", ref: "guest:docs:d1")
        attempts.heard(host: "box", ref: "guest:docs:d1", state: .stillWaiting)
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == nil)
        let second = attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [])
        #expect(second != first)
        attempts.answered(host: "box", ref: "guest:docs:d1")
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) != second)
        attempts.heard(host: "box", ref: "guest:docs:d1", state: .failed("shared too widely"))
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == .refused("shared too widely"))
    }

    @Test func `a Create the host's restart cut off keeps its key and says so; New Link starts over`() {
        let attempts = GuestAttempts()
        let first = attempts.attempt(host: "box", ref: "guest:docs:d1", pending: [])
        attempts.lost(host: "box", ref: "guest:docs:d1")
        attempts.heard(host: "box", ref: "guest:docs:d1", state: .mayHaveGone)
        #expect(attempts.phase(host: "box", ref: "guest:docs:d1") == .cut(ShareRules.cutWords))
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) == first)
        attempts.newLink(host: "box", ref: "guest:docs:d1")
        #expect(attempts.attempt(host: "box", ref: "guest:docs:d1", pending: []) != first)
    }

    @Test func `Replace Address keeps one key a link through a lost answer, as Create does`() {
        let attempts = GuestAttempts()
        let ref = ShareRules.rekeyRef("link9")
        let out = PendingPress(host: "box", kind: .guestRekey, ref: ref, at: 1, attempt: "phone-rekey")
        #expect(attempts.attempt(host: "box", ref: ref, pending: [out]) == "phone-rekey")
        #expect(PendingPress.Kind.guestRekey.readsBack && !PendingPress.Kind.guestRekey.readsItem)
    }

    @Test func `Share stays open while a Create or a Replace Address is out, so its one address is never lost`() {
        #expect(ShareRules.mayClose(creating: false, linkBusy: nil))
        // Create pressed and waiting for the host (a slow success, or a refusal still on its way).
        #expect(!ShareRules.mayClose(creating: true, linkBusy: nil))
        // Replace Address out on one link.
        #expect(!ShareRules.mayClose(creating: false, linkBusy: "link-1"))
    }

    @Test func `every address the host made waits in memory by its attempt until a screen shows it`() {
        let attempts = GuestAttempts()
        let a = ShareRules.rekeyRef("link-a"), b = ShareRules.rekeyRef("link-b")
        // Two replacements answered while no screen waits (Back during New Address, a late answer): both are kept.
        attempts.delivered(host: "box", ref: a, attempt: "phone-1-a", address: "https://x/a")
        attempts.delivered(host: "box", ref: b, attempt: "phone-2-b", address: "https://x/b")
        // The press's own outcome being settled does not drop the address.
        attempts.answered(host: "box", ref: a)
        #expect(attempts.unseen(host: "box", ref: a) == .init(attempt: "phone-1-a", address: "https://x/a"))
        #expect(attempts.unseen(host: "box", ref: b)?.address == "https://x/b")
        #expect(attempts.unseen(host: "mac", ref: a) == nil)
        // Shown once: it goes; the other still waits.
        attempts.shown(host: "box", ref: a)
        #expect(attempts.unseen(host: "box", ref: a) == nil)
        #expect(attempts.unseen(host: "box", ref: b) != nil)
    }

    @Test func `the sheet acknowledges the attempt it showed, and a second address that came meanwhile shows next`() {
        let attempts = GuestAttempts()
        let a = ShareRules.rekeyRef("link-a"), b = ShareRules.rekeyRef("link-b")
        // B answers first and its sheet opens on B's attempt.
        attempts.delivered(host: "box", ref: b, attempt: "phone-2-b", address: "https://x/b")
        let open = attempts.next(host: "box", refs: [a, b])
        #expect(open?.kept.attempt == "phone-2-b")
        // A answers while B's sheet is up; A is above B in the list.
        attempts.delivered(host: "box", ref: a, attempt: "phone-3-a", address: "https://x/a")
        // Done on B's sheet acknowledges B alone, never A.
        attempts.shown(host: "box", ref: b, attempt: "phone-2-b")
        #expect(attempts.unseen(host: "box", ref: a)?.address == "https://x/a")
        #expect(attempts.next(host: "box", refs: [a, b])?.kept.attempt == "phone-3-a")
        // A stale acknowledgement for a ref whose newer address waits leaves the newer one.
        attempts.delivered(host: "box", ref: b, attempt: "phone-4-b", address: "https://x/b2")
        attempts.shown(host: "box", ref: b, attempt: "phone-2-b")
        #expect(attempts.unseen(host: "box", ref: b)?.attempt == "phone-4-b")
    }

    @Test func `a kept address names whose link it opens and to what`() {
        let attempts = GuestAttempts()
        let a = ShareRules.rekeyRef("link-a"), b = ShareRules.rekeyRef("link-b")
        attempts.delivered(host: "box", ref: a, attempt: "phone-1-a", address: "https://x/a", name: "Dana Lee", title: "Budget")
        attempts.delivered(host: "box", ref: b, attempt: "phone-2-b", address: "https://x/b", name: "Sam", title: "Stage plan")
        #expect(attempts.unseen(host: "box", ref: a)?.whose == "Dana Lee’s link to Budget")
        // Shown in turn, each named; the first stays as it was while shown.
        let first = attempts.next(host: "box", refs: [a, b])
        #expect(first?.kept.whose == "Dana Lee’s link to Budget")
        attempts.delivered(host: "box", ref: b, attempt: "phone-3-b", address: "https://x/b2", name: "Sam", title: "Stage plan")
        #expect(first?.kept.address == "https://x/a")
        attempts.shown(host: "box", ref: a, attempt: first!.kept.attempt)
        #expect(attempts.next(host: "box", refs: [a, b])?.kept.whose == "Sam’s link to Stage plan")
        #expect(GuestAttempts.Unseen(attempt: "p", address: "u").whose == "A guest link")
    }
}
