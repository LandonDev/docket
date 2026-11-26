import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The council's round 4 on the phone (surface 12).
@Suite struct BoardFootLineTests {
    @Test func `the master's own line, else the rules sentence, never both`() {
        let rules = BatchRules(land: .asTheyFinish, steps: [], then: .notify)
        #expect(MasterBoard.footLine(rules) == MasterBoard.rulesSentence(rules))
        let said = BatchRules(land: .asTheyFinish, steps: [], then: .notify, summary: "Land as they finish, gate once, release, then the smoke test")
        #expect(MasterBoard.footLine(said) == "Land as they finish, gate once, release, then the smoke test")
        #expect(MasterBoard.footLine(BatchRules(land: .asTheyFinish, steps: [], then: .notify, summary: "  ")) == MasterBoard.rulesSentence(rules))
    }
}

/// At the accessibility sizes a finding's file and line sit above its summary.
@Suite struct FindingLayoutTests {
    @Test func `stacked at accessibility sizes, beside the summary otherwise`() {
        #expect(ReviewText.findingLayout(accessibilityText: true) == .stacked)
        #expect(ReviewText.findingLayout(accessibilityText: false) == .inline)
    }
}

/// A board row's effort takes the composer's word.
@Suite struct BoardEffortWordTests {
    @Test func `low reads Low, as the composer says it`() {
        #expect(Reasoning(rawValue: "low").title == "Low")
        #expect(Reasoning(rawValue: "xhigh").title == "Extra high")
    }
}

/// A read key's review card leaves Merge anyway's place empty; the composer says who can, once.
@Suite struct ReviewReadKeyTests {
    @Test func `a read key is a key limit, a dropped link is not`() {
        #expect(ActionBlock.readOnly.isKeyLimit)
        #expect(!ActionBlock.reconnecting(retryAt: nil).isKeyLimit)
    }
}

/// Home's host card offers no Retry while the link is already connecting.
@Suite struct HostCardRetryTests {
    @Test func `Retry only where it can start something`() {
        #expect(!ConnectionFact.offersRetry(EnvironmentStatus(transport: .connecting, nextRetryAt: 5, attempts: 2)))
        #expect(!ConnectionFact.offersRetry(EnvironmentStatus(transport: .unauthorized)))
        #expect(ConnectionFact.offersRetry(EnvironmentStatus(transport: .reconnecting)))
        #expect(ConnectionFact.offersRetry(EnvironmentStatus(transport: .offline)))
    }
}
