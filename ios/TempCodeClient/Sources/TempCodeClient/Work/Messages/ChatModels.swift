import Foundation

/// LifeOS's chat as its `chats:*` functions answer it (src/shared/work/messages.ts, docs/agents/work-messages.md).
/// The phone reads these through LifeKit's live queries on the LifeOS session, never through the host; only his
/// reply goes through the host (`WorkHost+Messages.swift`). Every optional field decodes absent, and a source this
/// build does not know is `.other`, so a new LifeOS field or source never fails a whole page.

/// The sources that are chat.
public enum ChatSource: String, Codable, Sendable, Hashable, CaseIterable {
    case slack, discord, imessage, teams
    /// A source this build does not know: shown by its row, never sent to.
    case other

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ChatSource(rawValue: raw) ?? .other
    }
}

public enum ChatKind: String, Codable, Sendable, Hashable {
    case direct, group, channel

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ChatKind(rawValue: raw) ?? .group
    }
}

/// One conversation, as `chats:list` and `chats:get` answer it.
public struct ChatRow: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var source: ChatSource
    public var account: String
    public var accountName: String?
    public var channel: String
    /// "#builds", "Dana Lee", "Dana, Omar"
    public var name: String
    public var kind: ChatKind
    public var sector: String
    public var lastAt: Double
    public var lastText: String
    public var lastWho: String
    public var lastFromMe: Bool
    public var lastInAt: Double?
    public var lastForMeAt: Double?
    public var lastOutAt: Double?
    public var readAt: Double?
    public var sourceReadAt: Double?
    public var lastInId: String?
    public var unread: Bool
    public var link: String?

    private enum CodingKeys: String, CodingKey {
        case id = "_id", source, account, accountName, channel, name, kind, sector, lastAt, lastText, lastWho, lastFromMe
        case lastInAt, lastForMeAt, lastOutAt, readAt, sourceReadAt, lastInId, unread, link
    }

    public init(
        id: String, source: ChatSource, account: String = "", accountName: String? = nil, channel: String = "", name: String,
        kind: ChatKind = .direct, sector: String, lastAt: Double, lastText: String = "", lastWho: String = "", lastFromMe: Bool = false,
        lastInAt: Double? = nil, lastForMeAt: Double? = nil, lastOutAt: Double? = nil, readAt: Double? = nil, sourceReadAt: Double? = nil,
        lastInId: String? = nil, unread: Bool = false, link: String? = nil
    ) {
        self.id = id
        self.source = source
        self.account = account
        self.accountName = accountName
        self.channel = channel
        self.name = name
        self.kind = kind
        self.sector = sector
        self.lastAt = lastAt
        self.lastText = lastText
        self.lastWho = lastWho
        self.lastFromMe = lastFromMe
        self.lastInAt = lastInAt
        self.lastForMeAt = lastForMeAt
        self.lastOutAt = lastOutAt
        self.readAt = readAt
        self.sourceReadAt = sourceReadAt
        self.lastInId = lastInId
        self.unread = unread
        self.link = link
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = try c.decode(ChatSource.self, forKey: .source)
        account = try c.decodeIfPresent(String.self, forKey: .account) ?? ""
        accountName = try c.decodeIfPresent(String.self, forKey: .accountName)
        channel = try c.decodeIfPresent(String.self, forKey: .channel) ?? ""
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decodeIfPresent(ChatKind.self, forKey: .kind) ?? .group
        sector = try c.decode(String.self, forKey: .sector)
        lastAt = try c.decode(Double.self, forKey: .lastAt)
        lastText = try c.decodeIfPresent(String.self, forKey: .lastText) ?? ""
        lastWho = try c.decodeIfPresent(String.self, forKey: .lastWho) ?? ""
        lastFromMe = try c.decodeIfPresent(Bool.self, forKey: .lastFromMe) ?? false
        lastInAt = try c.decodeIfPresent(Double.self, forKey: .lastInAt)
        lastForMeAt = try c.decodeIfPresent(Double.self, forKey: .lastForMeAt)
        lastOutAt = try c.decodeIfPresent(Double.self, forKey: .lastOutAt)
        readAt = try c.decodeIfPresent(Double.self, forKey: .readAt)
        sourceReadAt = try c.decodeIfPresent(Double.self, forKey: .sourceReadAt)
        lastInId = try c.decodeIfPresent(String.self, forKey: .lastInId)
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        link = try c.decodeIfPresent(String.self, forKey: .link)
    }
}

/// Whether a reply can go, as LifeOS judges it; `why` is LifeOS's sentence.
public struct ChatRoute: Codable, Sendable, Hashable {
    public var can: Bool
    public var why: String?

    public init(can: Bool, why: String? = nil) {
        self.can = can
        self.why = why
    }
}

/// A source's sync state, as `sources:list` and `chats:get` answer it.
public struct ChatSourceState: Codable, Sendable, Hashable {
    public enum Status: String, Codable, Sendable, Hashable {
        case idle, ok, error

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .idle
        }
    }

    public var kind: ChatSource
    public var label: String
    public var status: Status
    public var lastSyncAt: Double?
    public var reportedAt: Double?
    public var error: String?

    public init(kind: ChatSource, label: String = "", status: Status, lastSyncAt: Double? = nil, reportedAt: Double? = nil, error: String? = nil) {
        self.kind = kind
        self.label = label
        self.status = status
        self.lastSyncAt = lastSyncAt
        self.reportedAt = reportedAt
        self.error = error
    }
}

/// `chats:get`: the conversation, its source, whether a reply can go.
public struct ChatDetail: Codable, Sendable, Hashable {
    public var chat: ChatRow
    public var source: ChatSourceState?
    public var route: ChatRoute
    public var link: String?

    public init(chat: ChatRow, source: ChatSourceState? = nil, route: ChatRoute, link: String? = nil) {
        self.chat = chat
        self.source = source
        self.route = route
        self.link = link
    }
}

public struct ChatWho: Codable, Sendable, Hashable {
    public var name: String
    public var me: Bool

    public init(name: String, me: Bool) {
        self.name = name
        self.me = me
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        me = try c.decodeIfPresent(Bool.self, forKey: .me) ?? false
    }
}

/// A picture or file of a message. `url` is LifeOS's own storage address, present once it is stored.
public struct ChatFile: Codable, Sendable, Hashable, Identifiable {
    public enum Status: String, Codable, Sendable, Hashable {
        case listed, wanted, stored, failed

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .listed
        }
    }

    public var id: String
    public var name: String
    public var contentType: String?
    public var size: Double?
    public var status: Status
    public var url: String?
    public var error: String?

    private enum CodingKeys: String, CodingKey {
        case id = "_id", name, contentType, size, status, url, error
    }

    public init(id: String, name: String, contentType: String? = nil, size: Double? = nil, status: Status, url: String? = nil, error: String? = nil) {
        self.id = id
        self.name = name
        self.contentType = contentType
        self.size = size
        self.status = status
        self.url = url
        self.error = error
    }
}

/// His reply as LifeOS's outbox holds it: inside its undo time, on its way, sent or failed.
public struct ChatReplyState: Codable, Sendable, Hashable {
    public enum Status: String, Codable, Sendable, Hashable {
        case queued, sending, sent, failed

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .sending
        }
    }

    public var outboxId: String
    public var status: Status
    public var sendAt: Double?
    public var error: String?

    public init(outboxId: String, status: Status, sendAt: Double? = nil, error: String? = nil) {
        self.outboxId = outboxId
        self.status = status
        self.sendAt = sendAt
        self.error = error
    }
}

/// One message, as `chats:messages` answers it, newest first. A queued or failed reply of his rides in as his own row.
public struct ChatMessage: Codable, Sendable, Hashable, Identifiable {
    public struct Answers: Codable, Sendable, Hashable {
        public var who: String
        public var text: String
    }

    public var id: String
    public var who: ChatWho
    public var text: String
    public var sentAt: Double
    public var replyTo: Answers?
    public var files: [ChatFile]
    public var reply: ChatReplyState?

    private enum CodingKeys: String, CodingKey {
        case id = "_id", who, text, sentAt, replyTo, files, reply
    }

    public init(id: String, who: ChatWho, text: String, sentAt: Double, replyTo: Answers? = nil, files: [ChatFile] = [], reply: ChatReplyState? = nil) {
        self.id = id
        self.who = who
        self.text = text
        self.sentAt = sentAt
        self.replyTo = replyTo
        self.files = files
        self.reply = reply
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        who = try c.decode(ChatWho.self, forKey: .who)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        sentAt = try c.decode(Double.self, forKey: .sentAt)
        replyTo = try c.decodeIfPresent(Answers.self, forKey: .replyTo)
        files = try c.decodeIfPresent([ChatFile].self, forKey: .files) ?? []
        reply = try c.decodeIfPresent(ChatReplyState.self, forKey: .reply)
    }
}
