import Foundation

/// The NSL1 wire on the phone (docs/agents/live-video.md "The wire"): a live
/// stream's own socket carries one message per WebSocket message, a 20-byte
/// big-endian header and its payload. The phone reads frames and writes acks,
/// byte for byte as `src/shared/video/nsl1.ts` (from screen-relay 0.1.2).
public enum NSL1 {
    public static let magic: UInt32 = 0x4E53_4C31
    public static let version: UInt8 = 1
    public static let headerSize = 20
    /// width, height and the capture time, ahead of a frame's access unit
    public static let framePrefix = 12
    public static let maxBytesInFlight = 8 * 1024 * 1024
    /// the largest whole message: the header, a frame's prefix and an access unit of 8 MiB
    public static let maxMessageBytes = headerSize + framePrefix + maxBytesInFlight
    public static let subprotocol = "nsl1"
    static let frameType: UInt8 = 1
    static let ackType: UInt8 = 2
    static let lastType: UInt8 = 6

    public struct Malformed: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// One frame as the source sent it.
    public struct Frame: Equatable, Sendable {
        public let generation: UInt32
        public let sequence: UInt32
        public let keyframe: Bool
        public let width: Int
        public let height: Int
        /// when the source captured it, µs on the source's clock
        public let timestamp: UInt64
        /// one H.264 access unit in Annex B form
        public let data: Data
    }

    /// Decodes one frame message; throws for any other type or a malformed one.
    public static func parseFrame(_ bytes: Data) throws -> Frame {
        let b = [UInt8](bytes)
        guard b.count >= headerSize, b.count <= maxMessageBytes else { throw Malformed(description: "Invalid message length") }
        let type = b[5], flags = UInt16(b[6]) << 8 | UInt16(b[7])
        let generation = read32(b, 8), sequence = read32(b, 12), size = Int(read32(b, 16))
        guard read32(b, 0) == magic, b[4] == version, (1...lastType).contains(type), flags <= (type == frameType ? 1 : 0),
              generation != 0, size == b.count - headerSize else { throw Malformed(description: "Invalid message envelope") }
        guard type == frameType else { throw Malformed(description: "Invalid message type") }
        guard size >= framePrefix + 1, sequence != 0 else { throw Malformed(description: "Invalid frame header") }
        let width = Int(b[20]) << 8 | Int(b[21]), height = Int(b[22]) << 8 | Int(b[23])
        let timestamp = (24..<32).reduce(UInt64(0)) { $0 << 8 | UInt64(b[$1]) }
        guard width > 0, height > 0, timestamp <= 9_007_199_254_740_991 else { throw Malformed(description: "Invalid frame header") }
        return Frame(generation: generation, sequence: sequence, keyframe: flags == 1, width: width, height: height, timestamp: timestamp, data: Data(b[(headerSize + framePrefix)...]))
    }

    /// An ack for one frame, carrying how long it waited on the phone in microseconds (saturating at 2^32 − 1);
    /// without a wait, the bare 20-byte ack.
    public static func encodeAck(generation: UInt32, sequence: UInt32, waitMs: Double? = nil) -> Data {
        var out = header(type: ackType, generation: generation, sequence: sequence, size: waitMs == nil ? 0 : 4)
        if let waitMs {
            let micros = waitMs.isFinite ? UInt32(min(4_294_967_295, max(0, (waitMs * 1000).rounded()))) : 0
            out.append(contentsOf: [UInt8(micros >> 24), UInt8(micros >> 16 & 0xFF), UInt8(micros >> 8 & 0xFF), UInt8(micros & 0xFF)])
        }
        return out
    }

    static func header(type: UInt8, generation: UInt32, sequence: UInt32, size: Int, flags: UInt16 = 0) -> Data {
        var out = Data(capacity: headerSize + size)
        for value in [magic] { out.append(contentsOf: be32(value)) }
        out.append(version)
        out.append(type)
        out.append(contentsOf: [UInt8(flags >> 8), UInt8(flags & 0xFF)])
        out.append(contentsOf: be32(generation))
        out.append(contentsOf: be32(sequence))
        out.append(contentsOf: be32(UInt32(size)))
        return out
    }

    private static func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)] }

    private static func read32(_ b: [UInt8], _ at: Int) -> UInt32 {
        UInt32(b[at]) << 24 | UInt32(b[at + 1]) << 16 | UInt32(b[at + 2]) << 8 | UInt32(b[at + 3])
    }
}
