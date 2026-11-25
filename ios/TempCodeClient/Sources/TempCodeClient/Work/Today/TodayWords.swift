import Foundation

/// Every time and count a Today row says, as the desktop words it: the helpers its sources call
/// (lib/duration.ts `clockTime`/`dayTime`, outbox/when.ts `heldWhen`, work-kit's `formatDue`, `waitedFor`,
/// `waitingWho`, messages/model.ts `rowTime`, shared/work/money.ts, shared/work/clashes.ts, shared/work/review.ts).
/// `calendar` carries the zone and the locale; nothing reads the clock itself.
public enum TodayWords {
    static let dayMs = 86_400_000.0

    // MARK: - formats

    static func format(_ ms: Double, _ template: String, _ calendar: Calendar, locale: Locale? = nil) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale ?? calendar.locale ?? .current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: TodayModel.date(ms))
    }

    /// "2:00 PM": the app's one clock time.
    public static func clock(_ ms: Double, _ calendar: Calendar) -> String {
        TimeFormat.clock(Int(ms.rounded()), locale: calendar.locale ?? .current, timeZone: calendar.timeZone)
    }

    /// Whole local days from `from`'s day to `to`'s: 0 the same day, negative before.
    static func days(from: Double, to: Double, _ calendar: Calendar) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: TodayModel.date(from)), to: calendar.startOfDay(for: TodayModel.date(to))).day ?? 0
    }

    /// A clock time that names its day when that is not today: "2:02 PM", "Mon 2:02 PM" within the last six days,
    /// "Nov 3, 2:02 PM" otherwise (a day ahead too).
    public static func dayTime(_ ts: Double, now: Double, _ calendar: Calendar) -> String {
        let ago = days(from: ts, to: now, calendar)
        if ago == 0 { return clock(ts, calendar) }
        if ago > 0 && ago < 7 { return "\(format(ts, "EEE", calendar)) \(clock(ts, calendar))" }
        return "\(format(ts, "MMMd", calendar)), \(clock(ts, calendar))"
    }

    /// When an item was held, a time that names its day: a bare date before the last six days.
    public static func heldWhen(_ ts: Double, now: Double, _ calendar: Calendar) -> String {
        days(from: ts, to: now, calendar) < 7 ? dayTime(ts, now: now, calendar) : format(ts, "MMMd", calendar)
    }

    /// A task's due label: a time today, Tomorrow, Yesterday, a weekday this week, a date beyond.
    public static func due(_ ms: Double, now: Double, _ calendar: Calendar) -> String {
        let offset = days(from: now, to: ms, calendar)
        if offset == 0 { return clock(ms, calendar) }
        if offset == 1 { return "Tomorrow" }
        if offset == -1 { return "Yesterday" }
        if offset > 1 && offset < 7 { return format(ms, "EEE", calendar) }
        return format(ms, "MMMd", calendar)
    }

    /// Whom he wrote to: "Dana", "Dana and Lee", "Dana and 2 more"; "No one".
    public static func waitingWho(_ to: [TodaySources.Wait.Address]) -> String {
        let names = to.map { a in a.name.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 } ?? a.address }
        guard let first = names.first else { return "No one" }
        guard names.count > 1 else { return first }
        return names.count == 2 ? "\(first) and \(names[1])" : "\(first) and \(names.count - 1) more"
    }

    /// How long he has waited, in whole days from the day he wrote to `today` (a local midnight): "1 day",
    /// "6 days", then "2 weeks" from the fourteenth day, rounded down.
    public static func waitedFor(_ since: Double, today: Double, _ calendar: Calendar) -> String {
        let sent = TodayModel.ms(calendar.startOfDay(for: TodayModel.date(since)))
        let n = max(1, Int(((today - sent) / dayMs).rounded()))
        if n < 14 { return n == 1 ? "1 day" : "\(n) days" }
        return "\(n / 7) weeks"
    }

    /// A conversation's time: "2:14 PM" today, "Yesterday", "Mon" within the week, "Nov 3" this year, "Nov 3, 2025".
    public static func chatTime(_ at: Double, now: Double, _ calendar: Calendar) -> String {
        let ago = days(from: at, to: now, calendar)
        if ago <= 0 { return clock(at, calendar) }
        if ago == 1 { return "Yesterday" }
        if ago < 7 { return format(at, "EEE", calendar) }
        let year = { (ms: Double) in calendar.component(.year, from: TodayModel.date(ms)) }
        return year(at) == year(now) ? format(at, "MMMd", calendar) : format(at, "MMMdy", calendar)
    }

    // MARK: - money

    /// "$1,234.56", "-$3.00".
    public static func money(_ cents: Double) -> String {
        let abs = Int(Swift.abs(cents).rounded())
        // US grouping whatever the phone's locale, as the desktop's `toLocaleString('en-US')`.
        var digits = Array(String(abs / 100))
        var grouped = ""
        while digits.count > 3 {
            grouped = ",\(String(digits.suffix(3)))\(grouped)"
            digits.removeLast(3)
        }
        return "\(cents < 0 ? "-" : "")$\(String(digits))\(grouped).\(String(format: "%02d", abs % 100))"
    }

    /// The local day as "2026-11-24".
    public static func localDay(_ ms: Double, _ calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: TodayModel.date(ms))
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Whole days between two "YYYY-MM-DD" days, as UTC midnights.
    static func daysBetween(_ from: String, _ to: String) -> Int? {
        guard let a = utcDay(from), let b = utcDay(to) else { return nil }
        return Int(((b - a) / dayMs).rounded())
    }

    static func utcDay(_ day: String) -> Double? {
        let p = day.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        return utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2])).map(TodayModel.ms)
    }

    /// Local noon of a "YYYY-MM-DD" day: what Owed orders by, so a row's place never turns on a time zone.
    static func localNoon(_ day: String, _ calendar: Calendar) -> Double? {
        let p = day.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12)).map(TodayModel.ms)
    }

    /// How long something has been open: "Today", "1 day", "32 days"; nil with no day.
    public static func since(_ since: String?, today: String) -> String? {
        guard let since else { return nil }
        let n = max(0, daysBetween(since, today) ?? 0)
        return n == 0 ? "Today" : n == 1 ? "1 day" : "\(n) days"
    }

    // MARK: - clashes (shared/work/clashes.ts)

    static let enUS = Locale(identifier: "en_US")

    /// A sector's name where no job names it.
    public static func sectorName(_ sector: String) -> String {
        ["cosmic": "Cosmic", "hypixel": "Hypixel", "purdue": "Purdue", "ref": "Ref", "unify": "Unify", "life": "Life"][sector] ?? sector
    }

    /// "6:00 PM", with an ordinary space where ICU puts a narrow no-break one; always the US words.
    static func clockOf(_ at: Double, _ calendar: Calendar) -> String {
        format(at, "hmm", calendar, locale: enUS).replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    /// Whether an instant is the second time its clock shows, where the clocks go back.
    static func isSecond(_ at: Double, _ calendar: Calendar) -> Bool {
        [3_600_000.0, 1_800_000.0].contains { clockOf(at - $0, calendar) == clockOf(at, calendar) }
    }

    /// A time beside a day: "6:00 PM" that day, "Wed 11:00 PM" within three days, "Jan 7, 8:00 AM" further off.
    static func timeNear(_ at: Double, on: Double, _ calendar: Calendar) -> String {
        let apart = Swift.abs(days(from: on, to: at, calendar))
        let lead = apart == 0 ? "" : apart <= 3 ? "\(format(at, "EEE", calendar, locale: enUS)) " : "\(format(at, "MMMd", calendar, locale: enUS)), "
        return "\(lead)\(isSecond(at, calendar) ? "second " : "")\(clockOf(at, calendar))"
    }

    static func shortWords(_ clash: TodayClash) -> String {
        let rough = clash.measured == false
        let short: String
        if let by = clash.shortBy {
            let n = rough ? max(5, Int((by / 5).rounded()) * 5) : max(1, Int(by.rounded()))
            short = "\(n) min short"
        } else {
            short = "Not enough time"
        }
        return rough ? "About \(short.prefix(1).lowercased())\(short.dropFirst())" : short
    }

    /// The one line on an event's row, from that event's side: "Overlaps Varsity (Ref), 6:00 PM"; "15 min short
    /// after Staff meeting" on the later event, "… before …" on the earlier. `on` is the day the line is read under.
    public static func clashLine(_ clash: TodayClash, eventId: String, on: Double?, label: (String) -> String, _ calendar: Calendar) -> String {
        let earlier = eventId == clash.a.eventId
        let (own, other) = earlier ? (clash.a, clash.b) : (clash.b, clash.a)
        let named = other.sector == own.sector ? other.title : "\(other.title) (\(label(other.sector)))"
        if clash.kind == "overlap" { return "Overlaps \(named), \(timeNear(other.startsAt, on: on ?? own.startsAt, calendar))" }
        return "\(shortWords(clash)) \(earlier ? "before" : "after") \(named)"
    }

    /// "Leave 4:35 PM".
    public static func leaveLine(_ leave: TodayLeave, _ calendar: Calendar) -> String { "Leave \(clockOf(leave.leaveAt, calendar))" }

    // MARK: - the weekly review (shared/work/review.ts)

    /// The Monday-to-Monday week that holds `at`, in the calendar's zone.
    public static func weekOf(_ at: Double, _ calendar: Calendar) -> (from: Double, to: Double) {
        var cal = calendar
        cal.firstWeekday = 2
        cal.minimumDaysInFirstWeek = 1
        let day = cal.startOfDay(for: TodayModel.date(at))
        let weekday = cal.component(.weekday, from: day)
        let back = (weekday - 2 + 7) % 7
        let first = cal.date(byAdding: .day, value: -back, to: day) ?? day
        let next = cal.date(byAdding: .day, value: 7, to: first) ?? first
        return (TodayModel.ms(first), TodayModel.ms(next))
    }

    /// The week a host names by its first moment: found from its middle, which lies in the same week in every zone.
    public static func weekNamed(_ from: Double, _ calendar: Calendar) -> (from: Double, to: Double) { weekOf(from + 3.5 * dayMs, calendar) }

    /// "Week of Nov 16".
    public static func weekWords(_ from: Double, _ calendar: Calendar) -> String { "Week of \(format(from, "MMMd", calendar, locale: enUS))" }

    /// The review row's words: which week it is, said from today.
    public static func readyTitle(_ from: Double, now: Double, _ calendar: Calendar) -> String {
        let now0 = weekOf(now, calendar).from
        if from == now0 { return "This week's review is ready" }
        if from == weekOf(now0 - dayMs, calendar).from { return "Last week's review is ready" }
        return "A week's review is ready"
    }
}
