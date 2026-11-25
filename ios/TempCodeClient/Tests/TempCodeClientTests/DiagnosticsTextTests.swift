import Testing
@testable import TempCodeClient

@Suite struct DiagnosticsTextTests {
    @Test func `milliseconds keep one decimal under ten`() {
        #expect(DiagnosticsText.ms(8.33) == "8.3 ms")
        #expect(DiagnosticsText.ms(21.4) == "21 ms")
        #expect(DiagnosticsText.hitch(3.06) == "3.1 ms per second")
    }

    @Test func `a launch mark reads in milliseconds, or None`() {
        #expect(DiagnosticsText.mark(240.4) == "240 ms")
        #expect(DiagnosticsText.mark(nil) == "None")
    }

    @Test func `late frames read as a share`() {
        #expect(DiagnosticsText.late(0, of: 0) == "No frames")
        #expect(DiagnosticsText.late(0, of: 2_400) == "None")
        #expect(DiagnosticsText.late(1, of: 2_400) == "Under 0.1%")
        #expect(DiagnosticsText.late(12, of: 2_400) == "0.5%")
        #expect(DiagnosticsText.late(300, of: 2_400) == "13%")
    }

    @Test func `the display names the drawn rate only when it differs`() {
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: nil) == "120 Hz")
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: 8.3) == "120 Hz")
        #expect(DiagnosticsText.display(maxFramesPerSecond: 120, medianMs: 16.7) == "120 Hz, drawing at 60")
    }

    @Test func `the list check reads as rows against its limit, with misses only when there are any`() {
        var report = WorkListReport()
        report.window = 14
        report.peakAlive = 26
        #expect(DiagnosticsText.rows(report) == "26 of 28")
        #expect(DiagnosticsText.listMisses(report) == nil)
        report.madeAgain = 1
        #expect(DiagnosticsText.listMisses(report) == "1 row built again")
        report.stillMade = 2
        report.offsetWrites = 1
        #expect(DiagnosticsText.listMisses(report) == "3 rows built again, 1 scroll under the finger")
    }

    @Test func `clocks, sizes and protection read plainly`() {
        #expect(DiagnosticsText.clocks([]) == "None")
        #expect(DiagnosticsText.clocks(["messages.hold", "today.minute"]) == "messages.hold, today.minute")
        #expect(DiagnosticsText.size(nil) == "None")
        #expect(DiagnosticsText.size(0) == "None")
        #expect(DiagnosticsText.size(2_000_000).hasSuffix("MB"))
        #expect(DiagnosticsText.protection("NSFileProtectionComplete") == "Complete")
        #expect(DiagnosticsText.protection("NSFileProtectionCompleteUntilFirstUserAuthentication") == "After First Unlock")
        #expect(DiagnosticsText.protection(nil) == "No File")
    }
}
