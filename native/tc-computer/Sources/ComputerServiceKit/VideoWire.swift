import ComputerProtocol
import Foundation

/// The bytes pipe between the host and the service (docs/computer-protocol.md §30): file descriptor 3,
/// both ways. A record is the stream's number as four bytes, big-endian, then one whole NSL1 message:
/// a 20-byte big-endian header (magic, version, type, flags, generation, sequence, payload length) and its
/// payload. The service writes frames and reads acks. `src/shared/video/nsl1.ts` and
/// `src/shared/computer/videoPipe.ts` are the same bytes on the host's side.
public enum NSL1 {
    public static let magic: UInt32 = 0x4e53_4c31
    public static let version: UInt8 = 1
    public static let headerSize = 20
    /// width, height and the capture time, ahead of a frame's access unit
    public static let framePrefix = 12
    public static let maxAccessUnit = 8 * 1_024 * 1_024
    /// the largest whole message: the header, a frame's prefix and an access unit of 8 MiB
    public static let maxMessage = headerSize + framePrefix + maxAccessUnit
    public static let idBytes = ComputerDefaults.VideoStream.pipeIdBytes

    public static let frameType: UInt8 = 1
    public static let ackType: UInt8 = 2
    public static let keyframeFlag: UInt16 = 1
}

public struct VideoWireError: Error, Equatable, Sendable, CustomStringConvertible {
    public let description: String

    public init(_ description: String) {
        self.description = description
    }
}

/// One encoded picture, as a frame message carries it.
public struct VideoFrame: Equatable, Sendable {
    public var generation: UInt32
    public var sequence: UInt32
    public var keyframe: Bool
    public var width: Int
    public var height: Int
    /// when the capture took the picture, in microseconds on the monotonic clock
    public var captureMicros: UInt64
    /// one H.264 access unit in Annex B form
    public var accessUnit: Data

    public init(generation: UInt32, sequence: UInt32, keyframe: Bool, width: Int, height: Int, captureMicros: UInt64, accessUnit: Data) {
        self.generation = generation
        self.sequence = sequence
        self.keyframe = keyframe
        self.width = width
        self.height = height
        self.captureMicros = captureMicros
        self.accessUnit = accessUnit
    }
}

/// One record read off the pipe: the stream's number and one message's header and payload.
public struct VideoRecord: Equatable, Sendable {
    public var stream: UInt32
    public var type: UInt8
    public var flags: UInt16
    public var generation: UInt32
    public var sequence: UInt32
    public var payload: Data

    public init(stream: UInt32, type: UInt8, flags: UInt16, generation: UInt32, sequence: UInt32, payload: Data) {
        self.stream = stream
        self.type = type
        self.flags = flags
        self.generation = generation
        self.sequence = sequence
        self.payload = payload
    }

    /// An ack's viewer wait in microseconds: four bytes, else 0 (screen-relay's `ackWaitUs`).
    public var ackWaitMicros: UInt64 {
        guard payload.count == 4 else { return 0 }
        return payload.reduce(0) { $0 << 8 | UInt64($1) }
    }

    /// The record for one frame of `stream`, whole: what the service writes.
    public static func frame(stream: UInt32, _ frame: VideoFrame) throws -> Data {
        guard stream > 0 else { throw VideoWireError("Invalid stream number") }
        guard frame.generation > 0 else { throw VideoWireError("Invalid generation") }
        guard frame.sequence > 0 else { throw VideoWireError("Invalid frame sequence") }
        guard (1...0xFFFF).contains(frame.width), (1...0xFFFF).contains(frame.height) else { throw VideoWireError("Invalid picture size") }
        guard (1...NSL1.maxAccessUnit).contains(frame.accessUnit.count) else { throw VideoWireError("Invalid access unit") }
        var out = Data(capacity: NSL1.idBytes + NSL1.headerSize + NSL1.framePrefix + frame.accessUnit.count)
        out.append(be: stream)
        out.appendHeader(type: NSL1.frameType, flags: frame.keyframe ? NSL1.keyframeFlag : 0, generation: frame.generation, sequence: frame.sequence, length: NSL1.framePrefix + frame.accessUnit.count)
        out.append(be: UInt16(frame.width))
        out.append(be: UInt16(frame.height))
        out.append(be: frame.captureMicros)
        out.append(frame.accessUnit)
        return out
    }

    /// The record for one ack, with the viewer's wait when given: what the host writes (the tests and fakes).
    public static func ack(stream: UInt32, generation: UInt32, sequence: UInt32, waitMicros: UInt32? = nil) -> Data {
        var out = Data()
        out.append(be: stream)
        out.appendHeader(type: NSL1.ackType, flags: 0, generation: generation, sequence: sequence, length: waitMicros == nil ? 0 : 4)
        if let waitMicros { out.append(be: waitMicros) }
        return out
    }
}

/// Cuts the pipe's bytes into records as they come, in whatever pieces. A record whose stream number is 0,
/// that has no NSL1 magic after its number, or that names a message past the wire's limit throws: the pipe
/// has lost its place and cannot find it again.
public struct VideoRecordReader: Sendable {
    private var buffer: [UInt8] = []
    private var start = 0

    public init() {}

    public mutating func push(_ chunk: Data) throws -> [VideoRecord] {
        buffer.append(contentsOf: chunk)
        var out: [VideoRecord] = []
        let head = NSL1.idBytes + NSL1.headerSize
        while buffer.count - start >= head {
            let stream = read32(start)
            guard stream != 0, read32(start + 4) == NSL1.magic else { throw VideoWireError("The bytes pipe lost its place") }
            let length = NSL1.headerSize + Int(read32(start + 4 + 16))
            guard length <= NSL1.maxMessage else { throw VideoWireError("A message on the bytes pipe is larger than the wire allows") }
            guard buffer.count - start >= NSL1.idBytes + length else { break }
            let message = start + NSL1.idBytes
            out.append(VideoRecord(
                stream: stream, type: buffer[message + 5], flags: UInt16(buffer[message + 6]) << 8 | UInt16(buffer[message + 7]),
                generation: read32(message + 8), sequence: read32(message + 12),
                payload: Data(buffer[(message + NSL1.headerSize)..<(message + length)])
            ))
            start += NSL1.idBytes + length
        }
        if start == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            start = 0
        } else if start > 64 * 1_024 {
            buffer.removeFirst(start)
            start = 0
        }
        return out
    }

    private func read32(_ at: Int) -> UInt32 {
        UInt32(buffer[at]) << 24 | UInt32(buffer[at + 1]) << 16 | UInt32(buffer[at + 2]) << 8 | UInt32(buffer[at + 3])
    }
}

extension Data {
    mutating func append<T: FixedWidthInteger>(be value: T) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }

    mutating func appendHeader(type: UInt8, flags: UInt16, generation: UInt32, sequence: UInt32, length: Int) {
        append(be: NSL1.magic)
        append(NSL1.version)
        append(type)
        append(be: flags)
        append(be: generation)
        append(be: sequence)
        append(be: UInt32(length))
    }
}
