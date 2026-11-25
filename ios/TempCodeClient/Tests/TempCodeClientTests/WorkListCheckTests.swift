import Foundation
import Testing
@testable import TempCodeClient

struct WorkListCheckTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func theFixtureIsAThousandRowsWithTheirWordsMade() {
        let rows = WorkListRow.fixture(now: now)
        #expect(rows.count == 1_000)
        #expect(Set(rows.map(\.id)).count == 1_000)
        #expect(rows.allSatisfy { !$0.title.isEmpty && !$0.fact.isEmpty })
        // A folder has no size: its fact is the change time alone.
        #expect(rows.contains { $0.symbol == "folder" && !$0.title.contains(".") })
        #expect(WorkListRow.fixture(now: now) == rows)
    }

    @Test func aRowMadeTwiceIsCountedOnce() {
        var ledger = ListCheckLedger()
        ledger.made("a")
        ledger.made("b")
        ledger.made("a")
        ledger.made("a")
        #expect(ledger.made == 4)
        #expect(ledger.madeAgain == ["a"])
    }

    @Test func thePeakFollowsTheRowsAliveAndStartsAgain() {
        var ledger = ListCheckLedger()
        for key in ["a", "b", "c"] { ledger.appeared(key) }
        ledger.disappeared("a")
        #expect(ledger.peakAlive == 3)
        #expect(ledger.aliveCount == 2)
        ledger.resetPeak()
        #expect(ledger.peakAlive == 2)
        ledger.appeared("d")
        #expect(ledger.peakAlive == 3)
    }

    @Test func theCountsHoldOrSayWhatMissed() {
        var report = WorkListReport()
        report.window = 14
        report.firstPaintMade = 20
        report.peakAlive = 28
        #expect(report.rowLimit == 28)
        #expect(WorkListCheckRules.problems(report).isEmpty)
        report.peakAlive = 29
        report.madeAgain = 2
        report.stillMade = 1
        report.offsetWrites = 1
        #expect(WorkListCheckRules.problems(report) == [
            "29 rows alive at once (28)", "1 rows built while the list stood still", "1 scrolls the app made under the finger"
        ])
        report.note = "the list did not load"
        #expect(WorkListCheckRules.problems(report) == ["the list did not load"])
        #expect(WorkListCheckRules.problems(WorkListReport()) == ["the list showed no rows"])
    }
}
