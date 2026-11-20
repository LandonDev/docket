import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A host's capture calls, answered as a test says.
@MainActor
private final class StubHost: CaptureHost {
    let hostId: String
    var state: CaptureState?
    /// Never answers `work.capture.state` (a host asleep behind the relay).
    var asleep = false
    var failure: String?
    var threadError: String?
    private(set) var filed: [(text: String, sector: String?, start: Bool, key: String)] = []

    init(_ hostId: String = "box", last: String? = nil, connected: Bool = true) {
        self.hostId = hostId
        state = CaptureState(host: "box", last: last, homes: [], connected: connected)
    }

    func captureState() async throws -> CaptureState {
        if asleep { try await Task.sleep(for: .seconds(3600)) }
        guard let state else { throw ActionError.refused(message: "offline", forbidden: false) }
        return state
    }

    func capture(text: String, sector: String?, start: Bool, key: String) async throws -> CaptureFiled {
        filed.append((text, sector, start, key))
        if let failure { throw ActionError.refused(message: failure, forbidden: false) }
        return CaptureFiled(taskId: "t\(filed.count)", kept: [], threadId: start && threadError == nil ? "s1" : nil, threadError: threadError)
    }
}

/// The phone's recognizer, driven by the test: words yielded by hand, the
/// permissions answered on a gate.
@MainActor
private final class StubSpeech: SpeechSource {
    var access: SpeechAccess = .granted
    /// Holds `prepare()` until `open()` (the system's permission prompt).
    var gated = false
    private(set) var starts = 0
    private(set) var finishes = 0
    private var gate: CheckedContinuation<Void, Never>?
    private var words: AsyncThrowingStream<String, any Error>.Continuation?

    func prepare() async -> SpeechAccess {
        if gated { await withCheckedContinuation { gate = $0 } }
        return access
    }

    func open() {
        gate?.resume()
        gate = nil
    }

    var waiting: Bool { gate != nil }

    func start() throws -> AsyncThrowingStream<String, any Error> {
        starts += 1
        let (stream, continuation) = AsyncThrowingStream<String, any Error>.makeStream()
        words = continuation
        return stream
    }

    func say(_ text: String) { words?.yield(text) }
    func fail(_ error: any Error) { words?.finish(throwing: error) }

    func finish() {
        finishes += 1
        words?.finish()
    }

    func cancel() { words?.finish() }
}

private struct Broken: LocalizedError {
    var errorDescription: String? { "The microphone stopped" }
}

@MainActor
private func makeNote(_ speech: StubSpeech = StubSpeech(), keys: [String] = ["k-0001", "k-0002", "k-0003"]) -> (VoiceNote, UserDefaults) {
    let defaults = UserDefaults(suiteName: "voice-note-\(UUID().uuidString)")!
    var left = keys
    return (VoiceNote(source: speech, defaults: defaults, makeKey: { left.removeFirst() }), defaults)
}

@Suite @MainActor struct VoiceNoteTests {
    @Test func `the sector defaults to the host's last, and Unsorted after an unsorted one`() async {
        let (purdue, _) = makeNote()
        await purdue.find([StubHost(last: "purdue")])
        #expect(purdue.sector == "purdue")

        let (unsorted, _) = makeNote()
        await unsorted.find([StubHost(last: nil)])
        #expect(unsorted.sector == nil)
    }

    @Test func `a sector he picked stands when the host answers later`() async {
        let (note, _) = makeNote()
        note.pick("ref")
        await note.find([StubHost(last: "purdue")])
        #expect(note.sector == "ref")
    }

    @Test func `Save sends the trimmed words, the sector, a fresh key and no files`() async throws {
        let host = StubHost(last: "cosmic")
        let (note, defaults) = makeNote()
        note.text = "  Book the LAN room for Friday \n"
        note.start = true
        let filed = await note.save([host])
        #expect(filed?.threadId == "s1")
        let sent = try #require(host.filed.first)
        #expect(sent.text == "Book the LAN room for Friday")
        #expect(sent.sector == "cosmic")
        #expect(sent.start == true)
        #expect(sent.key == "k-0001")
        // Saved: the draft clears, here and in what the next launch reads.
        #expect(note.text.isEmpty)
        #expect(note.start == false)
        #expect(defaults.string(forKey: "work.capture.draft") == "")
    }

    @Test func `the wire carries sector null for Unsorted and leaves files out`() throws {
        let params = Methods.WorkCaptureFile.Params(key: "k-0001", text: "Call Sam", sector: nil, start: nil)
        let json = try #require(String(data: JSONEncoder().encode(params), encoding: .utf8))
        #expect(json.contains(#""sector":null"#))
        #expect(!json.contains("files"))
        #expect(!json.contains("start"))
    }

    @Test func `with no host connected the words stay and say why`() async {
        let (note, defaults) = makeNote()
        note.text = "Ask Mia about the budget"
        let offline = StubHost(connected: false)
        let gone = StubHost()
        gone.state = nil
        await note.find([offline, gone])
        #expect(await note.save([offline, gone]) == nil)
        #expect(note.error == VoiceNote.noHost)
        #expect(note.text == "Ask Mia about the budget")
        #expect(offline.filed.isEmpty)
        // A new launch finds the same draft.
        #expect(defaults.string(forKey: "work.capture.draft") == "Ask Mia about the budget")
        #expect(VoiceNote(source: StubSpeech(), defaults: defaults).text == "Ask Mia about the budget")
    }

    @Test func `a failed save keeps the words, and the same request keeps its key`() async {
        let host = StubHost(last: "life")
        host.failure = "LifeOS is not connected"
        let (note, _) = makeNote()
        note.text = "Renew the car registration"
        #expect(await note.save([host]) == nil)
        #expect(note.error == "LifeOS is not connected")
        #expect(note.text == "Renew the car registration")

        host.failure = nil
        #expect(await note.save([host]) != nil)
        #expect(host.filed.map(\.key) == ["k-0001", "k-0001"])
        #expect(note.error == nil)
    }

    @Test func `a changed request after a failure gets a new key`() async {
        let host = StubHost()
        host.failure = "timed out"
        let (note, _) = makeNote()
        note.text = "Order the jerseys"
        await note.save([host])
        note.pick("unify")
        await note.save([host])
        #expect(host.filed.map(\.key) == ["k-0001", "k-0002"])
    }

    @Test func `a host asleep does not hold up one that answers`() async {
        let asleep = StubHost(last: "hypixel")
        asleep.asleep = true
        let box = StubHost("mac", last: "purdue")
        let (note, _) = makeNote()
        await note.find([asleep, box])
        #expect(note.sector == "purdue")
        #expect(note.hostId == "mac")
    }

    @Test func `a thread that did not start is said, the task is filed all the same`() async {
        let host = StubHost()
        host.threadError = "No Work workspace for ref here"
        let (note, _) = makeNote()
        note.text = "Referee schedule for May"
        note.start = true
        #expect(await note.save([host])?.taskId == "t1")
        #expect(note.text.isEmpty)
        #expect(note.error == "Saved. The thread didn’t start: No Work workspace for ref here")
    }

    @Test func `nothing to save without words`() async {
        let host = StubHost()
        let (note, _) = makeNote()
        note.text = "   "
        #expect(await note.save([host]) == nil)
        #expect(host.filed.isEmpty)
    }
}

@Suite @MainActor struct DictationTests {
    @Test func `hold, hear, release: the words follow what was written`() async {
        let speech = StubSpeech()
        let (note, _) = makeNote(speech)
        note.text = "Call Sam."
        note.press()
        #expect(note.dictation.phase == .preparing)
        #expect(await eventually { note.dictation.phase == .listening })
        #expect(note.dictation.since != nil)
        #expect(!note.canSave)
        speech.say("about the")
        #expect(await eventually { note.text == "Call Sam. about the" })
        speech.say("about the venue")
        #expect(await eventually { note.text == "Call Sam. about the venue" })
        note.release()
        #expect(note.dictation.phase == .finishing)
        #expect(speech.finishes == 1)
        #expect(await eventually { note.dictation.phase == .idle })
        #expect(note.dictation.since == nil)
        #expect(note.canSave)
    }

    @Test func `a tap shorter than the preparing records nothing`() async {
        let speech = StubSpeech()
        speech.gated = true
        let (note, _) = makeNote(speech)
        note.press()
        #expect(await eventually { speech.waiting })
        note.release()
        speech.open()
        #expect(await eventually { note.dictation.phase == .idle })
        #expect(speech.starts == 0)
    }

    @Test(arguments: [SpeechAccess.denied, .offline])
    func `no permission or no on-device model refuses, never a server`(access: SpeechAccess) async {
        let speech = StubSpeech()
        speech.access = access
        let (note, _) = makeNote(speech)
        note.press()
        #expect(await eventually { note.dictation.phase == .refused(access) })
        #expect(speech.starts == 0)
        #expect(!note.dictation.isBusy)
    }

    @Test func `a recognizer that fails keeps the words heard so far`() async {
        let speech = StubSpeech()
        let (note, _) = makeNote(speech)
        note.press()
        #expect(await eventually { note.dictation.phase == .listening })
        speech.say("Pick up the badges")
        #expect(await eventually { note.text == "Pick up the badges" })
        speech.fail(Broken())
        #expect(await eventually { note.dictation.phase == .failed("The microphone stopped") })
        #expect(note.text == "Pick up the badges")
    }

    @Test func `a second press while held is ignored`() async {
        let speech = StubSpeech()
        let (note, _) = makeNote(speech)
        note.press()
        #expect(await eventually { note.dictation.phase == .listening })
        note.press()
        #expect(speech.starts == 1)
        note.release()
        #expect(await eventually { note.dictation.phase == .idle })
    }
}
