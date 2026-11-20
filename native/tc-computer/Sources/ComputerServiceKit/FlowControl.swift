// Ported from screen-relay 0.1.2 (github.com/vercel-labs/screen-relay, `src/engine/core/flow.hpp`),
// licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Changed here: C++ to Swift, names in Swift's case, the unsigned sums that may wrap in C++ written with
// the wrapping operators so they wrap the same way, and `Pressure` made comparable for its `>=`. The rules,
// the numbers and the TCP-statistics path are as they were; the service has no TCP statistics on its
// socket pair and runs the path without them. FlowControlTests.swift holds every case of its flow test.
import Foundation

/// One video stream's flow control (docs/computer-protocol.md §30): the window of frames sent and not
/// acked, the pause, the bitrate the acks and the viewer's wait move, and the timeout. Every time is
/// microseconds on the service's monotonic clock; the stream's queue owns the value.
public struct FlowControl: Sendable {
    public static let maxBytes = 8 * 1_024 * 1_024
    public static let pauseAgeUs: UInt64 = 250_000
    public static let timeoutUs: UInt64 = 3_000_000
    public static let maxFrames = Int(timeoutUs * 120 / 1_000_000)
    public static let baseWindowUs: UInt64 = 10_000_000
    public static let viewerHoldLimitUs: UInt64 = 100_000
    public enum Pressure: Int, Comparable, Sendable {
        case clear, building, congested, paused
        public static func < (a: Pressure, b: Pressure) -> Bool { a.rawValue < b.rawValue }
    }
    public static let deliveryWindowUs: UInt64 = 1_000_000
    public static let bitrateSmoothingUs: UInt64 = 500_000
    public static let sampleIntervalUs: UInt64 = 10_000
    public static let idleSampleIntervalUs: UInt64 = 100_000

    public struct TransportSample: Sendable {
        public var minRttUs: UInt64 = 0, rttUs: UInt64 = 0, deliveryRateBps: UInt64 = 0
        public var notsentBytes: UInt64 = 0, bytesAcked: UInt64 = 0, applicationQueuedBytes: UInt64 = 0
        public var sndCwnd: UInt32 = 0, totalRetrans: UInt32 = 0
        public var appLimited = false
        public init() {}
    }

    public struct DeliverySample: Sendable { var timeUs: UInt64, rateBps: UInt64 }

    /// Sliding-window extreme of timestamped values: keep a span, read the smallest (or largest) value over any shorter trailing window.
    public struct WindowExtreme: Sendable {
        struct Sample: Sendable { var timeUs: UInt64, value: UInt64 }
        var samples: [Sample] = []
        var smallest = true
        public internal(set) var forgottenUs: UInt64 = 0

        init(smallest: Bool = true) {
            self.smallest = smallest
        }

        mutating func push(_ now: UInt64, _ value: UInt64, _ spanUs: UInt64) {
            while let first = samples.first, now - min(now, first.timeUs) >= spanUs { samples.removeFirst() }
            while let last = samples.last, smallest ? last.value >= value : last.value <= value { samples.removeLast() }
            samples.append(Sample(timeUs: now, value: value))
        }

        var isEmpty: Bool { samples.isEmpty }

        func overall(_ none: UInt64) -> UInt64 { samples.first?.value ?? none }

        /// Makes later reads over a window ignore anything older than `windowUs` before `now`, even if a longer window is read later.
        mutating func forget(_ now: UInt64, _ windowUs: UInt64) { forgottenUs = max(forgottenUs, now - min(now, windowUs)) }

        func over(_ now: UInt64, _ windowUs: UInt64, _ none: UInt64, _ floorUs: UInt64 = 0) -> UInt64 {
            for sample in samples where sample.timeUs > max(forgottenUs, floorUs) && now - min(now, sample.timeUs) < windowUs {
                return sample.value
            }
            return none
        }
    }

    var depth = WindowExtreme(), network = WindowExtreme(), peak = WindowExtreme(smallest: false), held = WindowExtreme(smallest: false)
    /// Age of the oldest unacknowledged frame, sampled on service ticks; lets a stall be seen while no acknowledgements arrive.
    var waiting = WindowExtreme()
    public internal(set) var transport = TransportSample()
    public internal(set) var transportAvailable = false
    public internal(set) var deliveryRateBps: UInt64 = 0
    var lastTransportUpdateUs: UInt64 = 0
    var deliverySamples: [DeliverySample] = []
    public internal(set) var minBitrate: UInt64 = 1_000_000, initialBitrate: UInt64 = 8_000_000, maxBitrate: UInt64 = 40_000_000

    public struct Frame: Sendable {
        public var sequence: UInt32
        public var bytes: Int
        public var capturedUs: UInt64
        public var sent = false
        public var sentUs: UInt64 = 0
    }

    public internal(set) var frames: [Frame] = []
    public internal(set) var bytes = 0
    /// Largest frame this generation; capture pauses while the byte budget left could not hold one, since enqueue rejects a frame that does not fit and the server then closes the stream.
    public internal(set) var largestFrame = 0
    public internal(set) var lastEncoded: UInt32 = 0
    public internal(set) var acknowledged: UInt64 = 0, encoded: UInt64 = 0, lastProgressUs: UInt64 = 0
    public var targetBitrate: UInt64 = 8_000_000
    /// Smoothed send-to-acknowledgement time; reported by /metrics only.
    public internal(set) var ackRttUs: Double = 0
    public internal(set) var window = 1
    var sampleStartUs: UInt64 = 0, sampleBytes: UInt64 = 0, sampleAcks: UInt64 = 0, previousSentUs: UInt64 = 0
    var lastDecreaseUs: UInt64 = 0, lastIncreaseUs: UInt64 = 0
    /// Rate measured over the last busy sample; reported by /metrics, and caps a cut.
    public internal(set) var goodputBps: Double = 0
    public internal(set) var frameRate = 60

    public init() {}

    /// Applies the configured bitrate limits and starts at the configured initial rate.
    public mutating func configure(_ minimum: UInt64, _ initial: UInt64, _ maximum: UInt64, fps: Int = 60) {
        minBitrate = minimum; initialBitrate = initial; maxBitrate = maximum; targetBitrate = initial; frameRate = max(1, fps)
    }

    /// Restores the idle transport state while keeping the configured bitrate limits.
    public mutating func reset() {
        let minimum = minBitrate, initial = initialBitrate, maximum = maxBitrate
        let fps = frameRate
        self = FlowControl()
        configure(minimum, initial, maximum, fps: fps)
    }

    /// Reads the viewer wait from an acknowledgement payload: 4 bytes of big-endian microseconds, or zero when absent or malformed.
    public static func ackWaitUs(_ payload: [UInt8]) -> UInt64 {
        payload.count == 4 ? UInt64(payload[0]) << 24 | UInt64(payload[1]) << 16 | UInt64(payload[2]) << 8 | UInt64(payload[3]) : 0
    }

    public func oldestAge(_ now: UInt64) -> UInt64 {
        frames.first.map { now - min(now, $0.capturedUs) } ?? 0
    }

    public func frameIntervalUs() -> UInt64 { (1_000_000 + UInt64(frameRate) - 1) / UInt64(frameRate) }

    public func serviceDeadlineUs(_ now: UInt64, _ pending: UInt64) -> UInt64 {
        let next = now + (frames.isEmpty ? Self.idleSampleIntervalUs : Self.sampleIntervalUs)
        return pending != 0 ? min(pending, next) : next
    }

    /// Capture-to-acknowledgement time of an uncongested frame: the network base plus the viewer's wait, so a hold the viewer adds is not read as queue; zero when unmeasured. A queue that stands for the whole window becomes the new base because nothing drains it; the pause and the 3 s timeout bound that.
    public func baseDepthUs() -> UInt64 { networkBaseDepthUs() + viewerWaitUs() }
    /// Largest capture-to-acknowledgement time over the last 10 s; sizes the frame window.
    public func peakDepthUs() -> UInt64 { peak.overall(0) }
    /// Smallest network depth (capture-to-acknowledgement minus viewer wait) over the last 10 s; zero when unmeasured.
    public func networkBaseDepthUs() -> UInt64 { network.overall(0) }
    /// Span over which the smallest queueing delay is taken: one base round trip, at least two frame intervals.
    public func standingWindowUs() -> UInt64 { max(baseDepthUs(), 2 * frameIntervalUs()) }

    /// Standing queue at which capture stops: the base plus two frame intervals, or 250 ms before any acknowledgement. This mirrors the TCP-statistics rule of twice the round trip plus two frame intervals.
    public func pauseQueueUs() -> UInt64 {
        depth.isEmpty ? Self.pauseAgeUs : baseDepthUs() + 2 * frameIntervalUs()
    }

    /// Oldest-frame age at which capture pauses, as /metrics reports it. With TCP statistics it also gates admission; without, it is the base depth plus the pause queue.
    public func admissionAgeUs() -> UInt64 {
        transportAvailable ? transportAgeLimitUs() : baseDepthUs() + pauseQueueUs()
    }

    /// Longest wait a viewer reported for a frame in the last 10 s, up to the 100 ms a viewer may hold one. A longer wait is a viewer falling behind and must not widen the limits.
    public func viewerWaitUs() -> UInt64 { min(Self.viewerHoldLimitUs, held.overall(0)) }

    /// Oldest-frame age at which capture stops with TCP statistics: twice the minimum round trip plus two frame intervals plus the viewer's wait, capped at 3 s, or 250 ms before a round trip is known.
    public func transportAgeLimitUs() -> UInt64 {
        if transport.minRttUs == 0 { return Self.pauseAgeUs }
        return min(Self.timeoutUs, 2 * min(transport.minRttUs, Self.timeoutUs) + 2 * frameIntervalUs() + viewerWaitUs())
    }

    /// Queueing delay present for the whole recent window: the smallest oldest-frame age or acknowledgement time in it, above the given base.
    func standingAbove(_ now: UInt64, _ acknowledgedDepths: WindowExtreme, _ base: UInt64) -> UInt64 {
        if frames.isEmpty { return 0 }
        let window = standingWindowUs()
        let lowest = min(oldestAge(now), acknowledgedDepths.over(now, window, .max), waiting.over(now, window, .max, acknowledgedDepths.forgottenUs))
        return lowest > base ? lowest - base : 0
    }

    /// The total standing queue, viewer wait included.
    public func standingQueueUs(_ now: UInt64) -> UInt64 { standingAbove(now, depth, baseDepthUs()) }
    /// The part of the standing queue that is in the network, with the time frames wait inside the viewer taken out.
    public func standingNetworkQueueUs(_ now: UInt64) -> UInt64 { standingAbove(now, network, networkBaseDepthUs()) }

    /// Classifies a standing queue against the pause limit: clear below a quarter of it, building below half, congested below the limit, paused at it.
    public func levelOf(_ queue: UInt64) -> Pressure {
        let limit = pauseQueueUs()
        if queue >= limit { return .paused }
        if queue >= limit / 2 { return .congested }
        return queue >= limit / 4 ? .building : .clear
    }

    /// Bitrate decisions without TCP statistics: the standing network queue against the same limit as the pause.
    public func networkPressure(_ now: UInt64) -> Pressure { levelOf(standingNetworkQueueUs(now)) }

    public func frameLimit() -> Int {
        let count = (Self.timeoutUs * UInt64(frameRate) + 999_999) / 1_000_000
        return Int(min(max(count, 2), UInt64(Self.maxFrames)))
    }

    public func notsentLowat() -> UInt64 {
        let denominator = UInt64(frameRate) * 4
        return max(16 * 1_024, (targetBitrate + denominator - 1) / denominator)
    }

    public func senderQueueUs() -> UInt64 {
        var queued = Double(transport.notsentBytes) + Double(transport.applicationQueuedBytes)
        for frame in frames where !frame.sent { queued += Double(frame.bytes) }
        let rate = deliveryRateBps != 0 ? deliveryRateBps : max(1, targetBitrate)
        return UInt64((queued * 8_000_000.0 / Double(rate)).rounded(.up))
    }

    public static func headroomBitrate(_ target: UInt64, _ maximum: UInt64, _ elapsedUs: UInt64, _ queuedUs: UInt64, _ intervalUs: UInt64, _ oldestUs: UInt64, _ ageLimitUs: UInt64) -> UInt64 {
        if queuedUs >= (intervalUs + 1) / 2 || oldestUs >= ageLimitUs { return target }
        return UInt64(min(Double(maximum), Double(target) * pow(1.25, Double(elapsedUs) / 1_000_000.0)).rounded())
    }

    public func frameBitrate() -> UInt64 {
        if !transportAvailable { return targetBitrate }
        let interval = frameIntervalUs()
        let queued = min(max(senderQueueUs(), interval), 3 * interval)
        return UInt64(Double(targetBitrate) * (1.0 - 0.75 * Double(queued - interval) / Double(2 * interval)))
    }

    func pausedWithTransport(_ now: UInt64) -> Bool {
        oldestAge(now) >= transportAgeLimitUs() || frames.count >= window || senderQueueUs() >= 3 * frameIntervalUs()
    }

    func pausedWithoutTransport(_ now: UInt64) -> Bool {
        levelOf(standingQueueUs(now)) == .paused
    }

    public func paused(_ now: UInt64) -> Bool {
        bytes + largestFrame > Self.maxBytes || (transportAvailable ? pausedWithTransport(now) : pausedWithoutTransport(now))
    }

    public func timedOut(_ now: UInt64) -> Bool {
        !frames.isEmpty && (now - min(now, lastProgressUs) >= Self.timeoutUs || oldestAge(now) >= Self.timeoutUs)
    }

    @discardableResult
    public mutating func enqueue(_ seq: UInt32, _ size: Int, _ captured: UInt64, _ now: UInt64) -> Bool {
        if seq == 0 || seq != lastEncoded &+ 1 || frames.count >= frameLimit() || size == 0 || size > Self.maxBytes || size > Self.maxBytes - bytes { return false }
        if frames.isEmpty { lastProgressUs = now }
        frames.append(Frame(sequence: seq, bytes: size, capturedUs: captured)); bytes += size; largestFrame = max(largestFrame, size); lastEncoded = seq; encoded += 1
        return true
    }

    @discardableResult
    public mutating func sent(_ seq: UInt32, _ now: UInt64) -> Bool {
        for i in frames.indices {
            if frames[i].sent { continue }
            if frames[i].sequence != seq { return false }
            frames[i].sent = true; frames[i].sentUs = now; return true
        }
        return false
    }

    /// Credits the oldest frame. The viewer's wait is untrusted: one longer than the frame's whole capture-to-acknowledgement time counts as zero.
    @discardableResult
    public mutating func ack(_ seq: UInt32, _ now: UInt64, _ viewerWaitUs: UInt64 = 0) -> Bool {
        guard let frame = frames.first, frame.sent, frame.sequence == seq else { return false }
        let rtt = Double(now - min(now, frame.sentUs))
        ackRttUs = acknowledged != 0 ? ackRttUs * 0.875 + rtt * 0.125 : rtt
        recordDepth(frame.capturedUs, now, viewerWaitUs)
        // Sample continuous demand only: idle gaps and tiny updates are not capacity evidence.
        if !transportAvailable {
            if previousSentUs != 0 && frame.sentUs &- previousSentUs > 3 * frameIntervalUs() {
                sampleStartUs = 0; sampleBytes = 0; sampleAcks = 0
            }
            if sampleStartUs == 0 { sampleStartUs = frame.sentUs }
            previousSentUs = frame.sentUs
            sampleBytes += UInt64(frame.bytes); sampleAcks += 1
        }
        bytes -= frame.bytes; frames.removeFirst(); acknowledged += 1; lastProgressUs = now
        update(now)
        return true
    }

    mutating func recordDepth(_ captured: UInt64, _ now: UInt64, _ viewerWaitUs: UInt64) {
        let total = now - min(now, captured)
        let wait = viewerWaitUs <= total ? viewerWaitUs : 0
        let keptBefore = transportAvailable ? 2 * frameIntervalUs() : standingWindowUs()
        network.forget(now, keptBefore)
        depth.push(now, total, Self.baseWindowUs)
        peak.push(now, total, Self.baseWindowUs)
        held.push(now, wait, Self.baseWindowUs)
        network.push(now, total - wait, Self.baseWindowUs)
        depth.forget(now, transportAvailable ? 2 * frameIntervalUs() : standingWindowUs())
    }

    mutating func expireDelivery(_ now: UInt64) {
        while let first = deliverySamples.first, now - min(now, first.timeUs) >= Self.deliveryWindowUs {
            deliverySamples.removeFirst()
        }
        deliveryRateBps = deliverySamples.first?.rateBps ?? 0
    }

    public mutating func sampleTransport(_ sample: TransportSample, _ now: UInt64) {
        let progress = !transportAvailable || sample.bytesAcked > transport.bytesAcked
        if !transportAvailable { lastTransportUpdateUs = now }
        transport = sample; transportAvailable = true
        expireDelivery(now)
        if progress && !sample.appLimited && sample.deliveryRateBps != 0 {
            if deliverySamples.isEmpty { lastTransportUpdateUs = now }
            while let last = deliverySamples.last, last.rateBps <= sample.deliveryRateBps {
                deliverySamples.removeLast()
            }
            deliverySamples.append(DeliverySample(timeUs: now, rateBps: sample.deliveryRateBps))
        }
        update(now)
    }

    public mutating func clearTransport() {
        if !transportAvailable { return }
        transport = TransportSample(); transportAvailable = false; deliveryRateBps = 0; lastTransportUpdateUs = 0
        deliverySamples.removeAll()
        sampleStartUs = 0; sampleBytes = 0; sampleAcks = 0; previousSentUs = 0
        goodputBps = 0
        updateWindow()
    }

    mutating func windowWithTransport() {
        let count = transport.minRttUs != 0
            ? ((2 * min(transport.minRttUs, Self.timeoutUs) + viewerWaitUs()) * UInt64(frameRate) + 999_999) / 1_000_000 + 2
            : (Self.pauseAgeUs * UInt64(frameRate) + 999_999) / 1_000_000
        window = Int(min(max(count, 2), UInt64(frameLimit())))
    }

    mutating func windowWithoutTransport() {
        window = acknowledged != 0 ? Int(min(max((Double(peakDepthUs()) * Double(frameRate) / 1_000_000.0).rounded(.up) + 2.0, 2.0), Double(frameLimit()))) : 1
    }

    mutating func updateWindow() { transportAvailable ? windowWithTransport() : windowWithoutTransport() }

    mutating func bitrateWithTransport(_ now: UInt64) {
        expireDelivery(now)
        let elapsed = now - min(now, lastTransportUpdateUs)
        lastTransportUpdateUs = now
        let probe = transport.appLimited || deliveryRateBps == 0
            ? Self.headroomBitrate(targetBitrate, maxBitrate, elapsed, senderQueueUs(), frameIntervalUs(), oldestAge(now), transportAgeLimitUs())
            : 0
        if deliveryRateBps != 0 {
            let desired = min(max(Double(deliveryRateBps) * 0.85, Double(minBitrate)), Double(maxBitrate))
            if !transport.appLimited || desired > Double(targetBitrate) {
                let weight = 1.0 - exp(-Double(elapsed) / Double(Self.bitrateSmoothingUs))
                targetBitrate = min(max(UInt64((Double(targetBitrate) + (desired - Double(targetBitrate)) * weight).rounded()), minBitrate), maxBitrate)
            }
        }
        targetBitrate = max(targetBitrate, probe)
    }

    mutating func bitrateWithoutTransport(_ now: UInt64) {
        if !frames.isEmpty {
            waiting.push(now, oldestAge(now), Self.baseWindowUs)
            depth.forget(now, standingWindowUs())
            network.forget(now, standingWindowUs())
        }
        let busy = sampleStartUs != 0 && sampleAcks >= 8 && sampleBytes >= 65_536
        let interval = sampleStartUs != 0 ? now - min(now, sampleStartUs) : 0
        if busy && interval >= 500_000 { goodputBps = Double(sampleBytes) * 8_000_000.0 / Double(interval) }
        let state = networkPressure(now)
        if frames.count >= 2 && UInt64(bytes) >= min(targetBitrate / 80, 65_536) && state >= .congested && now &- lastDecreaseUs >= 500_000 {
            var next = targetBitrate * 3 / 4
            if busy && interval >= 500_000 { next = min(next, UInt64(goodputBps * 0.9)) }
            targetBitrate = max(minBitrate, next); lastDecreaseUs = now
            lastIncreaseUs = now
        } else if busy && interval >= 1_000_000 && state == .clear && now &- lastIncreaseUs >= 1_000_000 && now &- lastDecreaseUs >= 2_000_000 {
            // CRF can emit far below its cap; prompt ACKs of sustained demand permit a probe.
            targetBitrate = min(maxBitrate, targetBitrate + targetBitrate / 10)
            lastIncreaseUs = now
        }
        if interval >= 1_000_000 { sampleStartUs = now; sampleBytes = 0; sampleAcks = 0 }
    }

    public mutating func update(_ now: UInt64) {
        updateWindow()
        transportAvailable ? bitrateWithTransport(now) : bitrateWithoutTransport(now)
    }
}
