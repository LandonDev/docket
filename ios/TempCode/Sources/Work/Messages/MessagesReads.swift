import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// LifeOS's chat as LifeKit reads it (docs/agents/work-messages.md "The phone"): `chats:list` per sector, one
/// conversation's `chats:get` and `chats:messages`, each a live query on the LifeOS session the place signs
/// (`LifeReach`: the whole session, else the job's own), and the read mark (`chats:markRead`) through the same store.
/// The screens hold their queries only while they are on screen (`MessagesHolding`); LifeKit drops a query its
/// screen let go of after its grace. On LifeKit's fixture day (`TC_TEST_LIFE_FIXTURES`) the reads are
/// `MessagesFixtures`'s, in memory.
extension ChatRow: @retroactive Model {}
extension ChatMessage: @retroactive Model {}

@MainActor
enum MessagesReads {
    static let listPage = 50
    static let messagePage = 50

    /// One sector's conversations, newest first, as one growing live page.
    static func list(_ store: LifeStore, sector: String) -> PagedQuery<ChatRow> {
        store.live.paged("chats:list", ["sector": .string(sector)], as: ChatRow.self, pageSize: listPage, cache: "chats-\(sector)")
    }

    /// One conversation, its source and whether a reply can go. Nil inside: it is gone, or of a sector this
    /// session does not read.
    static func detail(_ store: LifeStore, chatId: String) -> LiveQuery<ChatDetail?> {
        store.live.query("chats:get", ["id": .string(chatId)], cache: "chat-\(chatId)")
    }

    /// One conversation's messages, newest first; his queued and failed replies ride in as his own rows.
    static func messages(_ store: LifeStore, chatId: String) -> PagedQuery<ChatMessage> {
        store.live.paged("chats:messages", ["chatId": .string(chatId)], as: ChatMessage.self, pageSize: messagePage, cache: "chat-messages-\(chatId)")
    }

    /// Opening a conversation marks it read in LifeOS, on the session that read it.
    static func markRead(_ store: LifeStore, chatId: String) async throws {
        _ = try await store.mutate("chats:markRead", ["id": json(chatId)])
    }

    static func markUnread(_ store: LifeStore, chatId: String) async throws {
        _ = try await store.mutate("chats:markUnread", ["id": json(chatId)])
    }

    /// LifeOS fetches a message's files only once a client asks (`chats:requestFiles`); the files' rows then move.
    static func requestFiles(_ store: LifeStore, messageId: String) async throws {
        _ = try await store.mutate("chats:requestFiles", ["messageId": json(messageId)])
    }

    /// A string argument as LifeKit's mutate takes it: JSON text.
    private static func json(_ value: String) -> String {
        (try? String(data: JSONEncoder().encode(value), encoding: .utf8)) ?? "\"\(value)\""
    }

    /// The LifeOS session a conversation of this job is read on: the job's own, signed on its host.
    static func host(environmentId: String, workspaceId: String, registry: ClientRegistry) -> WorkLifeHost? {
        guard let client = registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) else { return nil }
        return WorkLifeHost.of(client, workspace: workspace)
    }
}

/// Keeps live queries subscribed while the view is on screen, as LifeKitUI's `holding` does, by their registry keys.
struct MessagesHolding: ViewModifier {
    let store: LifeStore?
    let keys: [String]

    func body(content: Content) -> some View {
        content.task(id: keys) {
            guard let live = store?.live else { return }
            for key in keys { live.hold(key) }
            defer { for key in keys { live.release(key) } }
            TickLedger.begin("messages.hold"); defer { TickLedger.end("messages.hold") }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3600))
            }
        }
    }
}

extension View {
    func holdingChats(_ store: LifeStore?, keys: [String]) -> some View {
        modifier(MessagesHolding(store: store, keys: keys))
    }
}

#if DEBUG
/// The Messages part of LifeKit's fixture day: two jobs' conversations, one unread, one Discord (Copy), one with his
/// failed reply, and a message with a PDF. Reads only; a Send still goes to the host.
enum MessagesFixtures {
    static var on: Bool { TestHooks.lifeFixtures }

    private static let now = Date().timeIntervalSince1970 * 1000
    private static let minute = 60_000.0

    static let rows: [ChatRow] = [
        ChatRow(id: "c-dana", source: .slack, accountName: "CosmicGames", name: "Dana Lee", kind: .direct, sector: "cosmic", lastAt: now - 4 * minute,
                lastText: "Can you look at the build before 3?", lastWho: "Dana Lee", lastInAt: now - 4 * minute, readAt: now - 90 * minute, lastInId: "m3", unread: true),
        ChatRow(id: "c-esports", source: .imessage, accountName: "iMessage", name: "Esports staff", kind: .group, sector: "purdue", lastAt: now - 38 * minute,
                lastText: "Arena is booked for the LAN", lastWho: "Priya Shah", lastInAt: now - 38 * minute, readAt: now - 20 * minute),
        ChatRow(id: "c-omar", source: .discord, name: "#editors", kind: .channel, sector: "hypixel", lastAt: now - 3 * 60 * minute,
                lastText: "Cut 2 is up", lastWho: "Omar Reyes", lastInAt: now - 3 * 60 * minute, readAt: now - 2 * 60 * minute),
        ChatRow(id: "c-builds", source: .slack, accountName: "CosmicGames", name: "#builds", kind: .channel, sector: "cosmic", lastAt: now - 26 * 60 * minute,
                lastText: "Shipped.", lastWho: "Landon", lastFromMe: true, lastOutAt: now - 26 * 60 * minute)
    ]

    static func detail(_ chatId: String) -> ChatDetail? {
        guard let row = rows.first(where: { $0.id == chatId }) else { return nil }
        let route = row.source == .discord ? ChatRoute(can: false, why: "LifeOS can’t reply in Discord yet") : ChatRoute(can: true)
        return ChatDetail(chat: row, source: ChatSourceState(kind: row.source, status: .ok, lastSyncAt: now - minute), route: route)
    }

    static func messages(_ chatId: String) -> [ChatMessage] {
        let dana = ChatWho(name: "Dana Lee", me: false), me = ChatWho(name: "Landon", me: true)
        switch chatId {
        case "c-dana":
            return [
                ChatMessage(id: "m3", who: dana, text: "Can you look at the build before 3?", sentAt: now - 4 * minute),
                ChatMessage(id: "m2", who: dana, text: "Here is the plan [file: Release plan.pdf]", sentAt: now - 6 * minute,
                            files: [ChatFile(id: "f1", name: "Release plan.pdf", contentType: "application/pdf", size: 182_000, status: .stored, url: "https://example.invalid/f1")]),
                ChatMessage(id: "out-1", who: me, text: "On my way in.", sentAt: now - 70 * minute, reply: ChatReplyState(outboxId: "out_1", status: .failed, error: "Slack did not answer")),
                ChatMessage(id: "m1", who: dana, text: "Morning! Are you in today?", sentAt: now - 80 * minute)
            ]
        default:
            guard let row = rows.first(where: { $0.id == chatId }) else { return [] }
            return [ChatMessage(id: "\(chatId)-1", who: ChatWho(name: row.lastWho, me: row.lastFromMe), text: row.lastText, sentAt: row.lastAt)]
        }
    }
}
#endif
