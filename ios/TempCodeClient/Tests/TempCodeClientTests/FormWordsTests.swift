import Foundation
import Testing
@testable import TempCodeClient

/// A form's answers on the phone (Work/Items/FormWords.swift), held to the desktop's forms/responses.tsx `when` over
/// model.ts `submittedTime` and `dayTime`.
@Suite struct FormWordsTests {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        c.locale = Locale(identifier: "en_US")
        return c
    }

    /// Thursday, Nov 26, 2026, 9:41 AM in Central.
    private var now: Date { calendar.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 9, minute: 41))! }

    /// The cell's words with the system's narrow space before AM and PM read as a plain one.
    private func cell(_ text: String) -> String {
        FormWords.cell(text, column: 3, columns: 4, now: now, calendar: calendar).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    @Test func submittedReadsAsADayAndATime() {
        #expect(cell("2026-11-26 04:46") == "4:46 AM")
        #expect(cell("2026-11-24 20:36") == "Tue 8:36 PM")
        #expect(cell("2026-11-12 08:05") == "Nov 12, 8:05 AM")
    }

    @Test func anyOtherAnswerStaysAsGiven() {
        // Not the last column: a date he typed in an answer is his own words.
        #expect(FormWords.cell("2026-11-24 20:36", column: 1, columns: 4, now: now, calendar: calendar) == "2026-11-24 20:36")
        #expect(FormWords.cell("Last Tuesday", column: 3, columns: 4, now: now, calendar: calendar) == "Last Tuesday")
        #expect(FormWords.cell("2026-11-24", column: 3, columns: 4, now: now, calendar: calendar) == "2026-11-24")
        #expect(FormWords.submittedTime("2026-11-24T20:36", calendar: calendar) == nil)
    }
}
