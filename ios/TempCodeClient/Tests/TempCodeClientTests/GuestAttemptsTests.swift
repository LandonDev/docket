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
}
