#if canImport(ScreenCaptureKit)

import AppKit
import ComputerCore
import ComputerProtocol
import CoreMedia
import CoreVideo
import Foundation
import os
@preconcurrency import ScreenCaptureKit
import VideoToolbox

extension ScreenCaptureKitCapture: VideoCapturing {
    /// One SCStream on the window in NV12, BT.709, at the window's own pixels fitted to `maxEdge`, at the
    /// display's own rate (docs/computer-protocol.md §30). Streams join it through `addEncoder`.
    public func startVideo(windowID: UInt32, fps: Int, maxEdge: Int) async throws -> any WindowVideo {
        let (window, bounds) = try await target(windowID)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let refresh = await MainActor.run { WindowVideoCapture.refreshRate(of: bounds) }
        let capture = WindowVideoCapture(windowID: windowID, filter: filter, points: bounds.size, rate: max(refresh, fps), maxEdge: maxEdge, videoRate: videoRate, trace: trace)
        do {
            try await capture.start()
        } catch {
            throw CaptureErrors.failure(error, windowID: windowID)
        }
        return capture
    }
}

/// A picture the capture took: ScreenCaptureKit's buffer, when it showed, and when our callback ran.
struct VideoPicture: @unchecked Sendable {
    let buffer: CVPixelBuffer
    /// the frame's display time on the monotonic clock, µs
    let captureMicros: UInt64
    let enteredMicros: UInt64
}

/// One window's capture for every video stream of it. Samples, encoders and the closed check all run on the
/// window's serial queue; the lock guards the end against `ended()` readers.
final class WindowVideoCapture: NSObject, WindowVideo, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let windowID: UInt32
    let queue: DispatchQueue
    /// the window's own pixels now: set on the queue as the window resizes, read by the shell
    private let current: OSAllocatedUnfairLock<PixelSize>
    var pixels: PixelSize { current.withLock { $0 } }
    private let filter: SCContentFilter
    private let pointPixelScale: Double
    private let rate: Int
    private let videoRate: @Sendable (VideoMode) -> VideoRate
    private let trace: CaptureTraceHandler?
    private var stream: SCStream?
    private var clock: DispatchSourceTimer?
    // on the queue
    private var encoders: [VideoEncoderSession] = []
    private var stopping = false
    private(set) var last: VideoPicture?
    private var size: PixelSize
    private var points: CGSize
    // under the lock
    private struct End {
        var finished: StreamEndReason?
        var waiters: [CheckedContinuation<StreamEndReason, Never>] = []
    }
    private let end = OSAllocatedUnfairLock(uncheckedState: End())

    init(windowID: UInt32, filter: SCContentFilter, points: CGSize, rate: Int, maxEdge: Int, videoRate: @escaping @Sendable (VideoMode) -> VideoRate, trace: CaptureTraceHandler?) {
        self.windowID = windowID
        self.videoRate = videoRate
        self.filter = filter
        self.points = points
        self.rate = rate
        self.trace = trace
        pointPixelScale = Double(filter.pointPixelScale)
        let pixels = Self.pixels(points, scale: Double(filter.pointPixelScale))
        current = OSAllocatedUnfairLock(initialState: pixels)
        size = VideoGeometry.picture(pixels, maxEdge: maxEdge)
        queue = DispatchQueue(label: "tc.capture.video.\(windowID).\(UUID().uuidString.prefix(8))", qos: .userInteractive)
        super.init()
    }

    static func pixels(_ points: CGSize, scale: Double) -> PixelSize {
        PixelSize(width: max(1, Int((Double(points.width) * scale).rounded())), height: max(1, Int((Double(points.height) * scale).rounded())))
    }

    /// `NSScreen.maximumFramesPerSecond` of the screen under the window's centre (global top-left points).
    @MainActor static func refreshRate(of bounds: CGRect) -> Int {
        var display: CGDirectDisplayID = 0
        var count: UInt32 = 0
        guard CGGetDisplaysWithPoint(CGPoint(x: bounds.midX, y: bounds.midY), 1, &display, &count) == .success, count > 0 else {
            return NSScreen.main?.maximumFramesPerSecond ?? VideoTuning.fallbackRefresh
        }
        let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display }
        let rate = screen?.maximumFramesPerSecond ?? 0
        return rate > 0 ? rate : VideoTuning.fallbackRefresh
    }

    func start() async throws {
        let stream = SCStream(filter: filter, configuration: configuration(size), delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await withDeadline(CaptureTuning.streamStartTimeout, failure: ComputerFailure.captureTimedOut) { try await stream.startCapture() }
        queue.async { self.startClock() }
    }

    private func configuration(_ size: PixelSize) -> SCStreamConfiguration {
        let configuration = ScreenCaptureKitCapture.configuration(width: size.width, height: size.height, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(rate))
        configuration.queueDepth = VideoTuning.queueDepth
        return configuration
    }

    // MARK: WindowVideo

    func addEncoder(_ spec: VideoEncoderSpec, output: any VideoOutput) throws -> any VideoEncoder {
        let encoder = VideoEncoderSession(spec: spec, rate: videoRate(spec.mode), output: output, queue: queue) { [weak self] in self?.last }
        let size = try queue.sync { () throws -> PixelSize in
            // on the queue, so the capture cannot end between this check and the encoder joining it
            guard end.withLockUnchecked({ $0.finished == nil }) else { throw ComputerFailure.windowGone(windowID) }
            // the window's pixels now, which a resize since the shell read them may have changed
            let size = VideoGeometry.picture(pixels, maxEdge: spec.maxEdge)
            try encoder.open(size: size)
            encoders.append(encoder)
            fitCapture()
            return size
        }
        trace?(.videoEncoder(window: windowID, width: size.width, height: size.height, mode: spec.mode.rawValue))
        return encoder
    }

    func removeEncoder(_ encoder: any VideoEncoder) {
        queue.async {
            guard let index = self.encoders.firstIndex(where: { $0 === encoder }) else { return }
            self.encoders.remove(at: index).close()
            self.fitCapture()
        }
    }

    func stop() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                // an error ScreenCaptureKit reports while our own stop is in flight is still our stop
                self.stopping = true
                guard let stream = self.stream else { return done.resume() }
                stream.stopCapture { _ in done.resume() }
            }
        }
        queue.sync { finish(.stopped) }
    }

    var isOver: Bool { end.withLockUnchecked { $0.finished != nil } }

    func ended() async -> StreamEndReason {
        await withCheckedContinuation { continuation in
            let finished = end.withLockUnchecked { state -> StreamEndReason? in
                if state.finished == nil { state.waiters.append(continuation) }
                return state.finished
            }
            if let finished { continuation.resume(returning: finished) }
        }
    }

    // MARK: Samples

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        let entered = monotonicMicros()
        guard type == .screen, let info = FrameInfo(sampleBuffer), info.status == .complete, let buffer = sampleBuffer.imageBuffer else { return }
        let picture = VideoPicture(buffer: buffer, captureMicros: machMicros(info.displayTime), enteredMicros: entered)
        trace?(.videoPicture(window: windowID, captureMicros: picture.captureMicros, dirty: info.dirtyRects))
        // ScreenCaptureKit marks all of the window dirty in every sample, so a sample after a rest is held
        // against the last: the same pixels are no change, and the still window stays at rest
        if let last, picture.captureMicros >= last.captureMicros + UInt64(ComputerDefaults.VideoStream.sharpenAfterMs) * 1_000,
           Self.samePixels(buffer, last.buffer) { return }
        last = picture
        for encoder in encoders { encoder.offer(picture, again: false) }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        queue.async {
            var reason = CaptureErrors.endReason(error)
            if case .error = reason, LiveWindows.bounds(self.windowID) == nil { reason = .windowClosed }
            self.finish(self.stopping ? .stopped : reason)
        }
    }

    /// Whether two NV12 buffers hold the same pixels, row by row over both planes.
    static func samePixels(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Bool {
        guard CVPixelBufferGetWidth(a) == CVPixelBufferGetWidth(b), CVPixelBufferGetHeight(a) == CVPixelBufferGetHeight(b),
              CVPixelBufferGetPixelFormatType(a) == CVPixelBufferGetPixelFormatType(b),
              CVPixelBufferLockBaseAddress(a, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(a, .readOnly) }
        guard CVPixelBufferLockBaseAddress(b, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
        let planes = max(1, CVPixelBufferGetPlaneCount(a))
        for plane in 0..<planes {
            let planar = CVPixelBufferIsPlanar(a)
            guard let baseA = planar ? CVPixelBufferGetBaseAddressOfPlane(a, plane) : CVPixelBufferGetBaseAddress(a),
                  let baseB = planar ? CVPixelBufferGetBaseAddressOfPlane(b, plane) : CVPixelBufferGetBaseAddress(b) else { return false }
            let rows = planar ? CVPixelBufferGetHeightOfPlane(a, plane) : CVPixelBufferGetHeight(a)
            let strideA = planar ? CVPixelBufferGetBytesPerRowOfPlane(a, plane) : CVPixelBufferGetBytesPerRow(a)
            let strideB = planar ? CVPixelBufferGetBytesPerRowOfPlane(b, plane) : CVPixelBufferGetBytesPerRow(b)
            let width = planar ? CVPixelBufferGetWidthOfPlane(a, plane) : CVPixelBufferGetWidth(a)
            let rowBytes = min(strideA, strideB, width * (planar ? (plane == 0 ? 1 : 2) : 4))
            for row in 0..<rows where memcmp(baseA + row * strideA, baseB + row * strideB, rowBytes) != 0 { return false }
        }
        return true
    }

    // MARK: Size

    /// The capture's size is the largest picture its encoders want, so the largest gets the buffer as it is.
    private func fitCapture() {
        let largest = encoders.map(\.size).max { $0.width * $0.height < $1.width * $1.height } ?? size
        guard largest != size else { return }
        size = largest
        stream?.updateConfiguration(configuration(largest)) { _ in }
    }

    /// The window's live size off the one the capture is configured for by more than 1% on either side:
    /// the encoders take it, and each whose picture size changes starts a new generation.
    private func resizeIfNeeded(_ live: CGSize) {
        guard live.width > 0, live.height > 0 else { return }
        let off = abs(Double(live.width) - Double(points.width)) / Double(points.width) > VideoTuning.resizeTolerance
            || abs(Double(live.height) - Double(points.height)) / Double(points.height) > VideoTuning.resizeTolerance
        guard off else { return }
        points = live
        let now = Self.pixels(live, scale: pointPixelScale)
        current.withLock { $0 = now }
        for encoder in encoders { encoder.resize(to: now) }
        fitCapture()
        trace?(.videoResized(window: windowID, width: now.width, height: now.height))
    }

    // MARK: The end

    private func startClock() {
        guard end.withLockUnchecked({ $0.finished == nil }) else { return }
        let clock = DispatchSource.makeTimerSource(queue: queue)
        let every = VideoTuning.windowCheck.timeInterval
        clock.schedule(deadline: .now() + every, repeating: every)
        clock.setEventHandler { [weak self] in
            guard let self else { return }
            guard let bounds = LiveWindows.bounds(windowID) else {
                stream?.stopCapture { _ in }
                return finish(.windowClosed)
            }
            resizeIfNeeded(bounds.size)
        }
        clock.resume()
        self.clock = clock
    }

    /// On the queue: every encoder closes, the waiters hear the reason, once.
    private func finish(_ reason: StreamEndReason) {
        let waiters = end.withLockUnchecked { state -> [CheckedContinuation<StreamEndReason, Never>]? in
            guard state.finished == nil else { return nil }
            state.finished = reason
            defer { state.waiters = [] }
            return state.waiters
        }
        guard let waiters else { return }
        clock?.cancel()
        clock = nil
        for encoder in encoders { encoder.close() }
        encoders = []
        last = nil
        stream = nil
        trace?(.videoEnded(window: windowID, reason: "\(reason)"))
        for waiter in waiters { waiter.resume(returning: reason) }
    }
}

/// One stream's encoder: a VTCompressionSession of its picture's size, H.264, on the capture's queue.
final class VideoEncoderSession: VideoEncoder, @unchecked Sendable {
    let spec: VideoEncoderSpec
    let rate: VideoRate
    private let output: any VideoOutput
    private let queue: DispatchQueue
    /// the capture's last picture, read on the queue
    private let last: () -> VideoPicture?
    /// the picture's size when the encoder joined: `capture.video.start`'s answer
    private(set) var startSize: PixelSize
    // on the queue
    private(set) var size: PixelSize
    private var session: VTCompressionSession?
    /// every frame submitted and not yet settled with the stream: each is settled exactly once
    private var owed: [UInt64: Bool] = [:]
    private var nextSubmit: UInt64 = 0
    private var transfer: VTPixelTransferSession?
    private var generation: UInt32 = 0
    private var keyNext = true
    private var bitrate: Int
    private var lastPTS: Int64 = 0
    private var failures = 0
    private var closed = false

    /// Every call but the four of `VideoEncoder` runs on `queue`, the capture's.
    init(spec: VideoEncoderSpec, rate: VideoRate? = nil, output: any VideoOutput, queue: DispatchQueue, last: @escaping () -> VideoPicture?) {
        self.spec = spec
        self.rate = rate ?? .standard(spec.mode)
        self.output = output
        self.queue = queue
        self.last = last
        size = spec.size
        startSize = spec.size
        bitrate = spec.bitrate
    }

    // MARK: VideoEncoder

    func setBitrate(_ bitsPerSecond: Int) {
        queue.async { [self] in
            guard spec.mode == .budget, bitsPerSecond != bitrate, let session else { return }
            bitrate = bitsPerSecond
            applyBitrate(session)
        }
    }

    func encodeLast() {
        queue.async { [self] in
            guard !closed, let picture = last() else { return }
            // a frame of now to the flow: the old picture's time would read as queue
            let now = monotonicMicros()
            offer(VideoPicture(buffer: picture.buffer, captureMicros: now, enteredMicros: now), again: true)
        }
    }

    func keyframe() {
        queue.async { [self] in keyNext = true }
    }

    // MARK: On the queue

    /// Makes the session of `size`: a new generation, whose first frame is a keyframe.
    func open(size: PixelSize) throws {
        close(keepOpen: true)
        let lowLatency = rate.lowLatency
        var made: VTCompressionSession?
        var status: OSStatus = -1
        // hardware when there is one; the software encoder only when the Mac has none
        for require in [true, false] {
            let hardware = require ? kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder : kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder
            var encoderSpec: [CFString: Any] = [hardware: true]
            if lowLatency { encoderSpec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
            let attributes: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: size.width, kCVPixelBufferHeightKey: size.height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
            ]
            status = VTCompressionSessionCreate(
                allocator: nil, width: Int32(size.width), height: Int32(size.height), codecType: kCMVideoCodecType_H264,
                encoderSpecification: encoderSpec as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
                compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &made
            )
            if status == noErr { break }
        }
        guard status == noErr, let made else { throw ComputerFailure.captureFailed("VideoToolbox gave no H.264 encoder (\(status)).") }
        let set = { (key: CFString, value: Any) in _ = VTSessionSetProperty(made, key: key, value: value as CFTypeRef) }
        set(kVTCompressionPropertyKey_RealTime, true)
        set(kVTCompressionPropertyKey_AllowFrameReordering, false)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, spec.fps)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, VideoTuning.maxKeyFrameInterval)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, VideoTuning.maxKeyFrameIntervalSeconds)
        set(kVTCompressionPropertyKey_ProfileLevel, VideoTuning.profileHigh ? kVTProfileLevel_H264_High_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel)
        set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        applyBitrate(made)
        VTCompressionSessionPrepareToEncodeFrames(made)
        session = made
        self.size = size
        if generation == 0 { startSize = size }
        generation += 1
        keyNext = true
        closed = false
    }

    private func applyBitrate(_ session: VTCompressionSession) {
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFTypeRef)
        if rate.dataRateLimits {
            let bytes = Double(bitrate) / 8 * VideoTuning.dataRateWindowSeconds
            _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [bytes, VideoTuning.dataRateWindowSeconds] as CFArray)
        }
    }

    /// The window's new pixels: a new picture size makes the session again.
    func resize(to pixels: PixelSize) {
        let next = VideoGeometry.picture(pixels, maxEdge: spec.maxEdge)
        guard next != size, !closed else { return }
        do {
            try open(size: next)
        } catch {
            closed = true
            output.failed("\(error)")
        }
    }

    func close(keepOpen: Bool = false) {
        if let session {
            // the frames inside come out first; whatever is still owed to the stream is settled as dropped
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        settleOwed()
        if let transfer {
            VTPixelTransferSessionInvalidate(transfer)
            self.transfer = nil
        }
        if !keepOpen { closed = true }
    }

    /// One picture, if the stream admits it: scaled to the session's size when it is not, then encoded.
    func offer(_ picture: VideoPicture, again: Bool) {
        guard !closed, let session, output.admit(captureMicros: picture.captureMicros, again: again) else { return }
        guard let buffer = sized(picture.buffer, session: session) else {
            output.dropped()
            return
        }
        // our own clock, strictly rising, so a repeated picture is a new frame to the encoder
        let pts = max(lastPTS + 1, Int64(monotonicMicros()))
        lastPTS = pts
        let forced = keyNext
        let properties: CFDictionary? = forced ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        keyNext = false
        let generation = self.generation
        let size = self.size
        nextSubmit += 1
        let submit = nextSubmit
        owed[submit] = forced
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: buffer, presentationTimeStamp: CMTime(value: pts, timescale: 1_000_000), duration: .invalid,
            frameProperties: properties, infoFlagsOut: nil
        ) { [weak self, queue] status, flags, sample in
            let unit = Self.unit(status: status, flags: flags, sample: sample)
            queue.async { self?.finished(unit, submit: submit, generation: generation, size: size, picture: picture) }
        }
        if status != noErr, owed.removeValue(forKey: submit) != nil {
            output.dropped()
            if forced { keyNext = true }
            failed(status)
        }
    }

    /// Every frame still owed to the stream goes as dropped; their handlers, if they come, change nothing.
    private func settleOwed() {
        for _ in owed { output.dropped() }
        owed.removeAll()
    }

    private enum Result { case unit(Data, keyframe: Bool), dropped, failed(OSStatus) }

    /// On VideoToolbox's thread: the sample as Annex B.
    private static func unit(status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) -> Result {
        guard status == noErr else { return .failed(status) }
        guard let sample, !flags.contains(.frameDropped), CMSampleBufferGetTotalSampleSize(sample) > 0 else { return .dropped }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        guard let format = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return .failed(-1) }
        var lengthSize: Int32 = 4
        var sets: [Data] = []
        if keyframe {
            var count = 0
            _ = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &lengthSize)
            for index in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var length = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &length, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
                    sets.append(Data(bytes: pointer, count: length))
                }
            }
        } else {
            _ = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: nil, nalUnitHeaderLengthOut: &lengthSize)
        }
        var avcc = Data(count: CMBlockBufferGetDataLength(block))
        let copied = avcc.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!) }
        guard copied == noErr, let annexB = try? AnnexB.accessUnit(avcc: avcc, lengthSize: Int(lengthSize), parameterSets: sets) else { return .failed(-1) }
        return .unit(annexB, keyframe: keyframe)
    }

    /// On the queue: what the encoder gave for one admitted picture.
    private func finished(_ result: Result, submit: UInt64, generation: UInt32, size: PixelSize, picture: VideoPicture) {
        // settled already (the session closed, or its submit failed): nothing more to say
        guard let forced = owed.removeValue(forKey: submit) else { return }
        // a frame of a session made again, or of a closed one, never reaches the stream
        guard !closed, generation == self.generation else {
            output.dropped()
            return
        }
        // a forced keyframe that never came out is asked of the next frame
        var keyframe = false
        if case .unit(_, let key) = result { keyframe = key }
        if forced && !keyframe { keyNext = true }
        switch result {
        case .unit(let data, let keyframe):
            failures = 0
            output.encoded(EncodedVideo(
                generation: generation, keyframe: keyframe, size: size, captureMicros: picture.captureMicros, accessUnit: data,
                encodeMicros: monotonicMicros() &- picture.enteredMicros
            ))
        case .dropped:
            output.dropped()
        case .failed(let status):
            output.dropped()
            failed(status)
        }
    }

    /// The encoder failed: made again, a new generation, up to `rebuildLimit` times in a row.
    private func failed(_ status: OSStatus) {
        failures += 1
        guard failures <= VideoTuning.rebuildLimit else {
            close()
            output.failed("the H.264 encoder failed \(failures) times (\(status))")
            return
        }
        do {
            try open(size: size)
        } catch {
            close()
            output.failed("\(error)")
        }
    }

    /// The picture at the session's size: as it is when it fits, else scaled into a buffer of the session's pool.
    private func sized(_ buffer: CVPixelBuffer, session: VTCompressionSession) -> CVPixelBuffer? {
        if CVPixelBufferGetWidth(buffer) == size.width && CVPixelBufferGetHeight(buffer) == size.height { return buffer }
        if transfer == nil {
            var made: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &made) == noErr, let made else { return nil }
            _ = VTSessionSetProperty(made, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
            transfer = made
        }
        guard let transfer, let pool = VTCompressionSessionGetPixelBufferPool(session) else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let out else { return nil }
        CVBufferPropagateAttachments(buffer, out)
        return VTPixelTransferSessionTransferImage(transfer, from: buffer, to: out) == noErr ? out : nil
    }
}

/// mach_absolute_time units (a frame's `displayTime`) in microseconds, the clock `monotonicMicros` reads.
func machMicros(_ time: UInt64) -> UInt64 {
    UInt64(Double(time) * machMicrosPerTick)
}

private let machMicrosPerTick: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1_000
}()

#endif
