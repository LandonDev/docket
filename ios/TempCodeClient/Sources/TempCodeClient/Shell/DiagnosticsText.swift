import Foundation

/// The Diagnostics screen's numbers as it says them (Settings → a long
/// press on the version line): the phone's own measure of a scroll and of
/// typing, against the budgets in docs/IOS-DESIGN.md "Performance".
public enum DiagnosticsText {
    /// Milliseconds: one decimal under ten, whole above ("8.3 ms", "21 ms").
    public static func ms(_ value: Double) -> String {
        "\(number(value)) ms"
    }

    /// A launch mark ("240 ms"), or "None" for one this launch did not reach (no cached row).
    public static func mark(_ ms: Double?) -> String {
        ms.map(Self.ms) ?? "None"
    }

    /// Hitch time for each second of scrolling ("3.1 ms per second").
    public static func hitch(_ msPerSecond: Double) -> String {
        "\(number(msPerSecond)) ms per second"
    }

    /// The share of frames that came late ("0.4%"; "None" for none, "No frames" when nothing was recorded).
    public static func late(_ late: Int, of frames: Int) -> String {
        guard frames > 0 else { return "No frames" }
        guard late > 0 else { return "None" }
        let percent = Double(late) / Double(frames) * 100
        return percent < 0.1 ? "Under 0.1%" : "\(number(percent))%"
    }

    /// The screen's rate, and the rate the frames came at when it differs ("120 Hz", "120 Hz, drawing at 60").
    public static func display(maxFramesPerSecond: Int, medianMs: Double?) -> String {
        guard let medianMs, medianMs > 0 else { return "\(maxFramesPerSecond) Hz" }
        let drawn = Int((1_000 / medianMs).rounded())
        return abs(drawn - maxFramesPerSecond) <= maxFramesPerSecond / 10 ? "\(maxFramesPerSecond) Hz" : "\(maxFramesPerSecond) Hz, drawing at \(drawn)"
    }

    /// The list check's rows: the most alive at once against the visible window and one page ("26 of 28").
    public static func rows(_ report: WorkListReport) -> String {
        "\(report.peakAlive) of \(report.rowLimit)"
    }

    /// Rows the list check saw built again while it stood still (a scroll's own rebuilds are List's, not a miss), and
    /// its own scrolls under the finger: nil when none.
    public static func listMisses(_ report: WorkListReport) -> String? {
        let again = report.stillMade
        var parts: [String] = []
        if again > 0 { parts.append(again == 1 ? "1 row built again" : "\(again) rows built again") }
        if report.offsetWrites > 0 { parts.append(report.offsetWrites == 1 ? "1 scroll under the finger" : "\(report.offsetWrites) scrolls under the finger") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The repeating tasks alive now, by name (`TickLedger`), or "None".
    public static func clocks(_ names: [String]) -> String {
        names.isEmpty ? "None" : names.joined(separator: ", ")
    }

    /// A cache's size on disk ("1.2 MB"), or "None" for no file yet.
    public static func size(_ bytes: Int64?) -> String {
        guard let bytes, bytes > 0 else { return "None" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// A file's protection class as Settings would say it.
    public static func protection(_ raw: String?) -> String {
        switch raw {
        case "NSFileProtectionComplete": "Complete"
        case "NSFileProtectionCompleteUnlessOpen": "Complete Unless Open"
        case "NSFileProtectionCompleteUntilFirstUserAuthentication": "After First Unlock"
        case "NSFileProtectionNone": "None"
        case nil: "No File"
        default: "Unknown"
        }
    }

    private static func number(_ value: Double) -> String {
        value < 10 ? String(format: "%.1f", value) : String(Int(value.rounded()))
    }
}
