@testable import ComputerServiceKit
import Foundation
import Testing

@Suite struct FramePacerTests {
    /// The frames `hz` a second for `seconds`, each moved by `jitter(i)` µs, and the ones the pacer kept.
    private func run(fps: Int, hz: Double, seconds: Double = 10, jitter: (Int) -> Double = { _ in 0 }) -> (offered: [UInt64], kept: [UInt64]) {
        var pacer = FramePacer(fps: fps)
        let count = Int(hz * seconds)
        let offered = (0..<count).map { UInt64(max(0, 1_000_000 + Double($0) * 1_000_000 / hz + jitter($0)).rounded()) }
        return (offered, offered.filter { pacer.take($0) })
    }

    /// The most frames in any second.
    private func busiestSecond(_ kept: [UInt64]) -> Int {
        var most = 0, from = 0
        for (i, at) in kept.enumerated() {
            while kept[from] + 1_000_000 <= at { from += 1 }
            most = max(most, i - from + 1)
        }
        return most
    }

    @Test func aHundredFortyFourComeAndAnEvenHundredTwentyGo() {
        let (offered, kept) = run(fps: 120, hz: 144)
        check(abs(kept.count - 1_200) <= 1)
        check(busiestSecond(kept) <= 120)
        // even: five of every six, never two dropped in a row
        let input = 1_000_000 / 144.0
        let gaps = zip(kept.dropFirst(), kept).map { Double($0 - $1) }
        check(gaps.allSatisfy { $0 < 2 * input + 2 })
        check(gaps.filter { $0 > 1.5 * input }.count <= offered.count / 6 + 1)
    }

    @Test func everyFrameAtTheAskedRateOrBelowIsKept() {
        check(run(fps: 120, hz: 120).kept.count == 1_200)
        check(run(fps: 120, hz: 60).kept.count == 600)
        check(run(fps: 60, hz: 60).kept.count == 600)
        // a millisecond's jitter either way changes nothing
        let jittery = run(fps: 120, hz: 120, jitter: { $0 % 2 == 0 ? 1_000 : -1_000 })
        check(jittery.kept.count == jittery.offered.count)
    }

    @Test func neverMoreThanTheRateInAnySecond() {
        var seed: UInt64 = 7
        let random = { (_: Int) -> Double in
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(seed >> 40) / Double(1 << 24) * 3_000 - 1_500
        }
        for (fps, hz) in [(120, 240.0), (120, 165), (60, 144), (30, 120), (10, 60)] {
            let kept = run(fps: fps, hz: hz, jitter: random).kept.sorted()
            check(busiestSecond(kept) <= fps)
            check(kept.count >= fps * 9)
        }
    }
}

@Suite struct StillWindowTests {
    @Test func aStillPictureIsSentAgainFourTimesThenNothing() {
        var still = StillWindow(fps: 120)
        check(!still.due(atUs: 1_000_000)) // nothing yet to send again
        still.picture(atUs: 1_000_000)
        check(!still.due(atUs: 1_149_999))
        var asks: [UInt64] = []
        for at in stride(from: UInt64(1_150_000), to: 2_000_000, by: 1_000) where still.due(atUs: at) {
            asks.append(at)
            still.repeated()
        }
        check(asks.count == 4)
        check(asks.first == 1_150_000)
        check(zip(asks.dropFirst(), asks).allSatisfy { $0 - $1 >= 8_333 })
        check(!still.due(atUs: 9_000_000))
        // the window changed: the rule starts again from the new picture
        still.picture(atUs: 9_000_000)
        check(!still.due(atUs: 9_100_000))
        check(still.due(atUs: 9_150_000))
    }

    @Test func aRepeatTheFlowRefusedIsAskedAgain() {
        var still = StillWindow(fps: 60)
        still.picture(atUs: 0)
        check(still.due(atUs: 150_000))
        check(!still.due(atUs: 151_000)) // one interval between asks
        check(still.due(atUs: 166_667))
        for _ in 0..<4 { still.repeated() }
        check(!still.due(atUs: 400_000))
    }

    @Test func aMovingWindowIsNeverRepeated() {
        var still = StillWindow(fps: 120)
        for at in stride(from: UInt64(0), to: 2_000_000, by: 8_333) {
            still.picture(atUs: at)
            check(!still.due(atUs: at + 4_000))
        }
    }
}

/// `#expect` for a condition that calls a mutating method, which the macro cannot take.
private func check(_ condition: Bool, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(condition, sourceLocation: sourceLocation)
}
