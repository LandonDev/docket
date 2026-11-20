import CoreMedia
import Foundation

/// Why a stream's player stopped by itself; a socket's own close carries its code instead
/// (`PlayerFault` in src/renderer/src/lib/video/player.ts).
public enum VideoFault: String, Sendable, Equatable {
    case unsupported, decode, wire, stalled
}

/// What the phone shows in a stream's place once it is over (`VideoCloseFace` in src/shared/contract-video.ts).
public enum VideoFace: String, Sendable, Equatable {
    /// the kept still picture, with no line
    case picture
    /// the held act's kept picture
    case kept
    /// the line a browser that stopped shows
    case stopped
    /// the Screen Recording line
    case permission
}

/// The codes a stream's socket closes with (`VIDEO_CLOSE` in src/shared/contract-video.ts).
public enum VideoClose {
    public static let ended = 4100, moved = 4101, busy = 4102, held = 4103, revoked = 4104, error = 4105, permission = 4106, slow = 4107
    /// A dropped stream is opened again this many times before it gives way to the still picture (`VIDEO_RETRIES`).
    public static let retries = 5
    /// How long before each new open, by how many times it was opened again (`RETRY_DELAYS_MS`).
    public static let retryDelaysMs = [500, 1_000, 2_000, 4_000, 4_000]
    public static let path = "/video/"
}

public enum AfterClose: Equatable, Sendable {
    /// open it again with a fresh `video.open`, after `delayMs`
    case again(delayMs: Int)
    /// the stream is over: what shows in its place, and whether Retry is offered
    case over(VideoFace, retry: Bool)
}

public enum VideoRules {
    /// What a stream does when its socket closes (`afterClose` in src/renderer/src/lib/video/messages.ts). `tries` is
    /// how many times it was opened again since a frame was last shown.
    public static func afterClose(code: Int, fault: VideoFault?, tries: Int) -> AfterClose {
        if fault == .unsupported { return .over(.picture, retry: false) }
        let shown: (face: VideoFace?, retry: Bool) = fault != nil ? (nil, false) : shows(code)
        if let face = shown.face { return .over(face, retry: shown.retry) }
        if tries >= VideoClose.retries { return .over(.picture, retry: false) }
        return .again(delayMs: VideoClose.retryDelaysMs[min(tries, VideoClose.retryDelaysMs.count - 1)])
    }

    /// `VIDEO_CLOSE_SHOWS`: nil is "open again" (`slow`, and a drop that named no reason).
    static func shows(_ code: Int) -> (face: VideoFace?, retry: Bool) {
        switch code {
        case VideoClose.ended, VideoClose.revoked: (.stopped, false)
        case VideoClose.moved, VideoClose.busy: (.picture, false)
        case VideoClose.held: (.kept, false)
        case VideoClose.error: (.stopped, true)
        case VideoClose.permission: (.permission, false)
        default: (nil, false)
        }
    }

    /// The stream's own socket beside the RPC socket's: the same scheme, host and port, `/video/<stream>`, and the
    /// ticket as the only query (`streamUrl` in messages.ts). A relayed host's stream is on the socket the RPC rides.
    public static func streamURL(rpc: URL, stream: String, ticket: String) -> URL? {
        guard var parts = URLComponents(url: rpc, resolvingAgainstBaseURL: false) else { return nil }
        parts.percentEncodedPath = VideoClose.path + (stream.addingPercentEncoding(withAllowedCharacters: componentSafe) ?? stream)
        let value = (ticket.addingPercentEncoding(withAllowedCharacters: formSafe) ?? ticket).replacingOccurrences(of: "%20", with: "+")
        parts.percentEncodedQuery = "ticket=" + value
        parts.fragment = nil
        return parts.url
    }

    /// `encodeURIComponent`'s unreserved characters
    private static let componentSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    /// what `URLSearchParams` leaves as it is
    private static let formSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")
}

/// Where a stream's samples go: the phone's display layer. False from `enqueue` is a layer that failed.
public protocol VideoSampleSink: AnyObject {
    func enqueue(_ sample: CMSampleBuffer) -> Bool
    /// a new generation: what the old encoder left is of no use
    func flush()
}

/// One stream's frames on the phone, as the desktop's `StreamPlayer` takes them: a generation starts with a keyframe
/// numbered 1, sequences run without a gap, each frame becomes a sample for the display layer and is acked once it is
/// enqueued, in the order it came, with how long it waited on the phone. Pure but for CoreMedia's sample buffers: the
/// socket and the layer are handed in.
public final class VideoPlayerCore {
    /// The first frame must come within this.
    public static let stallMs: Double = 5_000

    private let sink: any VideoSampleSink
    private let send: (Data) -> Void
    private let now: () -> Double
    private var maker = SampleMaker()
    /// the generation the last frame said
    public private(set) var generation: UInt32 = 0
    private var sequence: UInt32 = 0
    private let openedAt: Double
    /// frames shown since the stream opened
    public private(set) var frames = 0
    public private(set) var size: (width: Int, height: Int)?
    public private(set) var fault: VideoFault?

    /// `send` writes an ack to the stream's socket; `now` is milliseconds on any steady clock.
    public init(sink: any VideoSampleSink, send: @escaping (Data) -> Void, now: @escaping () -> Double) {
        self.sink = sink
        self.send = send
        self.now = now
        openedAt = now()
    }

    /// One message from the socket. A fault ends the stream: the caller closes the socket and asks `VideoRules`.
    @discardableResult
    public func receive(_ data: Data) -> VideoFault? {
        guard fault == nil else { return fault }
        let arrived = now()
        let frame: NSL1.Frame
        do {
            frame = try NSL1.parseFrame(data)
            if generation != 0, frame.generation < generation { return fail(.wire) }
            if frame.generation != generation {
                // a new encoder at the source: nothing of the old one is of use to the new
                sink.flush()
                maker.reset()
                generation = frame.generation
                sequence = 0
                guard frame.keyframe, frame.sequence == 1 else { return fail(.wire) }
            }
            guard frame.sequence == sequence &+ 1 else { return fail(.wire) }
            sequence = frame.sequence
        } catch {
            return fail(.wire)
        }
        guard let sample = try? maker.sample(frame) else { return fail(.decode) }
        guard sink.enqueue(sample) else { return fail(.decode) }
        frames += 1
        size = (frame.width, frame.height)
        send(NSL1.encodeAck(generation: frame.generation, sequence: frame.sequence, waitMs: now() - arrived))
        return nil
    }

    /// Called now and then: a stream whose first frame never came is given up on.
    @discardableResult
    public func check() -> VideoFault? {
        if fault == nil, sequence == 0, now() - openedAt > Self.stallMs { return fail(.stalled) }
        return fault
    }

    private func fail(_ fault: VideoFault) -> VideoFault {
        self.fault = fault
        return fault
    }
}
