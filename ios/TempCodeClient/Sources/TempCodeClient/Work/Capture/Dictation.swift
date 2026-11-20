import Foundation
import Observation

/// What the phone may transcribe with: the owner's rule is that speech never
/// leaves the phone, so a recognizer that can only work on a server is refused.
public enum SpeechAccess: Sendable, Hashable {
    case granted
    /// The microphone or speech recognition was refused in Settings.
    case denied
    /// This phone cannot transcribe this language on the device.
    case offline
}

/// The phone's recognizer, behind a seam so the hold's states are tested
/// without a microphone (the app's `OnDeviceSpeech` is the real one).
@MainActor public protocol SpeechSource: AnyObject {
    /// Asks for the microphone and speech permissions (the system asks once) and checks the on-device model.
    func prepare() async -> SpeechAccess
    /// Starts listening. The stream yields the take's whole words so far and
    /// ends after `finish()` with the last of them.
    func start() throws -> AsyncThrowingStream<String, any Error>
    /// Stops listening; the stream finishes once the last words are in.
    func finish()
    /// Stops at once; the stream ends with what it had.
    func cancel()
}

/// Hold to talk, as states: a press prepares and listens while held; the
/// release finishes the take. A press shorter than the preparing is a tap and
/// records nothing. Each take's words go to `heard` as they grow.
@MainActor @Observable
public final class Dictation {
    public enum Phase: Sendable, Hashable {
        case idle
        /// Permissions and the on-device check, before the microphone opens.
        case preparing
        case listening
        /// Released: the last words are being transcribed.
        case finishing
        case refused(SpeechAccess)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// When the microphone opened (epoch ms), for the elapsed clock while held.
    public private(set) var since: Int?

    @ObservationIgnored private let source: any SpeechSource
    @ObservationIgnored private var held = false
    @ObservationIgnored private var take: Task<Void, Never>?

    public init(source: any SpeechSource) {
        self.source = source
    }

    /// The microphone is open or its last words are on their way.
    public var isBusy: Bool { phase == .preparing || phase == .listening || phase == .finishing }

    /// The hold began. `heard` takes the take's words so far, each time they grow.
    public func press(heard: @escaping @MainActor (String) -> Void) {
        guard !isBusy else { return }
        held = true
        phase = .preparing
        take = Task { await self.run(heard: heard) }
    }

    /// The hold ended.
    public func release() {
        held = false
        if phase == .listening {
            phase = .finishing
            source.finish()
        }
    }

    /// The screen went away mid-take: stop without waiting for the last words.
    public func cancel() {
        held = false
        if isBusy { source.cancel() }
        take?.cancel()
        take = nil
        since = nil
        if isBusy { phase = .idle }
    }

    private func run(heard: @escaping @MainActor (String) -> Void) async {
        let access = await source.prepare()
        guard access == .granted else { phase = .refused(access); return }
        // Let go before the microphone opened: a tap, nothing to record.
        guard held, !Task.isCancelled else { phase = .idle; return }
        do {
            let words = try source.start()
            since = Int(Date().timeIntervalSince1970 * 1000)
            phase = .listening
            for try await said in words { heard(said) }
            if phase == .listening || phase == .finishing { phase = .idle }
        } catch {
            if !Task.isCancelled { phase = .failed(error.localizedDescription) }
        }
        since = nil
    }
}
