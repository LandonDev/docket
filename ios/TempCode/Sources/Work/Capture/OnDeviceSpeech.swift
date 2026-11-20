import AVFoundation
import Speech
import TempCodeClient

/// The phone's recognizer for a voice note: `SFSpeechRecognizer` in the
/// phone's language with `requiresOnDeviceRecognition`, so the words never
/// leave the phone. A phone that cannot transcribe its language on the device
/// is refused (`.offline`); nothing falls back to Apple's servers.
final class OnDeviceSpeech: SpeechSource {
    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var words: AsyncThrowingStream<String, any Error>.Continuation?

    func prepare() async -> SpeechAccess {
        let recognizer = recognizer ?? SFSpeechRecognizer()
        self.recognizer = recognizer
        guard let recognizer, recognizer.supportsOnDeviceRecognition else { return .offline }
        guard await Self.speechAuthorization() == .authorized else { return .denied }
        guard await AVAudioApplication.requestRecordPermission() else { return .denied }
        return recognizer.isAvailable ? .granted : .offline
    }

    func start() throws -> AsyncThrowingStream<String, any Error> {
        guard let recognizer else { throw SpeechRefused() }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        let engine = AVAudioEngine()
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.feed(request))
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }

        let (stream, words) = AsyncThrowingStream<String, any Error>.makeStream()
        words.onTermination = { _ in Task { @MainActor in self.teardown() } }
        task = recognizer.recognitionTask(with: request, resultHandler: Self.deliver(to: words))
        self.engine = engine
        self.request = request
        self.words = words
        return stream
    }

    func finish() {
        stopAudio()
        request?.endAudio()
    }

    func cancel() {
        task?.cancel()
        words?.finish()
        teardown()
    }

    private func stopAudio() {
        guard let engine else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        self.engine = nil
    }

    private func teardown() {
        stopAudio()
        task = nil
        request = nil
        words = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // The callbacks below run on the audio thread and the recognizer's queue,
    // so they are made outside the main actor and touch only what they hold.

    private nonisolated static func feed(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        nonisolated(unsafe) let request = request
        return { buffer, _ in request.append(buffer) }
    }

    private nonisolated static func deliver(to words: AsyncThrowingStream<String, any Error>.Continuation) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            if let result {
                words.yield(result.bestTranscription.formattedString)
                if result.isFinal { words.finish() }
            } else if let error {
                // Released before any words, or stopped: the take simply ends.
                if Self.silence(error) { words.finish() } else { words.finish(throwing: error) }
            }
        }
    }

    /// "No speech detected" (1110) and a request ended before it began (216, 301).
    private nonisolated static func silence(_ error: any Error) -> Bool {
        let error = error as NSError
        return [1110, 216, 301].contains(error.code)
    }

    @concurrent private nonisolated static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
    }
}

private struct SpeechRefused: LocalizedError {
    var errorDescription: String? { "Speech recognition isn’t ready." }
}
