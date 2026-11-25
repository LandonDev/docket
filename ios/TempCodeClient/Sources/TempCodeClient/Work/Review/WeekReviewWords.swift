import Foundation
import TempCodeContract

/// Every word the weekly review says, as src/shared/work/review.ts says it: hours, the lines a host leaves, and the
/// rows. Days and clocks are US English in the review's zone, whatever the phone's own locale.
extension WeekReview {
    // MARK: - the words for hours

    /// Work's one duration form: "38 min", "1 hr", "1 hr 10 min".
    public static func durationOf(_ minutes: Double) -> String {
        let m = Int(max(0, jsRound(minutes)))
        if m < 60 { return "\(m) min" }
        return m % 60 != 0 ? "\(m / 60) hr \(m % 60) min" : "\(m / 60) hr"
    }

    /// JavaScript's `Math.round`: halves go up.
    static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    /// An estimate to the quarter hour; anything seen at all is at least one quarter.
    public static func toQuarter(_ ms: Double) -> Double { ms <= 0 ? 0 : max(quarterMs, jsRound(ms / quarterMs) * quarterMs) }

    /// What a length of time is: measured, or an estimate.
    public enum Measure: String, Hashable, Sendable {
        case measured, estimate
    }

    /// A length of time in words. A measure reads to the minute ("6 hr 30 min"); an estimate reads to the quarter
    /// hour and always says "about" ("about 4 hr 30 min"), so no caller can drop the "about".
    public static func hoursWords(_ ms: Double, _ kind: Measure) -> String {
        if kind == .estimate { return "about \(durationOf(toQuarter(ms) / minute))" }
        return durationOf(max(0, jsRound(ms / minute)))
    }

    /// A job's total: an estimate as soon as any of it is; nil when there is nothing to say.
    public static func totalWords(_ h: JobHours) -> String? {
        if totalMs(h) <= 0 { return nil }
        return h.deskMs > 0 ? hoursWords(totalMs(h), .estimate) : hoursWords(h.calendarMs, .measured)
    }

    /// A job with nothing all week. It names no week: the page may show one that is long over.
    public static let nothingSeen = "Nothing seen"
    /// The same row while the calendar could not be read: only the desk is known to be empty.
    public static let noDeskSeen = "No desk time seen"
    /// While what desk time stands on could not all be read: only the calendar is known to be empty.
    public static let noCalendarSeen = "Nothing on the calendar"
    /// Neither was read.
    public static let notKnown = "Not known"
    /// What a job with no hours reads: "nothing" only of what was read.
    public static func nothingWords(calendar: Bool, desk: Bool) -> String {
        calendar ? (desk ? nothingSeen : noCalendarSeen) : desk ? noDeskSeen : notKnown
    }
    public static func nothingWords(_ known: Known) -> String { nothingWords(calendar: known.calendar, desk: known.desk) }
    public static let calendarNote = "Calendar time is measured."
    public static let deskNote = "Desk time is an estimate from what you did in TempCode."
    public static let hoursNote = "\(calendarNote) \(deskNote)"

    /// "1,234 messages": US grouping whatever the phone's locale.
    static func count(_ n: Int, _ one: String, _ many: String) -> String {
        var digits = Array(String(abs(n)))
        var grouped = ""
        while digits.count > 3 {
            grouped = ",\(String(digits.suffix(3)))\(grouped)"
            digits.removeLast(3)
        }
        return "\(n < 0 ? "-" : "")\(String(digits))\(grouped) \(n == 1 ? one : many)"
    }

    /// What the estimate stands on: "28 messages, 9 mails sent, 4 document edits"; nil when on nothing.
    public static func standsWords(_ stands: Stands) -> String? {
        let parts = [
            stands.said != 0 ? count(stands.said, "message", "messages") : nil,
            stands.sent != 0 ? count(stands.sent, "mail sent", "mails sent") : nil,
            stands.pressed != 0 ? count(stands.pressed, "held item decided", "held items decided") : nil,
            stands.edited != 0 ? count(stands.edited, "document edit", "document edits") : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// A job's three facts, each said as what it is.
    public struct Facts: Hashable, Sendable {
        public var calendar: String
        public var calendarDetail: String?
        public var desk: String?
        public var deskDetail: String?
        public var ran: String?
    }

    /// A job's three facts, each said as what it is.
    public static func factsOf(_ h: JobHours) -> Facts {
        Facts(
            calendar: h.calendarMs > 0 ? hoursWords(h.calendarMs, .measured) : "Nothing",
            calendarDetail: h.events != 0 ? count(h.events, "event", "events") : nil,
            desk: h.deskMs > 0 ? hoursWords(h.deskMs, .estimate) : nil,
            deskDetail: standsWords(h.stands),
            ran: h.ranMs >= minute ? hoursWords(h.ranMs, .measured) : nil
        )
    }

    // MARK: - the lines a host leaves

    /// The lines a host leaves when a source failed. Another host that had LifeOS makes its lines untrue, so the
    /// merge drops them.
    public enum Left {
        public static let lifeos = "LifeOS did not answer, so the calendar, tasks and mail are not counted."
        public static let calendar = "The calendar did not answer."
        public static let tasks = "Tasks did not answer."
        public static let mail = "Mail did not answer."
        public static let held = "Held items could not be read."
        public static let threads = "Threads could not be read, so desk time may be short."
        public static let files = "Document history did not answer, so document edits are not counted."
        // A list cut at its cap, or a source that answered for some of its things: what was read counts.
        public static let mailPart = "Not every waiting mail could be read."
        public static let heldPart = "Not every held item could be read, so desk time may be short."
        public static let filesPart = "Not every document’s history could be read, so document edits may be short."
        /// his own addresses did not answer: every event's others would include him, so no meeting is judged
        public static let selfAddresses = "Your mail addresses could not be read, so no meeting is judged."
        /// a meeting put off into the week could not be read by its id: it stands as last known
        public static let carried = "A put-off meeting could not be read, so it stands as last known."
        /// the home could not judge the meetings (its marks live there): they stand as last known
        public static let meetings = "Meetings could not be checked, so they stand as last known."
        /// this host's Prep did not answer: a meeting followed up there may still be listed
        public static let prep = "Prep could not be read, so a meeting followed up there may still be listed."
        // A source that did not answer this time while a kept read of it stands in: the line says so.
        public static let lifeosKept = "LifeOS did not answer, so what it said when last read is shown."
        public static let calendarKept = "The calendar did not answer, so the hours count what it said when last read."
        public static let tasksKept = "Tasks did not answer, so what they said when last read is shown."
        public static let mailKept = "Mail did not answer, so what it said when last read is shown."
    }

    /// Each LifeOS line, by the lists it speaks of: it stays while one of them was not read whole this time.
    static let lineLists: [String: [ListKey]] = [
        // The calendar, tasks and mail, as the line says; the meetings are the home's to judge, said by their own line.
        Left.lifeos: [.events, .sent, .answered, .done, .due, .waits],
        Left.lifeosKept: [.events, .sent, .answered, .done, .due, .waits],
        Left.calendar: [.events],
        Left.calendarKept: [.events],
        Left.tasks: [.done, .due],
        Left.tasksKept: [.done, .due],
        Left.mail: [.sent, .answered, .waits],
        Left.mailKept: [.sent, .answered, .waits],
        Left.mailPart: [.waits],
        Left.selfAddresses: [.meetings],
        Left.carried: [.meetings],
    ]
    /// The lines that already say why the meetings were not judged.
    static let lineMeets: Set<String> = [Left.lifeos, Left.lifeosKept, Left.calendar, Left.calendarKept, Left.mail, Left.mailKept, Left.selfAddresses, Left.carried]

    /// A host that did not answer: "The Mac is off. Its threads and held items are not counted."
    public static func hostOffWords(_ name: String) -> String { "\(name) is off. Its threads and held items are not counted." }

    // MARK: - the words for rows

    /// "Dana Reyes", "Dana Reyes and Sam Park", "Dana Reyes and 3 others"; nil for nobody. `total` counts those not
    /// named too.
    public static func peopleWords(_ names: [String], total: Int) -> String? {
        guard let first = names.first, !first.isEmpty else { return nil }
        if total <= 1 { return first }
        if total == 2, names.count > 1, !names[1].isEmpty { return "\(first) and \(names[1])" }
        return "\(first) and \(count(total - 1, "other", "others"))"
    }

    /// The words a week's name opens with: a header short of room keeps the day alone.
    public static let weekLead = "Week of "
    /// "Week of Nov 16".
    public static func weekWords(_ week: Week, tz: String) -> String { "\(weekLead)\(monthDay(week.from, tz))" }

    static func format(_ at: Double, _ pattern: String, _ tz: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = zone(tz)
        f.dateFormat = pattern
        return f.string(from: Date(timeIntervalSince1970: at / 1000))
    }

    /// "2:00 PM".
    static func clock(_ at: Double, _ tz: String) -> String { format(at, "h:mm a", tz) }
    /// "Thu".
    static func weekday(_ at: Double, _ tz: String) -> String { format(at, "EEE", tz) }
    /// "Nov 12".
    static func monthDay(_ at: Double, _ tz: String) -> String { format(at, "MMM d", tz) }

    /// A day as the week's rows say it: its name inside the week shown ("Thu"), its date outside it ("Nov 12").
    public static func dayWords(_ at: Double, week: Week, tz: String) -> String {
        at >= week.from && at < week.to ? weekday(at, tz) : monthDay(at, tz)
    }

    /// The page's first line. "So far, made 2:02 PM" while the week runs; "Made Fri 4:00 PM" once it is over, which
    /// is when what slipped was last read inside the week; and for a week nobody made in its own time, that what
    /// slipped is as of today.
    public static func madeWords(madeAt: Double, over: Bool, slippedAt: Double, to: Double, tz: String, now: Double) -> String {
        if over && slippedAt >= to { return "Not made in its week. What slipped is as of today." }
        let at = over ? slippedAt : madeAt
        let days = Int(jsRound((dayStart(now, tz: tz) - dayStart(at, tz: tz)) / day))
        let lead = days == 0 ? "" : days > 0 && days < 7 ? "\(weekday(at, tz)) " : "\(monthDay(at, tz)), "
        return "\(over ? "Made" : "So far, made") \(lead)\(clock(at, tz))"
    }

    public static func madeWords(_ r: Merged, now: Double) -> String {
        madeWords(madeAt: r.madeAt, over: r.over, slippedAt: r.slippedAt, to: r.to, tz: r.tz, now: now)
    }

    /// A shipped row in three parts, so the page can weigh the title.
    public struct ShippedWords: Hashable, Sendable {
        public var lead: String
        public var title: String
        public var tail: String
    }

    /// A shipped row, led by what happened: "Sent Budget v2 to Dana Reyes".
    public static func shippedWords(kind: ReviewBody.Shipped.Kind, title: String, who: String?) -> ShippedWords {
        switch kind {
        case .sent: ShippedWords(lead: "Sent ", title: title, tail: who.flatMap { $0.isEmpty ? nil : " to \($0)" } ?? "")
        case .finished: ShippedWords(lead: "Finished ", title: title, tail: "")
        case .answered: ShippedWords(lead: "\(who ?? "Someone") answered ", title: title, tail: "")
        default: ShippedWords(lead: "Approved ", title: title, tail: "")
        }
    }

    public static func shippedWords(_ r: PlacedShipped) -> ShippedWords { shippedWords(kind: r.kind, title: r.title, who: r.who) }

    /// A slipped row's one muted detail: "due Tue", "sent Nov 12 to Dana Reyes", "held since Tue", "Thu 2:00 PM with
    /// Dana Reyes and 3 others, nothing sent after".
    public static func slippedDetail(ref: ReviewBody.Slipped.Row.Ref, at: Double, people: [String], others: Int, week: Week, tz: String) -> String {
        let day = dayWords(at, week: week, tz: tz)
        let who = peopleWords(people, total: others)
        switch ref {
        case .task: return "due \(day)"
        case .mail: return who.map { "sent \(day) to \($0)" } ?? "sent \(day)"
        case .held: return "held since \(day)"
        default: return "\(day) \(clock(at, tz))\(who.map { " with \($0)" } ?? ""), nothing sent after"
        }
    }

    public static func slippedDetail(_ r: PlacedSlipped, week: Week, tz: String) -> String {
        slippedDetail(ref: r.ref, at: r.at, people: r.people, others: r.others, week: week, tz: tz)
    }

    /// The three presses a slipped row offers, in order: now, next week, drop.
    public enum SettleHow: String, CaseIterable, Hashable, Sendable {
        case now, later, drop
    }

    /// A press's label, by the row's kind.
    public static func settleWords(_ kind: SlippedKind, _ how: SettleHow) -> String {
        switch (kind, how) {
        case (.task, .now): "Done"
        case (.task, .drop): "Drop"
        case (.mail, .now): "Nudge"
        case (.mail, .drop): "Stop waiting"
        case (.held, .now): "Open"
        case (.held, .drop): "Discard"
        case (.meeting, .now): "Follow up"
        case (.meeting, .drop): "None needed"
        case (_, .later): "Next week"
        }
    }

    /// What the toast says once a press has landed; empty where a press opens something and says nothing.
    public static func settledWords(_ kind: SlippedKind, _ how: SettleHow) -> String {
        switch (kind, how) {
        case (.task, .now): "Marked done"
        case (.task, .later): "Moved to next week"
        case (.task, .drop): "Dropped"
        case (.mail, .now): "Drafting a nudge"
        case (.mail, .drop): "Stopped waiting"
        case (.held, .now), (.meeting, .now): ""
        case (.held, .drop): "Discarded"
        case (.meeting, .drop): "Marked as needing nothing"
        case (_, .later): "Put off to next week"
        }
    }

    /// One job's Slipped rows in two groups: this week's rows lead, and tasks due before the week fold behind
    /// "12 older".
    public static func splitOlder(_ rows: [PlacedSlipped], week: Week) -> (lead: [PlacedSlipped], older: [PlacedSlipped]) {
        var lead: [PlacedSlipped] = []
        var older: [PlacedSlipped] = []
        for r in rows {
            if case .task = r.ref, r.at < week.from { older.append(r) } else { lead.append(r) }
        }
        return (lead, older)
    }
}
