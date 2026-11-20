import CoreMedia
import Foundation

/// An H.264 access unit in Annex B form as a `CMSampleBuffer` the phone's display layer takes
/// (docs/agents/live-video.md "The viewer"): the units split on their start codes, the format made from a
/// keyframe's SPS and PPS (again when they change), every other unit written behind its four-byte length.
public enum AccessUnit {
    public struct Unreadable: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// The NAL units of an Annex B access unit, start codes of three and four bytes taken off.
    public static func nalUnits(_ annexB: Data) -> [Data] {
        let b = [UInt8](annexB)
        var starts: [(code: Int, body: Int)] = []
        var i = 0
        while i + 2 < b.count {
            if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
                starts.append((i, i + 3))
                i += 3
            } else {
                i += 1
            }
        }
        return starts.enumerated().compactMap { index, start in
            var end = index + 1 < starts.count ? starts[index + 1].code : b.count
            // a four-byte start code's leading zero, and any trailing zeros, are not the unit's
            while end > start.body, b[end - 1] == 0 { end -= 1 }
            return end > start.body ? Data(b[start.body..<end]) : nil
        }
    }

    public static func type(_ unit: Data) -> Int { Int(unit.first ?? 0) & 0x1F }

    /// The stream's format from an SPS and a PPS.
    public static func format(sps: Data, pps: Data) throws -> CMVideoFormatDescription {
        var format: CMFormatDescription?
        let status = sps.withUnsafeBytes { s in
            pps.withUnsafeBytes { p in
                let pointers = [s.bindMemory(to: UInt8.self).baseAddress!, p.bindMemory(to: UInt8.self).baseAddress!]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
            }
        }
        guard status == noErr, let format else { throw Unreadable(description: "the SPS and PPS make no format (\(status))") }
        return format
    }

    /// One sample of the units that are not parameter sets or delimiters, shown at once.
    public static func sample(_ units: [Data], format: CMVideoFormatDescription, keyframe: Bool) throws -> CMSampleBuffer {
        var bytes = Data()
        for unit in units where ![7, 8, 9].contains(type(unit)) {
            let n = UInt32(unit.count)
            bytes.append(contentsOf: [UInt8(n >> 24), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)])
            bytes.append(unit)
        }
        guard !bytes.isEmpty else { throw Unreadable(description: "an access unit with no picture") }
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes.count, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes.count, flags: 0, blockBufferOut: &block)
        guard status == noErr, let block else { throw Unreadable(description: "no block buffer (\(status))") }
        status = bytes.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes.count) }
        guard status == noErr else { throw Unreadable(description: "the block buffer took no bytes (\(status))") }
        var sample: CMSampleBuffer?
        var size = bytes.count
        status = CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        guard status == noErr, let sample else { throw Unreadable(description: "no sample buffer (\(status))") }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(first, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            if !keyframe {
                CFDictionarySetValue(first, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            }
        }
        return sample
    }
}

/// A stream's frames into samples: the format kept from the last keyframe, made again when its SPS or PPS change.
public struct SampleMaker {
    private var format: CMVideoFormatDescription?
    private var sets: (sps: Data, pps: Data)?

    public init() {}

    /// The format's picture size, once a keyframe made one.
    public var dimensions: CMVideoDimensions? { format.map(CMVideoFormatDescriptionGetDimensions) }

    public mutating func sample(_ frame: NSL1.Frame) throws -> CMSampleBuffer {
        let units = AccessUnit.nalUnits(frame.data)
        if let sps = units.first(where: { AccessUnit.type($0) == 7 }), let pps = units.first(where: { AccessUnit.type($0) == 8 }),
           sets.map({ $0.sps != sps || $0.pps != pps }) ?? true {
            format = try AccessUnit.format(sps: sps, pps: pps)
            sets = (sps, pps)
        }
        guard let format else { throw AccessUnit.Unreadable(description: "a frame before any SPS and PPS") }
        return try AccessUnit.sample(units, format: format, keyframe: frame.keyframe)
    }

    /// A new generation: its keyframe brings its own sets.
    public mutating func reset() {
        format = nil
        sets = nil
    }
}
