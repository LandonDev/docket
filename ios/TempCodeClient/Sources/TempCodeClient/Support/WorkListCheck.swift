import Foundation

/// One row of the list check's fixture list (docs/IOS-DESIGN.md "The Work perf proof", `list-idle` and `list-busy`):
/// a file as Files draws it, its words made once here, off the main actor, never in a body.
public struct WorkListRow: Identifiable, Hashable, Sendable {
    public var id: String
    public var symbol: String
    public var title: String
    public var fact: String

    /// `count` rows of names, kinds and change times that repeat in no short cycle, so a row's height and words
    /// vary as a real folder's do. The same count and clock make the same list.
    public static func fixture(count: Int = WorkListCheckRules.rows, now: Date, calendar: Calendar = .current) -> [WorkListRow] {
        let kinds: [(symbol: String, suffix: String)] = [("doc.text", "docx"), ("tablecells", "xlsx"), ("rectangle.on.rectangle", "pptx"), ("doc.richtext", "pdf"), ("photo", "jpg"), ("folder", "")]
        let names = ["Budget", "Roster", "Venue contract", "Spring LAN poster", "Travel forms", "Minutes", "Sponsor deck", "Invoices", "Bracket", "Floor plan", "Press kit"]
        var day = Date.FormatStyle.dateTime.month(.abbreviated).day()
        day.timeZone = calendar.timeZone
        return (0..<count).map { index in
            let kind = kinds[(index * 7) % kinds.count]
            let name = "\(names[(index * 5) % names.count]) \(index + 1)"
            let title = kind.suffix.isEmpty ? name : "\(name).\(kind.suffix)"
            let changed = now.addingTimeInterval(-Double(index * 37 * 60)).formatted(day)
            let size = ByteCountFormatter.string(fromByteCount: Int64((index % 40 + 1) * 24_576), countStyle: .file)
            return WorkListRow(id: String(format: "list-%04d", index), symbol: kind.symbol, title: title, fact: kind.suffix.isEmpty ? changed : "\(size), \(changed)")
        }
    }
}

/// The counts the list check keeps of its rows' states: each made when SwiftUI builds the row's state, each alive
/// from its appearance to its disappearance. A row made a second time had its state thrown away and built again.
public struct ListCheckLedger: Sendable, Equatable {
    public private(set) var made = 0
    /// Rows made a second time, in order (each once).
    public private(set) var madeAgain: [String] = []
    /// The most rows alive at once since `resetPeak`.
    public private(set) var peakAlive = 0
    private var everMade: Set<String> = []
    private var alive: Set<String> = []

    public init() {}

    public var aliveCount: Int { alive.count }

    public mutating func made(_ key: String) {
        made += 1
        if !everMade.insert(key).inserted, !madeAgain.contains(key) { madeAgain.append(key) }
    }

    public mutating func appeared(_ key: String) {
        alive.insert(key)
        peakAlive = max(peakAlive, alive.count)
    }

    public mutating func disappeared(_ key: String) {
        alive.remove(key)
    }

    /// The peak starts again from the rows alive now: the measured pass reads its own.
    public mutating func resetPeak() {
        peakAlive = alive.count
    }
}

/// What one list check measured. The counts are the gates (`scripts/lib/ios_work_perf_check.py`); the frame times
/// are reported, never judged on a simulator.
public struct WorkListReport: Codable, Sendable, Equatable {
    /// Why the check measured nothing, when it did not.
    public var note: String?
    public var rows = 0
    /// The most rows the list showed at once in the measured pass: the visible window.
    public var window = 0
    /// Rows whose state was built before the finger first moved.
    public var firstPaintMade = 0
    /// The most rows alive at once in the measured (warm) pass.
    public var peakAlive = 0
    /// Rows whose state was built a second time, over the whole check, and the first of them: reported, never judged,
    /// since List drops a row's state once the scroll takes it far off. The still seconds' count is the gate.
    public var madeAgain = 0
    public var madeAgainKeys: [String] = []
    /// The still seconds after the scroll: rows built in them while other places' pushes arrived, and those pushes.
    public var stillSeconds = 0.0
    public var stillMade = 0
    public var stillPushes = 0
    /// Pushes for other places that arrived during the measured scroll (`list-busy` needs one, so its offsets judged
    /// something).
    public var scrollPushes = 0
    /// The app's own scrolls of the list while the finger moved, and moves the finger did not make (reported).
    public var offsetWrites = 0
    public var foreignMoves = 0
    public var travelPt = 0.0
    /// Frames over the measured pass, in milliseconds.
    public var maxFramesPerSecond = 0
    public var frames = 0
    public var late = 0
    public var frameP95Ms = 0.0
    public var frameWorstMs = 0.0
    public var hitchMsPerS = 0.0
    public var mainP95Ms = 0.0
    public var thermal = "nominal"
    public var lowPower = false

    public init() {}

    /// The rows a list may build at most: the visible window and one page more.
    public var rowLimit: Int { WorkListCheckRules.rowLimit(window: window) }
}

public enum WorkListCheckRules {
    /// The fixture list's length.
    public static let rows = 1_000
    /// The still seconds after the scroll, while pushes for other places arrive.
    public static let stillSeconds = 6.0
    /// How long `list-busy`'s traffic may play: past the measured scroll (at most 90 s) and the still seconds; the
    /// check stops it when done.
    public static let loadSeconds = 120

    /// The visible window plus one page (a page is a window).
    public static func rowLimit(window: Int) -> Int { window * 2 }

    /// What the counts miss, in the checker's words; empty when they hold.
    public static func problems(_ report: WorkListReport) -> [String] {
        if let note = report.note { return [note] }
        var problems: [String] = []
        let limit = rowLimit(window: report.window)
        if report.window <= 0 { problems.append("the list showed no rows") }
        if report.firstPaintMade > limit { problems.append("\(report.firstPaintMade) rows built before the scroll (\(limit))") }
        if report.peakAlive > limit { problems.append("\(report.peakAlive) rows alive at once (\(limit))") }
        if report.stillMade > 0 { problems.append("\(report.stillMade) rows built while the list stood still") }
        if report.offsetWrites > 0 { problems.append("\(report.offsetWrites) scrolls the app made under the finger") }
        return problems
    }
}
