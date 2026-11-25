import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct MoneyPageTests {
    private func read(_ json: String) throws -> MoneyReadPhone {
        try JSONDecoder().decode(MoneyReadPhone.self, from: Data(json.utf8))
    }

    private let full = """
    {"made":true,"any":true,"root":{"at":"file","host":"mac","path":"/w/Money"},"period":{"from":"2026-11-01","to":"2026-12-01"},
     "rows":[\(Array(repeating: #"{"row":3,"ref":"r1","date":"2026-11-20","who":"Shell","what":"Gas","category":"Travel","in":0,"out":4817,"status":"Paid","paidOn":null,"receipt":"Receipts/2026/a.png"}"#, count: 10).joined(separator: ","))],
     "sums":{"in":24000,"out":4817,"net":19183,"owedToHim":7500,"heOwes":0},
     "byCategory":[],"byMonth":[],
     "owed":[{"row":5,"ref":null,"sig":"abc","who":"West Lafayette HS","what":"Varsity game","amount":7500,"since":"2026-11-02","way":"toHim","reimburse":false,"both":false},
             {"row":6,"ref":"r6","sig":"def","who":"Diner","what":"Team lunch","amount":4300,"since":"2026-11-10","way":"toHim","reimburse":true,"both":false},
             {"row":7,"ref":"r7","sig":"ghi","who":"Printer","what":"","amount":1200,"since":null,"way":"byHim","reimburse":false,"both":false}],
     "miles":{"miles":42.5,"value":2975,"rate":0.7},"categories":["Game fees","Travel"],"sellers":[],
     "toConfirm":[{"id":"b","state":"ready","source":"phone","name":"IMG_2.jpg","picture":true,"fields":{"amount":1043,"date":"2026-11-21","who":null,"category":"Meals"},"at":20},
                  {"id":"a","state":"reading","source":"drop","name":null,"picture":false,"fields":{"amount":null,"date":null,"who":"Kroger","category":null},"at":10}],
     "calendar":[],"rate":{"year":2026,"rate":0.7,"own":false},
     "problems":[{"kind":"undated","rows":[9,12]},{"kind":"columns","missing":["In","Out"],"renamed":[]}]}
    """

    @Test func theDesktopsReadDecodesAsThePhonesView() throws {
        let r = try read(full)
        #expect(r.rows.count == 10)
        #expect(r.owed.map(\.way) == [.toHim, .toHim, .byHim])
        #expect(r.toConfirm.first?.state == .ready)
        #expect(r.problems.count == 2)
    }

    @Test func thePageListsInItsOrderAndCutsTheRows() throws {
        let shown = MoneyPage.shown(try read(full))
        #expect(shown.waiting.map(\.id) == ["a", "b"]) // the oldest first
        #expect(shown.owedToHim.map(\.row) == [5, 6])
        #expect(shown.heOwes.map(\.row) == [7])
        #expect(shown.recent.count == MoneyPage.recentShown)
        #expect(shown.more == 2)
        #expect(shown.problems == [
            "2 rows (9, 12) have money and no date Money can read, so no month or year counts them.",
            "The ledger has no In or Out column, so its money cannot be read.",
        ])
        #expect(!shown.empty)
    }

    @Test func aJobWithNoMoneyIsOneEmptyState() throws {
        let r = try read(#"{"made":false,"any":false,"period":{"from":"2026-11-01","to":"2026-12-01"},"rows":[],"sums":{"in":0,"out":0,"net":0,"owedToHim":0,"heOwes":0},"owed":[],"miles":{"miles":0,"value":0,"rate":null},"categories":[],"toConfirm":[],"problems":[]}"#)
        #expect(MoneyPage.shown(r).empty)
    }

    @Test func wordsAreTheDesktops() {
        #expect(MoneyPage.rowMoney(in: 7500, out: 0) == "+$75.00")
        #expect(MoneyPage.rowMoney(in: 0, out: 4817) == "$48.17")
        #expect(MoneyPage.rowMoney(in: 100, out: 200) == "+$1.00 and $2.00")
        #expect(MoneyPage.rowMoney(in: -500, out: 0) == "-$5.00 in")
        #expect(MoneyPage.rowMoney(in: 0, out: 0) == "$0.00")
        #expect(MoneyPage.owedWords(who: "Diner", what: "Team lunch", reimburse: true) == ("Team lunch", "Diner"))
        #expect(MoneyPage.owedWords(who: "Diner", what: "", reimburse: true) == ("Diner", "to be paid back"))
        #expect(MoneyPage.owedWords(who: "", what: "Game", reimburse: false) == ("Entry", "Game"))
        #expect(MoneyPage.sinceWords("2026-11-24", today: "2026-11-24") == "Today")
        #expect(MoneyPage.sinceWords("2026-11-23", today: "2026-11-24") == "1 day")
        #expect(MoneyPage.sinceWords("2026-10-23", today: "2026-11-24") == "32 days")
        #expect(MoneyPage.sinceWords(nil, today: "2026-11-24") == nil)
        #expect(MoneyPage.shortDay("2026-11-20", today: "2026-11-24") == "Nov 20")
        #expect(MoneyPage.shortDay("2025-11-20", today: "2026-11-24") == "Nov 20, 2025")
        #expect(MoneyPage.undatedWords([7], mileage: true) == "Row 7 of the mileage log has miles and no date Money can read, so no month or year counts it.")
    }

    @Test func spansStepAcrossTheYear() {
        let nov = MoneyPage.Span(kind: .month, year: 2026, month: 11)
        #expect((nov.from, nov.to, nov.label) == ("2026-11-01", "2026-12-01", "November 2026"))
        let dec = nov.step(1)
        #expect((dec.from, dec.to) == ("2026-12-01", "2027-01-01"))
        #expect(dec.step(1).label == "January 2027")
        #expect(MoneyPage.Span(kind: .month, year: 2026, month: 1).step(-1).label == "December 2025")
        let year = MoneyPage.Span(kind: .year, year: 2026, month: 11)
        #expect((year.from, year.to, year.label) == ("2026-01-01", "2027-01-01", "2026"))
        let chicago = TimeZone(identifier: "America/Chicago")!
        // 11:30 PM on Nov 30 in Chicago is already December in UTC: the span is his zone's.
        let late = Date(timeIntervalSince1970: 1_796_103_000) // 2026-12-01T05:30:00Z
        #expect(MoneyPage.Span.now(.month, at: late, zone: chicago).month == 11)
        #expect(MoneyPage.today(late, zone: chicago) == "2026-11-30")
    }

    @Test func acceptNeedsAnAmountAndADayThatExists() {
        #expect(MoneyPage.acceptFields(amount: nil, date: "2026-11-21", who: "", what: "", category: "", way: .out) == nil)
        #expect(MoneyPage.acceptFields(amount: 1043, date: "2026-02-30", who: "", what: "", category: "", way: .out) == nil)
        #expect(MoneyPage.acceptFields(amount: 0, date: "2026-11-21", who: "", what: "", category: "", way: .out) == nil)
        let f = MoneyPage.acceptFields(amount: 1043, date: "2026-11-21", who: " Kroger ", what: "", category: "Meals", way: .out)
        #expect(f?.who == "Kroger")
        #expect(f?.amount == 1043)
        #expect(MoneyPage.isDay("2028-02-29"))
        #expect(!MoneyPage.isDay("1989-12-31"))
    }

    @Test func aWritesAnswerSaysWhatHappened() throws {
        let decode = { (json: String) in try JSONDecoder().decode(MoneyActed.self, from: Data(json.utf8)) }
        #expect(MoneyPage.heard(try decode(#"{"ok":true,"ref":"r","row":4}"#)) == .written)
        #expect(MoneyPage.heard(try decode(#"{"ok":true,"ref":null,"row":4,"suggested":true}"#)) == .suggested)
        #expect(MoneyPage.heard(try decode(#"{"changed":true}"#)) == .changed)
    }
}
