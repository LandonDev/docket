import CoreMedia
import Foundation
import Testing
@testable import TempCodeClient

/// The box engine's own stream (180 frames, 1280×800, constrained baseline), one NSL1 message after another as the
/// engine sent them; the test server replays the same file.
enum BoxStream {
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("scripts/fixtures/ios-test-server/box-stream.nsl1")

    /// Each whole message of the file.
    static func messages() throws -> [Data] {
        let bytes = [UInt8](try Data(contentsOf: url))
        var out: [Data] = []
        var at = 0
        while at + NSL1.headerSize <= bytes.count {
            let size = Int(bytes[at + 16]) << 24 | Int(bytes[at + 17]) << 16 | Int(bytes[at + 18]) << 8 | Int(bytes[at + 19])
            out.append(Data(bytes[at..<(at + NSL1.headerSize + size)]))
            at += NSL1.headerSize + size
        }
        return out
    }
}

@Suite struct NSL1Tests {
    @Test func `a frame reads its header and payload as the wire writes them`() throws {
        let unit: [UInt8] = [0, 0, 0, 1, 0x65, 0xAA]
        let bytes: [UInt8] = [0x4E, 0x53, 0x4C, 0x31, 1, 1, 0, 1, 0, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 18, 0x05, 0x00, 0x03, 0x20, 0, 0, 0, 0, 0, 0x0F, 0x42, 0x40] + unit
        let frame = try NSL1.parseFrame(Data(bytes))
        #expect(frame == NSL1.Frame(generation: 2, sequence: 7, keyframe: true, width: 1280, height: 800, timestamp: 1_000_000, data: Data(unit)))
    }

    @Test func `anything off the wire is refused`() {
        let good: [UInt8] = [0x4E, 0x53, 0x4C, 0x31, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 13, 0, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 9]
        #expect((try? NSL1.parseFrame(Data(good))) != nil)
        var cases: [[UInt8]] = []
        var badMagic = good; badMagic[0] = 0; cases.append(badMagic)
        var ack = good; ack[5] = 2; cases.append(ack)
        var noGeneration = good; noGeneration[11] = 0; cases.append(noGeneration)
        var noSequence = good; noSequence[15] = 0; cases.append(noSequence)
        var longer = good; longer[19] = 14; cases.append(longer)
        var flags = good; flags[7] = 2; cases.append(flags)
        var noWidth = good; noWidth[21] = 0; cases.append(noWidth)
        cases.append(Array(good.prefix(19)))
        for bytes in cases { #expect(throws: NSL1.Malformed.self) { try NSL1.parseFrame(Data(bytes)) } }
    }

    @Test func `an ack is the bare header or four bytes of wait, as nsl1.ts writes it`() {
        #expect([UInt8](NSL1.encodeAck(generation: 2, sequence: 9)) == [0x4E, 0x53, 0x4C, 0x31, 1, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 9, 0, 0, 0, 0])
        #expect([UInt8](NSL1.encodeAck(generation: 2, sequence: 9, waitMs: 10)) == [0x4E, 0x53, 0x4C, 0x31, 1, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 9, 0, 0, 0, 4, 0, 0, 0x27, 0x10])
        #expect([UInt8](NSL1.encodeAck(generation: 1, sequence: 1, waitMs: 1e12).suffix(4)) == [0xFF, 0xFF, 0xFF, 0xFF])
        #expect([UInt8](NSL1.encodeAck(generation: 1, sequence: 1, waitMs: -3).suffix(4)) == [0, 0, 0, 0])
        #expect([UInt8](NSL1.encodeAck(generation: 1, sequence: 1, waitMs: .nan).suffix(4)) == [0, 0, 0, 0])
    }

    @Test func `the fixture's first messages are a keyframe then deltas of one generation`() throws {
        let messages = try BoxStream.messages()
        #expect(messages.count == 180)
        let frames = try messages.prefix(4).map(NSL1.parseFrame)
        #expect(frames[0].keyframe && frames[0].sequence == 1 && frames[0].width == 1280 && frames[0].height == 800)
        #expect(frames.dropFirst().allSatisfy { !$0.keyframe && $0.generation == frames[0].generation })
        #expect(frames.map(\.sequence) == [1, 2, 3, 4])
    }
}

@Suite struct AccessUnitTests {
    @Test func `units split on three- and four-byte start codes`() {
        let annexB = Data([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 0])
        #expect(AccessUnit.nalUnits(annexB) == [Data([0x67, 1, 2]), Data([0x68, 3]), Data([0x65, 4, 5])])
        #expect(AccessUnit.nalUnits(Data([1, 2, 3])).isEmpty)
    }

    @Test func `the fixture's keyframe makes a 1280 × 800 format and every frame a sample`() throws {
        let frames = try BoxStream.messages().map(NSL1.parseFrame)
        let units = AccessUnit.nalUnits(frames[0].data)
        let sps = try #require(units.first { AccessUnit.type($0) == 7 })
        let pps = try #require(units.first { AccessUnit.type($0) == 8 })
        let format = try AccessUnit.format(sps: sps, pps: pps)
        let size = CMVideoFormatDescriptionGetDimensions(format)
        #expect(size.width == 1280 && size.height == 800)
        var maker = SampleMaker()
        var samples = 0
        for frame in frames {
            let sample = try maker.sample(frame)
            #expect(CMSampleBufferGetNumSamples(sample) == 1)
            samples += 1
        }
        #expect(samples == 180)
        #expect(maker.dimensions?.width == 1280)
    }

    @Test func `a delta before any keyframe has no format`() throws {
        let frames = try BoxStream.messages().map(NSL1.parseFrame)
        var maker = SampleMaker()
        #expect(throws: AccessUnit.Unreadable.self) { try maker.sample(frames[1]) }
    }
}

private final class Layer: VideoSampleSink {
    var enqueued = 0
    var flushes = 0
    var failing = false
    func enqueue(_ sample: CMSampleBuffer) -> Bool {
        guard !failing else { return false }
        enqueued += 1
        return true
    }
    func flush() { flushes += 1 }
}

@Suite struct VideoPlayerCoreTests {
    private func rig() -> (VideoPlayerCore, Layer, () -> [Data], (Double) -> Void) {
        let layer = Layer()
        var sent: [Data] = []
        var clock = 0.0
        let player = VideoPlayerCore(sink: layer, send: { sent.append($0) }, now: { clock })
        return (player, layer, { sent }, { clock += $0 })
    }

    /// The fixture's message `index` under another generation and sequence.
    private func message(_ index: Int, generation: UInt32? = nil, sequence: UInt32? = nil) throws -> Data {
        var bytes = [UInt8](try BoxStream.messages()[index])
        if let generation { bytes.replaceSubrange(8..<12, with: [UInt8(generation >> 24), UInt8(generation >> 16 & 0xFF), UInt8(generation >> 8 & 0xFF), UInt8(generation & 0xFF)]) }
        if let sequence { bytes.replaceSubrange(12..<16, with: [UInt8(sequence >> 24), UInt8(sequence >> 16 & 0xFF), UInt8(sequence >> 8 & 0xFF), UInt8(sequence & 0xFF)]) }
        return Data(bytes)
    }

    @Test func `each frame is enqueued then acked in the order it came`() throws {
        let (player, layer, sent, _) = rig()
        for message in try BoxStream.messages() { #expect(player.receive(message) == nil) }
        #expect(layer.enqueued == 180 && player.frames == 180)
        let acks = sent()
        #expect(acks.count == 180)
        #expect(acks.map { Int($0[15]) | Int($0[14]) << 8 } == Array(1...180))
        #expect(acks.allSatisfy { $0[5] == 2 && $0.count == 24 })
    }

    @Test func `a gap, a stale generation, or a generation that does not start with keyframe 1 ends the stream`() throws {
        let (gap, _, _, _) = rig()
        #expect(gap.receive(try message(0)) == nil)
        #expect(gap.receive(try message(2)) == .wire)
        let (late, _, _, _) = rig()
        #expect(late.receive(try message(1)) == .wire) // a delta first
        let (stale, _, _, _) = rig()
        #expect(stale.receive(try message(0, generation: 5)) == nil)
        #expect(stale.receive(try message(1, generation: 4, sequence: 2)) == .wire)
        let (renew, layer, _, _) = rig()
        #expect(renew.receive(try message(0)) == nil)
        #expect(renew.receive(try message(0, generation: 9)) == nil)
        #expect(layer.flushes == 2)
        #expect(renew.receive(try message(1, generation: 9, sequence: 2)) == nil)
    }

    @Test func `a layer that fails, or a first frame that never comes, ends the stream`() throws {
        let (player, layer, _, _) = rig()
        layer.failing = true
        #expect(player.receive(try message(0)) == .decode)
        let (quiet, _, _, advance) = rig()
        advance(4_999)
        #expect(quiet.check() == nil)
        advance(2)
        #expect(quiet.check() == .stalled)
    }
}

@Suite struct VideoRulesTests {
    @Test func `puts the stream's socket beside the RPC socket, with the ticket and nothing of the old address`() {
        #expect(VideoRules.streamURL(rpc: URL(string: "ws://127.0.0.1:4123")!, stream: "abc", ticket: "tk")?.absoluteString == "ws://127.0.0.1:4123/video/abc?ticket=tk")
        #expect(VideoRules.streamURL(rpc: URL(string: "wss://box.example/ws?ticket=old&profile=remote")!, stream: "a/b", ticket: "t k")?.absoluteString == "wss://box.example/video/a%2Fb?ticket=t+k")
    }

    @Test func `opens a dropped or slow stream again five times, then gives way to the picture`() {
        for code in [1006, 1001, VideoClose.slow] {
            #expect(VideoRules.afterClose(code: code, fault: nil, tries: 0) == .again(delayMs: 500))
            #expect(VideoRules.afterClose(code: code, fault: nil, tries: VideoClose.retries - 1) == .again(delayMs: 4_000))
            #expect(VideoRules.afterClose(code: code, fault: nil, tries: VideoClose.retries) == .over(.picture, retry: false))
        }
        #expect(VideoRules.afterClose(code: 0, fault: .decode, tries: 1) == .again(delayMs: 1_000))
        #expect(VideoRules.afterClose(code: 0, fault: .stalled, tries: VideoClose.retries) == .over(.picture, retry: false))
    }

    @Test func `never opens again a stream the host ended, and gives way at once on a phone that cannot decode it`() {
        #expect(VideoRules.afterClose(code: VideoClose.moved, fault: nil, tries: 0) == .over(.picture, retry: false))
        #expect(VideoRules.afterClose(code: VideoClose.busy, fault: nil, tries: 0) == .over(.picture, retry: false))
        #expect(VideoRules.afterClose(code: VideoClose.held, fault: nil, tries: 0) == .over(.kept, retry: false))
        #expect(VideoRules.afterClose(code: VideoClose.ended, fault: nil, tries: 0) == .over(.stopped, retry: false))
        #expect(VideoRules.afterClose(code: VideoClose.revoked, fault: nil, tries: 0) == .over(.stopped, retry: false))
        #expect(VideoRules.afterClose(code: VideoClose.error, fault: nil, tries: 0) == .over(.stopped, retry: true))
        #expect(VideoRules.afterClose(code: VideoClose.permission, fault: nil, tries: 0) == .over(.permission, retry: false))
        #expect(VideoRules.afterClose(code: 0, fault: .unsupported, tries: 0) == .over(.picture, retry: false))
    }
}
