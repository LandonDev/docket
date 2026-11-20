@testable import Capture
import ComputerCore
import ComputerProtocol
import CoreVideo
import Foundation
import Testing

@Suite struct AnnexBTests {
    @Test func eachUnitGetsAStartCodeAndTheParameterSetsGoFirst() throws {
        let avcc = Data([0, 0, 0, 2, 0x41, 0x9A, 0, 0, 0, 3, 0x41, 1, 2])
        #expect(try AnnexB.accessUnit(avcc: avcc, lengthSize: 4) == Data([0, 0, 0, 1, 0x41, 0x9A, 0, 0, 0, 1, 0x41, 1, 2]))
        let sps = Data([0x67, 0x64, 0, 0x1F]), pps = Data([0x68, 0xEE])
        let idr = Data([0, 0, 0, 3, 0x65, 0x88, 0x84])
        let key = try AnnexB.accessUnit(avcc: idr, lengthSize: 4, parameterSets: [sps, pps])
        #expect(key == Data([0, 0, 0, 1, 0x67, 0x64, 0, 0x1F, 0, 0, 0, 1, 0x68, 0xEE, 0, 0, 0, 1, 0x65, 0x88, 0x84]))
        #expect(AnnexB.unitTypes(key) == [7, 8, 5])
        // two-byte lengths, as an encoder may choose
        #expect(try AnnexB.accessUnit(avcc: Data([0, 2, 0x41, 7]), lengthSize: 2) == Data([0, 0, 0, 1, 0x41, 7]))
    }

    @Test func aLengthPastTheEndIsMalformed() {
        #expect(throws: AnnexB.Malformed.self) { try AnnexB.accessUnit(avcc: Data([0, 0, 0, 9, 0x41]), lengthSize: 4) }
        #expect(throws: AnnexB.Malformed.self) { try AnnexB.accessUnit(avcc: Data([0, 0, 0, 1, 0x41, 0, 0]), lengthSize: 4) }
        #expect(throws: AnnexB.Malformed.self) { try AnnexB.accessUnit(avcc: Data([0, 0, 0, 0]), lengthSize: 4) }
        #expect(throws: AnnexB.Malformed.self) { try AnnexB.accessUnit(avcc: Data([0, 1, 0x41]), lengthSize: 3) }
    }
}

@Suite struct VideoGeometryTests {
    @Test func thePictureFitsTheEdgeNeverGrowsAndIsEven() {
        #expect(VideoGeometry.picture(PixelSize(width: 2_560, height: 1_600), maxEdge: 1_280) == PixelSize(width: 1_280, height: 800))
        #expect(VideoGeometry.picture(PixelSize(width: 2_561, height: 1_601), maxEdge: 3_840) == PixelSize(width: 2_560, height: 1_600))
        #expect(VideoGeometry.picture(PixelSize(width: 1_001, height: 333), maxEdge: 256) == PixelSize(width: 256, height: 84))
        #expect(VideoGeometry.picture(PixelSize(width: 600, height: 2_000), maxEdge: 1_000) == PixelSize(width: 300, height: 1_000))
        #expect(VideoGeometry.picture(PixelSize(width: 3, height: 1), maxEdge: 256) == PixelSize(width: 2, height: 2))
    }
}

/// A stream's side as the encoder sees it: admits what it is told, keeps what comes back.
private final class Recorder: VideoOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var units: [EncodedVideo] = []
    private var admits: [Bool] = []
    private var drops = 0
    private var failures: [String] = []

    func admit(captureMicros: UInt64, again: Bool) -> Bool {
        lock.withLock { admits.append(again) }
        return true
    }

    func encoded(_ unit: EncodedVideo) { lock.withLock { units.append(unit) } }
    func dropped() { lock.withLock { drops += 1 } }
    var dropCount: Int { lock.withLock { drops } }
    func failed(_ why: String) { lock.withLock { failures.append(why) } }

    var encoded: [EncodedVideo] { lock.withLock { units } }
    var admitted: [Bool] { lock.withLock { admits } }
    var failed: [String] { lock.withLock { failures } }
}

/// The real VideoToolbox encoder on pictures made here: no window and no screen.
@Suite(.serialized) struct VideoEncoderTests {
    /// An NV12 picture with a moving gradient, so each frame differs.
    private func picture(_ width: Int, _ height: Int, frame: Int) throws -> VideoPicture {
        var made: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
        #expect(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes, &made) == kCVReturnSuccess)
        let buffer = try #require(made)
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<2 {
            let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane)!.assumingMemoryBound(to: UInt8.self)
            let rows = CVPixelBufferGetHeightOfPlane(buffer, plane), stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane)
            for y in 0..<rows { for x in 0..<stride { base[y * stride + x] = UInt8(truncatingIfNeeded: x + y * 3 + frame * 7 + plane * 64) } }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let now = monotonicMicros()
        return VideoPicture(buffer: buffer, captureMicros: now, enteredMicros: now)
    }

    private func encoder(_ size: PixelSize, mode: VideoMode = .quality, maxEdge: Int = 3_840, last: VideoPicture? = nil) throws -> (VideoEncoderSession, Recorder, DispatchQueue) {
        let queue = DispatchQueue(label: "tc.test.video")
        let recorder = Recorder()
        let spec = VideoEncoderSpec(maxEdge: maxEdge, fps: 60, mode: mode, bitrate: mode == .quality ? 20_000_000 : 8_000_000, size: size)
        let session = VideoEncoderSession(spec: spec, output: recorder, queue: queue) { last }
        try queue.sync { try session.open(size: size) }
        return (session, recorder, queue)
    }

    private func settle(_ recorder: Recorder, count: Int) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if recorder.encoded.count >= count { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return false
    }

    @Test func theFirstFrameIsAKeyframeWithItsParameterSetsAndTheRestAreNot() async throws {
        for mode in [VideoMode.quality, .budget] {
            let (session, recorder, queue) = try encoder(PixelSize(width: 640, height: 400), mode: mode)
            for frame in 0..<6 {
                let next = try picture(640, 400, frame: frame)
                queue.sync { session.offer(next, again: false) }
                try? await Task.sleep(for: .milliseconds(17))
            }
            #expect(await settle(recorder, count: 6))
            let units = recorder.encoded
            #expect(units.first?.keyframe == true)
            // SPS and PPS first; the encoder may put an SEI ahead of the IDR slice
            let types = AnnexB.unitTypes(units[0].accessUnit)
            #expect(types.prefix(2) == [7, 8] && types.contains(5))
            #expect(units.dropFirst().allSatisfy { !$0.keyframe && !AnnexB.unitTypes($0.accessUnit).contains(7) })
            #expect(units.allSatisfy { $0.generation == 1 && $0.size == PixelSize(width: 640, height: 400) })
            #expect(recorder.failed.isEmpty)
            queue.sync { session.close() }
        }
    }

    @Test func everyAdmittedPictureIsSettledOnceWhenTheSessionCloses() async throws {
        let (session, recorder, queue) = try encoder(PixelSize(width: 640, height: 400))
        let pictures = try (0..<8).map { try picture(640, 400, frame: $0) }
        queue.sync {
            for next in pictures { session.offer(next, again: false) }
            session.close()
        }
        try? await Task.sleep(for: .milliseconds(200))
        #expect(recorder.admitted.count == 8)
        #expect(recorder.encoded.count + recorder.dropCount == 8)
    }

    @Test func aPictureOfAnotherSizeIsScaledToTheStreams() async throws {
        let (session, recorder, queue) = try encoder(PixelSize(width: 320, height: 200))
        let big = try picture(640, 400, frame: 0)
        queue.sync { session.offer(big, again: false) }
        #expect(await settle(recorder, count: 1))
        #expect(recorder.encoded.first?.size == PixelSize(width: 320, height: 200))
        #expect(recorder.encoded.first?.keyframe == true)
        queue.sync { session.close() }
    }

    @Test func aResizeThatChangesThePictureStartsANewGeneration() async throws {
        let (session, recorder, queue) = try encoder(PixelSize(width: 640, height: 400), maxEdge: 640)
        queue.sync { session.offer(try! picture(640, 400, frame: 0), again: false) }
        #expect(await settle(recorder, count: 1))
        // the window doubled: the picture held to 640 stays 640 × 400, the encoder as it was
        queue.sync { session.resize(to: PixelSize(width: 1_280, height: 800)) }
        queue.sync { session.offer(try! picture(640, 400, frame: 1), again: false) }
        #expect(await settle(recorder, count: 2))
        #expect(recorder.encoded[1].generation == 1 && !recorder.encoded[1].keyframe)
        // a wider window: a new picture size, a new generation, a keyframe
        queue.sync { session.resize(to: PixelSize(width: 1_280, height: 640)) }
        queue.sync { session.offer(try! picture(640, 320, frame: 2), again: false) }
        #expect(await settle(recorder, count: 3))
        let third = recorder.encoded[2]
        #expect(third.generation == 2 && third.keyframe && third.size == PixelSize(width: 640, height: 320))
        queue.sync { session.close() }
    }

    @Test func theStillWindowOffersTheLastPictureAgainAndAKeyframeCanBeAsked() async throws {
        let last = try picture(640, 400, frame: 0)
        let (session, recorder, queue) = try encoder(PixelSize(width: 640, height: 400), last: last)
        queue.sync { session.offer(last, again: false) }
        #expect(await settle(recorder, count: 1))
        session.encodeLast()
        #expect(await settle(recorder, count: 2))
        #expect(recorder.admitted == [false, true])
        // the repeat is a frame of now to the flow, not of the old picture's time
        #expect(recorder.encoded[1].captureMicros > last.captureMicros)
        session.keyframe()
        queue.sync { session.offer(try! picture(640, 400, frame: 1), again: false) }
        #expect(await settle(recorder, count: 3))
        #expect(recorder.encoded.map(\.keyframe) == [true, false, true])
        queue.sync { session.close() }
    }
}

@Suite struct SamePixelsTests {
    private func buffer(_ width: Int, _ height: Int, value: UInt8) throws -> CVPixelBuffer {
        var made: CVPixelBuffer?
        #expect(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &made) == kCVReturnSuccess)
        let buffer = try #require(made)
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(buffer, plane), Int32(value), CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

    @Test func onlyTheSamePixelsAreTheSame() throws {
        let a = try buffer(64, 40, value: 9), b = try buffer(64, 40, value: 9)
        #expect(WindowVideoCapture.samePixels(a, b))
        CVPixelBufferLockBaseAddress(b, [])
        CVPixelBufferGetBaseAddressOfPlane(b, 1)!.storeBytes(of: 10, toByteOffset: CVPixelBufferGetBytesPerRowOfPlane(b, 1) * 19 + 63, as: UInt8.self)
        CVPixelBufferUnlockBaseAddress(b, [])
        #expect(!WindowVideoCapture.samePixels(a, b))
        #expect(!WindowVideoCapture.samePixels(a, try buffer(64, 42, value: 9)))
    }
}

@Suite struct H264SPSTests {
    /// The SPS of an encoded keyframe's Annex B unit.
    private func sps(_ unit: Data) -> Data? {
        let bytes = [UInt8](unit)
        var starts: [Int] = []
        var i = 0
        while i + 3 < bytes.count {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 0, bytes[i + 3] == 1 { starts.append(i + 4); i += 4 } else { i += 1 }
        }
        for (k, start) in starts.enumerated() where bytes[start] & 0x1F == 7 {
            return Data(bytes[start..<((k + 1 < starts.count ? starts[k + 1] - 4 : bytes.count))])
        }
        return nil
    }

    @Test func aHandWrittenSPSGainsTheRestrictionAndKeepsItsFields() throws {
        // Baseline 3.0, id 0, log2_max_frame_num 4, poc type 2, 1 ref frame, 40 × 30 macroblocks, frame mbs only, no VUI
        var w = BitWriter()
        w.write(66, bits: 8); w.write(0xC0, bits: 8); w.write(30, bits: 8)
        w.writeUE(0); w.writeUE(0); w.writeUE(2); w.writeUE(1); w.write(0, bits: 1)
        w.writeUE(39); w.writeUE(29); w.write(1, bits: 1); w.write(1, bits: 1); w.write(0, bits: 1)
        w.write(0, bits: 1) // no VUI
        w.write(1, bits: 1) // stop bit
        let nal = Data([0x67]) + H264SPS.escape(w.bytes())
        #expect(try H264SPS.restriction(nal) == nil)
        let out = try H264SPS.withoutReordering(nal)
        #expect(try H264SPS.restriction(out) == H264SPS.Restriction(maxNumReorderFrames: 0, maxDecFrameBuffering: 1))
        #expect(out.first == 0x67)
        // the fields before the VUI are the same bits: the prefix of both, as read
        #expect(try H264SPS.withoutReordering(out) == out)
    }

    @Test func emulationPreventionGoesBothWays() {
        #expect(H264SPS.unescape(Data([0, 0, 3, 1, 0, 0, 3, 0])) == [0, 0, 1, 0, 0, 0])
        #expect([UInt8](H264SPS.escape([0, 0, 1, 0, 0, 0, 5])) == [0, 0, 3, 1, 0, 0, 3, 0, 5])
    }

    @Test func videoToolboxsSPSGainsTheRestriction() async throws {
        let queue = DispatchQueue(label: "tc.test.sps")
        let recorder = SPSRecorder()
        let spec = VideoEncoderSpec(maxEdge: 3_840, fps: 60, mode: .quality, bitrate: 20_000_000, size: PixelSize(width: 640, height: 400))
        let session = VideoEncoderSession(spec: spec, output: recorder, queue: queue) { nil }
        try queue.sync { try session.open(size: spec.size) }
        var made: CVPixelBuffer?
        CVPixelBufferCreate(nil, 640, 400, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &made)
        let buffer = try #require(made)
        queue.sync { session.offer(VideoPicture(buffer: buffer, captureMicros: 1, enteredMicros: 1), again: false) }
        for _ in 0..<200 where recorder.unit == nil { try? await Task.sleep(for: .milliseconds(10)) }
        let unit = try #require(recorder.unit)
        let set = try #require(sps(unit))
        #expect(try H264SPS.restriction(set)?.maxNumReorderFrames == 0)
        queue.sync { session.close() }
    }
}

private final class SPSRecorder: VideoOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var first: Data?
    var unit: Data? { lock.withLock { first } }
    func admit(captureMicros: UInt64, again: Bool) -> Bool { true }
    func encoded(_ unit: EncodedVideo) { lock.withLock { if first == nil { first = unit.accessUnit } } }
    func dropped() {}
    func failed(_ why: String) {}
}
