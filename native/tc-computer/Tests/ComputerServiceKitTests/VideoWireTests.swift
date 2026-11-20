@testable import ComputerServiceKit
import Foundation
import Testing

@Suite struct VideoWireTests {
    private let unit = Data([0, 0, 0, 1, 0x65, 0xAA])

    @Test func aFrameRecordIsTheStreamThenTheHeaderThenThePayload() throws {
        let frame = VideoFrame(generation: 1, sequence: 2, keyframe: true, width: 640, height: 400, captureMicros: 0x0102_0304_0506_0708, accessUnit: unit)
        let bytes = try VideoRecord.frame(stream: 7, frame)
        #expect([UInt8](bytes) == [
            0, 0, 0, 7,                 // stream
            0x4E, 0x53, 0x4C, 0x31,     // NSL1
            1, 1, 0, 1,                 // version, frame, keyframe
            0, 0, 0, 1,                 // generation
            0, 0, 0, 2,                 // sequence
            0, 0, 0, 18,                // payload: 12 + 6
            0x02, 0x80, 0x01, 0x90,     // 640 × 400
            1, 2, 3, 4, 5, 6, 7, 8,     // capture time
            0, 0, 0, 1, 0x65, 0xAA
        ])
        var delta = frame
        delta.keyframe = false
        #expect(try VideoRecord.frame(stream: 7, delta)[10...11] == Data([0, 0]))
    }

    @Test func aFrameOutsideTheWireIsRefused() {
        let good = VideoFrame(generation: 1, sequence: 1, keyframe: true, width: 2, height: 2, captureMicros: 0, accessUnit: unit)
        var bad = [good, good, good, good, good]
        bad[0].generation = 0
        bad[1].sequence = 0
        bad[2].width = 0
        bad[3].height = 70_000
        bad[4].accessUnit = Data()
        for frame in bad { #expect(throws: VideoWireError.self) { try VideoRecord.frame(stream: 1, frame) } }
        #expect(throws: VideoWireError.self) { try VideoRecord.frame(stream: 0, good) }
    }

    @Test func anAckIsTheBareHeaderOrFourBytesOfWait() {
        #expect([UInt8](VideoRecord.ack(stream: 3, generation: 2, sequence: 9)) == [0, 0, 0, 3, 0x4E, 0x53, 0x4C, 0x31, 1, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 9, 0, 0, 0, 0])
        #expect([UInt8](VideoRecord.ack(stream: 3, generation: 2, sequence: 9, waitMicros: 10_000).suffix(8)) == [0, 0, 0, 4, 0, 0, 0x27, 0x10])
    }

    @Test func theReaderTakesRecordsInOddPieces() throws {
        let frame = VideoFrame(generation: 4, sequence: 5, keyframe: false, width: 8, height: 6, captureMicros: 99, accessUnit: unit)
        var stream = try VideoRecord.frame(stream: 2, frame)
        stream.append(VideoRecord.ack(stream: 9, generation: 1, sequence: 1, waitMicros: 300))
        stream.append(VideoRecord.ack(stream: 9, generation: 1, sequence: 2))
        var reader = VideoRecordReader()
        var records: [VideoRecord] = []
        var at = 0
        for size in [1, 3, 2, 17, 5, 1, 40, 7, 1_000] where at < stream.count {
            let end = min(stream.count, at + size)
            records += try reader.push(stream.subdata(in: at..<end))
            at = end
        }
        #expect(at == stream.count)
        #expect(records.count == 3)
        #expect(records[0] == VideoRecord(stream: 2, type: 1, flags: 0, generation: 4, sequence: 5, payload: stream.subdata(in: 24..<(24 + 18))))
        #expect(records[1].stream == 9 && records[1].type == NSL1.ackType && records[1].sequence == 1 && records[1].ackWaitMicros == 300)
        #expect(records[2].sequence == 2 && records[2].ackWaitMicros == 0)
        let rest = try reader.push(Data())
        #expect(rest.isEmpty)
    }

    @Test func aRecordWithNoMagicOrPastTheLimitLosesThePlace() throws {
        var reader = VideoRecordReader()
        #expect(throws: VideoWireError.self) { try reader.push(Data(repeating: 0x58, count: 32)) }

        var zero = VideoRecordReader()
        var noStream = VideoRecord.ack(stream: 1, generation: 1, sequence: 1)
        noStream[3] = 0
        #expect(throws: VideoWireError.self) { try zero.push(noStream) }

        var long = VideoRecordReader()
        var head = VideoRecord.ack(stream: 1, generation: 1, sequence: 1)
        let over = UInt32(NSL1.framePrefix + NSL1.maxAccessUnit + 1)
        head.replaceSubrange(20..<24, with: withUnsafeBytes(of: over.bigEndian) { Data($0) })
        #expect(throws: VideoWireError.self) { try long.push(head) }

        // the limit itself is a whole record still to come, not an error
        var limit = VideoRecordReader()
        var largest = VideoRecord.ack(stream: 1, generation: 1, sequence: 1)
        largest.replaceSubrange(20..<24, with: withUnsafeBytes(of: (over - 1).bigEndian) { Data($0) })
        let whole = try limit.push(largest)
        #expect(whole.isEmpty)
    }
}
