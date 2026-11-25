import Foundation
import Observation

/// One item's Create link across presses and sheets (docs/agents/work-guests.md "The phone"): the attempt key the
/// host answers once is kept until the phone knows what became of it. It survives a busy refusal, a lost answer and
/// the sheet closing; after a relaunch the press record still holds it (`PendingPress.attempt`). A fresh key comes
/// only after the host answered (made, or refused in its words), a read-back found nothing made, or his own New Link.
@MainActor @Observable
public final class GuestAttempts {
    public static let shared = GuestAttempts()

    /// Where one item's Create stands.
    public enum Phase: Sendable, Hashable {
        /// The answer was lost: the form waits while the host is read back.
        case checking
        /// A read-back found the link made: its address showed nowhere and is not kept.
        case made
        /// The host refused the lost press in its words: no link was made.
        case refused(String)
        /// The host cannot say: it restarted while making it. The key stays, so a Create under it gets the host's own
        /// answer again, never a second link; New Link is his to press.
        case cut(String)
    }

    /// The kept key per item, by `key(host:ref:)`.
    public private(set) var attempts: [String: String] = [:]
    public private(set) var phases: [String: Phase] = [:]

    /// An address the host made that no screen has shown yet: the host sends it once, so it waits here, by item and
    /// with the attempt it answered, until a screen shows it (`shown`). In memory alone: never written to disk, and
    /// gone with the app.
    public struct Unseen: Sendable, Hashable {
        public let attempt: String
        public let address: String
    }
    public private(set) var unseen: [String: Unseen] = [:]

    public init() {}

    nonisolated static func key(_ host: String, _ ref: String) -> String { "\(host)|\(ref)" }

    /// The key his next Create on the item sends: the one a press already out holds (`pending`, the press record),
    /// else the one kept here, else a fresh one, kept from now on.
    public func attempt(host: String, ref: String, pending: [PendingPress]) -> String {
        let key = Self.key(host, ref)
        if let out = pending.first(where: { $0.host == host && $0.ref == ref && ($0.kind == .guestLink || $0.kind == .guestRekey) })?.attempt {
            attempts[key] = out
            return out
        }
        if let kept = attempts[key] { return kept }
        let fresh = PendingPress.newAttempt()
        attempts[key] = fresh
        return fresh
    }

    public func phase(host: String, ref: String) -> Phase? { phases[Self.key(host, ref)] }

    /// The host answered his Create (made, or refused in its own words): the next Create is a new link.
    public func answered(host: String, ref: String) {
        forget(Self.key(host, ref))
    }

    /// The answer was lost, or a press on the item is still out (a busy refusal): the key stays, Checking.
    public func lost(host: String, ref: String) {
        phases[Self.key(host, ref)] = .checking
    }

    /// What the ledger heard of a lost Create (a late answer, or a read-back on a later link).
    public func heard(host: String, ref: String, state: PressState) {
        let key = Self.key(host, ref)
        switch state {
        case .done:
            // Made by the first try: shown from the item's links, the key kept until his New Link.
            phases[key] = .made
        case .stillWaiting, .changed, .gone:
            // Confirmed: no link was made by it. The next Create is his own new press.
            forget(key)
        case .failed(let words):
            attempts[key] = nil
            phases[key] = .refused(words.isEmpty ? "The link was not made." : words)
        case .mayHaveGone:
            phases[key] = .cut(ShareRules.cutWords)
        case .checking, .sending:
            phases[key] = .checking
        }
    }

    /// The host's answer carried an address: kept until shown, whether or not the screen that pressed is still there
    /// (Back during New Address, an answer after the fifteen seconds).
    public func delivered(host: String, ref: String, attempt: String, address: String) {
        unseen[Self.key(host, ref)] = Unseen(attempt: attempt, address: address)
    }

    /// The address waiting for this item or link, if any.
    public func unseen(host: String, ref: String) -> Unseen? { unseen[Self.key(host, ref)] }

    /// A screen showed it: it goes from memory (the sheet showing it keeps its own copy until closed).
    public func shown(host: String, ref: String) {
        unseen[Self.key(host, ref)] = nil
    }

    /// His New Link: whatever the last try made, the next Create is a new link.
    public func newLink(host: String, ref: String) {
        forget(Self.key(host, ref))
    }

    private func forget(_ key: String) {
        attempts[key] = nil
        phases[key] = nil
    }
}
