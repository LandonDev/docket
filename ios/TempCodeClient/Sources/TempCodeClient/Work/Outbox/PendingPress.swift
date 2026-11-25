import Foundation
import TempCodeContract

/// An outward press that has left the phone and whose answer has not come
/// (plan "Never twice, never silently"). Written to disk before the request
/// goes: the host, the thing's canonical ref, the revision he saw and the
/// time. It is what the phone reads the truth back by, never work to run: a
/// press is not sent again from this record.
public struct PendingPress: Codable, Sendable, Hashable, Identifiable {
    /// The method the press went out as.
    public enum Kind: String, Codable, Sendable, Hashable {
        case outboxSend = "work.outbox.send"
        case outboxDiscard = "work.outbox.discard"
        case outboxEdit = "work.outbox.edit"
        /// His Send on a thread's request (`work.outbox.decide {request, receipts}`), by the request's ref (`requestRef`).
        case outboxDecide = "work.outbox.decide"
        /// Send Later on one held item (`work.outbox.decide do: later`), read back by the item.
        case outboxLater = "work.outbox.later"
        /// Send Now on a send the hold timed (`work.outbox.sendNow`), read back by the item's time.
        case outboxSendNow = "work.outbox.sendNow"
        /// The composer's Send of a mail of his own (`work.mail.send`), by its draft (`mailRef`).
        case mailSend = "work.mail.send"
        /// Send Now on a mail he timed in Mail, read back by the Outbox's item (`MailRules.sendNowTruth`).
        case mailSendNow = "work.mail.sendNow"
        case chatReply = "work.messages.send"
        /// Retry of a failed reply (`work.messages.retry`), read back by LifeOS's outbox row (`ChatPress.retryRef`).
        case chatRetry = "work.messages.retry"
        case guestLink = "work.guests.create"
        /// Replace Address on a live link, by its attempt key (`work.guests.attempt`, as Create's).
        case guestRekey = "work.guests.rekey"
        case clashAnswer = "work.clashes.answer"

        /// The method has a handle the phone can read the truth back by today: the Outbox's item
        /// by its ref, a request by its id, a mail by its draft, a chat reply or its Retry by its attempt
        /// key (`work.messages.attempt`, which sends nothing), a guest link by its attempt key (`work.guests.attempt`,
        /// which makes nothing), a clash answer by the clash list (gone is done, still listed may have gone).
        public var readsBack: Bool {
            switch self {
            case .outboxSend, .outboxDiscard, .outboxEdit, .outboxDecide, .outboxLater, .outboxSendNow, .mailSend, .mailSendNow, .chatReply, .chatRetry, .guestLink, .guestRekey, .clashAnswer: true
            }
        }

        /// The method the key must still be able to press when the request leaves (KeyMay).
        public var method: KeyMethod {
            switch self {
            case .outboxSend: .outboxSend
            case .outboxDiscard: .outboxDiscard
            case .outboxEdit: .outboxEdit
            case .outboxDecide, .outboxLater: .outboxDecide
            case .outboxSendNow: .outboxSendNow
            case .mailSend: .mailSend
            case .mailSendNow: .mailSendNow
            case .chatReply: .messagesSend
            case .chatRetry: .messagesRetry
            case .guestLink: .guestsCreate
            case .guestRekey: .guestsRekey
            case .clashAnswer: .clashesAnswer
            }
        }

        /// A pushed Outbox item settles it (`PressLedger.heard`): every kind read by the item, and a mail Send, whose draft
        /// a thread made is the Outbox's item for the same ref.
        public var settledByItem: Bool { readsItem || self == .mailSend }

        /// Read back by the Outbox's item (`PressLedger.check(host:read:)`), not by an attempt key.
        public var readsItem: Bool {
            switch self {
            case .outboxSend, .outboxDiscard, .outboxEdit, .outboxLater, .outboxSendNow, .mailSendNow: true
            case .outboxDecide, .mailSend, .chatReply, .chatRetry, .guestLink, .guestRekey, .clashAnswer: false
            }
        }
    }

    public var host: String
    public var kind: Kind
    /// The item's canonical ref (`OutboxModel.key`), a request's (`requestRef`), a draft's (`mailRef`), a chat's.
    public var ref: String
    /// The revision he saw.
    public var rev: String?
    /// When it left, seconds since 1970.
    public var at: Double
    /// The key a method answers once by (`work.messages.send`, `work.guests.create`).
    public var attempt: String?

    public var id: String { "\(host)|\(kind.rawValue)|\(ref)" }

    public init(host: String, kind: Kind, ref: String, rev: String? = nil, at: Double, attempt: String? = nil) {
        self.host = host
        self.kind = kind
        self.ref = ref
        self.rev = rev
        self.at = at
        self.attempt = attempt
    }

    /// A fresh key for one press the host answers once (a reply, a link): `phone-<ms>-<uuid>`. The host reads its time:
    /// one older than it keeps answers is unknown when read back and refused when repeated (attemptAge.ts).
    public static func newAttempt(now: Double = Date().timeIntervalSince1970) -> String {
        "phone-\(Int((now * 1000).rounded()))-\(UUID().uuidString.lowercased())"
    }

    /// The ledger's ref for his Send on a thread's request.
    public static func requestRef(_ id: String) -> String { "request:\(id)" }
    /// The request a ref names, nil for any other ref.
    public static func request(ofRef ref: String) -> String? {
        ref.hasPrefix("request:") ? String(ref.dropFirst("request:".count)) : nil
    }
    /// The ledger's ref for the composer's Send of one mail draft: the same mail as the Outbox's item for it
    /// (`OutboxModel.key` of `{lifeos, outbox, id}`), so a Send and a Send Now on it are one press at a time.
    public static func mailRef(_ draftId: String) -> String { "lifeos:outbox:\(draftId)" }
    /// The draft a mail ref names, nil for any other ref.
    public static func draft(ofRef ref: String) -> String? {
        ref.hasPrefix("lifeos:outbox:") ? String(ref.dropFirst("lifeos:outbox:".count)) : nil
    }
}

/// What the host says of the thing a press was for, read back on this link.
public enum PressTruth: Sendable, Hashable {
    /// It went (sent, discarded, decided), by this press or another device's.
    case done
    /// It still waits; `rev` is its revision now.
    case waiting(rev: String?)
    /// The host cannot say whether it went.
    case mayHaveGone
    /// It is no longer there to act on.
    case gone
    /// The host tried and failed, in its words.
    case failed(String)

    /// A held item as the Outbox reads it now, for a Send (`sent` is done) or a Discard
    /// (`discarded` is done). Nil while the host is still sending: nothing is known yet.
    public static func outbox(_ item: OutboxItem?, kind: PendingPress.Kind) -> PressTruth? {
        guard let item else { return kind == .outboxDiscard ? .done : .gone }
        switch item.state {
        case .sending: return nil
        case .sent, .scheduled: return kind == .outboxDiscard ? .gone : .done
        case .discarded: return kind == .outboxDiscard ? .done : .gone
        case .failed:
            if item.outcomeUnknown == true { return .mayHaveGone }
            return .failed(item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        case .held, .live, .stale, .unknown:
            return .waiting(rev: String(item.updatedAt))
        }
    }
}

public extension PressTruth {
    /// A thread's request read back after his Send's answer was lost. The host claims the request before it sends
    /// anything (requests.ts `answer`), so answered is his press landed, and once it no longer runs its rows' results
    /// are the end; open is the host never got it; declined or void is no longer his to send; none on the host is gone.
    static func request(_ request: OutboxRequest?, rev: String?) -> PressTruth? {
        guard let request else { return .gone }
        switch request.state {
        // Claimed with its items still going (`running`): not the press's end yet, so nothing is known.
        case .answered: return request.running == true ? nil : .done
        case .open: return .waiting(rev: rev)
        case .declined, .void: return .gone
        case .unknown: return .mayHaveGone
        }
    }

    /// The composer's Send read back by its draft's status in LifeOS (`OutboxStatus`): still a draft is the host never
    /// sent it; queued, sending or sent is it went; failed is LifeOS's own failure; no such draft is gone.
    static func mail(status: String?) -> PressTruth {
        switch status {
        case nil: return .gone
        case "draft": return .waiting(rev: nil)
        case "queued", "sending", "sent": return .done
        case "failed": return .failed("")
        default: return .mayHaveGone
        }
    }

    /// The composer's Send of a thread's draft, read by the Outbox's item for it: sent or on its way is done, still held is
    /// the host never sent it, failed in the host's words.
    static func mailItem(_ item: OutboxItem?) -> PressTruth? {
        let truth = outbox(item, kind: .outboxSend)
        if case .waiting? = truth { return .waiting(rev: nil) }
        return truth
    }

    /// Send Now on a send the hold timed, read back by the item (`rev` is the time he saw it set for): sent or on its
    /// way is done; still timed for that time is the host never got it; timed for another is changed; held again or
    /// dropped is gone. Nil while LifeOS is on it: nothing is known yet.
    static func sendNow(_ item: OutboxItem?, rev: String?) -> PressTruth? {
        guard let item else { return .done }
        switch item.state {
        case .sent: return .done
        case .sending: return item.scheduledFor.map(String.init) == rev ? nil : .done
        case .scheduled: return .waiting(rev: item.scheduledFor.map(String.init))
        case .failed:
            if item.outcomeUnknown == true { return .mayHaveGone }
            return .failed(item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        case .held, .live, .stale, .discarded, .unknown: return .gone
        }
    }
}

/// What a screen shows of a press.
public enum PressState: Sendable, Hashable {
    /// It left under fifteen seconds ago on a live link.
    case sending
    /// No answer in fifteen seconds, the link dropped, or the app was relaunched: unknown, never failed.
    case checking
    case done
    /// The host never got it: the item waits as he saw it, and a new press is his to make.
    case stillWaiting
    /// The item changed since he pressed: it is read again before anything else.
    case changed
    /// Check Sent First, then Send Again: one item, his own fresh press.
    case mayHaveGone
    case gone
    case failed(String)

    /// The one line a row or the bar says.
    public var line: String? {
        switch self {
        case .sending: "Sending…"
        case .checking: "Checking…"
        case .done, .stillWaiting: nil
        case .changed: "Changed"
        case .mayHaveGone: "May have gone"
        case .gone: "No longer waits"
        case .failed(let words): words.isEmpty ? "Not sent" : "Not sent: \(words)"
        }
    }
}

/// Every press on its way, as the phone keeps them on disk.
public struct PendingPresses: Codable, Sendable, Hashable {
    /// With no answer this long the outcome is unknown. Never failed: the press may have landed.
    public static let unknownAfter: Double = 15

    public private(set) var presses: [PendingPress]
    /// When this launch read the file: a press from before it has no request in flight.
    public var launchedAt: Double = 0

    private enum CodingKeys: String, CodingKey { case presses }

    public init(presses: [PendingPress] = []) {
        self.presses = presses
    }

    /// Each record on its own: one this build cannot read (a kind a later build added) is dropped alone, never the file.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        presses = (try container.decodeIfPresent([OneRecord].self, forKey: .presses) ?? []).compactMap(\.press)
    }

    private struct OneRecord: Decodable {
        let press: PendingPress?
        init(from decoder: any Decoder) throws { press = try? PendingPress(from: decoder) }
    }

    /// The line where a press would be when its host has no link: refused at once, the item stays.
    public static func notConnected(_ hostName: String) -> String { "Not connected to \(hostName)" }

    public func press(_ id: String) -> PendingPress? { presses.first { $0.id == id } }

    /// One for the same thing on the same host is out: a second submit is not made (a double
    /// tap, a press whose answer was lost, a method with nothing to read back by).
    public func blocks(_ press: PendingPress) -> Bool { self.press(press.id) != nil }

    /// Before the request goes. False: nothing may leave, one is already out. With no link
    /// nothing is recorded either: the press is refused at once (`notConnected`).
    public mutating func leaving(_ press: PendingPress, linked: Bool) -> Bool {
        guard linked, !blocks(press) else { return false }
        presses.append(press)
        return true
    }

    /// The host answered the request itself, done or refused in its words: nothing is pending.
    public mutating func answered(_ id: String) {
        presses.removeAll { $0.id == id }
    }

    /// What a press shows while its answer is out.
    public func state(of id: String, now: Double, linked: Bool) -> PressState? {
        guard let press = press(id) else { return nil }
        if !linked || press.at < launchedAt || now - press.at >= Self.unknownAfter { return .checking }
        return .sending
    }

    /// On a host's next link: the presses to read back, by each method's own handle.
    public func toCheck(host: String, now: Double) -> [PendingPress] {
        presses.filter { $0.host == host && $0.kind.readsBack && ($0.at < launchedAt || now - $0.at >= Self.unknownAfter) }
    }

    /// The truth read back for one press. The record goes unless nothing is known yet.
    public mutating func resolve(_ id: String, truth: PressTruth?) -> PressState {
        guard let press = press(id) else { return .done }
        guard let truth else { return .checking }
        presses.removeAll { $0.id == id }
        switch truth {
        case .done: return .done
        case .waiting(let rev): return rev == press.rev ? .stillWaiting : .changed
        case .mayHaveGone: return .mayHaveGone
        case .gone: return .gone
        case .failed(let words): return .failed(words)
        }
    }

    /// Whether a send carries `again`: only his own fresh Send Again on one item whose outcome
    /// the host calls unknown. Never a group, a request, or anything the phone does by itself.
    public static func again(outcomeUnknown: Bool, hisPress: Bool, items: Int, request: Bool) -> Bool {
        outcomeUnknown && hisPress && items == 1 && !request
    }

    // MARK: - the file

    /// The presses as last written, with this launch's time on them. A missing or unreadable file is none.
    public static func load(from url: URL, now: Double) -> PendingPresses {
        read(from: url, now: now) ?? PendingPresses(launchedAt: now)
    }

    /// The presses as last written, or nil when the file is there and cannot be read (the phone locked at a launch
    /// a notice's action made): not known, which is never none, so nothing may be written over it until it reads. No
    /// file is none out; a file that reads but does not decode is none too, as nothing could ever read it back.
    public static func read(from url: URL, now: Double) -> PendingPresses? {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return FileManager.default.fileExists(atPath: url.path) ? nil : PendingPresses(launchedAt: now)
        }
        var kept = (try? JSONDecoder().decode(PendingPresses.self, from: data)) ?? PendingPresses()
        kept.launchedAt = now
        return kept
    }

    init(launchedAt: Double) {
        presses = []
        self.launchedAt = launchedAt
    }

    /// Written whole and atomically before a request leaves. It holds ids, refs and times, no words: protected
    /// until the first unlock after a restart, so a launch with the phone locked still reads it.
    public func save(to url: URL) throws {
        let data = try JSONEncoder().encode(self)
        #if canImport(Darwin)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: [.atomic])
        #endif
    }
}
