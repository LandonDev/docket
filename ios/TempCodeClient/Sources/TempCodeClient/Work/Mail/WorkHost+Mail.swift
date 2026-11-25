import Foundation
import TempCodeContract

/// Mail as a place (docs/agents/work-mail.md "The phone"): what the screens ask of the host beyond LifeOS's own
/// reads. Every verb on a mail he timed is `approve` with the person's word; only Send Now goes out to anyone.
extension WorkHost {
    /// Moves a mail he timed to another time, in his zone; it stays scheduled. Not outward.
    public func rescheduleMail(_ id: String, at: Int, zone: String = TimeZone.current.identifier) async throws {
        _ = try await socket.request(Methods.WorkMailReschedule.self, .init(id: id, sendAt: at, sendZone: zone))
    }

    /// Takes a mail he timed back to a draft. False: it was already on its way. Not outward.
    public func cancelMail(_ id: String) async throws -> Bool {
        try await socket.request(Methods.WorkMailCancel.self, .init(id: id)).back
    }

    /// Send Now on a mail he timed (outward): written to the ledger by the Outbox item's ref before it leaves, read
    /// back by that item's time (`MailRules.sendNowTruth`). It goes after LifeOS's undo time.
    public func sendMailNow(_ item: OutboxItem, id: String, key: String? = nil) async throws {
        _ = try await presses.run(.mailSendNow, host: environment.id, hostName: environment.name, ref: OutboxModel.key(item.ref), rev: MailRules.rev(item), linked: linked, key: key) { [socket] in
            // The time he saw it set for: the host sends nothing moved since (mail/index.ts `TIME_CHANGED`).
            try await socket.request(Methods.WorkMailSendNow.self, .init(id: id, sendAt: item.scheduledFor)).sendAt
        }
        await refreshOutbox()
    }

    /// A job's Waiting on settings (the days a question waits, the nudge routine). Read only on the phone.
    public func mailWaiting(_ workspaceId: String) async throws -> MailWaiting {
        try await socket.request(Methods.WorkMailWaiting.self, .init(workspaceId: workspaceId))
    }

    /// The job's chats about one mail thread, newest first.
    public func mailChats(workspaceId: String, mailThreadId: String) async throws -> [String] {
        try await socket.request(Methods.WorkMailChatFind.self, .init(workspaceId: workspaceId, mailThreadId: mailThreadId)).sessionIds
    }

    /// Ask's first send: a Work thread made a mail chat before its first message goes (`mailAdopt`, a must step:
    /// a refusal stops the message), the mail as its chip.
    public func startMailChat(workspaceId: String, mailThreadId: String, about chip: ContextChip, text: String) async throws -> SessionMeta {
        try await socket.request(
            Methods.SessionCreate.self,
            .init(
                workspaceId: .set(workspaceId), threadType: .set(.chat), firstMessage: ChipWords.message([chip], text: text),
                mailAdopt: MailRules.adopt(workspaceId: workspaceId, mailThreadId: mailThreadId), scope: .work, about: chip
            )
        )
    }
}
