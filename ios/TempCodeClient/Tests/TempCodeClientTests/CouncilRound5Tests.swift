import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The council's round 5 on the phone (surface 12).
@Suite struct RulesStepLineTests {
    @Test func `the line under a step is left out when it says the name again`() {
        let release = BatchStepSpec(id: "release", name: "Release", kind: .release, run: nil)
        #expect(RulesEdit.stepLine(release, under: "Release") == nil)
        #expect(RulesEdit.stepLine(release, under: " release ") == nil, "case and the ends' spaces aside, as the desktop's sameWords")
        #expect(RulesEdit.stepLine(release, under: "Ship it") == "Release")
        let gate = BatchStepSpec(id: "gate", name: "Gate", kind: .gate, run: nil)
        #expect(RulesEdit.stepLine(gate, under: "Gate") == "Gate the merged tree")
        let smoke = BatchStepSpec(id: "shell", name: "Smoke test", kind: .shell, run: "./smoke.sh")
        #expect(RulesEdit.stepLine(smoke, under: "Smoke test") == "./smoke.sh")
    }
}

@Suite struct ComposerFieldLineTests {
    @Test func `the field keeps the prose line box at the usual sizes and the font's own line at the accessibility sizes`() {
        #expect(ComposerHeight.fieldLineBox(accessibilityText: false))
        #expect(!ComposerHeight.fieldLineBox(accessibilityText: true))
        // Where the font's line is drawn, the field is the one that scrolls past two lines.
        #expect(ComposerHeight.maxLines(accessibilityText: true) == 2)
    }
}
