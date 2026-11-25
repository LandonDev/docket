import Foundation
import TempCodeContract

/// A meeting's page in words (docs/agents/work-prep.md "The page", src/renderer/src/work/prep/model.ts): the comma
/// line under its title, which verb leads, what each row says. Pure, for its tests; the phone's page draws it.
public enum PrepRules {
    public typealias Page = PrepPagePhone

    /// The one verb the page leads with (the desktop's `headVerb`). Before the end: Prepare, then Preparing while
    /// its thread works, then none once a brief stands. After the end, or once notes stand: Add Notes, then Follow
    /// Up, then Following Up while its thread works, then none once an outcome stands.
    public enum Verb: String, Sendable, Hashable {
        case prepare, preparing, addNotes, followUp, following
    }

    /// A thread's status as the phone's own session row has it; nil when the phone does not list the thread, and
    /// then the host's bound on time (`briefUntil`, `followUntil`) stands in, read on the phone's clock.
    public static func verb(_ page: Page, now: Double, brief: String? = nil, follow: String? = nil, calendar: Calendar) -> Verb? {
        let doc = page.doc
        let unread = page.notesFile?.error != nil
        let followWrote = wrote(page.followStartedAt, doc.after?.at)
        if !unread, works(page.followSessionId, follow, page.followUntil, followWrote, now) { return .following }
        if doc.after != nil { return nil }
        if notesToFollow(page) { return .followUp }
        if isOver(page.event, now: now, calendar: calendar) { return .addNotes }
        if briefWorks(page, now: now, brief: brief) { return .preparing }
        return doc.brief == nil ? .prepare : nil
    }

    public static func label(_ verb: Verb) -> String {
        switch verb {
        case .prepare: "Prepare"
        case .preparing: "Preparing"
        case .addNotes: "Add Notes"
        case .followUp: "Follow Up"
        case .following: "Following Up"
        }
    }

    /// Whether the brief thread is at work, whatever leads: notes kept early lead with Follow Up while a brief
    /// started before them still writes.
    public static func briefWorks(_ page: Page, now: Double, brief: String? = nil) -> Bool {
        guard page.briefSessionId != nil, !wrote(page.briefStartedAt, page.doc.brief?.at) else { return false }
        return brief.map(threadWorks) ?? ((page.briefUntil ?? 0) > now)
    }

    /// Notes to follow up from: words he typed, his notes document, or a meeting this host has and could read.
    public static func notesToFollow(_ page: Page) -> Bool {
        guard let notes = page.doc.notes else { return false }
        return !notes.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || notes.file != nil
            || (page.notesFile?.kind == .meeting && page.notesFile?.error == nil)
    }

    /// The thread More's Open Thread opens: the follow-up's once there is one, else the brief's.
    public static func thread(_ page: Page) -> String? { page.followSessionId ?? page.briefSessionId }

    /// A thread is at work while starting, running, queued or waiting on him inside its turn.
    public static func threadWorks(_ status: String) -> Bool {
        ["starting", "running", "queued", "waiting"].contains(status)
    }

    // MARK: - when

    /// When a meeting is over (the contract's `prepEndOf`): its end; else an hour after its start, or the next
    /// midnight for one that lasts the day.
    public static func endOf(_ event: Page.Event, calendar: Calendar) -> Double {
        if let end = event.endsAt { return end }
        if !event.allDay { return event.startsAt + 3_600_000 }
        let start = calendar.startOfDay(for: Date(timeIntervalSince1970: event.startsAt / 1000))
        return (calendar.date(byAdding: .day, value: 1, to: start) ?? start).timeIntervalSince1970 * 1000
    }

    public static func isOver(_ event: Page.Event, now: Double, calendar: Calendar) -> Bool {
        endOf(event, calendar: calendar) <= now
    }

    /// The line under the title: "Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40 PM". A place that is only a link
    /// is left out (Files and Links offers it); the leave time only while it is ahead.
    public static func whenLine(_ event: Page.Event, now: Double, calendar: Calendar) -> String {
        var parts = [dayWords(event.startsAt, now: now, calendar: calendar), timeWords(event, calendar: calendar)]
        if let place = event.location?.trimmingCharacters(in: .whitespacesAndNewlines), !place.isEmpty, !isLink(place) { parts.append(place) }
        if let leave = event.leaveAt, !event.allDay, now < event.startsAt { parts.append("leave \(clock(leave, calendar))") }
        return parts.joined(separator: ", ")
    }

    /// "Today", "Tomorrow", "Yesterday", else "Mon, Nov 16".
    public static func dayWords(_ at: Double, now: Double, calendar: Calendar) -> String {
        let day = calendar.startOfDay(for: Date(timeIntervalSince1970: at / 1000))
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
        switch calendar.dateComponents([.day], from: today, to: day).day ?? 0 {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        default: return day.formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).month(.abbreviated).day())
        }
    }

    /// "2:00 to 2:45 PM", "11:30 AM to 12:15 PM", "2:00 PM" with no end, "all day".
    public static func timeWords(_ event: Page.Event, calendar: Calendar) -> String {
        if event.allDay { return "all day" }
        guard let end = event.endsAt, end > event.startsAt else { return clock(event.startsAt, calendar) }
        let start = clock(event.startsAt, calendar), stop = clock(end, calendar)
        let sameHalf = String(start.suffix(2)) == String(stop.suffix(2))
        return "\(sameHalf ? String(start.dropLast(3)) : start) to \(stop)"
    }

    /// "2:00 PM", with an ordinary space.
    public static func clock(_ at: Double, _ calendar: Calendar) -> String {
        Date(timeIntervalSince1970: at / 1000)
            .formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).hour().minute())
            .replacingOccurrences(of: "\u{202F}", with: " ")
    }

    static func isLink(_ text: String) -> Bool {
        let lower = text.lowercased()
        return (lower.hasPrefix("http://") || lower.hasPrefix("https://")) && !text.contains(" ")
    }

    // MARK: - rows

    /// Why a task is on the page: "Asked by Maya Chen", "Waiting on Tom Beck"; nil for one that names the subject.
    public static func taskLine(_ task: PrepTask) -> String? {
        guard let who = task.who else { return nil }
        switch task.why {
        case .asked?: return "Asked by \(who)"
        case .waiting?: return "Waiting on \(who)"
        default: return nil
        }
    }

    /// A person's second line: their newest mail's subject.
    public static func personLine(_ person: Page.People) -> String? {
        guard let mail = person.mail else { return nil }
        let subject = mail.subject.trimmingCharacters(in: .whitespacesAndNewlines)
        return subject.isEmpty ? "(no subject)" : subject
    }

    /// "and 3 more".
    public static func moreWords(_ count: Int) -> String? { count > 0 ? "and \(count) more" : nil }

    /// What did not load: the one part by its own words, more than one as one line.
    public static func problemWords(_ problems: [Page.Problem]) -> String? {
        var parts: [String] = []
        for problem in problems {
            let words: String = switch problem {
            case .people: "People’s mail and tasks"
            case .tasks: "Tasks"
            case .last: "Last time"
            case .drafts: "The follow-up mail"
            case .unknown(let raw): raw
            }
            if !parts.contains(words) { parts.append(words) }
        }
        guard let first = parts.first else { return nil }
        return parts.count == 1 ? "\(first) did not load" : "Parts of this page did not load"
    }

    /// "Last time, Nov 16".
    public static func lastLabel(_ last: Page.Last, calendar: Calendar) -> String {
        "Last time, \(Date(timeIntervalSince1970: last.startsAt / 1000).formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()))"
    }

    /// The mail row's words: "Follow-up to Maya Chen and Tom Beck".
    public static func draftLine(_ draft: Page.Draft) -> String {
        let to = draft.to
        if to.isEmpty {
            let subject = draft.subject.trimmingCharacters(in: .whitespacesAndNewlines)
            return subject.isEmpty ? "Follow-up mail" : subject
        }
        let names = to.count <= 2 ? to.joined(separator: " and ") : "\(to[0]), \(to[1]) and \(to.count - 2) more"
        return "Follow-up to \(names)"
    }

    /// The suggestions the page draws: one he rejected is gone.
    public static func shownTasks(_ page: Page) -> [PrepSuggestion] {
        (page.doc.after?.tasks ?? []).filter { $0.state != .rejected }
    }

    /// "Add 3 Tasks", "Add 1 Task".
    public static func addLabel(_ count: Int) -> String { "Add \(count) \(count == 1 ? "Task" : "Tasks")" }

    /// The state line of a filing LifeOS did not take; why stays on each task's own row.
    public static func failedWords(_ failed: [String: String], tasks: [PrepSuggestion]) -> String {
        guard failed.count == 1, let id = failed.keys.first, let title = tasks.first(where: { $0.id == id })?.title else {
            return "\(failed.count) tasks were not added"
        }
        return "“\(title)” was not added"
    }

    static func wrote(_ startedAt: Double?, _ writtenAt: Double?) -> Bool {
        guard let startedAt, let writtenAt else { return false }
        return writtenAt >= startedAt
    }

    static func works(_ sessionId: String?, _ status: String?, _ until: Double?, _ written: Bool, _ now: Double) -> Bool {
        guard sessionId != nil, !written else { return false }
        return status.map(threadWorks) ?? ((until ?? 0) > now)
    }
}

/// The suggested tasks he ticks (the desktop's To do): none ticked at first; Tick All takes every proposed task but
/// one a failed filing still owns; a filing in flight holds the ticks still.
public struct PrepTicks: Sendable, Hashable {
    public private(set) var ticked: Set<String> = []
    /// Why a task's filing failed, by its id: it is not ticked again until Retry files it.
    public private(set) var failed: [String: String] = [:]
    public private(set) var filing = false

    public init() {}

    public func isTicked(_ id: String) -> Bool { ticked.contains(id) }

    /// The tasks a tick may take: proposed and not owned by a failed filing.
    public static func open(_ tasks: [PrepSuggestion]) -> [PrepSuggestion] {
        tasks.filter { $0.state == .proposed }
    }

    public mutating func toggle(_ id: String) {
        guard !filing, failed[id] == nil else { return }
        if ticked.contains(id) { ticked.remove(id) } else { ticked.insert(id) }
    }

    public mutating func tickAll(_ tasks: [PrepSuggestion]) {
        guard !filing else { return }
        ticked = Set(Self.open(tasks).map(\.id).filter { failed[$0] == nil })
    }

    /// What one press files: the ticked tasks still proposed, in the page's order.
    public func toFile(_ tasks: [PrepSuggestion]) -> [String] {
        Self.open(tasks).map(\.id).filter(ticked.contains)
    }

    public mutating func begin() { filing = true }

    /// The host's answer: the filed tasks leave the ticks, a failure keeps its task with why.
    public mutating func answered(_ ids: [String], failed refused: [(id: String, error: String)]) {
        filing = false
        for id in ids { ticked.remove(id); failed.removeValue(forKey: id) }
        for (id, error) in refused { failed[id] = error }
    }

    /// The press never reached the host: the ticks stay as he left them.
    public mutating func lost() { filing = false }

    /// Retry: the failed tasks are filed again on their own.
    public var retrying: [String] { failed.keys.sorted() }

    /// The page read again: a task gone or no longer proposed leaves the ticks.
    public mutating func keep(_ tasks: [PrepSuggestion]) {
        let open = Set(Self.open(tasks).map(\.id))
        ticked = ticked.intersection(open)
        failed = failed.filter { open.contains($0.key) }
    }
}

/// His notes as he types them (the house's draft rule, docs/IOS-DESIGN.md: every change kept at once, written
/// after 500 ms of quiet and at once when the page leaves or the app goes to the background). Each save names the
/// words the page last held (`base`): when another window kept other notes meanwhile, the host writes nothing,
/// his words stay with a line that says so, and his next save puts them in place.
public struct PrepNotesDesk: Sendable, Hashable {
    public static let quiet: Double = 0.5
    public static let changedLine = "These notes were changed in another window while you typed. Save again to keep yours."

    public private(set) var text: String
    /// What the host holds, as last heard.
    public private(set) var base: String
    /// When the words are due to go, seconds; nil: nothing to save.
    public private(set) var due: Double?
    public private(set) var saving = false
    public private(set) var line: String?

    public init(kept: String) {
        text = kept
        base = kept
    }

    public var dirty: Bool { text != base }

    public mutating func edit(_ words: String, at now: Double) {
        guard words != text else { return }
        text = words
        due = dirty ? now + Self.quiet : nil
    }

    /// The save to send now (at the quiet's end, or `force` on leaving), else nil.
    public mutating func take(now: Double, force: Bool = false) -> (text: String, base: String)? {
        guard !saving, dirty, force || (due.map { now >= $0 } ?? false) else { return nil }
        saving = true
        due = nil
        return (text, base)
    }

    /// The host's answer to a save of `sent`. `kept` is what the page holds now.
    public mutating func answered(sent: String, kept: String, conflict: Bool, now: Double) {
        saving = false
        base = kept
        if conflict {
            line = Self.changedLine
            due = nil
        } else {
            line = nil
            if dirty { due = now + Self.quiet }
        }
    }

    /// The save failed: the words stay, said in its words, and go again on his next change or on leaving.
    public mutating func failed(_ words: String) {
        saving = false
        line = words
    }

    /// The page read again with no save of his out: words he has not changed follow the host's.
    public mutating func heard(_ kept: String) {
        guard !saving else { return }
        if !dirty { text = kept }
        base = kept
        if text == base { line = nil; due = nil }
    }
}
