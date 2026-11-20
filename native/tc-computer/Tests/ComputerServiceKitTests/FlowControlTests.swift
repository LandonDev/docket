@testable import ComputerServiceKit
import Foundation
import Testing

// Every case of screen-relay 0.1.2's flow test (`flow-test.cpp`), with its numbers and, where they
// translate, its names (FlowControl.swift says what the port changed).
@Suite struct FlowControlTests {
    private typealias Flow = FlowControl

    @Test func creditFollowsTheOldestSentFrame() {
        var f = Flow()
        check(f.window == 1 && f.targetBitrate == 8_000_000)
        check(!f.ack(1, 1))
        check(!f.enqueue(2, 1, 10, 10))
        check(!f.enqueue(1, 0, 10, 10))
        check(!f.enqueue(1, Flow.maxBytes + 1, 10, 10))
        check(f.enqueue(1, 100, 10, 10))
        check(!f.ack(1, 20)) // Encoded but unsent is never credit.
        check(f.sent(1, 20))
        check(!f.ack(2, 30))
        check(f.ack(1, 100_020))
        check(f.bytes == 0 && f.acknowledged == 1)
        check(!f.ack(1, 100_021))
        for seq in UInt32(2)..<10 { check(f.enqueue(seq, 100, 100_030, 100_030)) }
        check(f.enqueue(10, 100, 100_030, 100_030))
        check(f.sent(2, 100_040))
        check(!f.sent(4, 100_040))
        check(!f.ack(3, 100_050))
        check(f.frames.count == 9 && f.bytes == 900)
        check(!f.paused(100_030 + 100_010 + 100_000) && f.paused(100_030 + 100_010 + 200_000))
        check(!f.timedOut(3_100_029) && f.timedOut(3_100_030))
        check(f.ack(2, 400_000))
        check(!f.timedOut(3_100_029) && f.timedOut(3_100_030)) // Trickle ACKs cannot retain an old tail.
    }

    @Test func frameIntervals() {
        var sixty = Flow(), oneTwenty = Flow()
        oneTwenty.configure(1_000_000, 8_000_000, 40_000_000, fps: 120)
        check(sixty.frameIntervalUs() == 16_667 && oneTwenty.frameIntervalUs() == 8_334)
        check(sixty.enqueue(1, 100, 1, 1) && sixty.sent(1, 1) && sixty.ack(1, 45_001))
        check(oneTwenty.enqueue(1, 100, 1, 1) && oneTwenty.sent(1, 1) && oneTwenty.ack(1, 45_001))
    }

    @Test func fallbackLimits() {
        for (fps, limit) in [(10, UInt32(30)), (30, 90), (60, 180), (120, 360)] {
            var fallbackLimit = Flow()
            fallbackLimit.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            check(fallbackLimit.window == 1)
            check(fallbackLimit.enqueue(1, 1_000, 1, 1) && fallbackLimit.sent(1, 1))
            check(fallbackLimit.ack(1, 1_000_001))
            for seq in UInt32(2)...(limit + 1) {
                check(fallbackLimit.enqueue(seq, 1_000, 1_000_002, 1_000_002))
            }
            check(!fallbackLimit.enqueue(limit + 2, 1_000, 1_000_002, 1_000_002))
            check(fallbackLimit.frameBitrate() == fallbackLimit.targetBitrate)
            check(fallbackLimit.sent(2, 1_000_003) && fallbackLimit.ack(2, 1_000_004))
            check(fallbackLimit.enqueue(limit + 2, 1_000, 1_000_005, 1_000_005))
        }
    }

    @Test func cap() {
        var cap = Flow()
        check(cap.enqueue(1, Flow.maxBytes, 1, 1))
        check(cap.paused(1))
        check(!cap.enqueue(2, 1, 1, 1))
        check(cap.sent(1, 2) && cap.ack(1, 3))
        check(cap.bytes == 0 && cap.enqueue(2, 1, 4, 4))
    }

    @Test func congested() {
        var congested = Flow()
        check(congested.enqueue(1, 100_000, 1, 1))
        check(congested.enqueue(2, 100_000, 1, 1))
        congested.update(500_001)
        check(congested.targetBitrate == 6_000_000)
        congested.update(500_002)
        check(congested.targetBitrate == 6_000_000) // Downshift hysteresis.
        var now: UInt64 = 1_000_001
        while now < 10_000_000 { congested.update(now); now += 500_000 }
        check(congested.targetBitrate == 1_000_000)
    }

    @Test func smallAndIdle() {
        var small = Flow()
        check(small.enqueue(1, 100, 1, 1) && small.enqueue(2, 100, 1, 1))
        small.update(1_000_000)
        check(small.targetBitrate == 8_000_000) // Tiny updates are not a bandwidth estimate.

        var idle = Flow()
        idle.update(900_000_000)
        check(idle.targetBitrate == 8_000_000)
        for seq in UInt32(1)...20 {
            let now = UInt64(seq) * 1_000_000
            check(idle.enqueue(seq, 200, now, now))
            check(idle.sent(seq, now))
            check(idle.ack(seq, now + 10_000))
        }
        check(idle.targetBitrate == 8_000_000)
    }

    @Test func recovery() {
        var recovery = Flow()
        for seq in UInt32(1)...180 {
            let now = UInt64(seq) * 16_667
            check(recovery.enqueue(seq, 20_000, now, now))
            check(recovery.sent(seq, now))
            check(recovery.ack(seq, now + 5_000))
        }
        check(recovery.targetBitrate > 8_000_000 && recovery.targetBitrate <= 10_648_000)
    }

    /// ACKs arrive after 55ms while capture continues, matching an uncongested 50ms path.
    private func demand(_ flow: inout Flow, _ count: UInt32, _ size: Int, _ spacing: UInt64) {
        var pending: [(UInt32, UInt64)] = []
        for seq in UInt32(1)...count {
            let now = UInt64(seq) * spacing
            while let first = pending.first, first.1 <= now {
                check(flow.ack(first.0, first.1))
                pending.removeFirst()
            }
            check(flow.enqueue(seq, size, now, now) && flow.sent(seq, now))
            pending.append((seq, now + 55_000))
        }
        for ack in pending { check(flow.ack(ack.0, ack.1)) }
    }

    @Test func demandProbesAndBacksOff() {
        var cappedQuality = Flow()
        cappedQuality.targetBitrate = 8_800_000
        demand(&cappedQuality, 180, 18_000, 33_333) // 4.32 Mbit/s is below 60% of the cap.
        check(cappedQuality.targetBitrate > 8_800_000)

        var bounded = Flow()
        demand(&bounded, 1_800, 18_000, 33_333)
        check(bounded.targetBitrate == 40_000_000)
        check(bounded.enqueue(1_801, 1_000_000, 61_000_000, 61_000_000))
        check(bounded.enqueue(1_802, 1_000_000, 61_000_000, 61_000_000))
        bounded.update(61_500_000)
        check(bounded.targetBitrate < 40_000_000) // Probing cannot disable congestion backoff.

        var tinyContinuous = Flow()
        demand(&tinyContinuous, 180, 200, 33_333)
        check(tinyContinuous.targetBitrate == 8_000_000)
        var discontinuous = Flow()
        demand(&discontinuous, 60, 100_000, 100_000)
        check(discontinuous.targetBitrate == 8_000_000)

        for target in [UInt64(8_000_000), 17_118_698] {
            var queued = Flow()
            queued.targetBitrate = target
            check(queued.enqueue(1, 100_000, 1, 1) && queued.sent(1, 1))
            check(queued.ack(1, 5_001))
            check(queued.enqueue(2, 90_000, 5_002, 5_002))
            check(queued.enqueue(3, 90_000, 5_002, 5_002))
            queued.update(550_002)
            check(queued.targetBitrate < target)
        }

        var slow = Flow()
        slow.configure(1_000_000, 8_000_000, 40_000_000, fps: 10)
        demand(&slow, 100, 18_000, 100_000)
        check(slow.targetBitrate > 8_000_000)
    }

    @Test func timer() {
        var timer = Flow()
        let idleDeadline = timer.serviceDeadlineUs(1, 0)
        check(idleDeadline == 100_001)
        check(timer.enqueue(1, 1_000, 2, 2))
        let activeDeadline = timer.serviceDeadlineUs(2, idleDeadline)
        check(activeDeadline == 10_002)
        check(timer.serviceDeadlineUs(10_001, activeDeadline) == activeDeadline)
        let rearmedDeadline = timer.serviceDeadlineUs(activeDeadline, 0)
        check(rearmedDeadline == 20_002)
        check(timer.sent(1, 10_003) && timer.ack(1, 10_004))
        check(timer.serviceDeadlineUs(10_005, rearmedDeadline) == rearmedDeadline)
        check(timer.serviceDeadlineUs(rearmedDeadline, 0) == 120_002)
    }

    private static var sample: Flow.TransportSample {
        var sample = Flow.TransportSample()
        sample.minRttUs = 45_000; sample.rttUs = 50_000
        sample.deliveryRateBps = 10_000_000; sample.bytesAcked = 10_000
        sample.sndCwnd = 20
        return sample
    }

    @Test func capacity() {
        for fps in [10, 30, 60, 120] {
            var capacity = Flow()
            capacity.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            var capacitySample = Self.sample
            capacitySample.minRttUs = 2_000_000
            capacity.sampleTransport(capacitySample, 1)
            let limit = 3 * fps
            check(capacity.frameLimit() == limit && capacity.window == limit)
            check(capacity.admissionAgeUs() == Flow.timeoutUs)
            for seq in UInt32(1)...UInt32(limit) {
                check(!capacity.paused(1))
                check(capacity.enqueue(seq, 1, 1, 1) && capacity.sent(seq, 1))
            }
            check(capacity.paused(1) && !capacity.enqueue(UInt32(limit) + 1, 1, 1, 1))
            check(capacity.ack(1, 1_000_001) && capacity.window == limit)
            check(!capacity.paused(1_000_001) && capacity.enqueue(UInt32(limit) + 1, 1, 1_000_001, 1_000_001))
            check(!capacity.timedOut(3_000_000) && capacity.timedOut(3_000_001))
        }
    }

    @Test func budget() {
        for fps in [10, 60, 120] {
            var budget = Flow()
            budget.configure(4_000_000, 8_000_000, 40_000_000, fps: fps)
            var budgetSample = Self.sample
            budgetSample.deliveryRateBps = 8_000_000
            budget.sampleTransport(budgetSample, 1)
            let interval = budget.frameIntervalUs()
            check(!budget.paused(1) && budget.frameBitrate() == 8_000_000)
            budgetSample.notsentBytes = interval - 1
            budget.sampleTransport(budgetSample, 1)
            check(budget.senderQueueUs() == interval - 1)
            check(!budget.paused(1) && budget.frameBitrate() == 8_000_000)
            budgetSample.notsentBytes = interval
            budget.sampleTransport(budgetSample, 1)
            check(!budget.paused(1) && budget.frameBitrate() == 8_000_000)
            budgetSample.notsentBytes = 2 * interval
            budget.sampleTransport(budgetSample, 1)
            check(!budget.paused(1) && budget.frameBitrate() == 5_000_000)
            check(budget.enqueue(1, 1, 1, 1) && budget.sent(1, 1))
            budgetSample.notsentBytes = 3 * interval - 1
            budget.sampleTransport(budgetSample, 1)
            check(!budget.paused(1) && budget.frameBitrate() > 2_000_000 && budget.frameBitrate() < 5_000_000)
            budgetSample.notsentBytes = 3 * interval
            budget.sampleTransport(budgetSample, 1)
            check(budget.paused(1) && budget.frameBitrate() == 2_000_000)
            check(budget.frameBitrate() < budget.minBitrate && budget.targetBitrate == 8_000_000)
            budgetSample.notsentBytes = 3 * interval + 1
            budget.sampleTransport(budgetSample, 1)
            check(budget.paused(1) && budget.frameBitrate() == 2_000_000)
            budgetSample.notsentBytes = 0
            budget.sampleTransport(budgetSample, 1)
            check(!budget.paused(1) && budget.frameBitrate() == 8_000_000)
        }
    }

    @Test func estimator() {
        var estimator = Flow()
        estimator.sampleTransport(Self.sample, 0)
        var lower = Self.sample
        lower.deliveryRateBps = 6_000_000; lower.bytesAcked += 10_000
        estimator.sampleTransport(lower, 500_000)
        check(estimator.deliveryRateBps == 10_000_000)
        lower.bytesAcked += 10_000
        estimator.sampleTransport(lower, 999_999)
        check(estimator.deliveryRateBps == 10_000_000)
        estimator.update(1_000_000)
        check(estimator.deliveryRateBps == 6_000_000)
        lower.deliveryRateBps = 20_000_000
        estimator.sampleTransport(lower, 1_200_000)
        check(estimator.deliveryRateBps == 6_000_000)
        estimator.sampleTransport(lower, 1_999_999)
        check(estimator.deliveryRateBps == 0)
    }

    @Test func limited() {
        var limited = Flow()
        var appLimited = Self.sample
        appLimited.appLimited = true; appLimited.deliveryRateBps = 1_000_000
        limited.sampleTransport(appLimited, 1)
        appLimited.bytesAcked += 10_000
        limited.sampleTransport(appLimited, 500_001)
        check(limited.deliveryRateBps == 0 && limited.targetBitrate > 8_000_000)
        var eligible = Self.sample
        eligible.deliveryRateBps = 6_000_000; eligible.bytesAcked = 30_000
        limited.sampleTransport(eligible, 500_002)
        let limitedTarget = limited.targetBitrate
        appLimited.deliveryRateBps = 100_000_000
        appLimited.bytesAcked = 40_000
        limited.sampleTransport(appLimited, 750_002)
        limited.update(800_002)
        check(limited.deliveryRateBps == 6_000_000 && limited.targetBitrate >= limitedTarget)
        let cachedTarget = limited.targetBitrate
        appLimited.bytesAcked += 10_000
        limited.sampleTransport(appLimited, 1_500_002)
        check(limited.deliveryRateBps == 0 && limited.targetBitrate >= cachedTarget)
    }

    @Test func probing() {
        for appLimitedSample in [true, false] {
            var probing = Flow(), sparseProbing = Flow()
            var headroom = Self.sample
            headroom.appLimited = appLimitedSample
            headroom.deliveryRateBps = appLimitedSample ? 1_000_000 : 0
            probing.sampleTransport(headroom, 1)
            sparseProbing.sampleTransport(headroom, 1)
            var elapsed: UInt64 = 100_000
            while elapsed <= 8_000_000 {
                let previous = probing.targetBitrate
                headroom.bytesAcked += 10_000
                probing.sampleTransport(headroom, elapsed + 1)
                probing.update(elapsed + 1)
                check(probing.targetBitrate >= previous && probing.targetBitrate <= probing.maxBitrate)
                if elapsed % 500_000 == 0 {
                    sparseProbing.sampleTransport(headroom, elapsed + 1)
                    check(abs(Double(probing.targetBitrate) - Double(sparseProbing.targetBitrate)) < 100)
                }
                if elapsed == 1_000_000 { check(abs(Double(probing.targetBitrate) - 10_000_000.0) < 100) }
                elapsed += 100_000
            }
            check(probing.targetBitrate == probing.maxBitrate)

            for queuedUs in [(probing.frameIntervalUs() + 1) / 2, probing.frameIntervalUs() + 1] {
                var building = Flow()
                headroom.notsentBytes = queuedUs
                building.sampleTransport(headroom, 1)
                check(building.senderQueueUs() == queuedUs)
                building.update(1_000_001)
                check(building.targetBitrate == 8_000_000)
            }

            var stale = Flow()
            headroom.notsentBytes = 0
            stale.sampleTransport(headroom, 1)
            check(stale.enqueue(1, 1_000, 1, 1) && stale.sent(1, 1))
            check(stale.senderQueueUs() == 0)
            stale.update(1 + stale.admissionAgeUs())
            stale.update(1_000_001)
            check(stale.targetBitrate == 8_000_000)
        }
    }

    @Test func smoothedAndClamped() {
        var smoothed = Flow(), frequent = Flow()
        var fast = Self.sample
        fast.deliveryRateBps = 20_000_000
        smoothed.sampleTransport(fast, 0)
        frequent.sampleTransport(fast, 0)
        check(smoothed.targetBitrate == 8_000_000)
        smoothed.update(500_000)
        var now: UInt64 = 10_000
        while now <= 500_000 { frequent.update(now); now += 10_000 }
        check(smoothed.targetBitrate > 13_600_000 && smoothed.targetBitrate < 13_800_000)
        check(abs(Double(smoothed.targetBitrate) - Double(frequent.targetBitrate)) < 100)
        check(smoothed.notsentLowat() > 56_000 && smoothed.notsentLowat() < 58_000)

        var lowBudget = Flow()
        lowBudget.configure(1_000_000, 1_000_000, 40_000_000)
        check(lowBudget.notsentLowat() == 16_384)

        var clamped = Flow()
        clamped.configure(4_000_000, 8_000_000, 12_000_000)
        fast.deliveryRateBps = 100_000_000
        clamped.sampleTransport(fast, 0)
        now = 500_000
        while now <= 10_000_000 {
            fast.bytesAcked += 10_000
            clamped.sampleTransport(fast, now)
            check(clamped.targetBitrate >= 8_000_000 && clamped.targetBitrate <= 12_000_000)
            now += 500_000
        }
        check(clamped.targetBitrate >= 11_999_000)
        fast.deliveryRateBps = 1_000_000
        now = 10_500_000
        while now <= 22_000_000 {
            fast.bytesAcked += 10_000
            clamped.sampleTransport(fast, now)
            check(clamped.targetBitrate >= 4_000_000 && clamped.targetBitrate <= 12_000_000)
            now += 500_000
        }
        check(clamped.targetBitrate <= 4_001_000 && clamped.notsentLowat() == 16_667)
    }

    @Test func queuedAndStartup() {
        var queued = Flow()
        queued.sampleTransport(Self.sample, 1)
        check(queued.enqueue(1, 20_000, 1, 1))
        check(queued.senderQueueUs() == 16_000 && !queued.paused(1))
        check(queued.enqueue(2, 1_000, 1, 1))
        check(queued.senderQueueUs() == 16_800 && !queued.paused(1))
        check(queued.frameBitrate() < queued.targetBitrate)
        check(queued.sent(1, 2))
        check(queued.senderQueueUs() == 800 && !queued.paused(2))
        var buffered = Self.sample
        buffered.notsentBytes = 10_000; buffered.applicationQueuedBytes = 10_000
        queued.sampleTransport(buffered, 3)
        check(queued.senderQueueUs() == 16_800 && !queued.paused(3))
        check(queued.frameBitrate() < queued.targetBitrate)
        check(queued.sent(2, 4))
        check(queued.senderQueueUs() == 16_000 && !queued.paused(4))
        queued.sampleTransport(Self.sample, 5)
        check(queued.bytes == 21_000 && queued.senderQueueUs() == 0 && !queued.paused(5))

        var startup = Flow()
        var zeroRate = Self.sample
        zeroRate.deliveryRateBps = 0
        startup.sampleTransport(zeroRate, 1)
        check(startup.enqueue(1, 17_000, 1, 1))
        check(startup.targetBitrate == 8_000_000 && startup.deliveryRateBps == 0)
        check(startup.senderQueueUs() == 17_000 && !startup.paused(1))
        check(startup.frameBitrate() < startup.targetBitrate)
        check(startup.sent(1, 2))
        check(startup.senderQueueUs() == 0 && !startup.paused(2))
    }

    @Test func lossyAndFrameRates() {
        var lossy = Flow()
        var highRtt = Self.sample
        highRtt.minRttUs = 200_000; highRtt.rttUs = 600_000
        highRtt.totalRetrans = 12
        lossy.sampleTransport(highRtt, 1)
        let lossyWindow = lossy.window
        for seq in UInt32(1)...12 {
            check(lossy.enqueue(seq, 100_000, 1, 1) && lossy.sent(seq, 1))
        }
        lossy.update(300_001)
        check(lossy.window > 8 && lossy.window == lossyWindow && !lossy.paused(300_001))
        check(lossy.targetBitrate >= 8_000_000)
        highRtt.totalRetrans += 10; highRtt.rttUs = 1_000_000
        lossy.sampleTransport(highRtt, 300_002)
        check(lossy.window == lossyWindow && lossy.targetBitrate >= 8_000_000)
        check(lossy.ack(1, 300_003))
        check(lossy.ackRttUs > 300_000 && lossy.window == lossyWindow && !lossy.paused(300_003))
        check(!lossy.paused(1 + lossy.admissionAgeUs() - 1))
        check(lossy.paused(1 + lossy.admissionAgeUs()))

        var lowFps = Flow()
        lowFps.configure(1_000_000, 8_000_000, 40_000_000, fps: 10)
        lowFps.sampleTransport(highRtt, 1)
        check(lowFps.admissionAgeUs() == 600_000 && lowFps.window == 6)
        check(lossy.admissionAgeUs() == 433_334 && lossy.window == 26)
        var highFps = Flow()
        highFps.configure(1_000_000, 8_000_000, 40_000_000, fps: 120)
        highFps.sampleTransport(Self.sample, 1)
        check(highFps.admissionAgeUs() == 106_668 && highFps.window == 13)
        check(highFps.notsentLowat() == 16_667)
        check(highFps.enqueue(1, 1, 1, 1) && highFps.sent(1, 1))
        check(highFps.ack(1, 500_001) && highFps.window == 13)
        highFps.clearTransport()
        check(highFps.frameBitrate() == highFps.targetBitrate)
        var distant = Self.sample
        distant.minRttUs = 2_000_000
        lowFps.sampleTransport(distant, 2)
        check(lowFps.admissionAgeUs() == Flow.timeoutUs && lowFps.window == 30)
        for seq in UInt32(1)...30 { check(lowFps.enqueue(seq, 1, 2, 2)) }
        check(!lowFps.enqueue(31, 1, 2, 2) && lowFps.paused(2))
    }

    @Test func fallback() {
        var fallback = Flow()
        fallback.configure(1_000_000, 8_000_000, 40_000_000, fps: 10)
        fallback.sampleTransport(Self.sample, 1)
        check(fallback.enqueue(1, 100_000, 1, 1) && fallback.sent(1, 1))
        check(fallback.ack(1, 100_001))
        let fallbackTarget = fallback.targetBitrate
        fallback.clearTransport()
        check(!fallback.transportAvailable && fallback.deliveryRateBps == 0)
        check(fallback.frameBitrate() == fallback.targetBitrate)
        check(fallback.enqueue(2, 100_000, 100_002, 100_002))
        check(fallback.enqueue(3, 100_000, 100_002, 100_002))
        check(!fallback.paused(500_001) && fallback.paused(500_002))
        fallback.update(600_002)
        check(fallback.targetBitrate < fallbackTarget && fallback.targetBitrate >= fallback.minBitrate)
        fallback.clearTransport()
        check(fallback.frames.count == 2 && fallback.targetBitrate < fallbackTarget)
    }

    @Test func kernelCapAndSession() {
        var kernelCap = Flow()
        kernelCap.sampleTransport(Self.sample, 1)
        check(kernelCap.enqueue(1, Flow.maxBytes, 1, 1))
        check(kernelCap.paused(1) && !kernelCap.enqueue(2, 1, 1, 1))
        check(kernelCap.sent(1, 2) && kernelCap.ack(1, 3))
        check(kernelCap.enqueue(2, 1, 4, 4) && kernelCap.sent(2, 4))
        kernelCap.sampleTransport(Self.sample, 3_000_003)
        check(!kernelCap.timedOut(3_000_003) && kernelCap.timedOut(3_000_004))

        var session = Flow()
        session.configure(2_000_000, 9_000_000, 30_000_000, fps: 10)
        session.sampleTransport(Self.sample, 1)
        check(session.enqueue(1, 1_000, 1, 1) && session.sent(1, 2))
        session.reset()
        check(!session.transportAvailable && session.deliveryRateBps == 0)
        check(session.transport.minRttUs == 0 && session.transport.bytesAcked == 0)
        check(session.frames.isEmpty && session.bytes == 0 && session.window == 1)
        check(session.frameRate == 10 && session.targetBitrate == 9_000_000)
        check(session.minBitrate == 2_000_000 && session.maxBitrate == 30_000_000)
        check(!session.timedOut(9_000_000) && session.enqueue(1, 1_000, 9_000_001, 9_000_001))
    }

    private struct PathRun { var skipped = 0, pausedTicks = 0; var worstAge: UInt64 = 0, minBitrate = UInt64.max, bitrateAtStall: UInt64 = 0 }

    private func simulate(_ flow: inout Flow, _ fps: Int, _ rtt: UInt64, _ refresh: UInt64, _ serviceGap: UInt64,
                          _ seconds: UInt64, _ warmupUs: UInt64, _ burst: UInt64 = 0, _ stallAt: UInt64 = 0,
                          _ stallUs: UInt64 = 0, _ viewerWait: UInt64 = 0, _ lifetimeWait: Bool = false) -> PathRun {
        var run = PathRun()
        var pending: [(UInt32, UInt64, UInt64)] = []
        var lastAck: UInt64 = 0, rng: UInt64 = 12_345
        var seq: UInt32 = 0, waitFrom = UInt32.max
        let interval = 1_000_000 / UInt64(fps)
        var now: UInt64 = 0
        while now < seconds * 1_000_000 {
            defer { now += interval }
            while let first = pending.first, first.1 <= now {
                let (acked, at, captured) = first
                let wait = lifetimeWait ? at - captured : acked >= waitFrom ? viewerWait : 0
                check(flow.ack(acked, at, wait))
                pending.removeFirst()
            }
            flow.update(now)
            run.worstAge = max(run.worstAge, flow.oldestAge(now))
            if stallUs != 0 && now >= stallAt && run.bitrateAtStall == 0 { run.bitrateAtStall = flow.targetBitrate }
            if run.bitrateAtStall != 0 { run.minBitrate = min(run.minBitrate, flow.targetBitrate) }
            let admitted = !flow.paused(now) && flow.frames.count < flow.window
            if !admitted {
                if now >= warmupUs { run.skipped += 1; run.pausedTicks += flow.paused(now) ? 1 : 0 }
                continue
            }
            seq += 1
            check(flow.enqueue(seq, Int(flow.targetBitrate / 8 / UInt64(fps)), now, now) && flow.sent(seq, now))
            if now >= 2_000_000 && waitFrom == UInt32.max { waitFrom = seq }
            rng = rng &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            var at = now + rtt + (waitFrom != UInt32.max ? viewerWait : 0) + (rng >> 33) % (refresh + 1)
            if burst != 0 { at = (at + burst - 1) / burst * burst }
            if stallUs != 0 && at >= stallAt && at < stallAt + stallUs { at = stallAt + stallUs }
            if serviceGap != 0 { at = max(at, lastAck + serviceGap) }
            at = max(at, lastAck)
            lastAck = at
            pending.append((seq, at, now))
        }
        return run
    }

    @Test func cleanPaths() {
        for fps in [60, 120] {
            for rtt in [UInt64(100_000), 150_000, 300_000] {
                var clean = Flow()
                clean.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
                let run = simulate(&clean, fps, rtt, 16_667, 0, 12, 2_000_000)
                check(run.skipped == 0)
                check(clean.targetBitrate > 16_000_000)
            }
        }
    }

    @Test func burstyPaths() {
        for fps in [60, 120] {
            var bursty = Flow()
            bursty.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            let interval = 1_000_000 / UInt64(fps)
            let run = simulate(&bursty, fps, 100_000, 0, 0, 20, 2_000_000, 5 * interval)
            check(run.worstAge >= 100_000 + 3 * interval)
            check(run.skipped == 0 && run.pausedTicks == 0)
            check(bursty.targetBitrate > 16_000_000)
        }
    }

    @Test func hiccup() {
        for fps in [60, 120] {
            var hiccup = Flow()
            hiccup.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            let run = simulate(&hiccup, fps, 100_000, 16_667, 0, 30, 0, 0, 10_000_000, 300_000)
            check(run.minBitrate > 4_000_000)
            check(hiccup.targetBitrate >= run.bitrateAtStall)
        }
    }

    @Test func viewerWaits() {
        for fps in [60, 120] {
            var waiting = Flow()
            waiting.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            let run = simulate(&waiting, fps, 100_000, 0, 0, 9, 2_000_000, 0, 0, 0, 80_000)
            check(run.pausedTicks == 0 && run.skipped <= fps / 10)
            check(waiting.targetBitrate > 12_000_000)
        }

        for fps in [60, 120] {
            var shortHold = Flow()
            shortHold.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            check(simulate(&shortHold, fps, 20_000, 0, 0, 12, 2_000_000, 0, 0, 0, 80_000).skipped <= fps / 10)
        }
    }

    @Test func lanPaths() {
        for fps in [60, 120] {
            for base in [UInt64(5_000), 20_000] {
                let interval = 1_000_000 / UInt64(fps)
                for jitter in [interval, 2 * interval] {
                    var lan = Flow()
                    lan.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
                    let run = simulate(&lan, fps, base, jitter, 0, 12, 2_000_000)
                    check(run.skipped == 0 && run.pausedTicks == 0)
                    check(lan.targetBitrate >= 8_000_000)
                }
            }
        }
    }

    @Test func stalled() {
        for fps in [60, 120] {
            var stalled = Flow()
            stalled.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            let run = simulate(&stalled, fps, 100_000, 16_667, 0, 15, 0, 0, 5_000_000, 1_500_000)
            check(run.pausedTicks > 0 && run.worstAge >= 1_500_000 && run.worstAge < Flow.timeoutUs)
            check(!stalled.paused(15_000_000) && stalled.acknowledged > 10 * UInt64(fps))
        }
    }

    @Test func hiddenAndByteBudget() {
        var hidden = Flow()
        let hiddenRun = simulate(&hidden, 60, 100_000, 16_667, 40_000, 20, 0, 0, 0, 0, 0, true)
        check(hiddenRun.pausedTicks > 0)
        check(hiddenRun.worstAge < 900_000)

        var budget = Flow()
        for seq in UInt32(1)...4 { check(!budget.paused(1) && budget.enqueue(seq, 1_536 * 1_024, 1, 1)) }
        check(!budget.paused(1) && budget.enqueue(5, 1_536 * 1_024, 1, 1) && budget.paused(1))
    }

    @Test func untrustedWait() {
        var untrusted = Flow()
        check(untrusted.enqueue(1, 100, 1, 1) && untrusted.sent(1, 1))
        check(untrusted.ack(1, 100_001, 4_294_967_295))
        check(untrusted.networkBaseDepthUs() == 100_000 && untrusted.baseDepthUs() == 100_000)
        check(untrusted.enqueue(2, 100, 100_002, 100_002) && untrusted.sent(2, 100_002))
        check(untrusted.ack(2, 200_002, 100_000))
        check(untrusted.networkBaseDepthUs() == 0 && untrusted.baseDepthUs() == 100_000)
        let four: [UInt8] = [0, 0, 0x27, 0x10]
        check(Flow.ackWaitUs(four) == 10_000 && Flow.ackWaitUs([]) == 0 && Flow.ackWaitUs(Array(four.prefix(3))) == 0)
        check(Flow.ackWaitUs([0xFF, 0xFF, 0xFF, 0xFF]) == 4_294_967_295)
    }

    @Test func growing() {
        var growing = Flow()
        let grown = simulate(&growing, 60, 100_000, 16_667, 40_000, 20, 0)
        check(grown.pausedTicks > 0 && growing.targetBitrate < 8_000_000)
        check(grown.worstAge < 850_000)
    }

    @Test func direct() {
        for fps in [60, 120] {
            var direct = Flow()
            direct.configure(1_000_000, 8_000_000, 40_000_000, fps: fps)
            var link = Flow.TransportSample()
            link.minRttUs = 2_000; link.rttUs = 2_000; link.deliveryRateBps = 40_000_000; link.sndCwnd = 20
            let interval = direct.frameIntervalUs(), hold: UInt64 = 60_000
            var now: UInt64 = 1, blocked = 0
            var captured: UInt32 = 0, acked: UInt32 = 0
            var shownAt: [UInt64] = []
            for _ in 0..<(3_000_000 / 1_000) {
                defer { now += 1_000 }
                link.bytesAcked += 5_000
                direct.sampleTransport(link, now)
                while let first = shownAt.first, first <= now {
                    acked += 1
                    check(direct.ack(acked, now, hold))
                    shownAt.removeFirst()
                }
                if now >= UInt64(captured) * interval + 1 {
                    if direct.paused(now) || shownAt.count >= direct.window { if now > 1_000_000 { blocked += 1 }; continue }
                    captured += 1
                    check(direct.enqueue(captured, 5_000, now, now) && direct.sent(captured, now))
                    shownAt.append(now + 2_000 + hold)
                }
            }
            check(blocked == 0 && captured >= 3 * UInt32(fps) - 2)
        }
    }
}

/// `#expect` for a condition that calls a mutating method, which the macro cannot take.
private func check(_ condition: Bool, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(condition, sourceLocation: sourceLocation)
}
