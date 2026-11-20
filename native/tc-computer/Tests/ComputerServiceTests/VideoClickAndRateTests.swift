import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// The agent's click on a video stream (P2 on §30), and `budget`'s bitrate at the flow's edge.
@Suite(.serialized) struct VideoClickAndRateTests {
    private func clicking(_ rig: ServiceRig) {
        rig.input.onPerform = { action, _ in
            InputOutcome(tier: .process, via: nil, clipboard: nil, cursor: action.coordinate, lastInputAt: mach_absolute_time(),
                         clickAt: action.action == .leftClick ? action.coordinate : nil)
        }
    }

    private func click(_ rig: ServiceRig, _ at: String) async {
        _ = await rig.call("action.run", "{\(docTarget),\"action\":{\"action\":\"left_click\",\"coordinate\":\(at)},\"tiers\":[\"process\"],\"wait\":\(quick),\"observe\":{\"mode\":\"none\"}}")
    }

    @Test func aClickReachesTheVideoStreamInItsPicturesPixels() async throws {
        let rig = ServiceRig(videoPipe: true)
        await rig.ready(features: ["video"])
        clicking(rig)
        let started = try #require(await rig.call("capture.video.start", "{\(docTarget),\"mode\":\"quality\",\"maxEdge\":1280}").result)
        let stream = try #require(started["stream"]?.intValue)
        // the session's space is 1280 × 960, the picture 1280 × 800
        await click(rig, "[640,480]")
        #expect(await eventually { rig.lines.notifications("capture/click").count == 1 })
        let first = try #require(rig.lines.notifications("capture/click").first)
        #expect(first["stream"]?.stringValue == String(stream))
        #expect(first["at"]?.arrayValue?.compactMap(\.intValue) == [640, 400])
        #expect(first["width"]?.intValue == 1_280 && first["height"]?.intValue == 800)
        // a frame of a new size went out: the next click maps into it
        let encoder = try #require(rig.capture.videos.capture(7)?.encoders.first)
        #expect(encoder.picture(at: monotonicMicros(), size: PixelSize(width: 1_600, height: 1_000)))
        #expect(await eventually { rig.videoRecords().count == 1 })
        await click(rig, "[640,480]")
        #expect(await eventually { rig.lines.notifications("capture/click").count == 2 })
        let second = try #require(rig.lines.notifications("capture/click").last)
        #expect(second["at"]?.arrayValue?.compactMap(\.intValue) == [800, 500])
        #expect(second["width"]?.intValue == 1_600 && second["height"]?.intValue == 1_000)
    }

    @Test func aVideoStreamStartedJustAfterTheClickGetsItOnceAfterItsAnswer() async throws {
        let rig = ServiceRig(videoPipe: true)
        await rig.ready(features: ["video"])
        clicking(rig)
        await click(rig, "[640,480]")
        let start = await rig.call("capture.video.start", "{\(docTarget),\"mode\":\"budget\",\"maxEdge\":1280}")
        let stream = try #require(start.result?["stream"]?.intValue)
        #expect(await eventually { rig.lines.notifications("capture/click").count == 1 })
        let sent = try #require(rig.lines.notifications("capture/click").first)
        #expect(sent["stream"]?.stringValue == String(stream))
        #expect(sent["at"]?.arrayValue?.compactMap(\.intValue) == [640, 400])
        let frames = rig.lines.frames
        let answered = try #require(frames.firstIndex { if case .result(start.id, _) = $0 { true } else { false } })
        let clicked = try #require(frames.firstIndex { if case .notification("capture/click", _) = $0 { true } else { false } })
        #expect(answered < clicked)
        try await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/click").count == 1)
    }

    // MARK: Budget's bitrate

    /// Runs a `budget` stream for `seconds` in real time at 120 pictures a second, the encoder dropping two
    /// of every three it admits and sizing what it keeps to the bitrate asked of it (as low-latency rate
    /// control does), each ack coming `ackDelayMs` after its frame is written and, with `linkBitsPerSecond`,
    /// only once a link of that rate has carried the frame. Returns the bitrate the stream asked at the end.
    private func run(seconds: Double, ackDelayMs: Double, linkBitsPerSecond: Double? = nil) async -> (start: Int, end: Int, asked: [Int]) {
        let start = 8_000_000
        let spec = VideoEncoderSpec(maxEdge: 1_280, fps: 120, mode: .budget, bitrate: start, size: PixelSize(width: 1_280, height: 800))
        let entry = WindowVideoEntry(windowID: 7, start: Task { FakeWindowVideo(pixels: PixelSize(width: 1_280, height: 800), log: CallLog()) })
        let written = Box<[Data]>()
        written.value = []
        let lock = NSLock()
        let stream = VideoStream(id: 1, session: "s1", windowID: 7, entry: entry, spec: spec, write: { record in lock.withLock { written.value!.append(record) } }, fail: { _ in })
        let encoder = FakeEncoder(spec: spec, output: stream)
        stream.attach(encoder)
        var reader = VideoRecordReader()
        var due: [(at: UInt64, record: VideoRecord)] = []
        var lastAck: UInt64 = 0
        var offered = 0
        let begin = monotonicMicros()
        while monotonicMicros() < begin + UInt64(seconds * 1_000_000) {
            let now = monotonicMicros()
            if stream.admit(captureMicros: now, again: false) {
                offered += 1
                if offered % 3 == 1 {
                    // about 40 frames a second come out: each a fortieth of a second's bits
                    let bytes = stream.counts.bitrate / 8 / 40
                    stream.encoded(EncodedVideo(generation: 1, keyframe: offered == 1, size: spec.size, captureMicros: now, accessUnit: Data(repeating: 0x41, count: bytes), encodeMicros: 900))
                } else {
                    stream.dropped()
                }
            }
            let fresh = lock.withLock { () -> [Data] in
                defer { written.value = [] }
                return written.value!
            }
            for bytes in fresh {
                for record in (try? reader.push(bytes)) ?? [] {
                    var at = now + UInt64(ackDelayMs * 1_000)
                    if let link = linkBitsPerSecond {
                        // the link carries one frame after another
                        at = max(at, lastAck + UInt64(Double(record.payload.count * 8) / link * 1_000_000))
                    }
                    at = max(at, lastAck)
                    lastAck = at
                    due.append((at, VideoRecord(stream: 1, type: NSL1.ackType, flags: 0, generation: record.generation, sequence: record.sequence, payload: Data())))
                }
            }
            while let first = due.first, first.at <= now {
                stream.ack(first.record)
                due.removeFirst()
            }
            _ = stream.tick(now: now)
            try? await Task.sleep(for: .microseconds(8_333))
        }
        stream.end()
        let asked = encoder.calls.compactMap { $0.hasPrefix("bitrate ") ? Int($0.dropFirst(8)) : nil }
        return (start, stream.counts.bitrate, asked)
    }

    @Test func budgetsBitrateRisesWhileTheEncoderDropsAndTheAcksComeAtOnce() async {
        let result = await run(seconds: 4, ackDelayMs: 2)
        #expect(result.end > result.start, "the stream asked \(result.asked)")
        #expect(result.asked.allSatisfy { $0 <= ComputerDefaults.VideoStream.maxBitrate })
    }

    @Test func budgetsBitrateStillFallsWhenTheAcksFallBehind() async {
        // a 3 Mbit/s link under a stream that starts at 8: a queue builds behind it
        let result = await run(seconds: 5, ackDelayMs: 20, linkBitsPerSecond: 3_000_000)
        #expect(result.end < result.start, "the stream asked \(result.asked)")
    }
}
