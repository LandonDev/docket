import Foundation
import TempCodeContract

/// The Routines screen's two bands: routines, then watches; within each,
/// what runs soonest first, ended ones last. Proposals wait on the desktop's
/// page and are left out here.
public enum RoutineBands {
    public static func bands(_ rows: [RoutinePhoneRow]) -> (routines: [RoutinePhoneRow], watches: [RoutinePhoneRow]) {
        let kept = rows.filter { !$0.proposed }.sorted(by: order)
        return (kept.filter { $0.kind == .routine }, kept.filter { $0.kind == .watch })
    }

    /// The bands are headed only when both have rows: one band under the screen's title "Routines" would say it twice.
    public static func headed(_ bands: (routines: [RoutinePhoneRow], watches: [RoutinePhoneRow])) -> Bool {
        !bands.routines.isEmpty && !bands.watches.isEmpty
    }

    private static func order(_ a: RoutinePhoneRow, _ b: RoutinePhoneRow) -> Bool {
        if a.ended != b.ended { return !a.ended }
        switch (a.nextAt, b.nextAt) {
        case let (x?, y?) where x != y: return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        default: return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The stamp: "Until Tue, Nov 24" for a watch that ends on a day, else when it next runs where that adds a fact.
    /// A cadence that says its day and time ("Fridays at 4:00 PM", "Weekdays at 7:00 AM") is said once: a next run
    /// inside the week it names takes no stamp; one a week or more away is its date ("Dec 4").
    public static func stamp(_ row: RoutinePhoneRow, now: Date = Date(), calendar: Calendar = .current) -> String {
        if row.ended { return "Ended" }
        if !row.enabled { return "Paused" }
        if row.running { return "Running" }
        let style = Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone)
        if row.kind == .watch, case .day(let until) = row.ends {
            return "Until " + style.weekday(.abbreviated).month(.abbreviated).day().format(Date(timeIntervalSince1970: Double(until.at) / 1000))
        }
        guard let next = row.nextAt else { return "" }
        let date = Date(timeIntervalSince1970: Double(next) / 1000)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days >= 7 { return style.month(.abbreviated).day().format(date) }
        if says(row.words, date, style) { return "" }
        if days == 0 { return style.hour().minute().format(date) }
        return style.weekday(.abbreviated).hour().minute().format(date)
    }

    /// The cadence already names this run: its clock, and its day or a day that covers it (every day, weekdays).
    static func says(_ words: String, _ date: Date, _ style: Date.FormatStyle) -> Bool {
        let plain = { (text: String) in text.replacingOccurrences(of: "\u{202F}", with: " ").lowercased() }
        let cadence = plain(words)
        guard cadence.contains(plain(style.hour().minute().format(date))) else { return false }
        let day = plain(style.weekday(.wide).format(date))
        return cadence.contains(day) || ["every day", "daily", "weekdays", "every weekday"].contains { cadence.contains($0) }
    }
}

/// The guest link sheet's fields (For, Can, Ends) and the bounds the host keeps
/// (contract-work-guests.ts: at least an hour, at most 366 days, thirty by default).
public struct GuestLinkDraft: Equatable, Sendable {
    public enum Role: String, CaseIterable, Sendable {
        case view, comment, edit
        public var title: String { rawValue.capitalized }
        public var wire: Methods.WorkGuestsCreate.Params.Role {
            switch self {
            case .view: .view
            case .comment: .comment
            case .edit: .edit
            }
        }
    }

    public static let defaultDays = 30
    public static let minimum: TimeInterval = 60 * 60
    public static let maximum: TimeInterval = 366 * 24 * 60 * 60

    public var name = ""
    public var role: Role = .comment
    public var ends: Date

    public init(now: Date = Date()) {
        ends = now.addingTimeInterval(Double(Self.defaultDays) * 24 * 60 * 60)
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var expiresAtMs: Int { Int((ends.timeIntervalSince1970 * 1000).rounded()) }

    /// The span a picker offers, from `now`.
    public static func range(now: Date = Date()) -> ClosedRange<Date> {
        now.addingTimeInterval(minimum)...now.addingTimeInterval(maximum)
    }

    public func canCreate(now: Date = Date()) -> Bool {
        !trimmedName.isEmpty && trimmedName.count <= 80 && Self.range(now: now).contains(ends)
    }
}
