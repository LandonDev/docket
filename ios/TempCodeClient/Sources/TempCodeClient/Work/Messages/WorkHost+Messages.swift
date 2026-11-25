import Foundation
import TempCodeContract

/// Messages through the host (docs/agents/work-messages.md "The phone"). The conversations are LifeKit's own reads on
/// the LifeOS session; what goes through the host is his reply (Send, Undo inside LifeOS's undo time, Retry of a
/// failed one), the read-back of a Send whose answer was lost, the search, the unread count, and a thread's
/// copy-only drafts. The host checks approve (operate for a draft's drop) and fences each call to the job's sector.
extension WorkHost {
    /// His own reply, written to the ledger under `attempt` before it leaves (`PressLedger.run`). Answers LifeOS's
    /// outbox row. A lost answer throws `PressLedger.Unknown` and is read back by the key on the next link.
    public func sendReply(workspaceId: String, chatId: String, text: String, attempt: String, key: String? = nil) async throws -> String {
        let ref = ChatPress.ref(workspaceId: workspaceId, chatId: chatId)
        return try await presses.run(.chatReply, host: environment.id, hostName: environment.name, ref: ref, rev: nil, attempt: attempt, linked: linked, key: key) { [socket] in
            try await socket.request(Methods.WorkMessagesSend.self, .init(workspaceId: workspaceId, chatId: chatId, text: text, attempt: attempt)).id
        }
    }

    /// Takes back a reply still inside LifeOS's undo time; answers its words.
    public func undoReply(workspaceId: String, chatId: String, outboxId: String) async throws -> String {
        try await socket.request(Methods.WorkMessagesUndo.self, .init(workspaceId: workspaceId, chatId: chatId, id: outboxId)).text
    }

    /// Sends a failed reply again, through the ledger by LifeOS's outbox row (`ChatPress.retryRef`): a lost answer
    /// throws `PressLedger.Unknown`, and the row stays Checking until the conversation's live rows say what LifeOS did
    /// (`settleRetry`).
    public func retryReply(workspaceId: String, chatId: String, outboxId: String, key: String? = nil) async throws {
        _ = try await presses.run(.chatRetry, host: environment.id, hostName: environment.name, ref: ChatPress.retryRef(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId), rev: nil, linked: linked, key: key) { [socket] in
            try await socket.request(Methods.WorkMessagesRetry.self, .init(workspaceId: workspaceId, chatId: chatId, id: outboxId))
        }
    }

    /// A Retry whose answer was lost, read back by LifeOS's own row for it once this host is linked again: still
    /// failed is LifeOS never took it; anything else is it went (`PressTruth.retry`).
    public func settleRetry(workspaceId: String, chatId: String, outboxId: String, status: ChatReplyState.Status?) {
        settleRetry(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId, truth: PressTruth.retry(status))
    }

    /// The same, with the truth the conversation's own read gave (`RetryReadBack`).
    public func settleRetry(workspaceId: String, chatId: String, outboxId: String, truth: PressTruth) {
        guard linked else { return }
        presses.settle(host: environment.id, ref: ChatPress.retryRef(workspaceId: workspaceId, chatId: chatId, outboxId: outboxId), truth: truth)
    }

    public func searchMessages(workspaceId: String, query: String) async throws -> [ChatHit] {
        try await socket.request(Methods.WorkMessagesSearch.self, .init(workspaceId: workspaceId, query: query, limit: 50)).hits
    }

    public func messagesUnread(workspaceId: String) async throws -> MessagesUnread {
        try await socket.request(Methods.WorkMessagesUnread.self, .init(workspaceId: workspaceId))
    }

    /// A thread's drafts for conversations nothing here can send to; one conversation's, or the job's.
    public func chatDrafts(workspaceId: String, chatId: String? = nil) async throws -> [ChatDraft] {
        try await socket.request(Methods.WorkMessagesDrafts.self, .init(workspaceId: workspaceId, chatId: chatId)).drafts
    }

    /// Seats a chat's file in the job's Messages pane (`work.canvas.open`, operate), for the reader to open; the host
    /// fetches its bytes from LifeOS as the owner, fenced to the job's sector.
    public func openChatFile(workspaceId: String, chatId: String, messageId: String, file: ChatFile, kind: String) async throws -> CanvasItem {
        try await socket.request(Methods.WorkCanvasOpen.self, .init(
            sessionId: ChatPress.pane(workspaceId: workspaceId),
            kind: Methods.WorkCanvasOpen.Params.Kind(rawValue: kind),
            source: ChatPress.fileSource(chatId: chatId, messageId: messageId, file: file),
            title: file.name
        ))
    }

    /// He copied a draft, or does not want it.
    public func dropChatDraft(workspaceId: String, id: String) async throws {
        _ = try await socket.request(Methods.WorkMessagesDropDraft.self, .init(workspaceId: workspaceId, id: id))
    }

    /// Each reply of his on this host whose answer was lost, read back by its attempt key; the conversation's desk
    /// hears what became of it. The read sends nothing: a key the host never heard reads `none`, and the words go
    /// back to him to send again by his own press.
    func checkChatPresses() async {
        // Each one's desk hears it through the ledger's hearer for chat replies (WorkHost.init).
        await presses.check(host: environment.id, where: { $0 == .chatReply }) { [socket] press in
            guard let attempt = press.attempt, let workspaceId = ChatPress.workspace(ofRef: press.ref) else { return .mayHaveGone }
            return PressTruth.chat(try await socket.request(Methods.WorkMessagesAttempt.self, .init(workspaceId: workspaceId, attempt: attempt)), rev: press.rev)
        }
    }
}
