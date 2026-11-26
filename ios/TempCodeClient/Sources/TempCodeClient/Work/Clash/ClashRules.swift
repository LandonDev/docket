import Foundation
import TempCodeContract

/// A clash on the phone (docs/agents/work-clashes.md "The phone"): the words the desktop's Clash dialog says
/// (src/shared/work/clashes.ts, src/renderer/src/work/clashes/model.ts), the ways out each event allows, the time a
/// proposal starts filled with, and how a press is recorded and read back. Pure, for its tests.
public enum ClashRules {
    public typealias Side = ClashSide

    /// The clash a route names: by its own id, else the first live clash of the event a tell names (a clash's tell
    /// opens on one of its events). Nil: it is settled or gone.
    public static func find(_ id: String, in clashes: [ClashPhoneRow], now: Double) -> ClashPhoneRow? {
        if let clash = clashes.first(where: { $0.id == id }) { return clash }
        return clashes.first { ($0.a.eventId == id || $0.b.eventId == id) && $0.b.endsAt > now }
    }

    /// The read that finds it: the day of the event or clash it names, a fortnight on (a clash is told up to two
    /// weeks ahead), from the start of that day. With no clue in the id, today on.
    public static func window(around: Double?, now: Double, calendar: Calendar) -> (from: Int, to: Int) {
        let day = calendar.startOfDay(for: Date(timeIntervalSince1970: (around ?? now) / 1000))
        let from = day.timeIntervalSince1970 * 1000
        return (Int(from), Int(from + 15 * 86_400_000))
    }

    /// "Two things at once", "15 minutes short", "About 15 minutes short".
    public static func title(_ clash: ClashPhoneRow) -> String {
        if clash.kind == .overlap { return "Two things at once" }
        guard let by = clash.shortBy else { return "Not enough time" }
        let n = shortMinutes(clash, by)
        return "\(clash.measured == false ? "About " : "")\(n) \(n == 1 ? "minute" : "minutes") short"
    }

    /// "38 min drive, 24 mi"; "About 40 min, 25 mi" without the map; nil with no minutes.
    public static func driveLine(minutes: Double?, miles: Double?, measured: Bool?) -> String? {
        guard let minutes else { return nil }
        let distance = miles.map { ", \(number($0)) mi" } ?? ""
        if measured == false { return "About \(duration(max(5, (minutes / 5).rounded() * 5)))\(distance)" }
        return "\(duration(minutes)) drive\(distance)"
    }

    /// An event's time as the sheet says it: "Tue 2:00 to 3:00 PM", "Tue 11:30 AM to 12:15 PM" (Prep's `span`).
    public static func timeLine(_ side: Side, calendar: Calendar) -> String {
        let start = Date(timeIntervalSince1970: side.startsAt / 1000)
        let day = start.formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated))
        return "\(day) \(PrepRules.span(side.startsAt, side.endsAt, calendar: calendar))"
    }

    /// The ways out the sheet offers for one event: decline and propose where LifeOS says the event allows them
    /// (an invitation). A move and Running late stay the desktop's.
    public static func ways(_ side: Side) -> [Way] {
        let can = side.can ?? []
        return [Way.decline, .propose].filter { way in can.contains { $0.rawValue == way.rawValue } }
    }

    public enum Way: String, Sendable, Hashable, CaseIterable {
        case decline, propose

        public var label: String {
            switch self {
            case .decline: "Decline"
            case .propose: "Propose New Time"
            }
        }

        /// What it does and who hears of it.
        public var words: String {
            switch self {
            case .decline: "Its organizer is told you declined."
            case .propose: "Your reply turns to Maybe and its organizer is asked for this time. Nothing moves until they agree."
            }
        }

        /// What the capsule says once the host has it: a calendar's act is queued with LifeOS's sender, so it is under way.
        public func done(_ title: String) -> String {
            switch self {
            case .decline: "Declining \(title)…"
            case .propose: "Proposing a new time for \(title)…"
            }
        }

        public var wire: Methods.WorkClashesAnswer.Params.Way {
            switch self {
            case .decline: .decline
            case .propose: .propose
            }
        }
    }

    /// The time a proposal starts filled with, for as long as the event runs now (the desktop's `freeAfter`): the
    /// earlier event the latest quarter hour that still ends a drive before the later one starts, while that is
    /// ahead and on its own day; otherwise the first quarter hour after the other event that the drive allows, and
    /// never a time already gone.
    public static func freeAfter(_ clash: ClashPhoneRow, eventId: String, now: Double, calendar: Calendar) -> (start: Double, end: Double) {
        let minute = 60_000.0, step = 15 * minute
        let earlier = eventId == clash.a.eventId
        let (side, other) = earlier ? (clash.a, clash.b) : (clash.b, clash.a)
        let length = side.endsAt > side.startsAt ? side.endsAt - side.startsAt : step
        let drive = (clash.minutes ?? 0) * minute
        var early = 0.0
        if clash.kind == .drive, let short = clash.shortBy {
            early = max(0, ((clash.b.startsAt - (clash.a.endsAt + drive - short * minute)) / minute).rounded(.down)) * minute
        }
        if earlier {
            let start = ((other.startsAt - early - drive - length) / step).rounded(.down) * step
            let sameDay = calendar.isDate(Date(timeIntervalSince1970: start / 1000), inSameDayAs: Date(timeIntervalSince1970: side.startsAt / 1000))
            if start > now && sameDay { return (start, start + length) }
        }
        let start = (max(other.endsAt + drive + (earlier ? 0 : early), now + 1) / step).rounded(.up) * step
        return (start, start + length)
    }

    /// The pair as the sheet showed it at his press: the host refuses a waive or a time once either moved.
    public static func seen(_ clash: ClashPhoneRow) -> [Methods.WorkClashesWaive.Params.Seen] {
        [clash.a, clash.b].map { .init(eventId: $0.eventId, startsAt: Int($0.startsAt), endsAt: Int($0.endsAt), location: $0.location ?? "", guests: $0.guests ?? false) }
    }

    public static func answerSeen(_ clash: ClashPhoneRow) -> [Methods.WorkClashesAnswer.Params.Seen] {
        [clash.a, clash.b].map { .init(eventId: $0.eventId, startsAt: Int($0.startsAt), endsAt: Int($0.endsAt), location: $0.location ?? "", guests: $0.guests ?? false) }
    }

    /// A proposal's fields as he left them: the end after the start, the start not gone.
    public static func timeProblem(start: Double, end: Double, now: Double) -> String? {
        if end <= start { return "It must end after it starts." }
        if start <= now { return "That time has passed." }
        return nil
    }

    // MARK: - the words' parts

    static func shortMinutes(_ clash: ClashPhoneRow, _ by: Double) -> Int {
        clash.measured == false ? max(5, Int((by / 5).rounded()) * 5) : max(1, Int(by.rounded()))
    }

    /// "38 min", "1 hr 5 min", "2 hr" (shared/work/duration.ts `durationOf`).
    static func duration(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        let hours = total / 60, rest = total % 60
        if hours == 0 { return "\(total) min" }
        return rest == 0 ? "\(hours) hr" : "\(hours) hr \(rest) min"
    }

    static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}

/// His answer as the press ledger keeps it: the clash it was for, and the span the read-back asks the host about.
public enum ClashPress {
    public static func ref(_ clashId: String) -> String { "clash:\(clashId)" }

    public static func clashId(ofRef ref: String) -> String? {
        ref.hasPrefix("clash:") && ref.count > 6 ? String(ref.dropFirst(6)) : nil
    }

    /// The span a read-back lists, as the press's `rev`: the later event's day.
    public static func rev(_ clash: ClashPhoneRow) -> String { "\(Int(clash.a.startsAt))-\(Int(clash.b.endsAt))" }

    public static func span(ofRev rev: String?) -> (from: Int, to: Int)? {
        guard let parts = rev?.split(separator: "-"), parts.count == 2, let from = Int(parts[0]), let to = Int(parts[1]), to >= from else { return nil }
        return (from, to)
    }
}

public extension PressTruth {
    /// A clash answer whose reply was lost, read back by the clash list: gone from it, the answer landed (or the
    /// calendar settled it); still listed, a decline or a proposal may be queued with LifeOS's sender all the same,
    /// so it may have gone, and he checks the calendar before he presses again.
    static func clash(listed: Bool) -> PressTruth {
        listed ? .mayHaveGone : .done
    }
}
