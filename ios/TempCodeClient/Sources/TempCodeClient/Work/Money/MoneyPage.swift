import Foundation
import TempCodeContract

/// His accept's fields, as `work.money.accept` takes them.
public typealias MoneyAcceptFields = Methods.WorkMoneyAccept.Params.Fields

/// A job's Money on the phone (docs/agents/work-money.md "The phone"): To confirm, what is owed, the span's sums and
/// its recent rows, from one `work.money.read`. The words are the desktop's (src/renderer/src/work/money/model.ts,
/// MoneyView.tsx); the rules here are pure and tested (MoneyPageTests).
public enum MoneyPage {
    /// How many of the span's rows the page lists; the rest live in the ledger on the desktop.
    public static let recentShown = 8
    public static let changedWords = "The ledger changed. Showing it as it is now."
    public static let suggestedWords = "Suggested in the ledger. Accept it there."

    /// A span of local days as the wire names it: `from` is in it, `to` is not.
    public struct Span: Hashable, Sendable {
        public enum Kind: String, Hashable, Sendable, CaseIterable {
            case month
            case year
        }

        public var kind: Kind
        public var year: Int
        /// 1 to 12; unused for a year.
        public var month: Int

        public init(kind: Kind, year: Int, month: Int) {
            self.kind = kind
            self.year = year
            self.month = month
        }

        /// The span that holds `now` in `zone` (the desktop's `periodNow`).
        public static func now(_ kind: Kind, at now: Date, zone: TimeZone) -> Span {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let parts = calendar.dateComponents([.year, .month], from: now)
            return Span(kind: kind, year: parts.year ?? 2026, month: parts.month ?? 1)
        }

        public var from: String { kind == .month ? Self.day(year, month) : Self.day(year, 1) }
        public var to: String {
            switch kind {
            case .month: month == 12 ? Self.day(year + 1, 1) : Self.day(year, month + 1)
            case .year: Self.day(year + 1, 1)
            }
        }

        /// "November 2026", or "2026".
        public var label: String { kind == .month ? "\(MoneyPage.months[month - 1]) \(year)" : String(year) }

        /// The span `by` months or years on (the desktop's `stepPeriod`).
        public func step(_ by: Int) -> Span {
            guard kind == .month else { return Span(kind: kind, year: year + by, month: month) }
            let index = year * 12 + (month - 1) + by
            return Span(kind: kind, year: index / 12, month: index % 12 + 1)
        }

        private static func day(_ year: Int, _ month: Int) -> String {
            String(format: "%04d-%02d-01", year, month)
        }
    }

    static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    /// "$1,204.50", a minus before the sign for less than nothing (`formatMoney`).
    public static func money(_ cents: Double) -> String { TodayWords.money(cents) }

    /// A row's money: "+$75.00" in, "$12.50" out, both joined, "-$5.00 in" for a negative cell (`moneyWords`).
    public static func rowMoney(in cin: Double, out cout: Double) -> String {
        func one(_ cents: Double, _ way: String) -> String {
            cents < 0 ? "\(money(cents)) \(way)" : way == "in" ? "+\(money(cents))" : money(cents)
        }
        let parts = [cin != 0 ? one(cin, "in") : nil, cout != 0 ? one(cout, "out") : nil].compactMap { $0 }
        return parts.isEmpty ? money(0) : parts.joined(separator: " and ")
    }

    /// An open row's words: a cost to be paid back leads with what it was for, else who then what (`owedWords`).
    public static func owedWords(who: String, what: String, reimburse: Bool) -> (lead: String, after: String?) {
        if reimburse {
            return what.isEmpty ? (who.isEmpty ? "Entry" : who, "to be paid back") : (what, who.isEmpty ? nil : who)
        }
        return (who.isEmpty ? "Entry" : who, what.isEmpty ? nil : what)
    }

    /// How long a row has been open: "Today", "1 day", "32 days" (`sinceWords`).
    public static func sinceWords(_ since: String?, today: String) -> String? {
        guard let since, let from = dayDate(since), let to = dayDate(today) else { return nil }
        let days = max(0, Int(((to.timeIntervalSince(from)) / 86_400).rounded()))
        return days == 0 ? "Today" : days == 1 ? "1 day" : "\(days) days"
    }

    /// "Nov 20", or "Nov 20, 2025" when it is not this year's (`shortDay`).
    public static func shortDay(_ day: String, today: String) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return day }
        let short = "\(months[parts[1] - 1].prefix(3)) \(parts[2])"
        return today.hasPrefix(String(format: "%04d", parts[0])) ? short : "\(short), \(parts[0])"
    }

    /// Today as the ledger writes a day, in his zone.
    public static func today(_ now: Date, zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let p = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0)
    }

    private static func dayDate(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    // MARK: - To confirm

    /// A waiting receipt's name: who it is from, else its file's name (`ReceiptRow`).
    public static func waitingName(_ item: MoneyReadPhone.ToConfirm) -> String {
        if let who = item.fields.who, !who.isEmpty { return who }
        if let name = item.name, !name.isEmpty { return name }
        return "Receipt"
    }

    /// What his accept files: the fields as he left them, or nil while the amount or the date is missing (Accept stays off).
    public static func acceptFields(amount: Int?, date: String?, who: String, what: String, category: String, way: MoneyAcceptFields.Way) -> MoneyAcceptFields? {
        guard let amount, amount > 0, let date, isDay(date) else { return nil }
        return MoneyAcceptFields(date: date, who: who.trimmingCharacters(in: .whitespacesAndNewlines), what: what.trimmingCharacters(in: .whitespacesAndNewlines),
                                 category: category.trimmingCharacters(in: .whitespacesAndNewlines), way: way, amount: amount)
    }

    /// A day the ledger files: one that exists, 1990 to 2100 (`isDay`).
    public static func isDay(_ text: String) -> Bool {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]), (1990...2100).contains(y), (1...12).contains(m), d >= 1 else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let first = calendar.date(from: DateComponents(year: y, month: m, day: 1)), let days = calendar.range(of: .day, in: .month, for: first) else { return false }
        return days.contains(d)
    }

    // MARK: - the page

    /// What the page draws from one read, in its order.
    public struct Shown: Hashable, Sendable {
        /// Waiting receipts, the oldest first; one still being read has no press.
        public var waiting: [MoneyReadPhone.ToConfirm]
        public var owedToHim: [MoneyReadPhone.Owed]
        public var heOwes: [MoneyReadPhone.Owed]
        /// The span's newest rows, at most `recentShown`.
        public var recent: [MoneyReadPhone.Row]
        /// How many of the span's rows are not listed.
        public var more: Int
        /// One line a fault in the books, in the desktop's words.
        public var problems: [String]
        /// The job has never had money: the page is one empty state.
        public var empty: Bool
    }

    /// What the page is, the span's state first: its bones while the first read or a newly picked span is out; the
    /// failure where that read failed (never "No Money Yet", which is said only of a span that was read); the empty
    /// state for a job with no money; else the list, whose span section says its own read.
    public enum PageState: Equatable, Sendable { case bones, failed, empty, list }

    public static func pageState(_ shown: Shown?, spanRead: Bool, failed: Bool) -> PageState {
        guard let shown else { return failed ? .failed : .bones }
        guard shown.empty, shown.problems.isEmpty else { return .list }
        if spanRead { return .empty }
        return failed ? .failed : .bones
    }

    public static func shown(_ read: MoneyReadPhone) -> Shown {
        Shown(
            waiting: read.toConfirm.sorted { $0.at < $1.at },
            owedToHim: read.owed.filter { $0.way == .toHim },
            heOwes: read.owed.filter { $0.way == .byHim },
            recent: Array(read.rows.prefix(recentShown)),
            more: max(0, read.rows.count - recentShown),
            problems: read.problems.map(problemWords),
            empty: !read.any && read.toConfirm.isEmpty
        )
    }

    /// One fault of the books as one sentence; its mend is the desktop's, in the sheet.
    public static func problemWords(_ p: MoneyReadPhone.Problem) -> String {
        switch p.kind {
        case .columns:
            if let twice = p.twice, !twice.isEmpty { return "The ledger has \(list(twice)) twice, so its money cannot be read." }
            if p.waits == true { return "The ledger's missing columns wait as a suggestion in the sheet." }
            return "The ledger has no \(list(p.missing ?? [])) column, so its money cannot be read."
        case .undated:
            return undatedWords((p.rows ?? []).map { Int($0) }, mileage: p.book == .mileage)
        case .mileage:
            return "The mileage log cannot be read, so no miles are shown."
        case .unknown:
            return "The ledger cannot be read whole."
        }
    }

    /// "Row 7 has money and no date Money can read, so no month or year counts it." (`undatedWords`)
    public static func undatedWords(_ rows: [Int], mileage: Bool) -> String {
        let of = mileage ? " of the mileage log" : ""
        let which = rows.count == 1
            ? "Row \(rows[0])\(of) has"
            : "\(rows.count) rows\(of) (\(rows.prefix(5).map(String.init).joined(separator: ", "))\(rows.count > 5 ? ", …" : "")) have"
        return "\(which) \(mileage ? "miles" : "money") and no date Money can read, so no month or year counts \(rows.count == 1 ? "it" : "them")."
    }

    private static func list(_ names: [String]) -> String {
        switch names.count {
        case 0: "needed"
        case 1: names[0]
        default: names.dropLast().joined(separator: ", ") + " or " + names[names.count - 1]
        }
    }

    /// What a write's answer means: written, waiting as a suggestion, or the ledger changed under him (nothing written).
    public enum Heard: Hashable, Sendable {
        case written
        case suggested
        case changed
    }

    public static func heard(_ acted: MoneyActed) -> Heard {
        if acted.changed == true { return .changed }
        return acted.suggested == true ? .suggested : .written
    }
}
