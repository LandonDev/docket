import Foundation
import Observation
import TempCodeContract

/// One host's capture calls (`WorkHost`; a stand-in in tests).
@MainActor public protocol CaptureHost: AnyObject, Sendable {
    /// The paired host's id, which a started thread opens on.
    var hostId: String { get }
    func captureState() async throws -> CaptureState
    func capture(text: String, sector: String?, start: Bool, key: String) async throws -> CaptureFiled
}

/// A voice note from the phone (docs/agents/work-capture.md "The phone"):
/// his words, transcribed on the phone, filed to LifeOS as his own quick add
/// through a host whose LifeOS answers. The draft outlives the sheet and the
/// app, so nothing he said is lost when no host can file it.
@MainActor @Observable
public final class VoiceNote {
    /// What one press of Save sends: the same request keeps its key, so a
    /// retry after a lost answer files nothing twice.
    struct Request: Hashable {
        var text: String
        var sector: String?
        var start: Bool
    }

    public static let noHost = "No host can reach LifeOS right now."

    public var text: String {
        didSet { defaults.set(text, forKey: Self.draftKey) }
    }
    /// The sector it goes to; nil is Unsorted (LifeOS's bot files it). Until
    /// he picks, the last one used on the filing host.
    public private(set) var sector: String?
    public var start = false
    public private(set) var saving = false
    /// Looking for a host whose LifeOS answers.
    public private(set) var finding = false
    /// The last failure, kept beside the draft.
    public private(set) var error: String?
    public let dictation: Dictation

    @ObservationIgnored private var host: (any CaptureHost)?
    @ObservationIgnored private var picked = false
    @ObservationIgnored private var pending: (key: String, request: Request, host: any CaptureHost)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeKey: () -> String

    static let draftKey = "work.capture.draft"

    public init(source: any SpeechSource, defaults: UserDefaults = .standard, makeKey: @escaping () -> String = { UUID().uuidString }) {
        dictation = Dictation(source: source)
        self.defaults = defaults
        self.makeKey = makeKey
        text = defaults.string(forKey: Self.draftKey) ?? ""
    }

    /// The host the last find chose (a started thread opens there).
    public var hostId: String? { host?.hostId }

    public var hasWords: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var canSave: Bool { hasWords && !saving && !dictation.isBusy }

    public func pick(_ sector: String?) {
        self.sector = sector
        picked = true
    }

    /// The hold began: each take's words follow what is already written.
    /// Not while a save is on its way: its answer clears the words it sent.
    public func press() {
        guard !saving else { return }
        error = nil
        let before = text
        dictation.press { [weak self] words in self?.text = Self.join(before, words) }
    }

    public func release() { dictation.release() }

    static func join(_ before: String, _ words: String) -> String {
        let head = before.trimmingCharacters(in: .whitespacesAndNewlines)
        let said = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if head.isEmpty || said.isEmpty { return head.isEmpty ? said : head }
        return head + " " + said
    }

    /// The first host (of those with Work on) to answer that its LifeOS is
    /// connected; its last sector becomes the default until he picks one.
    public func find(_ hosts: [any CaptureHost]) async {
        finding = true
        defer { finding = false }
        let found = await Self.first(of: hosts)
        host = found?.0
        if let state = found?.1, !picked { sector = state.last }
        if found != nil, error == Self.noHost { error = nil }
    }

    /// The first connected answer wins at once: a host that is asleep (its
    /// request waits out the socket's timeout) never holds up one that answered.
    private static func first(of hosts: [any CaptureHost]) async -> (any CaptureHost, CaptureState)? {
        guard !hosts.isEmpty else { return nil }
        return await withCheckedContinuation { done in
            let race = Race(left: hosts.count, done: done)
            for host in hosts {
                Task { race.answer(host, try? await host.captureState()) }
            }
        }
    }

    /// Files the draft. On success the draft clears and the answer comes
    /// back; on a failure the words stay, with the reason.
    private var current: Request {
        Request(text: text.trimmingCharacters(in: .whitespacesAndNewlines), sector: sector, start: start)
    }

    @discardableResult
    public func save(_ hosts: [any CaptureHost]) async -> CaptureFiled? {
        guard canSave else { return nil }
        saving = true
        defer { saving = false }
        error = nil
        // A retry goes back to the host that may have filed it, while it answers: another host
        // keeps no record of the key and would file it, and start its thread, a second time.
        if let retry = pending, retry.request == current, (try? await retry.host.captureState())?.connected == true { host = retry.host }
        if host == nil { await find(hosts) }
        guard let host else {
            error = Self.noHost
            return nil
        }
        // Built after the find, which may have set the default sector.
        let request = current
        let key = pending.flatMap { $0.request == request ? $0.key : nil } ?? makeKey()
        pending = (key, request, host)
        do {
            let filed = try await host.capture(text: request.text, sector: request.sector, start: request.start, key: key)
            pending = nil
            text = ""
            start = false
            picked = false
            sector = request.sector
            if let reason = filed.threadError { error = "Saved. The thread didn’t start: \(reason)" }
            return filed
        } catch {
            // The host may have gone; the next Save looks again.
            self.host = nil
            self.error = ActionError.wrap(error).message
            return nil
        }
    }
}

/// `VoiceNote.first(of:)`'s bookkeeping: resumes once, with the first
/// connected host or with nil when every host has answered.
@MainActor private final class Race {
    private var left: Int
    private var done: CheckedContinuation<(any CaptureHost, CaptureState)?, Never>?

    init(left: Int, done: CheckedContinuation<(any CaptureHost, CaptureState)?, Never>) {
        self.left = left
        self.done = done
    }

    func answer(_ host: any CaptureHost, _ state: CaptureState?) {
        left -= 1
        if let state, state.connected {
            done?.resume(returning: (host, state))
            done = nil
        } else if left == 0 {
            done?.resume(returning: nil)
            done = nil
        }
    }
}
