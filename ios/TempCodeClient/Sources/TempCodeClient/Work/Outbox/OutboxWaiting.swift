import Foundation
import Observation
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
        // The calendar's locale where it names one (on the phone, `.current`'s is the phone's own), so the words
        // never hang on the machine's settings.
        let locale = calendar.locale ?? .current
        var clock = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale)
        clock.timeZone = calendar.timeZone
        // The clock's narrow space before AM reads as a plain one, as the desktop's clockTime writes it.
        let time = date.formatted(clock).replacingOccurrences(of: "\u{202F}", with: " ")
        if days == 0 { return time }
        var style = Date.FormatStyle(locale: locale).month(.abbreviated).day()
        if days > 0, days < 7 { style = Date.FormatStyle(locale: locale).weekday(.abbreviated) }
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

    /// A failed send the host could not confirm: "May have gone", its reason, and what to check first.
    nonisolated static func mayHaveGoneLine(_ item: OutboxItem) -> String {
        let line = failureLine(item)
        return line.hasPrefix("It may have gone") ? line : "May have gone. \(line)"
    }

    /// The notes that apply, in the desktop's order and words (HeldDetail's `changedLine` and `repliedLine`).
    nonisolated static func notes(_ item: OutboxItem, held: (Int) -> String) -> [Note] {
        var out: [Note] = []
        // One that may have gone says so, with its Check Sent First line: never "Not sent" over it.
        if item.state == .failed { out.append(Note(kind: .failed, text: item.outcomeUnknown == true ? mayHaveGoneLine(item) : "Not sent. \(failureLine(item))")) }
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

    /// An item's one name: the list row's act, which its own screen and the request sheet's row take as their title.
    nonisolated static func title(_ item: OutboxItem) -> String {
        rowWords(item).title
    }

    /// A timed send's one line: "Scheduled for Wed 8:00 AM". Nil for an item no time holds.
    nonisolated static func scheduledLine(_ item: OutboxItem, now: Date = .now, calendar: Calendar = .current) -> String? {
        isScheduled(item) ? "Scheduled for \(aheadTime(scheduledAt(item), now: now, calendar: calendar))" : nil
    }

    /// The sentence the item screen draws under the title: the host's `effect` as it stands, saying only what the
    /// fields under it do not. None for a timed send: its "Scheduled for …" line is its one line, and its From says
    /// as whom (an older host's "as soon as you press" under a time would say the opposite).
    nonisolated static func effectLine(_ item: OutboxItem) -> String? {
        guard !isScheduled(item), let effect = item.effect?.trimmingCharacters(in: .whitespacesAndNewlines), !effect.isEmpty else { return nil }
        return effect
    }

    // MARK: - one sentence of what a press sends

    /// Each kind's noun, one and many, and the verb a head says for it when its items do not share one: the shared
    /// NOUN (src/shared/work/outboxHead.ts), word for word.
    private nonisolated static let nouns: [OutboxItem.Kind: (one: String, many: String, verb: String)] = [
        .mailSend: ("mail", "mails", "Send"), .officeMailSend: ("mail", "mails", "Send"), .teamsPost: ("message", "messages", "Post"),
        .chatReply: ("reply", "replies", "Send"), .calendarOp: ("invite", "invites", "Answer"), .officeCalendarOp: ("invite", "invites", "Answer"),
        .officeEdit: ("file", "files", "Change"), .googleEdit: ("file", "files", "Change"), .fileAct: ("file", "files", "Change"),
        .shareGuestLink: ("guest link", "guest links", "Make"), .shareGoogle: ("share", "shares", "Make"), .formPublish: ("form", "forms", "Publish"),
        .msformPublish: ("form", "forms", "Publish"), .msformMake: ("form", "forms", "Make"), .frameioPost: ("post", "posts", "Make"),
        .portalSubmit: ("form", "forms", "Submit"), .addonCall: ("call", "calls", "Run"), .computerAct: ("step", "steps", "Run"),
    ]

    /// Every address an item goes to, lower case, as the shared head counts them: a held mail's fields (under
    /// `message`), else an add-on call's own (under `arguments`), else the payload's top; each of `to`, `cc` and `bcc`
    /// one value or a list of them, a value a string with "@" or an `{address}`.
    private nonisolated static func headRecipients(_ item: OutboxItem) -> [String] {
        guard case .object(let p)? = item.payload else { return [] }
        var object = p
        if case .object(let m)? = p["message"] { object = m } else if case .object(let a)? = p["arguments"] { object = a }
        let one = { (v: JSONValue) -> String? in
            if case .string(let s) = v, s.contains("@") { return s.lowercased() }
            if case .object(let o) = v, case .string(let a)? = o["address"] { return a.lowercased() }
            return nil
        }
        return ["to", "cc", "bcc"].flatMap { key -> [String] in
            switch object[key] {
            case .array(let list)?: return list.compactMap(one)
            case let value?: return one(value).map { [$0] } ?? []
            case nil: return []
            }
        }
    }

    private nonisolated static func peopleWords(_ n: Int) -> String { "\(n) \(n == 1 ? "person" : "people")" }

    private nonisolated static func lowerFirst(_ s: String) -> String { s.prefix(1).lowercased() + s.dropFirst() }
    private nonisolated static func joinWords(_ parts: [String]) -> String {
        parts.count > 1 ? parts.dropLast().joined(separator: ", ") + " and " + parts.last! : parts.first ?? ""
    }

    /// Each kind's part of a head: its verb, its count and its noun; mail to how many people; an add-on call by its
    /// tool and add-on ("Echo with League, 3 times"). `bare`: the kind's words alone.
    private nonisolated static func groupParts(_ items: [OutboxItem], bare: Bool) -> [String] {
        var order: [String] = []
        var groups: [String: (noun: (one: String, many: String, verb: String), verbs: Set<String>, items: [OutboxItem])] = [:]
        for item in items {
            // An add-on's call that names its people is a mail as he reads it: one count with the held mails.
            let mailLike = item.kind == .mailSend || item.kind == .officeMailSend || item.kind == .addonCall && !headRecipients(item).isEmpty
            let noun = nouns[mailLike ? .mailSend : item.kind] ?? ("item", "items", "Run")
            var key = mailLike ? "mail" : item.kind.rawValue
            if item.kind == .addonCall, !mailLike {
                let o: [String: JSONValue] = if case .object(let o)? = item.payload { o } else { [:] }
                let word = { (v: JSONValue?) -> String in if case .string(let w)? = v { w } else { "undefined" } }
                key = "addon:\(word(o["addonId"])):\(word(o["tool"]))"
            }
            if groups[key] == nil { order.append(key); groups[key] = (noun, [], []) }
            groups[key]?.verbs.insert(item.verb.split(separator: " ").first.map(String.init) ?? item.verb)
            groups[key]?.items.append(item)
        }
        return order.enumerated().map { i, key -> String in
            let g = groups[key]!
            let n = g.items.count
            if key.hasPrefix("addon:"), !bare {
                let o: [String: JSONValue] = if case .object(let o)? = g.items[0].payload { o } else { [:] }
                let words: String = if case .string(let w)? = o["words"] { w } else if case .string(let t)? = o["tool"] { t } else { "Run" }
                let addon: String = if case .string(let a)? = o["addon"] { " with \(a)" } else { "" }
                // One that names its people is counted with the mails.
                let part = "\(words)\(addon)\(n > 1 ? ", \(n) times" : "")"
                return i > 0 ? lowerFirst(part) : part
            }
            let verb = key.hasPrefix("addon:") ? g.noun.verb : g.verbs.count == 1 ? g.verbs.first! : g.noun.verb
            var part = "\(i > 0 ? lowerFirst(verb) : verb) \(n) \(n == 1 ? g.noun.one : g.noun.many)"
            if key == "mail", !bare {
                let people = Set(g.items.flatMap(headRecipients)).count
                if people > 0 { part += " to \(peopleWords(people))" }
            }
            return part
        }
    }

    /// One sentence of everything a press sends, the shared `summaryHead` (src/shared/work/outboxHead.ts) in Swift:
    /// "Send 2 mails to 2 people, post 1 message and accept 1 invite"; what is sent at a time he set its own part
    /// ("… later"); what is discarded by its noun ("discard 1 mail"), or by a bare count.
    nonisolated static func summaryHead(_ items: [OutboxItem], discard: Int = 0, discarding: [OutboxItem] = [], later: [OutboxItem] = []) -> String {
        var parts = groupParts(items, bare: false)
        for part in later.isEmpty ? [] : groupParts(later, bare: false) { parts.append("\(parts.isEmpty ? part : lowerFirst(part)) later") }
        if !discarding.isEmpty {
            let nouns = groupParts(discarding, bare: true).map { $0.split(separator: " ", maxSplits: 1).dropFirst().joined() }
            parts.append("\(parts.isEmpty ? "Discard" : "discard") \(joinWords(nouns))")
        } else if discard > 0 {
            parts.append(parts.isEmpty ? "Discard \(discard)" : "discard \(discard)")
        }
        return joinWords(parts)
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

    /// The ticks a sheet starts with, as receipt ids: every row he may press as drawn, but one that changed since
    /// the thread asked, which has no receipt until he opens it (`request.view`) and ticks it himself. A tick is a
    /// receipt, never an item: the press names exactly what he saw ticked.
    public nonisolated static func initialTicks(_ request: OutboxRequest) -> Set<String> {
        Set(request.rows.filter { pressable($0) && !$0.changed }.compactMap(\.receipt))
    }

    /// The ticks that still hold on the request as drawn now: a receipt no pressable row carries any more (the row
    /// changed, moved on to a fresh receipt, was decided elsewhere) loses its tick; a fresh receipt starts unticked.
    public nonisolated static func reconcile(_ ticks: Set<String>, with request: OutboxRequest) -> Set<String> {
        ticks.intersection(request.rows.filter(pressable).compactMap(\.receipt))
    }

    /// Whether a row is ticked: its receipt as drawn is among the ticks.
    public nonisolated static func ticked(_ row: OutboxRequestRow, _ ticks: Set<String>) -> Bool {
        pressable(row) && row.receipt.map(ticks.contains) == true
    }

    /// The request as the sheet draws it: each row he opened through `request.view` in its fresh form, while the
    /// host's own row still waits at that same revision; a reload that moved the item drops the opened form (and so
    /// its receipt and tick).
    public nonisolated static func merged(_ request: OutboxRequest, opened: [String: OutboxRequestRow]) -> OutboxRequest {
        guard !opened.isEmpty else { return request }
        let rows = request.rows.map { row -> OutboxRequestRow in
            guard let fresh = opened[OutboxModel.key(row.ref)], row.open, row.result == nil, let now = row.item, fresh.item?.updatedAt == now.updatedAt else { return row }
            return fresh
        }
        return OutboxRequest(id: request.id, n: request.n, sessionId: request.sessionId, workspaceId: request.workspaceId, sector: request.sector, quote: request.quote, head: request.head, state: request.state, why: request.why,
                             createdAt: request.createdAt, expiresAt: request.expiresAt, answeredBy: request.answeredBy, answeredAt: request.answeredAt, rows: rows)
    }

    /// His Send as it stood at the press: exactly the ticked rows' receipts, in the request's order, frozen for the
    /// five seconds; nil with nothing ticked. A tick moved or a row reloaded during the wait changes nothing here.
    public nonisolated static func freeze(_ request: OutboxRequest, ticks: Set<String>, environmentId: String, now: Date = .now, calendar: Calendar = .current) -> RequestPress? {
        let held = reconcile(ticks, with: request)
        let rows = request.rows.filter { ticked($0, held) }
        guard !rows.isEmpty else { return nil }
        return RequestPress(environmentId: environmentId, requestId: request.id, receipts: rows.compactMap(\.receipt), word: pressWord(request, ticked: held), lines: pendingLines(request, ticked: held, now: now, calendar: calendar), head: head(request, ticked: held))
    }

    /// What a row does, in his words: the item's act, and under it what it is about, "Changed since asked", when a
    /// later one goes, or that it no longer waits.
    /// `closed`: the request is over, so a row his press did not take reads "Left out".
    public nonisolated static func rowWords(_ row: OutboxRequestRow, closed: Bool = false, now: Date = .now, calendar: Calendar = .current) -> (title: String, line: String?) {
        guard let item = row.item else { return ("An item this host no longer has", nil) }
        let words = OutboxModel.rowWords(item)
        let title = row.do == .discard ? "Discard: \(words.title)" : words.title
        if closed && row.result == nil { return (title, "Left out") }
        if !row.open && row.result == nil { return (title, "No longer waits") }
        if row.changed && row.result == nil { return (title, "Changed since asked") }
        if row.do == .later, let at = row.at { return (title, "Goes \(OutboxModel.aheadTime(at, now: now, calendar: calendar))") }
        return (title, words.line)
    }

    /// The head of a request as asked (the list's Asked row, the thread's card): every row it lists, in one sentence.
    /// The request's one name (the list's Asked row, the thread's card, the notice): the host's own, which it makes
    /// with the shared head over every row it lists.
    public nonisolated static func askedHead(_ request: OutboxRequest) -> String {
        request.head
    }

    /// Rows in one sentence, the shared head: what is sent now, what is sent later, what is discarded.
    nonisolated static func sentence(_ rows: [OutboxRequestRow]) -> String {
        OutboxModel.summaryHead(rows.filter { $0.do == .send }.compactMap(\.item), discarding: rows.filter { $0.do == .discard }.compactMap(\.item), later: rows.filter { $0.do == .later }.compactMap(\.item))
    }

    /// The sheet's head: while it is open, what the ticked rows do (so it always agrees with Send N); with none
    /// ticked, what was asked; once over, what his press did.
    public nonisolated static func head(_ request: OutboxRequest, ticked: Set<String>) -> String {
        guard request.state == .open else { return resultsHead(request) ?? request.head }
        let rows = request.rows.filter { self.ticked($0, ticked) && $0.item != nil }
        guard !rows.isEmpty else { return askedHead(request) }
        return sentence(rows)
    }

    /// The sheet's primary word: "Send 9", or "Approve 3" when the ticked rows' actions mix.
    public nonisolated static func pressWord(_ request: OutboxRequest, ticked: Set<String>) -> String {
        let rows = request.rows.filter { self.ticked($0, ticked) }
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
        request.rows.filter { self.ticked($0, ticked) }.compactMap { row in
            guard let item = row.item else { return nil }
            switch row.do {
            case .discard: return "Discarding \(OutboxModel.rowWords(item).title)"
            case .later: return row.at.map { OutboxModel.laterLine(item, at: $0, now: now, calendar: calendar) } ?? OutboxModel.pendingLine(item)
            default: return "\(OutboxModel.pendingLine(item)) now"
            }
        }
    }

    /// A row whose send the host could not confirm.
    public nonisolated static var mayHaveGone: String { PressState.mayHaveGone.line ?? "May have gone" }

    /// A row's result once his press landed: done with its word, or not, with the reason.
    public nonisolated static func resultWords(_ row: OutboxRequestRow) -> (ok: Bool, text: String)? {
        guard let result = row.result else { return nil }
        // The host could not confirm it (`unknown`): May have gone, never "not sent".
        if result.unknown == true { return (false, mayHaveGone) }
        guard result.ok else { return (false, result.error ?? "Not sent") }
        switch row.do {
        case .discard: return (true, "Discarded")
        case .later: return (true, "Scheduled")
        default:
            if row.item?.lifeos == .queued || result.state == "sent" && (row.item?.kind == .mailSend || row.item?.kind == .calendarOp) { return (true, "Queued in LifeOS") }
            return (true, row.item.map { OutboxModel.pastOf($0.verb.split(separator: " ").first.map(String.init) ?? $0.verb, kind: $0.kind) } ?? "Done")
        }
    }

    /// The head once his press answered: "Sent 2, 1 left out", "Queued 3 in LifeOS, 1 not sent", "Discarded 3": a
    /// mail LifeOS holds in its undo time is queued, never sent.
    public nonisolated static func resultsHead(_ request: OutboxRequest) -> String? {
        let settled = request.rows.compactMap(resultWords)
        guard !settled.isEmpty else { return nil }
        let queued = settled.filter { $0.ok && $0.text == "Queued in LifeOS" }.count
        let done = settled.filter(\.ok).count - queued
        let unsure = settled.filter { !$0.ok && $0.text == mayHaveGone }.count
        let failed = settled.count - done - queued - unsure
        let left = request.state == .answered ? request.rows.filter { $0.result == nil && $0.item != nil }.count : 0
        let actions = Set(request.rows.filter { $0.result != nil }.map(\.do.rawValue))
        let (yes, no) = actions == ["discard"] ? ("Discarded", "not discarded") : actions == ["later"] ? ("Scheduled", "not scheduled") : ("Sent", "not sent")
        let line = [done > 0 ? "\(yes) \(done)" : nil, queued > 0 ? "queued \(queued) in LifeOS" : nil, unsure > 0 ? "\(unsure) may have gone" : nil, failed > 0 ? "\(failed) \(no)" : nil, left > 0 ? "\(left) left out" : nil].compactMap { $0 }.joined(separator: ", ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }

    /// A settled row's line: its result when it adds something ("Queued in LifeOS", "Posted", "Discarded", a reason),
    /// else what the row is about: a check beside "Sent" would say one thing twice.
    public nonisolated static func settledLine(_ row: OutboxRequestRow) -> String? {
        guard let result = resultWords(row) else { return nil }
        return result.ok && result.text == "Sent" ? rowWords(row).line : result.text
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

/// His Send on a request's sheet, frozen at the press: the host, the request, exactly the receipts he had ticked,
/// the key he pressed under, and the words the wait shows.
public struct RequestPress: Sendable, Hashable {
    public var environmentId: String
    public var requestId: String
    public var receipts: [String]
    /// "Send 2", "Approve 3"
    public var word: String
    /// Each ticked row's action, target and time.
    public var lines: [String]
    /// What the ticked rows do, as the sheet's head said it at the press ("Send 2 mails to 2 people").
    public var head: String
    /// The host's name, for the line that says why a press did not go.
    public var hostName: String
    /// The key he pressed under (`PressGates.key`), frozen before the owner's check; nil: not yet frozen.
    public var key: String?

    public init(environmentId: String, requestId: String, receipts: [String], word: String, lines: [String], head: String = "", hostName: String = "", key: String? = nil) {
        self.environmentId = environmentId
        self.requestId = requestId
        self.receipts = receipts
        self.word = word
        self.lines = lines
        self.head = head
        self.hostName = hostName
        self.key = key
    }

    /// The ledger's revision for this press: exactly the receipts he sent.
    public var rev: String { receipts.sorted().joined(separator: ",") }

    /// The capsule's line while it waits: the head in the progressive ("Sending 2 mails to 2 people"), or for a press
    /// whose actions mix, "Approving 3".
    public var waitingLine: String {
        let parts = word.split(separator: " ")
        let verb = switch parts.first {
        case "Send": "Sending"
        case "Discard": "Discarding"
        case "Schedule": "Scheduling"
        default: "Approving"
        }
        if let first = parts.first, verb != "Approving", head.hasPrefix("\(first) ") { return verb + head.dropFirst(first.count) }
        return "\(verb) \(parts.last ?? "")"
    }
}

/// The phone's five seconds for a request's Send, on the Outbox's own rules (plan "Send waits its whole five
/// seconds"): the press is frozen when it starts, the host hears nothing until the seconds end, Undo drops it, and
/// nothing sends it early. The app leaving the screen, or the link to its host dropping, cancels it and says so; when
/// the seconds end the link and the key (the very key he pressed under) are checked again. The press goes through
/// the phone's record of presses (`WorkHost.answer`): an answer that does not come is Checking, never "Not sent", and
/// the request is read back on the next link (`heard`). One press at a time per request; its answer, or why it did
/// not go, is kept by request id for the sheet that shows it (open now or opened later).
@MainActor @Observable
public final class RequestPressWait {
    public enum Outcome: Sendable, Hashable {
        case answered(OutboxRequest)
        /// It did not go, or the host refused it: the whole line ("Not sent: TempCode left the screen").
        case failed(String)
        /// It went and no answer came: read back on the next link, never sent again from here.
        case checking
    }

    /// The presses waiting their seconds, by request id.
    public private(set) var pending: [String: RequestPress] = [:]
    /// The presses on their way to the host.
    public private(set) var sending: Set<String> = []
    /// What each press's host answered, by request id.
    public private(set) var outcomes: [String: Outcome] = [:]

    @ObservationIgnored private var waits: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let sleep: @Sendable () async throws -> Void

    /// `seconds`: the wait; `sleep` stands in for it in a test.
    public init(seconds: Double = 5, sleep: (@Sendable () async throws -> Void)? = nil) {
        self.sleep = sleep ?? { try await Task.sleep(for: .seconds(seconds)) }
    }

    /// The hosts a press waits on: the app hears their links and keys while any waits.
    public var waitingHosts: Set<String> { Set(pending.values.map(\.environmentId)) }

    /// Starts the wait for a frozen press. When it ends (and only then) `check` says whether it may still go (nil:
    /// yes), and `answer` runs with exactly its receipts. A second press on the same request while one waits is ignored.
    public func start(
        _ press: RequestPress,
        check: @escaping @MainActor (RequestPress) -> SendWait<RequestPress>.Why?,
        answer: @escaping @MainActor (RequestPress) async throws -> OutboxRequest
    ) {
        guard pending[press.requestId] == nil, !sending.contains(press.requestId), outcomes[press.requestId] != .checking else { return }
        outcomes[press.requestId] = nil
        pending[press.requestId] = press
        let sleep = self.sleep
        waits[press.requestId] = Task { [weak self] in
            do { try await sleep() } catch { return }
            guard !Task.isCancelled else { return }
            await self?.commit(press, check: check, answer: answer)
        }
    }

    /// Undo: the press never reaches the host.
    public func undo(_ requestId: String) {
        waits.removeValue(forKey: requestId)?.cancel()
        pending[requestId] = nil
    }

    /// TempCode left the screen: every press still waiting goes back, and says so.
    public func leftScreen() {
        cancel(.leftScreen) { _ in true }
    }

    /// The link to one host dropped: its waiting presses go back.
    public func linkLost(host: String) {
        cancel(.linkLost) { $0.environmentId == host }
    }

    /// The key on one host lost the right to send, or another key took its place: its waiting presses go back.
    public func keyLost(host: String) {
        cancel(.keyLost) { $0.environmentId == host }
    }

    /// The sheet took in an outcome: it is not offered again. A press still Checking stays until it is read back.
    public func clear(_ requestId: String) {
        if outcomes[requestId] != .checking { outcomes[requestId] = nil }
    }

    /// The request as a later read found it, after a press whose answer was lost: answered is his press's result.
    public func heard(_ request: OutboxRequest) {
        // Claimed and still going: Checking until its end comes (the host's push, or the next read).
        guard outcomes[request.id] == .checking, request.running != true else { return }
        outcomes[request.id] = request.state == .answered ? .answered(request) : .failed(Self.line(PressState.request(request.state)))
    }

    /// What the ledger read back of a press whose answer was lost, when there is no request to show.
    public func heard(requestId: String, state: PressState) {
        guard outcomes[requestId] == .checking, state != .checking, state != .sending, state != .done else { return }
        outcomes[requestId] = .failed(Self.line(state))
    }

    /// The words for a press that did not land: still open is "Not sent", over is why.
    static func line(_ state: PressState) -> String {
        switch state {
        case .stillWaiting, .changed: return "Not sent"
        case .gone: return "Not sent: it no longer waits"
        default: return state.line ?? "Not sent"
        }
    }

    private func cancel(_ why: SendWait<RequestPress>.Why, _ matches: (RequestPress) -> Bool) {
        for press in pending.values where matches(press) {
            waits.removeValue(forKey: press.requestId)?.cancel()
            pending[press.requestId] = nil
            outcomes[press.requestId] = .failed(SendWait<RequestPress>.line(why, hostName: press.hostName))
        }
    }

    private func commit(
        _ press: RequestPress,
        check: @MainActor (RequestPress) -> SendWait<RequestPress>.Why?,
        answer: @MainActor (RequestPress) async throws -> OutboxRequest
    ) async {
        guard pending[press.requestId] == press else { return }
        pending[press.requestId] = nil
        waits[press.requestId] = nil
        if let why = check(press) {
            outcomes[press.requestId] = .failed(SendWait<RequestPress>.line(why, hostName: press.hostName))
            return
        }
        sending.insert(press.requestId)
        defer { sending.remove(press.requestId) }
        do {
            outcomes[press.requestId] = .answered(try await answer(press))
        } catch is PressLedger.Unknown {
            // Its end may have come already (the request's last push): that stands.
            if case .answered? = outcomes[press.requestId] { return }
            outcomes[press.requestId] = .checking
        } catch {
            let words = ActionError.wrap(error).message
            outcomes[press.requestId] = .failed(words.hasPrefix("Not ") ? words : "Not sent: \(words)")
        }
    }
}

extension PressState {
    /// What a request's state says of a press on it that was read back.
    static func request(_ state: OutboxRequest.State) -> PressState {
        switch state {
        case .answered: .done
        case .open: .stillWaiting
        case .declined, .void: .gone
        case .unknown: .mayHaveGone
        }
    }
}
