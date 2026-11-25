import Foundation
import TempCodeContract

/// The names a chat reply's press goes by (`WorkHost.sendReply`, `PressLedger`): its ref, one press of his on its way
/// in a conversation at a time; its attempt key, which the host answers once; and what the host's read of the key
/// says of it.
public enum ChatPress {
    /// The ledger's ref for his reply in one conversation of one job.
    public static func ref(workspaceId: String, chatId: String) -> String { "chat:\(workspaceId):\(chatId)" }

    /// The job a chat ref names.
    public static func workspace(ofRef ref: String) -> String? {
        let parts = ref.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "chat", !parts[1].isEmpty else { return nil }
        return String(parts[1])
    }

    /// The conversation a chat ref names.
    public static func chat(ofRef ref: String) -> String? {
        let parts = ref.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "chat", !parts[2].isEmpty else { return nil }
        return String(parts[2])
    }

    /// The job's Messages pane on the host (`messagesPaneOf`): where a chat's file is seated to open beside it.
    public static func pane(workspaceId: String) -> String { "msgpane_\(workspaceId)" }

    /// A chat's file as the canvas fetches it: the mail arm with `from: 'chat'` (docs/agents/work-messages.md "Files").
    public static func fileSource(chatId: String, messageId: String, file: ChatFile) -> CanvasSource {
        .mail(MailSource(threadId: chatId, messageId: messageId, partId: file.id, name: file.name, contentType: file.contentType, size: file.size.map { Int($0) }, from: "chat"))
    }

    /// The ledger's ref for his Retry of one failed reply: LifeOS's outbox row names it.
    public static func retryRef(workspaceId: String, chatId: String, outboxId: String) -> String { "chatretry:\(workspaceId):\(chatId):\(outboxId)" }

    /// A fresh key for one press of his Send: the host answers a repeat of it once, never sending again.
    public static func newAttempt() -> String { PendingPress.newAttempt() }
}

extension PressTruth {
    /// What the host says of a Send by its attempt key: sent; never heard (still his to send, `rev` as he left it);
    /// refused in its words; may have gone. Nil while the host is still waiting on LifeOS.
    public static func chat(_ answer: MessagesAttempt, rev: String?) -> PressTruth? {
        switch answer.state {
        case .sent: return .done
        case .none: return .waiting(rev: rev)
        case .sending: return nil
        case .refused: return .failed(answer.words ?? "")
        case .unknown, .unrecognized: return .mayHaveGone
        }
    }
}

extension PressTruth {
    /// What LifeOS's own row says of a Retry whose answer was lost, read once its host is linked again: still failed
    /// is LifeOS never took it (his to retry again); queued, sending, sent or gone from his rows is it went.
    public static func retry(_ status: ChatReplyState.Status?) -> PressTruth {
        status == .failed ? .waiting(rev: nil) : .done
    }
}

/// A lost Try Again read back from the conversation's own rows (LifeKit reads LifeOS on its own link), asked again after
/// the press went Checking and read once that read has landed, equal to the old rows or not: an equal value is dropped
/// by LifeKit and moves nothing, so the screen awaits its own read rather than a change. A reply still failed is LifeOS
/// never took it (his to try again); queued, sending or sent is it went; one the page no longer holds cannot be proven
/// either way and says May have gone.
public enum RetryReadBack {
    public static func truths(asked: Set<String>, rows: [ChatReplyState]) -> [String: PressTruth] {
        var out: [String: PressTruth] = [:]
        for id in asked {
            out[id] = rows.first { $0.outboxId == id }.map { PressTruth.retry($0.status) } ?? .mayHaveGone
        }
        return out
    }
}
