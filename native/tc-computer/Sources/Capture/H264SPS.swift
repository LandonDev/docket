import Foundation

/// An H.264 sequence parameter set told that no frame is reordered (docs/computer-protocol.md §30). VideoToolbox
/// writes a VUI with no `bitstream_restriction`, and a decoder then must assume frames may come out of order: Chromium's
/// hardware decoder on the Mac held every frame of a 2560×1664 stream until `flush()` (0 out after 6 in), which with a
/// flow window of one frame is a stream that never starts. We encode with no reordering, so the SPS says so: its VUI
/// gains `bitstream_restriction` with `max_num_reorder_frames` 0 and `max_dec_frame_buffering` the number of reference
/// frames; every field before it is copied bit for bit. Pure.
public enum H264SPS {
    public struct Unsupported: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// What a VUI's bitstream restriction says; nil when the SPS has none.
    public struct Restriction: Equatable, Sendable {
        public let maxNumReorderFrames: Int
        public let maxDecFrameBuffering: Int
    }

    /// The SPS NAL unit (its header byte first, emulation prevention in place) with the restriction written, or as it
    /// was when it already says no reordering.
    public static func withoutReordering(_ nal: Data) throws -> Data {
        let parsed = try parse(nal)
        if parsed.restriction?.maxNumReorderFrames == 0 { return nal }
        var out = parsed.prefix
        // a VUI to come: present, or one with every part absent
        out.write(1, bits: 1)
        if parsed.vuiBody == nil {
            for _ in 0..<8 { out.write(0, bits: 1) } // aspect, overscan, signal, chroma, timing, nal hrd, vcl hrd, pic struct
        } else {
            out.append(parsed.vuiBody!)
        }
        out.write(1, bits: 1) // bitstream_restriction_flag
        out.write(1, bits: 1) // motion_vectors_over_pic_boundaries_flag
        out.writeUE(2) // max_bytes_per_pic_denom
        out.writeUE(1) // max_bits_per_mb_denom
        out.writeUE(16) // log2_max_mv_length_horizontal
        out.writeUE(16) // log2_max_mv_length_vertical
        out.writeUE(0) // max_num_reorder_frames
        out.writeUE(max(1, parsed.maxNumRefFrames)) // max_dec_frame_buffering
        out.write(1, bits: 1) // rbsp_stop_one_bit
        return Data([nal[nal.startIndex]]) + escape(out.bytes())
    }

    /// The bitstream restriction an SPS NAL unit carries.
    public static func restriction(_ nal: Data) throws -> Restriction? {
        try parse(nal).restriction
    }

    private struct Parsed {
        /// every bit up to `vui_parameters_present_flag`, not including it
        let prefix: BitWriter
        /// the VUI's bits up to `bitstream_restriction_flag`, not including it; nil without a VUI
        let vuiBody: BitWriter?
        let maxNumRefFrames: Int
        let restriction: Restriction?
    }

    private static func parse(_ nal: Data) throws -> Parsed {
        guard nal.count > 4, nal[nal.startIndex] & 0x1F == 7 else { throw Unsupported(description: "not an SPS") }
        var r = BitReader(unescape(nal.dropFirst()))
        var w = BitWriter()
        func copy(_ n: Int) throws -> Int { let v = try r.read(n); w.write(v, bits: n); return v }
        func copyUE() throws -> Int { let v = try r.readUE(); w.writeUE(v); return v }
        func copySE() throws { let v = try r.readUE(); w.writeUE(v) } // a signed value's code is copied as it is

        let profile = try copy(8)
        _ = try copy(8) // constraint flags
        _ = try copy(8) // level
        _ = try copyUE() // seq_parameter_set_id
        if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
            if try copyUE() == 3 { _ = try copy(1) } // chroma_format_idc, separate_colour_plane_flag
            _ = try copyUE() // bit_depth_luma_minus8
            _ = try copyUE() // bit_depth_chroma_minus8
            _ = try copy(1) // qpprime_y_zero_transform_bypass_flag
            if try copy(1) == 1 { throw Unsupported(description: "an SPS with scaling lists") }
        }
        _ = try copyUE() // log2_max_frame_num_minus4
        let poc = try copyUE()
        if poc == 0 {
            _ = try copyUE() // log2_max_pic_order_cnt_lsb_minus4
        } else if poc == 1 {
            _ = try copy(1)
            try copySE()
            try copySE()
            let cycle = try copyUE()
            for _ in 0..<cycle { try copySE() }
        }
        let refs = try copyUE() // max_num_ref_frames
        _ = try copy(1) // gaps_in_frame_num_value_allowed_flag
        _ = try copyUE() // pic_width_in_mbs_minus1
        _ = try copyUE() // pic_height_in_map_units_minus1
        if try copy(1) == 0 { _ = try copy(1) } // frame_mbs_only_flag, mb_adaptive_frame_field_flag
        _ = try copy(1) // direct_8x8_inference_flag
        if try copy(1) == 1 { for _ in 0..<4 { _ = try copyUE() } } // frame_cropping
        let prefix = w
        guard try r.read(1) == 1 else { return Parsed(prefix: prefix, vuiBody: nil, maxNumRefFrames: refs, restriction: nil) }

        w = BitWriter()
        if try copy(1) == 1, try copy(8) == 255 { _ = try copy(16); _ = try copy(16) } // aspect ratio
        if try copy(1) == 1 { _ = try copy(1) } // overscan
        if try copy(1) == 1 { // video signal type
            _ = try copy(3)
            _ = try copy(1)
            if try copy(1) == 1 { _ = try copy(8); _ = try copy(8); _ = try copy(8) }
        }
        if try copy(1) == 1 { _ = try copyUE(); _ = try copyUE() } // chroma location
        if try copy(1) == 1 { _ = try copy(32); _ = try copy(32); _ = try copy(1) } // timing
        func hrd() throws {
            let count = try copyUE()
            _ = try copy(4)
            _ = try copy(4)
            for _ in 0...count { _ = try copyUE(); _ = try copyUE(); _ = try copy(1) }
            for _ in 0..<4 { _ = try copy(5) }
        }
        let nalHRD = try copy(1)
        if nalHRD == 1 { try hrd() }
        let vclHRD = try copy(1)
        if vclHRD == 1 { try hrd() }
        if nalHRD == 1 || vclHRD == 1 { _ = try copy(1) } // low_delay_hrd_flag
        _ = try copy(1) // pic_struct_present_flag
        var restriction: Restriction?
        if try r.read(1) == 1 {
            _ = try r.read(1)
            for _ in 0..<4 { _ = try r.readUE() }
            restriction = Restriction(maxNumReorderFrames: try r.readUE(), maxDecFrameBuffering: try r.readUE())
        }
        return Parsed(prefix: prefix, vuiBody: w, maxNumRefFrames: refs, restriction: restriction)
    }

    /// The RBSP of a NAL unit's payload: each `00 00 03` loses its 03.
    static func unescape(_ bytes: Data) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(bytes.count)
        var zeros = 0
        for byte in bytes {
            if zeros >= 2 && byte == 3 {
                zeros = 0
                continue
            }
            out.append(byte)
            zeros = byte == 0 ? zeros + 1 : 0
        }
        return out
    }

    /// An RBSP as a NAL unit's payload: a 03 goes in wherever two zeros come before a byte of 3 or less.
    static func escape(_ bytes: [UInt8]) -> Data {
        var out = Data(capacity: bytes.count + 4)
        var zeros = 0
        for byte in bytes {
            if zeros >= 2 && byte <= 3 {
                out.append(3)
                zeros = 0
            }
            out.append(byte)
            zeros = byte == 0 ? zeros + 1 : 0
        }
        return out
    }
}

struct BitReader {
    private let bytes: [UInt8]
    private var at = 0

    init(_ bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func read(_ count: Int) throws -> Int {
        var value = 0
        for _ in 0..<count {
            guard at < bytes.count * 8 else { throw H264SPS.Unsupported(description: "an SPS cut short") }
            value = value << 1 | Int(bytes[at >> 3] >> (7 - UInt8(at & 7)) & 1)
            at += 1
        }
        return value
    }

    mutating func readUE() throws -> Int {
        var zeros = 0
        while try read(1) == 0 {
            zeros += 1
            guard zeros < 32 else { throw H264SPS.Unsupported(description: "an Exp-Golomb code past 32 bits") }
        }
        return (1 << zeros) - 1 + (zeros > 0 ? try read(zeros) : 0)
    }
}

struct BitWriter {
    private(set) var bits: [Bool] = []

    mutating func write(_ value: Int, bits count: Int) {
        for shift in stride(from: count - 1, through: 0, by: -1) { bits.append(value >> shift & 1 == 1) }
    }

    mutating func writeUE(_ value: Int) {
        let code = value + 1
        let width = Int.bitWidth - code.leadingZeroBitCount
        write(0, bits: width - 1)
        write(code, bits: width)
    }

    mutating func append(_ other: BitWriter) {
        bits.append(contentsOf: other.bits)
    }

    /// The bits, padded with zeros to a whole byte (the stop bit is the caller's).
    func bytes() -> [UInt8] {
        var out = [UInt8](repeating: 0, count: (bits.count + 7) / 8)
        for (index, bit) in bits.enumerated() where bit { out[index >> 3] |= 0x80 >> UInt8(index & 7) }
        return out
    }
}
