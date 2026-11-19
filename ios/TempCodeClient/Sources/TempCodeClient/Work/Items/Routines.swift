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

    private static func order(_ a: RoutinePhoneRow, _ b: RoutinePhoneRow) -> Bool {
        if a.ended != b.ended { return !a.ended }
        switch (a.nextAt, b.nextAt) {
        case let (x?, y?) where x != y: return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        default: return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The stamp: "Until Tue, Nov 24" for a watch that ends on a day, else when it next runs.
    public static func stamp(_ row: RoutinePhoneRow, now: Date = Date(), calendar: Calendar = .current) -> String {
        if row.ended { return "Ended" }
        if !row.enabled { return "Paused" }
        if row.running { return "Running" }
        if row.kind == .watch, case .day(let until) = row.ends {
            return "Until " + Date(timeIntervalSince1970: Double(until.at) / 1000).formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        guard let next = row.nextAt else { return "" }
        let date = Date(timeIntervalSince1970: Double(next) / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
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
