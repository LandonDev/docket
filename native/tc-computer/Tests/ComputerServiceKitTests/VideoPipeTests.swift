@testable import ComputerServiceKit
import Foundation
import Testing

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A socket pair: the service's end as a `VideoPipe`, the host's end as a raw descriptor.
private final class PipePair: @unchecked Sendable {
    let pipe: VideoPipe
    let host: Int32
    private let lock = NSLock()
    private var heard: [VideoRecord] = []
    private var losses: [String] = []

    init() {
        var fds: [Int32] = [0, 0]
        #if canImport(Darwin)
        let kind = SOCK_STREAM
        #else
        let kind = Int32(SOCK_STREAM.rawValue)
        #endif
        precondition(socketpair(AF_UNIX, kind, 0, &fds) == 0)
        pipe = VideoPipe(fd: fds[0])
        host = fds[1]
        pipe.start(onRecord: { [self] record in lock.locked { heard.append(record) } }, onLost: { [self] why in lock.locked { losses.append(why) } })
    }

    var records: [VideoRecord] { lock.locked { heard } }
    var lost: [String] { lock.locked { losses } }

    func hostWrite(_ data: Data) {
        data.withUnsafeBytes { _ = write(host, $0.baseAddress, $0.count) }
    }

    /// What the host reads within `timeout`, cut into records.
    func hostRead(until count: Int, timeout: Duration = .seconds(3)) throws -> [VideoRecord] {
        var reader = VideoRecordReader()
        var out: [VideoRecord] = []
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        let deadline = ContinuousClock.now + timeout
        _ = fcntl(host, F_SETFL, fcntl(host, F_GETFL) | O_NONBLOCK)
        while out.count < count && ContinuousClock.now < deadline {
            let n = read(host, &buffer, buffer.count)
            if n > 0 { out += try reader.push(Data(buffer[0..<n])) } else { usleep(1_000) }
        }
        return out
    }

    deinit {
        close(host)
        close(pipe.fd)
    }
}

@Suite struct VideoPipeTests {
    @Test func onlyASocketOrAPipeIsTheBytesPipe() throws {
        let pair = PipePair()
        #expect(VideoPipe.isSocketOrPipe(pair.host))
        let path = NSTemporaryDirectory() + "tc-pipe-\(UUID().uuidString)"
        FileManager.default.createFile(atPath: path, contents: Data())
        let file = open(path, O_RDONLY)
        defer { close(file); try? FileManager.default.removeItem(atPath: path) }
        #expect(!VideoPipe.isSocketOrPipe(file))
        #expect(!VideoPipe.isSocketOrPipe(9_999))
    }

    @Test func acksComeInOrderWhateverThePieces() async {
        let pair = PipePair()
        var bytes = Data()
        for sequence in UInt32(1)...20 { bytes.append(VideoRecord.ack(stream: 4, generation: 1, sequence: sequence, waitMicros: sequence * 10)) }
        var at = 0
        while at < bytes.count {
            let end = min(bytes.count, at + 7)
            pair.hostWrite(bytes.subdata(in: at..<end))
            at = end
        }
        #expect(await eventually { pair.records.count == 20 })
        #expect(pair.records.map(\.sequence) == Array(1...20))
        #expect(pair.records.last?.ackWaitMicros == 200)
        #expect(pair.lost.isEmpty)
    }

    @Test func recordsGoOutWholeAndInOrderFromManyWriters() async throws {
        let pair = PipePair()
        let unit = Data(repeating: 0xAB, count: 100_000)
        await withTaskGroup(of: Void.self) { group in
            for stream in UInt32(1)...8 {
                group.addTask {
                    for sequence in UInt32(1)...10 {
                        let frame = VideoFrame(generation: 1, sequence: sequence, keyframe: sequence == 1, width: 16, height: 16, captureMicros: 0, accessUnit: unit)
                        pair.pipe.write(try! VideoRecord.frame(stream: stream, frame))
                    }
                }
            }
        }
        let records = try pair.hostRead(until: 80)
        #expect(records.count == 80)
        for stream in UInt32(1)...8 {
            #expect(records.filter { $0.stream == stream }.map(\.sequence) == Array(1...10))
        }
        #expect(records.allSatisfy { $0.payload.count == NSL1.framePrefix + unit.count })
    }

    @Test func aRecordThatCannotBePlacedLosesThePipeOnce() async {
        let pair = PipePair()
        pair.hostWrite(Data(repeating: 0x58, count: 32))
        pair.hostWrite(VideoRecord.ack(stream: 1, generation: 1, sequence: 1))
        #expect(await eventually { pair.lost.count == 1 })
        #expect(pair.records.isEmpty)
        pair.pipe.write(VideoRecord.ack(stream: 1, generation: 1, sequence: 1))
        #expect(pair.pipe.backlog == 0)
        #expect(pair.lost.count == 1)
    }

    @Test func theHostClosingItsEndLosesThePipe() async {
        let pair = PipePair()
        shutdown(pair.host, Int32(SHUT_RDWR))
        #expect(await eventually { pair.lost.count == 1 })
        #expect(pair.pipe.isLost)
    }
}
