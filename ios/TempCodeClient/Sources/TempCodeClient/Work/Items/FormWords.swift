import Foundation

/// A form's answers as the phone draws them (the desktop's forms/responses.tsx `when` over model.ts `submittedTime`).
public enum FormWords {
    /// The Submitted time the sheet writes ("2026-11-24 20:36", the host's local clock); nil for any other text.
    public static func submittedTime(_ text: String, calendar: Calendar) -> Date? {
        let parts = text.trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0 == "-" || $0 == " " || $0 == ":" })
        guard parts.count == 5, parts.map(\.count) == [4, 2, 2, 2, 2] else { return nil }
        let n = parts.compactMap { Int($0) }
        guard n.count == 5 else { return nil }
        return calendar.date(from: DateComponents(year: n[0], month: n[1], day: n[2], hour: n[3], minute: n[4]))
    }

    /// One answer's words: the Submitted column, the form's last, as a time that names its day ("8:36 PM" today,
    /// "Tue 8:36 PM" this week, "Nov 12, 8:36 PM" before); an answer it cannot read as a time stays as given.
    public static func cell(_ text: String, column: Int, columns: Int, now: Date, calendar: Calendar) -> String {
        guard column == columns - 1, let at = submittedTime(text, calendar: calendar) else { return text }
        return TodayWords.dayTime(at.timeIntervalSince1970 * 1000, now: now.timeIntervalSince1970 * 1000, calendar)
    }
}
