import Foundation
import TempCodeContract

/// The messages pillar's names and pure rules on the phone: a port of src/shared/work/messages.ts and the few rules of
/// the desktop's view (src/renderer/src/work/messages/model.ts) the phone draws by. scripts/ios-messages-fixture.test.ts
/// writes the desktop's answers to Fixtures/messages/rules.json and MessagesRulesTests replays them, so the two cannot
/// drift unseen.
public enum MessagesRules {
    /// What heads a conversation's messages while it pages back: the older page's failure with Try Again, else its
    /// spinner while it reads, else nothing. A failed page still has no rows, so it is read as failed first.
    public enum OlderPage: Equatable, Sendable { case reading, failed }
    public static let olderFailed = "Older messages did not load"

    public static func olderPage(waiting: Bool, failed: Bool) -> OlderPage? {
        failed ? .failed : waiting ? .reading : nil
    }

    /// The conversations list's foot as it pages on, a page a sector: a next page that failed says so with Try Again,
    /// which asks each failed page again, since LifeKit asks no page past one that has no rows; else a spinner while
    /// one reads; else nothing.
    public static let moreFailed = "More conversations did not load"

    public static func nextPages(_ pages: [(waiting: Bool, failed: Bool)]) -> OlderPage? {
        olderPage(waiting: pages.contains { $0.waiting }, failed: pages.contains { $0.failed })
    }

    /// A refused Mark Read or Mark Unread in the house toast: the mark kept as it was, and why in Work's words
    /// ("Not marked read: The box did not answer. …"), never the host's raw text.
    public static func markFailed(unread: Bool, error: String, host: String) -> String {
        let lead = unread ? "Not marked unread" : "Not marked read"
        let words = WorkErrorWords.say(error, host: host)
        return words.isEmpty ? lead : "\(lead): \(words)"
    }

    /// A reply's outcome said off its conversation (the sticky toast when he has left it), named: "Not sent to Dana Lee:
    /// TempCode left the screen". Nil while the conversation is on screen: its own field and line say it there.
    /// What a reply read back late says off its conversation: nil when it went, or nothing is known yet.
    public static func lateLine(_ state: PressState) -> String? {
        switch state {
        case .done, .sending, .checking: nil
        case .stillWaiting, .changed, .gone: "Not sent: the host never had it"
        case .failed(let words): words.isEmpty ? "Not sent" : "Not sent: \(words)"
        case .mayHaveGone: "It may have gone. Check the conversation before sending it again."
        }
    }

    public static func offLine(_ line: String, name: String, shown: Bool) -> String? {
        guard !shown else { return nil }
        let prefix = "Not sent: "
        // A name the phone no longer holds (a relaunch since the press): the reply is named instead.
        if name.isEmpty { return line.hasPrefix(prefix) ? "Reply not sent: \(line.dropFirst(prefix.count))" : "A reply: \(line)" }
        return line.hasPrefix(prefix) ? "Not sent to \(name): \(line.dropFirst(prefix.count))" : "\(name): \(line)"
    }

    /// His own typed reply goes on his press (`OWN_REPLY_HELD`).
    public static let ownReplyHeld = false
    /// The longest a reply may be: LifeOS's own limit (`CHAT_REPLY_MAX`).
    public static let replyMax = 4000
    /// How the host's answer to a Send or an Undo begins when LifeOS may have acted all the same (`REPLY_MAY_HAVE_GONE`).
    public static let mayHaveGone = "It may have gone"

    // MARK: - names

    /// What a source is called in a sentence (`SOURCE_NAME`).
    public static func name(_ source: ChatSource) -> String {
        switch source {
        case .slack: "Slack"
        case .discord: "Discord"
        case .imessage: "iMessage"
        case .teams: "Teams"
        case .other: "Chat"
        }
    }

    /// The app a conversation opens in (`SOURCE_APP`).
    public static func app(_ source: ChatSource) -> String {
        switch source {
        case .imessage: "Messages"
        default: name(source)
        }
    }

    /// How a reply leaves (`CHAT_ROUTES`): LifeOS sends Slack and iMessage; nothing here sends the rest, so Copy.
    public static func sendsThroughLifeos(_ source: ChatSource) -> Bool {
        switch source {
        case .slack, .imessage: true
        case .discord, .teams, .other: false
        }
    }

    /// "Reply in Slack to Dana Lee" (`replyWhere`).
    public static func replyWhere(_ source: ChatSource, chat: String) -> String { "Reply in \(name(source)) to \(chat)" }

    /// The first words of a text, cut at a word, with an ellipsis (`firstWords`).
    public static func firstWords(_ text: String, max: Int = 60) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > max else { return flat }
        let cut = String(flat.prefix(max))
        let space = cut.lastIndex(of: " ").map { cut.distance(from: cut.startIndex, to: $0) }
        let kept = if let space, Double(space) > Double(max) * 0.6 { String(cut.prefix(space)) } else { cut }
        return trimEnd(kept) + "…"
    }

    // MARK: - a row

    /// The name a group's row leads its words with: "Dana" of "Dana Lee"; a handle stays whole.
    public static func firstName(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
    }

    /// A row's second line: his own newest led by "You: ", a group's or channel's by the writer's first name, a
    /// direct chat's bare (`rowLine`).
    public static func rowLine(_ row: ChatRow) -> String {
        let words = row.lastText.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if row.lastFromMe { return "You: \(words)" }
        if row.kind == .direct || row.lastWho.isEmpty { return words }
        return "\(firstName(row.lastWho)): \(words)"
    }

    /// The one muted fact under an open conversation's name: "Slack, CosmicGames"; an account named as its service
    /// is said once (`chatFact`).
    public static func chatFact(_ row: ChatRow) -> String {
        let source = name(row.source)
        let account = row.accountName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !account.isEmpty && account.lowercased() != source.lowercased() ? "\(source), \(account)" : source
    }

    /// When he last saw a conversation: his mark here, the service's own, or his own last word (`seenAt`).
    public static func seenAt(_ row: ChatRow) -> Double { max(row.readAt ?? 0, row.sourceReadAt ?? 0, row.lastOutAt ?? 0) }

    /// Opening it marks it read: it is unread, or someone wrote after he last saw it (`wantsRead`).
    public static func wantsRead(_ row: ChatRow) -> Bool { row.unread || (row.lastInAt ?? 0) > seenAt(row) }

    // MARK: - the list

    /// Every job's conversations as one list: each once, unread first, then the newest first.
    public static func ordered(_ rows: [ChatRow]) -> [ChatRow] {
        var seen = Set<String>()
        let once = rows.filter { seen.insert($0.id).inserted }
        return once.sorted { a, b in
            if a.unread != b.unread { return a.unread }
            if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
            return a.id < b.id
        }
    }

    // MARK: - sync

    /// How long a source may be silent before the view says so (`CHAT_SILENT_MS`), in milliseconds.
    public static func silentMs(_ source: ChatSource) -> Double {
        switch source {
        case .slack, .discord: 15 * 60_000
        case .imessage, .teams, .other: 36 * 3_600_000
        }
    }

    /// When a source last checked in or synced: the newer of the two (`lastHeard`).
    public static func lastHeard(_ source: ChatSourceState) -> Double? {
        let at = max(source.lastSyncAt ?? 0, source.reportedAt ?? 0)
        return at > 0 ? at : nil
    }

    /// In error, or silent past its limit, or never synced (`staleOf`).
    public static func stale(_ source: ChatSourceState, now: Double) -> Bool {
        if source.status == .error { return true }
        guard let heard = lastHeard(source) else { return true }
        return now - heard > silentMs(source.kind)
    }

    /// A service's rows as one: in error when any is, else as fresh as its freshest (`serviceState`).
    public static func service(_ sources: [ChatSourceState], kind: ChatSource, now: Double) -> (stale: Bool, heard: Double?)? {
        let rows = sources.filter { $0.kind == kind }
        guard !rows.isEmpty else { return nil }
        let heard = rows.compactMap(lastHeard).max()
        let stale = rows.contains { $0.status == .error } || heard.map { now - $0 > silentMs(kind) } ?? true
        return (stale, heard)
    }

    /// "Nov 3" for another day, "2:02 PM" for today, in `zone` (`syncWhen`).
    public static func syncWhen(_ at: Double, now: Double, zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = Date(timeIntervalSince1970: at / 1000)
        if calendar.isDate(date, inSameDayAs: Date(timeIntervalSince1970: now / 1000)) {
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            let hour = parts.hour ?? 0, minute = parts.minute ?? 0
            return "\(hour % 12 == 0 ? 12 : hour % 12):\(minute < 10 ? "0" : "")\(minute) \(hour < 12 ? "AM" : "PM")"
        }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        let parts = calendar.dateComponents([.month, .day], from: date)
        return "\(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1)"
    }

    /// One sentence naming each stale service once, or nil when all are fresh (`syncLine`): "Discord last synced
    /// Nov 3, iMessage Nov 16", "Teams has not synced".
    public static func syncLine(_ sources: [ChatSourceState], now: Double, zone: TimeZone) -> String? {
        var parts: [String] = []
        var said = false
        for kind in [ChatSource.slack, .discord, .imessage, .teams] {
            guard let state = service(sources, kind: kind, now: now), state.stale else { continue }
            if let heard = state.heard {
                parts.append(said ? "\(name(kind)) \(syncWhen(heard, now: now, zone: zone))" : "\(name(kind)) last synced \(syncWhen(heard, now: now, zone: zone))")
                said = true
            } else {
                parts.append("\(name(kind)) has not synced")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    // MARK: - a message's words

    /// A message's words less the names LifeOS's readers folded into them, once its files are listed beside it
    /// (`fileMarkers`): only the tail a reader added after the words, one a file.
    public static func fileMarkers(_ text: String, names: [String]) -> String {
        guard !names.isEmpty else { return text }
        var out = trimEnd(text)
        var left = names.filter { !$0.isEmpty }
        var cut = true
        while cut {
            cut = false
            var i = left.count - 1
            while i >= 0 {
                let n = NSRegularExpression.escapedPattern(for: left[i])
                let next = trimEnd(replace(replace(out, "(^|\\s)\\[file: \(n)\\]$"), "(^|\\n)\(n) https?://\\S+$"))
                if next != out {
                    out = next
                    left.remove(at: i)
                    cut = true
                }
                i -= 1
            }
        }
        // The line goes only when it is the whole message and every name it gives is listed beside it.
        let listed = Set(names)
        let prefix = "Sent an attachment: "
        if out.hasPrefix(prefix), !out.contains("\n"), out.dropFirst(prefix.count).components(separatedBy: ", ").allSatisfy(listed.contains) {
            out = ""
        }
        return replace(out, "\\n{3,}", with: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func replace(_ text: String, _ pattern: String, with template: String = "") -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func trimEnd(_ text: String) -> String {
        var out = Substring(text)
        while let last = out.last, last.isWhitespace { out.removeLast() }
        return String(out)
    }
}

// MARK: - the composer

/// How his reply leaves a conversation: Send through the host, or Copy where nothing here can send.
public enum ReplyWay: Sendable, Hashable {
    case send
    /// LifeOS's sentence for why, when it gave one.
    case copy(why: String?)

    /// Send when the source is LifeOS's (`CHAT_ROUTES`) and LifeOS's route says yes; else Copy, with LifeOS's reason,
    /// or for a Copy source whose route says yes, "LifeOS can't reply in Discord yet". With no route read yet: Copy
    /// with no reason, so no Send is drawn that LifeOS may refuse.
    public static func of(_ source: ChatSource, route: ChatRoute?) -> ReplyWay {
        guard let route else { return .copy(why: nil) }
        if MessagesRules.sendsThroughLifeos(source), route.can { return .send }
        if route.can { return .copy(why: "LifeOS can’t reply in \(MessagesRules.name(source)) yet") }
        return .copy(why: route.why)
    }
}

/// His sent reply as LifeOS's row says it: "Sending" with Undo inside LifeOS's own undo time, "Not sent." with the
/// reason and Retry, nothing once sent.
public extension MessagesRules {
    /// A conversation row as VoiceOver reads it: the job first on All Jobs (as Today and Review say it), then unread,
    /// who, the route, the last words and the time.
    static func rowLabel(_ row: ChatRow, job: String?) -> String {
        ([job, row.unread ? "Unread" : nil, row.name, name(row.source), rowLine(row), TimeFormat.stamp(Int(row.lastAt))] as [String?])
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}

public struct ReplyLine: Sendable, Hashable {
    public var words: String
    public var reason: String?
    public var undo: Bool
    public var retry: Bool

    /// `press`: his Retry of it while it is out or unread (the ledger's state): the row says so and offers no second
    /// Retry until LifeOS's row says what became of it.
    public static func of(_ reply: ChatReplyState?, press: PressState? = nil) -> ReplyLine? {
        guard let reply else { return nil }
        if reply.status == .failed, let press, press == .sending || press == .checking {
            return ReplyLine(words: press.line ?? "Checking…", reason: nil, undo: false, retry: false)
        }
        switch reply.status {
        case .queued: return ReplyLine(words: "Sending", reason: nil, undo: true, retry: false)
        case .sending: return ReplyLine(words: "Sending", reason: nil, undo: false, retry: false)
        case .failed:
            let reason = reply.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            return ReplyLine(words: "Not sent.", reason: reason?.isEmpty == false ? reason : nil, undo: false, retry: true)
        case .sent: return nil
        }
    }
}

/// A thread's draft for one conversation. A held reply waits in the Outbox for his press there; a copy-only one
/// (Discord, Teams) waits for him to copy it. A held one wins over a copy-only one.
public enum ChatThreadDraft: Sendable, Hashable {
    case held(OutboxItem)
    case copy(ChatDraft)

    public var text: String {
        switch self {
        case .held(let item): Self.payloadText(item) ?? ""
        case .copy(let draft): draft.text
        }
    }

    /// The conversation a held `chat.reply` answers, from its payload.
    public static func chatId(_ item: OutboxItem) -> String? {
        guard item.kind == .chatReply, case .object(let payload)? = item.payload, case .string(let id)? = payload["chatId"] else { return nil }
        return id
    }

    static func payloadText(_ item: OutboxItem) -> String? {
        guard case .object(let payload)? = item.payload, case .string(let text)? = payload["text"] else { return nil }
        return text
    }

    /// The draft the conversation shows: its newest held reply still waiting, else its newest copy-only draft.
    public static func of(chatId: String, held items: [OutboxItem], copies: [ChatDraft]) -> ChatThreadDraft? {
        if let item = items.filter({ chatId == Self.chatId($0) && $0.state == .held }).max(by: { $0.createdAt < $1.createdAt }) {
            return .held(item)
        }
        return copies.filter { $0.chatId == chatId }.max { $0.at < $1.at }.map(ChatThreadDraft.copy)
    }
}

// MARK: - a chat's file in the reader

/// Which canvas kind opens a chat's file beside its conversation (`threadCanvasOf`, src/shared/work/files.ts): the
/// name's extension decides, the type only for a name with none. Nil: no kind shows it, so it has no press here.
public enum ChatFiles {
    private static let byExt: [String: String?] = {
        var table: [String: String?] = [:]
        func row(_ canvas: String?, _ exts: String) { for ext in exts.split(separator: " ") { table[String(ext)] = .some(canvas) } }
        row("document", "tcdoc docx doc odt rtf")
        row(nil, "docm")
        row("sheet", "tcsheet xlsx xlsm csv xls ods tsv")
        row(nil, "xlsb")
        row("slides", "pptx ppt pps ppsx odp key")
        row(nil, "pptm")
        row("pdf", "pdf")
        row("media", "png jpg jpeg gif webp avif heic heif tif tiff bmp psd")
        row(nil, "svg ico")
        row("media", "mp4 m4v mov webm mkv mxf avi mts m2ts ogv")
        row("meeting", "wav mp3 m4a aac flac ogg opus wma aiff amr")
        row("file", "md markdown txt json xml html htm log yaml yml toml ini css js jsx ts tsx py rb go rs java c h cpp sh sql")
        row("file", "zip tar gz tgz 7z rar")
        return table
    }()

    private static let prose: Set<String> = ["md", "markdown", "txt"]

    /// A name's extension, lower case, no dot; empty when it has none (`extOf`).
    public static func ext(_ name: String) -> String {
        let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? name
        guard let dot = base.lastIndex(of: "."), dot > base.startIndex else { return "" }
        return base[base.index(after: dot)...].lowercased()
    }

    private static func byMime(_ mime: String) -> String? {
        let m = mime.lowercased()
        let office = "application/vnd.openxmlformats-officedocument."
        if m == "application/vnd.google-apps.document" || m == "\(office)wordprocessingml.document" { return "document" }
        if m == "application/vnd.google-apps.spreadsheet" || m == "\(office)spreadsheetml.sheet" || m == "application/vnd.ms-excel.sheet.macroenabled.12" || m == "text/csv" { return "sheet" }
        if m == "application/vnd.google-apps.presentation" || m == "\(office)presentationml.presentation" { return "slides" }
        if m == "application/pdf" { return "pdf" }
        if m.hasPrefix("image/") || m.hasPrefix("video/") { return "media" }
        if m.hasPrefix("audio/") { return "meeting" }
        if m.hasPrefix("text/") || m == "application/zip" { return "file" }
        return nil
    }

    public static func canvasKind(name: String, contentType: String?) -> String? {
        let ext = ext(name)
        let canvas: String? = if !ext.isEmpty { byExt[ext] ?? nil } else { contentType.flatMap(byMime) }
        guard canvas == "file" else { return canvas }
        return prose.contains(ext) ? "document" : nil
    }
}
