import Foundation
import TempCodeContract

/// The digest's rules on the phone, with no SwiftUI and no socket
/// (docs/agents/work-digest.md "The phone"): the phone's copy of the
/// desktop's `work/digest/store.ts` (`mergeRows`, `mergeDays`) and
/// `notice.ts` (`listSections`, `rowWhen`, `emptyLine`). Each host keeps its
/// own ledger; a thing two hosts tell under one key is one row, and hosts'
/// days of one date are one day, seen once any host's is.
public enum DigestModel {
    // MARK: - one host's ledger

    /// What one host answered (`work.digest.list` and `work.digest.get`), kept current by the `work.digest` push.
    public struct Ledger: Sendable, Hashable {
        public var days: [DigestDay]
        /// newest first
        public var rows: [TellRow]
        public var settings: DigestSettings?

        public init(days: [DigestDay] = [], rows: [TellRow] = [], settings: DigestSettings? = nil) {
            self.days = days
            self.rows = rows
            self.settings = settings
        }

        /// Takes a push into a ledger that was read. Answers true when a day was
        /// just made: the host stamped its rows with the day, so the list is read
        /// again rather than guessed.
        @discardableResult
        public mutating func apply(_ push: WorkDigestPush) -> Bool {
            if let day = push.day { days = [day] + days.filter { $0.day != day.day } }
            if let row = push.row { rows = [row] + rows.filter { $0.id != row.id } }
            if let gone = push.gone { rows.removeAll { $0.id == gone } }
            if let settings = push.settings { self.settings = settings }
            return push.day.map { $0.seenAt == nil } ?? false
        }

        /// He opened the day here: marked at once, before the host answers.
        public mutating func seen(_ day: String, at now: Double) {
            days = days.map { $0.day == day && $0.seenAt == nil ? DigestDay(day: $0.day, madeAt: $0.madeAt, seenAt: now, count: $0.count) : $0 }
        }
    }

    /// One host as the screen reads it.
    public struct HostInput: Sendable, Hashable {
        public var environmentId: String
        public var name: String
        /// nil: not read yet
        public var ledger: Ledger?
        /// the read's error; nil while it reads or once it answered
        public var error: String?

        public init(environmentId: String, name: String, ledger: Ledger?, error: String?) {
            self.environmentId = environmentId
            self.name = name
            self.ledger = ledger
            self.error = error
        }
    }

    // MARK: - across hosts

    /// A row and the host it came from: a tap opens its target there.
    public struct Entry: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var row: TellRow
        public var id: String { DigestModel.name(environmentId, row) }

        public init(environmentId: String, row: TellRow) {
            self.environmentId = environmentId
            self.row = row
        }
    }

    /// A row's name across hosts: its key, else its own id on its host.
    public nonisolated static func name(_ environmentId: String, _ row: TellRow) -> String {
        row.key.map { "k:\($0)" } ?? "i:\(environmentId):\(row.id)"
    }

    /// One row a key: the one he was told of at once wins, else the newest. Newest first.
    public nonisolated static func mergeRows(_ hosts: [(environmentId: String, rows: [TellRow])]) -> [Entry] {
        var order: [String] = []
        var byName: [String: Entry] = [:]
        for host in hosts {
            for row in host.rows {
                let entry = Entry(environmentId: host.environmentId, row: row)
                guard let had = byName[entry.id] else {
                    order.append(entry.id)
                    byName[entry.id] = entry
                    continue
                }
                let told = row.toldAt != nil, hadTold = had.row.toldAt != nil
                if (told && !hadTold) || (told == hadTold && row.at > had.row.at) { byName[entry.id] = entry }
            }
        }
        // A stable order for equal times: the first host's first.
        return order.enumerated().compactMap { i, name in byName[name].map { (i, $0) } }
            .sorted { $0.1.row.at != $1.1.row.at ? $0.1.row.at > $1.1.row.at : $0.0 < $1.0 }
            .map(\.1)
    }

    /// A day across hosts: made at its first host's time, seen once any host's is.
    public struct Day: Sendable, Hashable, Identifiable {
        public var day: String
        public var madeAt: Double
        public var seenAt: Double?
        /// every host that made it
        public var hosts: [String]
        public var id: String { day }
    }

    /// Hosts' days of one date are one day. Newest first.
    public nonisolated static func mergeDays(_ hosts: [(environmentId: String, days: [DigestDay])]) -> [Day] {
        var byDay: [String: Day] = [:]
        for host in hosts {
            for d in host.days {
                if var had = byDay[d.day] {
                    had.madeAt = min(had.madeAt, d.madeAt)
                    had.seenAt = had.seenAt ?? d.seenAt
                    had.hosts.append(host.environmentId)
                    byDay[d.day] = had
                } else {
                    byDay[d.day] = Day(day: d.day, madeAt: d.madeAt, seenAt: d.seenAt, hosts: [host.environmentId])
                }
            }
        }
        return byDay.values.sorted { $0.day > $1.day }
    }

    /// What "seen" sends when the screen opens: `work.digest.seen {day}` to every
    /// host that holds a day no host has seen yet.
    public nonisolated static func seenCalls(_ days: [Day]) -> [(environmentId: String, day: String)] {
        days.filter { $0.seenAt == nil }.flatMap { day in day.hosts.map { (environmentId: $0, day: day.day) } }
    }

    /// Everything the screen draws, from every host with Work on.
    public struct Screen: Sendable, Hashable {
        public var entries: [Entry]
        public var days: [Day]
        /// a host has not answered yet and none failed in its place
        public var reading: Bool
        /// the names of hosts whose read failed: one muted line each at the foot
        public var silent: [String]
    }

    public nonisolated static func screen(_ hosts: [HostInput]) -> Screen {
        let read = hosts.compactMap { host in host.ledger.map { (environmentId: host.environmentId, ledger: $0) } }
        return Screen(
            entries: mergeRows(read.map { ($0.environmentId, $0.ledger.rows) }),
            days: mergeDays(read.map { ($0.environmentId, $0.ledger.days) }),
            reading: hosts.contains { $0.ledger == nil && $0.error == nil },
            silent: hosts.filter { $0.error != nil }.map(\.name)
        )
    }

    /// The foot's line for a host that did not answer.
    public nonisolated static func silentLine(_ name: String) -> String { "\(name) did not answer" }

    // MARK: - the list

    public struct Section: Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var entries: [Entry]
    }

    /// The list's sections, newest first: what waits for the next digest, then each
    /// day's digest ("Today, 8:00 AM", "Yesterday", then dates). A day whose rows
    /// have all gone is left out.
    public nonisolated static func sections(_ entries: [Entry], days: [Day], now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [Section] {
        var out: [Section] = []
        let since = entries.filter { $0.row.day == nil }
        if !since.isEmpty { out.append(Section(id: "since", title: "Since the digest", entries: byJob(since))) }
        let today = dayKey(now, calendar)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now).map { dayKey($0, calendar) }
        let madeAt = Dictionary(days.map { ($0.day, $0.madeAt) }, uniquingKeysWith: { first, _ in first })
        let dayKeys = Set(entries.compactMap(\.row.day)).sorted(by: >)
        for day in dayKeys {
            let title: String
            if day == today {
                title = madeAt[day].map { "Today, \(clock(date($0), calendar, locale))" } ?? "Today"
            } else if day == yesterday {
                title = "Yesterday"
            } else {
                title = dateWords(day, calendar: calendar, locale: locale)
            }
            out.append(Section(id: day, title: title, entries: byJob(entries.filter { $0.row.day == day })))
        }
        return out
    }

    /// A section's rows: by job, then newest. A row about no one job comes last.
    nonisolated static func byJob(_ entries: [Entry]) -> [Entry] {
        entries.sorted { a, b in
            switch (a.row.sector, b.row.sector) {
            case let (x?, y?) where x != y: return x < y
            case (nil, _?): return false
            case (_?, nil): return true
            default: return a.row.at > b.row.at
            }
        }
    }

    /// A row's trailing fact: its clock in words when it has one ("by 2:00 PM"), else when it was told,
    /// each naming its day when it is not today. A clock the row's own words already say ("Budget review
    /// starts at 2:00 PM") is not said twice: that row ends with when it was told (the desktop's `rowWhen`).
    public nonisolated static func when(_ row: TellRow, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        if let by = row.by, !says(row, clock(date(by), calendar, locale)) { return "by \(dayTime(date(by), now: now, calendar, locale))" }
        return dayTime(date(row.at), now: now, calendar, locale)
    }

    /// The row's title or detail holds `clock`. Spaces compare as spaces: a formatter may write a narrow
    /// no-break space before AM and PM where the host's words have a plain one.
    nonisolated static func says(_ row: TellRow, _ clock: String) -> Bool {
        let plain = { (text: String) in text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ") }
        return plain("\(row.title) \(row.detail ?? "")").contains(plain(clock))
    }

    /// The empty list's one line: since when Work has had nothing to tell him (the ledger keeps 30 days).
    public nonisolated static func emptyLine(now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let since = calendar.date(byAdding: .day, value: -30, to: now) ?? now
        return "Work has had nothing to tell you since \(format(since, "MMMd", calendar, locale))."
    }

    // MARK: - where a press goes

    /// The Work views the phone has a screen for (`Route.workView`).
    public nonisolated static let phoneViews: Set<String> = ["mail", "tasks", "agenda", "projects", "routines"]

    /// A tell's target as a phone route on its host; nil where the phone has none
    /// (a page above the workspaces, a Settings section, a view it does not draw).
    public nonisolated static func route(_ open: TellOpen?, environmentId: String) -> Route? {
        guard let open, !environmentId.isEmpty else { return nil }
        // A held item names the thread that made it too: the item is the target.
        if let held = open.held {
            if case .unknown = held { return nil }
            return .outboxItem(environmentId: environmentId, ref: OutboxModel.key(held))
        }
        if let view = open.view, phoneViews.contains(view), let workspaceId = open.workspaceId, !workspaceId.isEmpty {
            return .workView(environmentId: environmentId, workspaceId: workspaceId, view: view)
        }
        if let thread = open.thread, !thread.isEmpty { return .thread(environmentId: environmentId, sessionId: thread, seq: nil) }
        return nil
    }

    // MARK: - Settings → Work → Digest

    /// The three groups Settings shows, in its order. Every other group stays at `clock` with no row.
    public nonisolated static let settingsGroups: [TellGroup] = [.held, .results, .people]

    /// The desktop's GROUP_NAMES for the rows Settings shows.
    public nonisolated static func groupName(_ group: TellGroup) -> String {
        switch group {
        case .held: "Held items"
        case .ending: "Sign-ins and licences"
        case .meetings: "Meetings"
        case .clashes: "Clashes"
        case .results: "Routine results"
        case .people: "Messages and mail"
        case .review: "Weekly review"
        case .system, .unknown: "Work"
        }
    }

    /// The three levels in his words, quietest first (the desktop's LEVEL_NAMES).
    public nonisolated static let levels: [TellLevel] = [.digest, .clock, .now]

    public nonisolated static func levelName(_ level: TellLevel) -> String {
        switch level {
        case .digest: "In the digest"
        case .clock, .unknown: "When it can’t wait"
        case .now: "Right away"
        }
    }

    /// A group's level on a host: what he set, else `clock`, where every group starts.
    public nonisolated static func level(_ settings: DigestSettings?, _ group: TellGroup) -> TellLevel {
        settings?.levels[group.rawValue] ?? .clock
    }

    /// The digest's time as he set it.
    public nonisolated static let defaultAt = "08:00"

    /// "08:00" as a time today, for a picker of the wall time.
    public nonisolated static func atDate(_ at: String, now: Date = .now, calendar: Calendar = .current) -> Date {
        let parts = at.split(separator: ":").compactMap { Int($0) }
        let (hour, minute) = parts.count == 2 ? (parts[0], parts[1]) : (8, 0)
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: now) ?? now
    }

    /// A picked time as the wire's "HH:mm".
    public nonisolated static func atString(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 8, parts.minute ?? 0)
    }

    // MARK: - time words

    private nonisolated static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    /// "2026-11-23" on the calendar's own wall clock.
    nonisolated static func dayKey(_ date: Date, _ calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private nonisolated static func format(_ date: Date, _ template: String, _ calendar: Calendar, _ locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }

    /// "2:00 PM": the phone's one clock time (`TimeFormat.clock`).
    nonisolated static func clock(_ date: Date, _ calendar: Calendar, _ locale: Locale) -> String {
        TimeFormat.clock(Int((date.timeIntervalSince1970 * 1000).rounded()), locale: locale, timeZone: calendar.timeZone)
    }

    /// A clock that names its day when it is not today: "2:00 PM" today, "Mon 2:00 PM" within the last
    /// six days, "Nov 3, 2:00 PM" otherwise, a day ahead too (the desktop's `dayTime`). `TimeFormat.stamp`
    /// names a coming day by its weekday, which a clock ahead must not: "by Nov 26", not "by Thu".
    nonisolated static func dayTime(_ date: Date, now: Date, _ calendar: Calendar, _ locale: Locale) -> String {
        let ago = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if ago == 0 { return clock(date, calendar, locale) }
        if ago > 0 && ago < 7 { return "\(format(date, "EEE", calendar, locale)) \(clock(date, calendar, locale))" }
        return "\(format(date, "MMMd", calendar, locale)), \(clock(date, calendar, locale))"
    }

    /// A day's heading past yesterday: "Mon, Nov 16".
    nonisolated static func dateWords(_ day: String, calendar: Calendar, locale: Locale) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)) else { return day }
        return format(date, "EEEMMMd", calendar, locale)
    }
}
