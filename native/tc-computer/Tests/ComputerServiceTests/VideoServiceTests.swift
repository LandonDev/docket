import ComputerCore
import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation
import Testing

/// Live video (§30) through the handlers, over the fake capture and a real socket pair for the bytes pipe.
@Suite(.serialized) struct VideoServiceTests {
    private func start(_ rig: ServiceRig, _ extra: String = #""mode":"quality","maxEdge":3840"#) async -> (stream: Int?, width: Int?, height: Int?, error: RPCErrorObject?) {
        let answer = await rig.call("capture.video.start", "{\(docTarget),\(extra)}")
        return (answer.result?["stream"]?.intValue, answer.result?["width"]?.intValue, answer.result?["height"]?.intValue, answer.error)
    }

    private func ready(_ rig: ServiceRig) async {
        await rig.ready(features: ["video"])
    }

    /// Waits until the stream has taken `count` acks (a picture offered before then would spend its pacing slot).
    private func acked(_ rig: ServiceRig, _ stream: Int, _ count: UInt64) async -> Bool {
        await eventually { rig.service.lock.withLock { rig.service.videos[stream] }?.counts.acked == count }
    }

    @Test func videoIsNamedOnlyWithAPipeAndAskedOnlyWhenTheHostOffersIt() async throws {
        let piped = ServiceRig(videoPipe: true)
        let named = try #require(await piped.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(piped.dataDir.path)","features":["video"]}"#).result)
        #expect(named["features"]?.arrayValue?.compactMap(\.stringValue).contains("video") == true)

        let bare = ServiceRig()
        let without = try #require(await bare.call("initialize", #"{"protocol":1,"client":{"name":"t","version":"0"},"dataDir":"\#(bare.dataDir.path)","features":["video"]}"#).result)
        #expect(without["features"]?.arrayValue?.compactMap(\.stringValue) == ["front", "commit", "save_as"])
        await bare.call("session.open", #"{"session":"s1"}"#)
        #expect(await start(bare).error?.code == ComputerDefaults.RPCErrorCode.methodNotFound)

        // a pipe, but a host that never offered the feature: the calls are unknown
        let unasked = ServiceRig(videoPipe: true)
        await unasked.ready(features: ["front"])
        #expect(await start(unasked).error?.code == ComputerDefaults.RPCErrorCode.methodNotFound)
        #expect(await unasked.call("capture.video.stop", #"{"stream":1}"#).error?.code == ComputerDefaults.RPCErrorCode.methodNotFound)
        #expect(unasked.log.count("startVideo") == 0)
    }

    @Test func startAnswersAnEvenPictureThatFitsMaxEdge() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let quality = await start(rig, #""mode":"quality","maxEdge":1001"#)
        #expect(quality.stream == 1 && quality.width == 1_000 && quality.height == 624)
        // the window's own pixels when they fit
        let whole = await start(rig, #""mode":"quality","maxEdge":3840"#)
        #expect(whole.stream == 2 && whole.width == 2_560 && whole.height == 1_600)
        // budget is held to the link's edge whatever it asks, and starts at its bitrate
        let budget = await start(rig, #""mode":"budget","maxEdge":3000,"bitrate":5000000"#)
        #expect(budget.width == 1_280 && budget.height == 800)
        #expect(rig.log.all.filter { $0.hasPrefix("addEncoder") } == ["addEncoder 1000x624 quality 20000000", "addEncoder 2560x1600 quality 20000000", "addEncoder 1280x800 budget 5000000"])
        let odd = ServiceRig(videoPipe: true)
        odd.capture.videos.pixels = PixelSize(width: 1_001, height: 333)
        await ready(odd)
        let fitted = await start(odd)
        #expect(fitted.width == 1_000 && fitted.height == 332)
    }

    @Test func streamsOfOneWindowShareTheCaptureAndTheLastStopsIt() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let first = try #require(await start(rig).stream)
        let second = try #require(await start(rig, #""mode":"budget","maxEdge":1280"#).stream)
        #expect(first != second)
        #expect(rig.log.count("startVideo") == 1)
        #expect(rig.log.count("addEncoder") == 2)
        let capture = try #require(rig.capture.videos.capture(7))
        #expect(await rig.call("capture.video.stop", #"{"stream":\#(first)}"#).result == .object([:]))
        #expect(await eventually { capture.encoders.count == 1 })
        #expect(!capture.stopped)
        _ = await rig.call("capture.video.stop", #"{"stream":\#(second)}"#)
        #expect(await eventually { capture.stopped })
        #expect(rig.log.count("stopVideo") == 1)
        // a stop ends silently, and a stream the service does not know is no error
        #expect(await rig.call("capture.video.stop", #"{"stream":99}"#).result == .object([:]))
        #expect(rig.lines.notifications("capture/videoEnded").isEmpty)
        // a new stream on the window starts a new capture
        _ = await start(rig)
        #expect(rig.log.count("startVideo") == 2)
    }

    @Test func framesGoOutInOrderAndTheAcksOpenTheWindow() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let stream = try #require(await start(rig, #""mode":"quality","maxEdge":1280"#).stream)
        let encoder = try #require(rig.capture.videos.capture(7)?.encoders.first)
        let t0 = monotonicMicros()
        #expect(encoder.picture(at: t0))
        // before any ack the window is one frame
        #expect(!encoder.picture(at: t0 + 10_000))
        #expect(await eventually { rig.videoRecords().count == 1 })
        let first = try #require(rig.videoRecords().first)
        #expect(first.stream == UInt32(stream) && first.type == NSL1.frameType && first.generation == 1 && first.sequence == 1)
        #expect(first.flags == NSL1.keyframeFlag)
        #expect([UInt8](first.payload.prefix(4)) == [0x05, 0x00, 0x03, 0x20]) // 1280 × 800
        rig.ack(stream: stream, sequence: 1, waitMicros: 2_000)
        #expect(await acked(rig, stream, 1))
        #expect(encoder.picture(at: t0 + 20_000))
        rig.ack(stream: stream, sequence: 2)
        #expect(await acked(rig, stream, 2))
        #expect(encoder.picture(at: t0 + 30_000))
        #expect(await eventually { rig.videoRecords().count == 3 })
        let records = rig.videoRecords()
        #expect(records.map(\.sequence) == [1, 2, 3])
        #expect(records.map(\.flags) == [1, 0, 0])
        // an ack of another generation is not this stream's
        rig.ack(stream: stream, generation: 9, sequence: 3)
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await acked(rig, stream, 2))
    }

    @Test func aNewGenerationStartsAtSequenceOneWithAKeyframe() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let stream = try #require(await start(rig).stream)
        let encoder = try #require(rig.capture.videos.capture(7)?.encoders.first)
        let t0 = monotonicMicros()
        #expect(encoder.picture(at: t0))
        rig.ack(stream: stream, sequence: 1)
        #expect(await acked(rig, stream, 1))
        #expect(encoder.picture(at: t0 + 10_000))
        rig.ack(stream: stream, sequence: 2)
        #expect(await acked(rig, stream, 2))
        encoder.newGeneration()
        #expect(encoder.picture(at: t0 + 20_000, size: PixelSize(width: 1_600, height: 1_000)))
        #expect(await eventually { rig.videoRecords().count == 3 })
        let last = try #require(rig.videoRecords().last)
        #expect(last.generation == 2 && last.sequence == 1 && last.flags == NSL1.keyframeFlag)
        #expect([UInt8](last.payload.prefix(4)) == [0x06, 0x40, 0x03, 0xE8])
        // the new generation's acks open its window; the old one's do nothing
        rig.ack(stream: stream, generation: 1, sequence: 3)
        try? await Task.sleep(for: .milliseconds(30))
        #expect(!encoder.picture(at: t0 + 30_000))
        rig.ack(stream: stream, generation: 2, sequence: 1)
        #expect(await acked(rig, stream, 1))
        #expect(encoder.picture(at: t0 + 40_000))
    }

    @Test func aStillWindowIsSentAgainAndTheRepeatsSkipThePacing() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let stream = try #require(await start(rig).stream)
        let encoder = try #require(rig.capture.videos.capture(7)?.encoders.first)
        let t0 = monotonicMicros()
        #expect(encoder.picture(at: t0))
        rig.ack(stream: stream, sequence: 1)
        #expect(await acked(rig, stream, 1))
        #expect(await eventually(.seconds(2)) { encoder.calls.contains("encodeLast") })
        // a repeat carries the last picture's time, which the pacer already took
        #expect(encoder.picture(at: t0, again: true))
        #expect(await eventually { rig.videoRecords().count == 2 })
    }

    @Test func aWindowThatEndsOnItsOwnSaysWhy() async throws {
        for (reason, wire) in [(StreamEndReason.windowClosed, "window-closed"), (.permission, "permission"), (.error("gone"), "error")] {
            let rig = ServiceRig(videoPipe: true)
            await ready(rig)
            let one = try #require(await start(rig).stream)
            let two = try #require(await start(rig).stream)
            try #require(rig.capture.videos.capture(7)).end(reason)
            #expect(await eventually { rig.lines.notifications("capture/videoEnded").count == 2 })
            let ended = rig.lines.notifications("capture/videoEnded")
            #expect(Set(ended.compactMap { $0["stream"]?.intValue }) == [one, two])
            #expect(ended.allSatisfy { $0["reason"]?.stringValue == wire })
        }
    }

    @Test func sessionCloseEndsItsStreamsWithNoNotice() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        _ = try #require(await start(rig).stream)
        let capture = try #require(rig.capture.videos.capture(7))
        _ = await rig.call("session.close", #"{"session":"s1"}"#)
        #expect(await eventually { capture.stopped })
        try? await Task.sleep(for: .milliseconds(50))
        #expect(rig.lines.notifications("capture/videoEnded").isEmpty)
    }

    @Test func noAckForThreeSecondsEndsTheStreamWithError() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        let stream = try #require(await start(rig).stream)
        let encoder = try #require(rig.capture.videos.capture(7)?.encoders.first)
        #expect(encoder.picture(at: monotonicMicros()))
        #expect(await eventually(.seconds(5)) { !rig.lines.notifications("capture/videoEnded").isEmpty })
        let ended = try #require(rig.lines.notifications("capture/videoEnded").first)
        #expect(ended["stream"]?.intValue == stream && ended["reason"]?.stringValue == "error")
        #expect(await eventually { rig.capture.videos.capture(7)?.stopped == true })
    }

    @Test func aRecordThatCannotBePlacedEndsEveryStream() async throws {
        let rig = ServiceRig(videoPipe: true)
        await ready(rig)
        _ = try #require(await start(rig).stream)
        _ = try #require(await start(rig).stream)
        rig.hostWrite(Data(repeating: 0x58, count: 32))
        #expect(await eventually { rig.lines.notifications("capture/videoEnded").count == 2 })
        #expect(rig.lines.notifications("capture/videoEnded").allSatisfy { $0["reason"]?.stringValue == "error" })
        #expect(await start(rig).error?.data?.kind == .captureFailed)
    }

    @Test func startPassesTheGuardEveryPicturePathDoes() async throws {
        let denied = ServiceRig(screenRecording: false, videoPipe: true)
        await ready(denied)
        #expect(await start(denied).error?.data?.kind == .permissionMissing)
        let minimized = ServiceRig(videoPipe: true)
        minimized.windows.set(500, [window(7, "Doc", minimized: true)])
        await ready(minimized)
        #expect(await start(minimized).error?.data?.kind == .windowMinimized)
        #expect(denied.log.count("startVideo") + minimized.log.count("startVideo") == 0)
    }
}
