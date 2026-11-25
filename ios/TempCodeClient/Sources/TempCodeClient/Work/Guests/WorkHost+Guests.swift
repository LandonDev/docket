import Foundation
import TempCodeContract

/// Share on the phone (docs/agents/work-guests.md "The phone"): one item's links, Create link with an attempt key
/// the host answers once, the role, a new address, Revoke. The rows live on the host that serves LifeOS's documents
/// (a file's, on the host that has the file); another host answers `served elsewhere: <env>` and the sheet asks that one.
extension WorkHost {
    /// The item's links, live and lately ended.
    public func links(for source: ShareSource) async throws -> [GuestLinkRow] {
        try await socket.request(Methods.WorkGuestsForItem.self, .init(source: source.forItemSource))
    }

    /// Create link, his press: written to the ledger under `attempt` before it leaves (`PressLedger.run`). A lost
    /// answer throws `PressLedger.Unknown` and is read back by the key on the next link; pressed again with the same
    /// key, the host makes no second link and answers it with no address.
    public func makeLink(_ draft: GuestLinkDraft, source: ShareSource, title: String, attempt: String, key: String? = nil) async throws -> ShareRules.Made {
        let params = Methods.WorkGuestsCreate.Params(source: source.createSource, title: title, name: draft.trimmedName, role: draft.role.wire, expiresAt: draft.expiresAtMs, attempt: attempt)
        let host = environment.id, ref = source.ref
        let answer = try await presses.run(.guestLink, host: host, hostName: environment.name, ref: ref, rev: nil, attempt: attempt, linked: linked, key: key) { [socket] in
            let out = try await socket.request(Methods.WorkGuestsCreate.self, params)
            // Kept as it lands, whoever still waits for it (`GuestAttempts.unseen`): the host sends it once.
            if out.again != true, let url = out.url { GuestAttempts.shared.delivered(host: host, ref: ref, attempt: attempt, address: url) }
            return out
        }
        return ShareRules.made(answer)
    }

    /// What a live link lets its guest do, changed at once: the guest's page opens again as the new role.
    /// Its frame is asked again as the socket releases it, under the key the owner's check passed (`guarded`).
    public func setRole(_ link: GuestLinkRow, to role: GuestLinkDraft.Role, key: String? = nil) async throws {
        _ = try await presses.guarded(host: environment.id, key: key, method: .guestsSetRole) { [socket] in
            try await socket.request(Methods.WorkGuestsSetRole.self, .init(linkId: link.id, role: .init(rawValue: role.rawValue)))
        }
    }

    /// Each Create link of his on this host whose answer was lost, read back by its attempt key. The read makes
    /// nothing: a key the host never heard reads as still his to press.
    func checkGuestPresses() async {
        // Create and Replace Address alike: the host answers both keys on the same rows.
        await presses.check(host: environment.id, where: { $0 == .guestLink || $0 == .guestRekey }) { [socket] press in
            guard let attempt = press.attempt else { return .mayHaveGone }
            return PressTruth.guest(try await socket.request(Methods.WorkGuestsAttempt.self, .init(attempt: attempt)))
        }
    }

    /// What a Replace Address press came to.
    public enum Replaced: Sendable, Hashable {
        /// The new address, shown once.
        case address(String)
        /// Replaced by an earlier try of this press: its address showed nowhere (`ShareRules.rekeyedWords`).
        case again
        /// The answer was lost, or one is still out: Checking, and no second Replace until it is read back.
        case checking
        /// Refused in the host's words: nothing was replaced.
        case refused(String)
    }

    /// Replace Address, his press, from Share or Settings → Work: one attempt key per link (`GuestAttempts`), kept
    /// through a lost answer and a relaunch, so a repeat replaces nothing twice; a fresh key only for his own next
    /// press once the last one's outcome is known.
    public func replaceAddress(_ link: GuestLinkRow, key: String? = nil) async -> Replaced {
        let ref = ShareRules.rekeyRef(link.id)
        let attempts = GuestAttempts.shared
        switch attempts.phase(host: environment.id, ref: ref) {
        case .checking?: return .checking
        case .made?, .refused?, .cut?: attempts.newLink(host: environment.id, ref: ref)
        case nil: break
        }
        let attempt = attempts.attempt(host: environment.id, ref: ref, pending: presses.pending.presses)
        do {
            guard let url = try await rekey(link, attempt: attempt, key: key) else {
                // Replaced by an earlier try of this press: the row says so until his next Replace.
                attempts.heard(host: environment.id, ref: ref, state: .done)
                return .again
            }
            attempts.answered(host: environment.id, ref: ref)
            return .address(url)
        } catch {
            if error is PressLedger.Unknown || presses.busy(host: environment.id, ref: ref) {
                attempts.lost(host: environment.id, ref: ref)
                return .checking
            }
            attempts.answered(host: environment.id, ref: ref)
            return .refused(ActionError.wrap(error).message)
        }
    }

    /// What a link's row says of its last Replace Address while it has words: Checking, replaced with its address shown
    /// nowhere, or the host's words. Nil once his next press or the host's answer cleared it.
    public func rekeyLine(_ linkId: String) -> String? {
        switch GuestAttempts.shared.phase(host: environment.id, ref: ShareRules.rekeyRef(linkId)) {
        case .checking?: ShareRules.rekeyCheckingWords
        case .made?: ShareRules.rekeyedWords
        case .refused(let words)?, .cut(let words)?: words
        case nil: nil
        }
    }

    /// Replace Address is offered while no press of it is out on the link.
    public func mayReplace(_ linkId: String) -> Bool {
        may(.guestsRekey) && GuestAttempts.shared.phase(host: environment.id, ref: ShareRules.rekeyRef(linkId)) != .checking
            && !presses.busy(host: environment.id, ref: ShareRules.rekeyRef(linkId))
    }
}
