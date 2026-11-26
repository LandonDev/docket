import Testing
@testable import TempCodeClient

@Suite("AwayWords")
struct AwayWordsTests {
    @Test func `each switch in the desktop's row names`() {
        #expect(AwayWords.title(.code) == "Code threads")
        #expect(AwayWords.title(.work) == "Work threads")
        #expect(AwayWords.title(nil) == "Code and Work threads")
    }

    @Test func `the root row says On while any computer has any kind away`() {
        #expect(AwayWords.summary([]) == "Off")
        #expect(AwayWords.summary([false, false]) == "Off")
        #expect(AwayWords.summary([false, true]) == "On")
    }
}

@Suite("WorkRowState")
struct WorkRowStateTests {
    @Test func `shown once any computer has answered, on or off`() {
        #expect(WorkRowState.of([(answered: false, settled: false), (answered: true, settled: true)]) == .shown)
    }

    @Test func `waiting in its place while a computer has yet to connect`() {
        #expect(WorkRowState.of([(answered: false, settled: false)]) == .waiting)
        #expect(WorkRowState.of([(answered: false, settled: true), (answered: false, settled: false)]) == .waiting)
    }

    @Test func `gone when every computer is connected and none knows Work`() {
        #expect(WorkRowState.of([(answered: false, settled: true)]) == .hidden)
        #expect(WorkRowState.of([]) == .hidden)
    }
}
