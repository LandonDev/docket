import Foundation
import TempCodeContract

/// LifeOS's screens inside a Work workspace (milestone 47): what they ask of the host.
extension WorkHost {
    /// A thread about a task, a mail or an event, started in the workspace when he presses Start:
    /// the chip's line above his words, and `about` so the host links it in LifeOS.
    public func startThread(workspaceId: String, about chip: ContextChip, text: String) async throws -> SessionMeta {
        try await socket.request(
            Methods.SessionCreate.self,
            .init(workspaceId: .set(workspaceId), threadType: .set(.chat), firstMessage: ChipWords.message([chip], text: text), scope: .work, about: chip)
        )
    }

    /// Ask from an item: his words go to the thread beside it, the selection's line above them.
    public func ask(sessionId: String, chip: ContextChip, text: String) async throws {
        _ = try await socket.request(Methods.SessionSend.self, .init(sessionId: sessionId, text: ChipWords.message([chip], text: text)))
    }

    /// The press on a saved draft from any screen: the host sends it as LifeOS holds it, only if it
    /// still says what the composer saved. A thread's draft goes through the hold (`via: hold`).
    /// A time goes with the IANA zone it was picked in (`sendZone`), so his screens can say it in both.
    /// Written to the ledger by the draft before it leaves (`PressLedger.run`): a lost answer throws
    /// `PressLedger.Unknown`, and the draft is read back by its LifeOS status (`checkMailPresses`).
    public func sendMail(draftId: String, seen: Methods.WorkMailSend.Params.Seen, sendAt: Date? = nil, sendZone: String? = nil, key: String? = nil) async throws -> Methods.WorkMailSend.Output {
        let params = Methods.WorkMailSend.Params(id: draftId, sendAt: sendAt.map { Int(($0.timeIntervalSince1970 * 1000).rounded()) }, sendZone: sendAt == nil ? nil : sendZone, seen: seen)
        return try await presses.run(.mailSend, host: environment.id, hostName: environment.name, ref: PendingPress.mailRef(draftId), rev: nil, linked: linked, key: key) { [socket] in
            try await socket.request(Methods.WorkMailSend.self, params)
        }
    }

    /// Each composer Send of his on this host whose answer was lost, read back by its draft's status in LifeOS
    /// (`status` reads it on the job's own LifeOS session; nil when LifeOS has no such draft). Answers each one's state.
    @discardableResult
    public func checkMailPresses(status: @MainActor (String) async throws -> String?) async -> [String: PressState] {
        let resolved = await presses.check(host: environment.id, where: { $0 == .mailSend }) { press in
            guard let id = PendingPress.draft(ofRef: press.ref) else { return .mayHaveGone }
            return PressTruth.mail(status: try await status(id))
        }
        return Dictionary(resolved.map { (PendingPress.draft(ofRef: $0.press.ref) ?? $0.press.ref, $0.state) }, uniquingKeysWith: { _, last in last })
    }

    /// The rule proposals a sent draft gave rise to: the line under it.
    public func proposals(forDraft draftId: String) async throws -> [RuleProposal] {
        try await socket.request(Methods.WorkRulesForDraft.self, .init(draftId: draftId)).proposals.filter { $0.state == .open }
    }

    public func workspaceSettings(_ workspaceId: String) async throws -> Methods.WorkWorkspaceGet.Output {
        try await socket.request(Methods.WorkWorkspaceGet.self, .init(workspaceId: workspaceId))
    }

    /// Write in his voice: the workspace's own switch.
    public func setVoice(_ workspaceId: String, _ on: Bool) async throws -> Methods.WorkWorkspaceSet.Output {
        try await socket.request(Methods.WorkWorkspaceSet.self, .init(workspaceId: workspaceId, patch: .init(voice: on)))
    }
}
