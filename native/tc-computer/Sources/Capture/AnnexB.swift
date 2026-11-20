import Foundation

/// H.264 from VideoToolbox's form to the wire's (docs/computer-protocol.md §30). The encoder writes each
/// NAL unit behind its length (AVCC) and keeps the SPS and PPS in the format description; the viewer
/// (WebCodecs with no `description`) reads Annex B: each NAL unit behind a start code, and a keyframe's
/// parameter sets ahead of its slices. Pure.
public enum AnnexB {
    public static let startCode: [UInt8] = [0, 0, 0, 1]

    public struct Malformed: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// One access unit: `parameterSets` (a keyframe's SPS and PPS, else none) then every NAL unit of
    /// `avcc`, whose lengths are `lengthSize` bytes big-endian. Throws on a length that runs past the end.
    public static func accessUnit(avcc: Data, lengthSize: Int, parameterSets: [Data] = []) throws -> Data {
        guard [1, 2, 4].contains(lengthSize) else { throw Malformed(description: "a NAL length of \(lengthSize) bytes") }
        var out = Data(capacity: avcc.count + parameterSets.reduce(0) { $0 + $1.count + 4 } + 16)
        for set in parameterSets where !set.isEmpty {
            out.append(contentsOf: startCode)
            out.append(set)
        }
        try avcc.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var at = 0
            while at < raw.count {
                guard raw.count - at >= lengthSize else { throw Malformed(description: "a NAL length cut short at byte \(at)") }
                var length = 0
                for i in 0..<lengthSize { length = length << 8 | Int(raw[at + i]) }
                at += lengthSize
                guard length > 0, length <= raw.count - at else { throw Malformed(description: "a NAL unit of \(length) bytes past the end at byte \(at)") }
                out.append(contentsOf: startCode)
                out.append(contentsOf: UnsafeRawBufferPointer(rebasing: raw[at..<(at + length)]))
                at += length
            }
        }
        return out
    }

    /// The NAL unit types of an Annex B access unit, in order (5 an IDR slice, 7 an SPS, 8 a PPS).
    public static func unitTypes(_ annexB: Data) -> [Int] {
        let bytes = [UInt8](annexB)
        var types: [Int] = []
        var i = 0
        while i + 3 < bytes.count {
            if bytes[i] == 0 && bytes[i + 1] == 0 && (bytes[i + 2] == 1 || (bytes[i + 2] == 0 && bytes[i + 3] == 1)) {
                let head = i + (bytes[i + 2] == 1 ? 3 : 4)
                if head < bytes.count { types.append(Int(bytes[head] & 0x1F)) }
                i = head
            } else {
                i += 1
            }
        }
        return types
    }
}
