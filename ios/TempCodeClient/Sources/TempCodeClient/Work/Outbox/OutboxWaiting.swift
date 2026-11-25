import Foundation
import TempCodeContract

/// Waiting's order and the words its rows, notes and the request sheet say on the phone: the desktop's
/// `work/outbox/waiting.ts` and HeldDetail's notes in Swift (docs/agents/work-outbox.md "The screens",
/// docs/IOS-DESIGN.md "Work on the phone"), with no SwiftUI. The views draw what these answer; the tests read them.
public extension OutboxModel {
    // MARK: - the sections

    /// A thread's open request, on the host it waits on.
    struct RequestEntry: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var request: OutboxRequest
        public var id: String { "\(environmentId):request:\(request.id)" }

        public init(environmentId: String, request: OutboxRequest) {
            self.environmentId = environmentId
            self.request = request
        }
    }

    enum SectionKind: Sendable, Hashable { case asked, failed, soon, thread, scheduled }

    /// One section of Waiting. Asked holds requests; every other section holds items.
    struct Section: Sendable, Hashable, Identifiable {
        public var id: String
        public var kind: SectionKind
        /// "Asked in threads", "Not sent", "Starts soon", "Scheduled", or a band's thread title (else its job's name).
        public var title: String
        /// A thread band's job, said after its title; nil where the title already is the job.
        public var job: String?
        public var sector: String?
        public var entries: [Entry]
        public var requests: [RequestEntry]
    }

    /// What the sections read of the hosts: the job's rail place and name, and a thread's title.
    struct Places {
        public var jobOrder: (_ environmentId: String, _ workspaceId: String?) -> Int
        public var jobOf: (_ environmentId: String, _ workspaceId: String?) -> String
        public var titleOf: (_ entry: Entry) -> String?

        public init(jobOrder: @escaping (String, String?) -> Int, jobOf: @escaping (String, String?) -> String, titleOf: @escaping (Entry) -> String?) {
            self.jobOrder = jobOrder
            self.jobOf = jobOf
            self.titleOf = titleOf
        }
    }

    /// The calendar kinds, whose act is too late once the event begins.
    private nonisolated static let calendarKinds: Set<OutboxItem.Kind> = [.calendarOp, .officeCalendarOp]

    /// When a calendar act's event starts (ms), read as the host reads its deadline; nil for every other kind.
    nonisolated static func startsAt(_ item: OutboxItem) -> Int? {
        guard calendarKinds.contains(item.kind), case .object(let p)? = item.payload else { return nil }
        let at: JSONValue?
        if item.kind == .calendarOp {
            if let starts = p["eventStartsAt"] { at = starts } else if case .object(let inner)? = p["payload"] { at = inner["startsAt"] } else { at = nil }
        } else if case .string("create")? = p["op"], case .object(let event)? = p["event"] {
            at = event["start"]
        } else {
            at = p["start"]
        }
        switch at {
        case .number(let n)?: return Int(n)
        case .string(let s)?:
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let date = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
            return date.map { Int(($0.timeIntervalSince1970 * 1000).rounded()) }
        default: return nil
        }
    }

    /// The items an open request lists: they show under its Asked row alone, never again under their thread.
    nonisolated static func askedKeys(_ requests: [RequestEntry]) -> Set<String> {
        Set(requests.flatMap { entry in entry.request.rows.filter(\.open).map { "\(entry.environmentId):\(key($0.ref))" } })
    }

    /// Waiting in the order he decides it (prototype A): Asked in threads (each open request, oldest first), Not
    /// sent (failed, oldest first), Starts soon (a calendar act whose event starts before the end of tomorrow,
    /// soonest first), one band per thread (a routine's run is its own) by the job's rail order and then the band's
    /// oldest item, then Scheduled (the sends he timed, soonest first, never counted). Each only when it has rows;
    /// an item is in one section alone.
    nonisolated static func waitingSections(_ entries: [Entry], requests: [RequestEntry], places: Places, now: Date = .now, calendar: Calendar = .current) -> [Section] {
        let asked = askedKeys(requests)
        let until = soonUntil(now, calendar: calendar)
        var failed: [Entry] = []
        var soon: [Entry] = []
        var scheduled: [Entry] = []
        var bands: [String: (section: Section, order: Int, oldest: Int)] = [:]
        for entry in entries where !asked.contains(entry.id) {
            let item = entry.item
            if isScheduled(item) { scheduled.append(entry); continue }
            if item.state == .failed { failed.append(entry); continue }
            if item.state != .stale, let starts = startsAt(item), starts < until { soon.append(entry); continue }
            let workspace = item.workspaceId == workChatsKey ? nil : item.workspaceId
            let id = item.sessionId.map { "\(entry.environmentId):\($0)" } ?? "\(entry.environmentId):\(workspace ?? workChatsKey):none"
            if bands[id] == nil {
                let job = places.jobOf(entry.environmentId, workspace)
                let title = item.sessionId == nil ? nil : places.titleOf(entry)
                bands[id] = (Section(id: id, kind: .thread, title: title ?? job, job: title == nil ? nil : job, sector: item.sector, entries: [], requests: []), places.jobOrder(entry.environmentId, workspace), item.createdAt)
            }
            if var band = bands[id] {
                band.section.entries.append(entry)
                band.oldest = min(band.oldest, item.createdAt)
                bands[id] = band
            }
        }
        let byHeld: (Entry, Entry) -> Bool = { ($0.item.createdAt, $0.id) < ($1.item.createdAt, $1.id) }
        var out: [Section] = []
        if !requests.isEmpty {
            out.append(Section(id: "asked", kind: .asked, title: "Asked in threads", entries: [], requests: requests.sorted { ($0.request.createdAt, $0.id) < ($1.request.createdAt, $1.id) }))
        }
        if !failed.isEmpty { out.append(Section(id: "failed", kind: .failed, title: "Not sent", entries: failed.sorted(by: byHeld), requests: [])) }
        if !soon.isEmpty { out.append(Section(id: "soon", kind: .soon, title: "Starts soon", entries: soon.sorted { (startsAt($0.item) ?? 0) < (startsAt($1.item) ?? 0) }, requests: [])) }
        for band in bands.values.sorted(by: { ($0.order, $0.oldest, $0.section.id) < ($1.order, $1.oldest, $1.section.id) }) {
            var section = band.section
            section.entries.sort(by: byHeld)
            out.append(section)
        }
        if !scheduled.isEmpty { out.append(Section(id: "scheduled", kind: .scheduled, title: "Scheduled", entries: scheduled.sorted { scheduledAt($0.item) < scheduledAt($1.item) }, requests: [])) }
        return out
    }

    /// When a timed send goes (ms): the host's schedule, else the time Mail set.
    nonisolated static func scheduledAt(_ item: OutboxItem) -> Int { item.scheduledFor ?? item.updatedAt }

    /// The end of tomorrow: an act whose event starts before it is in Starts soon.
    private nonisolated static func soonUntil(_ now: Date, calendar: Calendar) -> Int {
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 2, to: start) ?? start.addingTimeInterval(2 * 86_400)
        return Int(end.timeIntervalSince1970 * 1000)
    }

    // MARK: - a row's words

    /// A time ahead, as a row says it: "2:00 PM" today, "Wed 8:00 AM" this week, "Dec 4, 8:00 AM" past that.
    nonisolated static func aheadTime(_ ms: Int, now: Date = .now, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        var clock = Date.FormatStyle(date: .omitted, time: .shortened)
        clock.timeZone = calendar.timeZone
        // The clock's narrow space before AM reads as a plain one, as the desktop's clockTime writes it.
        let time = date.formatted(clock).replacingOccurrences(of: "\u{202F}", with: " ")
        if days == 0 { return time }
        var style = Date.FormatStyle().month(.abbreviated).day()
        if days > 0, days < 7 { style = Date.FormatStyle().weekday(.abbreviated) }
        style.timeZone = calendar.timeZone
        return days > 0 && days < 7 ? "\(date.formatted(style)) \(time)" : "\(date.formatted(style)), \(time)"
    }

    /// A row's one trailing word: when it goes (Scheduled), when its event starts (Starts soon, in the
    /// foreground), "Out of date", "Sending", "Changed" (the thread rewrote it), else nil: the row says when it
    /// was held. Never amber.
    nonisolated static func rowSide(_ item: OutboxItem, in kind: SectionKind, now: Date = .now, calendar: Calendar = .current) -> (text: String, strong: Bool)? {
        if kind == .scheduled { return (aheadTime(scheduledAt(item), now: now, calendar: calendar), false) }
        if kind == .soon, let starts = startsAt(item) { return (aheadTime(starts, now: now, calendar: calendar), true) }
        if item.state == .stale { return ("Out of date", false) }
        if item.state == .sending { return ("Sending", false) }
        if item.changed?.by == .thread { return ("Changed", false) }
        return nil
    }

    // MARK: - the item's notes

    /// One note under an item's effect: why it did not send, why it went out of date, whose words it is now, or
    /// who wrote back since it was made. Each its own line; only `failed` wears the red mark.
    struct Note: Sendable, Hashable, Identifiable {
        public enum Kind: String, Sendable, Hashable { case failed, stale, changed, replied }
        public var kind: Kind
        public var text: String
        public var id: String { kind.rawValue }
    }

    /// The notes that apply, in the desktop's order and words (HeldDetail's `changedLine` and `repliedLine`).
    nonisolated static func notes(_ item: OutboxItem, held: (Int) -> String) -> [Note] {
        var out: [Note] = []
        if item.state == .failed { out.append(Note(kind: .failed, text: "Not sent. \(failureLine(item))")) }
        if item.state == .stale {
            let why = item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            out.append(Note(kind: .stale, text: "Out of date. \(why.isEmpty ? "It changed after it was made." : why)"))
        }
        if let changed = item.changed {
            out.append(Note(kind: .changed, text: "\(changed.by == .thread ? "The thread rewrote this" : "You changed this") at \(held(changed.at))."))
        }
        if let replied = item.replied {
            out.append(Note(kind: .replied, text: "\(replied.from) wrote back at \(held(replied.at)), after this was made: “\(replied.line)”"))
        }
        return out
    }

    // MARK: - Send later

    /// Send later's choices: in an hour (on the next five minutes), this afternoon at 1 while the morning lasts,
    /// tomorrow at 8. Pick a time… is the view's own.
    nonisolated static func laterChoices(now: Date = .now, calendar: Calendar = .current) -> [(label: String, at: Int)] {
        let five = 5 * 60_000
        let ms = Int(now.timeIntervalSince1970 * 1000)
        var out = [(label: "In an hour", at: ((ms + 3_600_000 + five - 1) / five) * five)]
        let day = calendar.startOfDay(for: now)
        if calendar.component(.hour, from: now) < 12, let one = calendar.date(byAdding: .hour, value: 13, to: day) {
            out.append(("This afternoon", Int(one.timeIntervalSince1970 * 1000)))
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: day), let eight = calendar.date(byAdding: .hour, value: 8, to: tomorrow) {
            out.append(("Tomorrow morning", Int(eight.timeIntervalSince1970 * 1000)))
        }
        return out
    }

    /// The undo capsule's line for a timed send: "Sending to Dana Lee Wed 8:00 AM".
    nonisolated static func laterLine(_ item: OutboxItem, at: Int, now: Date = .now, calendar: Calendar = .current) -> String {
        "\(pendingLine(item)) \(aheadTime(at, now: now, calendar: calendar))"
    }

    // MARK: - the thread's inline card

    /// A Work thread's `outbox_request` answer: `{outboxRequest: {id, host}}` in its text (JSON) or its structured
    /// content; nil for any other result. Only the tool itself draws a card: a shell echoing the words draws nothing.
    nonisolated static func requestOf(tool: String, result: String) -> (id: String, host: String)? {
        guard tool == "outbox_request" || tool.hasSuffix("__outbox_request") else { return nil }
        guard let data = result.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let card = object["outboxRequest"] as? [String: Any],
              let id = card["id"] as? String, !id.isEmpty,
              let host = card["host"] as? String else { return nil }
        return (id, host)
    }
}

/// The request sheet's rules: which rows start ticked, what each row says, the Send button's word and the
/// head once his press answered. No SwiftUI.
public enum RequestSheetModel {
    /// A row he may press from the sheet as drawn: it waits and the host gave it a receipt.
    public nonisolated static func pressable(_ row: OutboxRequestRow) -> Bool {
        row.open && row.receipt != nil && row.result == nil
    }

    /// The rows that start ticked: every one he may press, but one that changed since the thread asked, which
    /// starts unticked until he opens it (`request.view`) and ticks it himself.
    public nonisolated static func initialTicks(_ request: OutboxRequest) -> Set<String> {
        Set(request.rows.filter { pressable($0) && !$0.changed }.map { OutboxModel.key($0.ref) })
    }

    /// What a row does, in his words: the item's act, and under it what it is about, "Changed since asked", when a
    /// later one goes, or that it no longer waits.
    public nonisolated static func rowWords(_ row: OutboxRequestRow, now: Date = .now, calendar: Calendar = .current) -> (title: String, line: String?) {
        guard let item = row.item else { return ("An item this host no longer has", nil) }
        let words = OutboxModel.rowWords(item)
        let title = row.do == .discard ? "Discard: \(words.title)" : words.title
        if !row.open && row.result == nil { return (title, "No longer waits") }
        if row.changed && row.result == nil { return (title, "Changed since asked") }
        if row.do == .later, let at = row.at { return (title, "Goes \(OutboxModel.aheadTime(at, now: now, calendar: calendar))") }
        return (title, words.line)
    }

    /// The sheet's primary word: "Send 9", or "Approve 3" when the ticked rows' actions mix.
    public nonisolated static func pressWord(_ request: OutboxRequest, ticked: Set<String>) -> String {
        let rows = request.rows.filter { ticked.contains(OutboxModel.key($0.ref)) }
        let actions = Set(rows.map(\.do.rawValue))
        let word: String = switch actions.count == 1 ? rows.first?.do : nil {
        case .discard?: "Discard"
        case .later?: "Schedule"
        case .send?: "Send"
        default: "Approve"
        }
        return "\(word) \(rows.count)"
    }

    /// The capsule's line while his press waits its five seconds: each ticked row's action, target and time.
    public nonisolated static func pendingLines(_ request: OutboxRequest, ticked: Set<String>, now: Date = .now, calendar: Calendar = .current) -> [String] {
        request.rows.filter { ticked.contains(OutboxModel.key($0.ref)) }.compactMap { row in
            guard let item = row.item else { return nil }
            switch row.do {
            case .discard: return "Discarding \(OutboxModel.rowWords(item).title)"
            case .later: return row.at.map { OutboxModel.laterLine(item, at: $0, now: now, calendar: calendar) } ?? OutboxModel.pendingLine(item)
            default: return "\(OutboxModel.pendingLine(item)) now"
            }
        }
    }

    /// A row's result once his press landed: done with its word, or not, with the reason.
    public nonisolated static func resultWords(_ row: OutboxRequestRow) -> (ok: Bool, text: String)? {
        guard let result = row.result else { return nil }
        guard result.ok else { return (false, result.error ?? "Not sent") }
        switch row.do {
        case .discard: return (true, "Discarded")
        case .later: return (true, "Scheduled")
        default:
            if row.item?.lifeos == .queued || result.state == "sent" && (row.item?.kind == .mailSend || row.item?.kind == .calendarOp) { return (true, "Queued in LifeOS") }
            return (true, row.item.map { OutboxModel.pastOf($0.verb.split(separator: " ").first.map(String.init) ?? $0.verb, kind: $0.kind) } ?? "Done")
        }
    }

    /// The head once his press answered: "Sent 8, 1 not sent", "Discarded 3"; the host's own head before.
    public nonisolated static func resultsHead(_ request: OutboxRequest) -> String? {
        let settled = request.rows.compactMap(resultWords)
        guard !settled.isEmpty else { return nil }
        let done = settled.filter(\.ok).count
        let failed = settled.count - done
        let actions = Set(request.rows.filter { $0.result != nil }.map(\.do.rawValue))
        let (yes, no) = actions == ["discard"] ? ("Discarded", "not discarded") : actions == ["later"] ? ("Scheduled", "not scheduled") : ("Sent", "not sent")
        let line = [done > 0 ? "\(yes) \(done)" : nil, failed > 0 ? "\(failed) \(no)" : nil].compactMap { $0 }.joined(separator: ", ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }

    /// The muted line under the head once it is over: who answered and when, Not now, or why it ran out.
    public nonisolated static func closedLine(_ request: OutboxRequest, time: (Int) -> String) -> String? {
        switch request.state {
        case .open: return nil
        case .answered: return request.answeredAt.map { "By you at \(time($0))" } ?? "Answered"
        case .declined: return "Not now. The items still wait in your Outbox."
        case .void: return request.why.map { "Ran out: \($0)" } ?? "Ran out. The items still wait in your Outbox."
        case .unknown: return nil
        }
    }
}
