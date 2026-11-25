import Foundation
import Observation
import TempCodeContract

/// The phone's record of outward presses whose answer is not known yet
/// (plan "Never twice, never silently"), over `PendingPresses`: one file per
/// phone, `work-presses.json` under Application Support, for every host.
///
/// A press is written down before its request leaves. The host's answer
/// (done, or a refusal in its words) clears it. A lost link after it left,
/// or fifteen seconds with no answer, leaves it Checking: the press may have
/// landed, so it is never called failed and never sent again from here. On
/// its host's next link (and after a relaunch) the phone reads the item back
/// by its ref and says what became of it. One record per thing per host: a
/// second press on it is refused while one is out.
@MainActor @Observable
public final class PressLedger {
    /// The phone's one ledger, read from disk at first use.
    public static let shared = PressLedger(file: defaultFile)

    public static let fileName = "work-presses.json"

    /// `<Application Support>/work-presses.json` on the phone. Elsewhere (the package's tests on a Mac or the
    /// box) the ledger stays in memory, so a test never writes into the machine's own folders.
    public static var defaultFile: URL? {
        #if os(iOS)
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent(fileName)
        #else
        nil
        #endif
    }

    /// The press went and no answer came: it is being checked, not failed. The press site says nothing of its
    /// own; the item's row and bar say `PressState.checking.line`.
    /// The host answered, and its answer is not the press's end (a request claimed with its items still going): the
    /// press stays Checking and is read back, as a lost answer is.
    public struct NotYetKnown: Error, Sendable, Hashable {
        public init() {}
    }

    public struct Unknown: Error, Sendable, Hashable {
        public var host: String
        public var ref: String
    }

    /// The presses out, as on disk.
    public private(set) var pending: PendingPresses
    /// What a press on each item came to while it has words to say ("Checking…", "May have gone", "Changed",
    /// "No longer waits"), by host and the item's key; his next press on the item clears it.
    public private(set) var states: [String: PressState] = [:]

    @ObservationIgnored private let file: URL?
    @ObservationIgnored private let now: @Sendable () -> Double
    @ObservationIgnored private let wait: @Sendable (Double) async -> Void
    /// Each press's fifteen-second watch, by press id.
    @ObservationIgnored private var watches: [String: Task<Void, Never>] = [:]
    /// Presses whose request is still waiting on its socket, by press id: an answer may yet come.
    @ObservationIgnored private var inFlight: Set<String> = []
    /// The file was there and could not be read (the phone locked at launch): nothing is written over it, and no
    /// press may leave, until it reads (`readIfUnread`).
    @ObservationIgnored private var unread = false
    /// Who hears what became of a press after its press site stopped waiting for it, by kind: an answer that came
    /// after the fifteen seconds, and each read-back on a later link. A chat reply's desk, a Create link's sheet.
    @ObservationIgnored private var hearers: [PendingPress.Kind: @MainActor (PendingPress, PressState) -> Void] = [:]

    /// `wait` sleeps the given seconds (tests pass one that returns when they say).
    public init(
        file: URL?,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
        wait: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.file = file
        self.now = now
        self.wait = wait
        if let file, let kept = PendingPresses.read(from: file, now: now()) {
            pending = kept
        } else {
            pending = PendingPresses()
            unread = file != nil
        }
        // A press from before this launch has no request in flight: each is Checking until its host is read.
        for press in pending.presses { states[Self.key(press.host, press.ref)] = .checking }
    }

    /// The file could not be read at launch: read it now (the phone was unlocked since). True once it is known.
    @discardableResult
    public func readIfUnread() -> Bool {
        guard unread, let file else { return true }
        guard let kept = PendingPresses.read(from: file, now: now()) else { return false }
        unread = false
        pending = kept
        for press in kept.presses { states[Self.key(press.host, press.ref)] = .checking }
        return true
    }

    /// Asked just before each request leaves, on its host with the key it was pressed under (nil: not frozen): why it
    /// may not go now (the app went to the background, the link dropped, another key), else nil. A press it stops never
    /// left: its record goes, and its site hears the line as a refusal and puts the thing back. The app sets it.
    @ObservationIgnored public var mayLeave: (@MainActor (_ host: String, _ key: String?, _ method: KeyMethod) -> String?)?

    /// The check the socket asks as it releases a press's frame: the same as `mayLeave`, and the press still this
    /// record's (Undo, a relaunch or a settle took it back meanwhile: it never goes).
    func release(host: String, key: String?, kind: PendingPress.Kind, presses: [PendingPress]) -> @Sendable @MainActor () -> String? {
        { [weak self] in
            guard let self else { return "Not sent" }
            guard presses.allSatisfy({ self.pending.press($0.id)?.at == $0.at }) else { return "Not sent: the press was taken back" }
            return self.mayLeave?(host, key, kind.method)
        }
    }

    /// A refusal made on the phone itself, around a request that is not the record's (a grant): the same check where
    /// the socket releases its frame.
    public func guarded<T: Sendable>(host: String, key: String?, method: KeyMethod, _ request: @MainActor () async throws -> T) async throws -> T {
        if let why = mayLeave?(host, key, method) { throw ActionError.refused(message: why, forbidden: false) }
        let check: @Sendable @MainActor () -> String? = { [weak self] in self?.mayLeave?(host, key, method) }
        return try await Transport.$release.withValue(check) { try await request() }
    }

    /// Presses that never left: their records go, and their rows say nothing.
    private func withdraw(_ presses: [PendingPress]) {
        for press in presses {
            inFlight.remove(press.id)
            watches.removeValue(forKey: press.id)?.cancel()
            pending.answered(press.id)
            states.removeValue(forKey: Self.key(press.host, press.ref))
        }
        try? save()
    }

    /// `hear` is told what became of each press of `kind` once its press site no longer waits for it (one per kind;
    /// a second replaces the first).
    public func listen(_ kind: PendingPress.Kind, hear: @escaping @MainActor (PendingPress, PressState) -> Void) {
        hearers[kind] = hear
    }

    /// The line where a press would be while the file of presses cannot be read.
    public static let unreadLine = "Not sent: unlock this iPhone and try again"

    public static func key(_ host: String, _ ref: String) -> String { "\(host)|\(ref)" }

    /// The item's press state on a host, while it has words (`ref` is `OutboxModel.key`).
    public func state(host: String, ref: String) -> PressState? {
        states[Self.key(host, ref)]
    }

    /// True while a press on the item is out or unread: its row offers no second Send.
    public func busy(host: String, ref: String) -> Bool {
        pending.presses.contains { $0.host == host && $0.ref == ref }
    }

    /// One outward press through the record. With no link it throws at once (`notConnected`) and records
    /// nothing; with a press on the same thing already out it throws that press's line and sends nothing.
    /// Else the record is saved, then the request leaves. The host's answer clears the record; a lost link,
    /// or `PendingPresses.unknownAfter` with no answer, leaves it Checking and throws `Unknown`.
    public func run<T: Sendable>(
        _ kind: PendingPress.Kind,
        host: String,
        hostName: String,
        ref: String,
        rev: String?,
        attempt: String? = nil,
        linked: Bool,
        key: String? = nil,
        request: @escaping @Sendable @MainActor () async throws -> T
    ) async throws -> T {
        guard linked else { throw ActionError.refused(message: PendingPresses.notConnected(hostName), forbidden: false) }
        guard readIfUnread() else { throw ActionError.refused(message: Self.unreadLine, forbidden: false) }
        let press = PendingPress(host: host, kind: kind, ref: ref, rev: rev, at: now(), attempt: attempt)
        // The key he pressed under, apart from the record's own key below.
        let frozen = key
        let key = Self.key(host, ref)
        if busy(host: host, ref: ref) {
            throw ActionError.refused(message: (states[key] ?? .checking).line ?? "Sending…", forbidden: false)
        }
        _ = pending.leaving(press, linked: true)
        do {
            try save()
        } catch {
            // Not written down, so not sent: a press whose record is lost could not be checked after a relaunch.
            pending.answered(press.id)
            throw ActionError.refused(message: "Not sent: this iPhone could not note the press", forbidden: false)
        }
        states[key] = .sending
        inFlight.insert(press.id)

        let once = Once<T>()
        return try await withCheckedThrowingContinuation { continuation in
            once.arm(continuation)
            watches[press.id]?.cancel()
            watches[press.id] = Task { @MainActor [weak self, wait] in
                await wait(PendingPresses.unknownAfter)
                guard !Task.isCancelled, let self, self.pending.press(press.id)?.at == press.at else { return }
                self.states[key] = .checking
                once.finish(.failure(Unknown(host: host, ref: ref)))
            }
            Task { @MainActor [weak self] in
                // The last word before the request leaves: the app in front, the link, the key he pressed under.
                if let self, let why = self.mayLeave?(host, frozen, kind.method) {
                    self.withdraw([press])
                    once.finish(.failure(ActionError.refused(message: why, forbidden: false)))
                    return
                }
                let result: Result<T, any Error>
                // Asked once more where the socket releases the frame (`Transport.release`), after any write it waited behind.
                let release = self?.release(host: host, key: frozen, kind: kind, presses: [press])
                do { result = .success(try await Transport.$release.withValue(release) { try await request() }) } catch { result = .failure(error) }
                guard let self else { once.finish(result); return }
                self.inFlight.remove(press.id)
                // Still this press's record (a relaunch or another press may have replaced it): only then is it settled here.
                let mine = self.pending.press(press.id)?.at == press.at
                if case .failure(let error) = result, !Self.reached(error) {
                    if mine { self.states[key] = .checking }
                    once.finish(.failure(Unknown(host: host, ref: ref)))
                    return
                }
                if mine {
                    self.watches.removeValue(forKey: press.id)?.cancel()
                    self.pending.answered(press.id)
                    self.states.removeValue(forKey: key)
                    try? self.save()
                }
                // The press site gave up at fifteen seconds and shows Checking: the answer reaches it by its kind's
                // hearer, and the item's row says a refusal in the host's words.
                if !once.finish(result), mine { self.late(press, Self.state(of: result)) }
            }
        }
    }

    /// One press on several items of one host (a group's part of `work.outbox.decide`): each item is written down
    /// as its own press of `kind` before the one request leaves, so each is read back by its ref as a single press
    /// is. With no link it throws at once and records nothing; with any of them already out it throws that one's
    /// line and sends nothing. The host's answer clears them all; a lost link, or `PendingPresses.unknownAfter`
    /// with no answer, leaves them all Checking and throws `Unknown` (the first item's ref).
    public func runMany<T: Sendable>(
        _ kind: PendingPress.Kind,
        host: String,
        hostName: String,
        items: [(ref: String, rev: String?)],
        linked: Bool,
        key: String? = nil,
        outcome: @escaping @MainActor (T) -> [String: PressState] = { _ in [:] },
        request: @escaping @Sendable @MainActor () async throws -> T
    ) async throws -> T {
        guard linked else { throw ActionError.refused(message: PendingPresses.notConnected(hostName), forbidden: false) }
        guard readIfUnread() else { throw ActionError.refused(message: Self.unreadLine, forbidden: false) }
        guard let first = items.first else { return try await request() }
        if let out = items.first(where: { busy(host: host, ref: $0.ref) }) {
            throw ActionError.refused(message: (states[Self.key(host, out.ref)] ?? .checking).line ?? "Sending…", forbidden: false)
        }
        let at = now()
        let presses = items.map { PendingPress(host: host, kind: kind, ref: $0.ref, rev: $0.rev, at: at) }
        for press in presses { _ = pending.leaving(press, linked: true) }
        do {
            try save()
        } catch {
            for press in presses { pending.answered(press.id) }
            throw ActionError.refused(message: "Not sent: this iPhone could not note the press", forbidden: false)
        }
        for press in presses {
            states[Self.key(host, press.ref)] = .sending
            inFlight.insert(press.id)
        }
        let mine = { [weak self] (press: PendingPress) -> Bool in self?.pending.press(press.id)?.at == press.at }
        let unknown = Unknown(host: host, ref: first.ref)

        let once = Once<T>()
        return try await withCheckedThrowingContinuation { continuation in
            once.arm(continuation)
            let watch = "many:" + presses.map(\.id).joined(separator: ",")
            watches[watch]?.cancel()
            watches[watch] = Task { @MainActor [weak self, wait] in
                await wait(PendingPresses.unknownAfter)
                guard !Task.isCancelled, let self else { return }
                for press in presses where mine(press) { self.states[Self.key(host, press.ref)] = .checking }
                once.finish(.failure(unknown))
            }
            Task { @MainActor [weak self] in
                if let self, let why = self.mayLeave?(host, key, kind.method) {
                    self.withdraw(presses)
                    self.watches.removeValue(forKey: watch)?.cancel()
                    once.finish(.failure(ActionError.refused(message: why, forbidden: false)))
                    return
                }
                let result: Result<T, any Error>
                let release = self?.release(host: host, key: key, kind: kind, presses: presses)
                do { result = .success(try await Transport.$release.withValue(release) { try await request() }) } catch { result = .failure(error) }
                guard let self else { once.finish(result); return }
                for press in presses { self.inFlight.remove(press.id) }
                if case .failure(let error) = result, !Self.reached(error) {
                    for press in presses where mine(press) { self.states[Self.key(host, press.ref)] = .checking }
                    once.finish(.failure(unknown))
                    return
                }
                self.watches.removeValue(forKey: watch)?.cancel()
                let settled = presses.filter(mine)
                for press in settled {
                    self.pending.answered(press.id)
                    self.states.removeValue(forKey: Self.key(host, press.ref))
                }
                try? self.save()
                // Late: each item says what the host did with it (`outcome`, by ref), not one word for the whole press.
                if !once.finish(result) {
                    let each: [String: PressState] = if case .success(let value) = result { outcome(value) } else { [:] }
                    for press in settled { self.late(press, each[press.ref] ?? Self.state(of: result)) }
                }
            }
        }
    }

    /// On a host's link: each of its presses whose answer was lost is read back by its ref, and the item's
    /// state says what became of it. `read` answers the item, nil when the host has no such item.
    public func check(host: String, read: @MainActor (PendingPress) async throws -> OutboxItem?) async {
        await check(host: host, where: \.readsItem) { press in
            do {
                return Self.truth(try await read(press), for: press)
            } catch let error where Self.noSuchItem(error) {
                // A host that says it has no such item has answered; anything else is not known yet.
                return Self.truth(nil, for: press)
            }
        }
    }

    /// On a host's link: each of its presses of the kinds `matches` takes whose answer was lost, read back by
    /// `truth` (a chat reply by its attempt key). A read that throws leaves the press Checking for the next link.
    /// Answers each press's state as it resolves.
    @discardableResult
    public func check(
        host: String,
        where matches: (PendingPress.Kind) -> Bool,
        truth read: @MainActor (PendingPress) async throws -> PressTruth?
    ) async -> [(press: PendingPress, state: PressState)] {
        // Nothing known of the file yet: nothing to read back, and nothing written over it.
        guard readIfUnread() else { return [] }
        // Each press with no request left waiting on a socket (the link dropped under it, or a past launch's):
        // one still waiting is answered by its own socket, or fails with it and is read on the next link.
        let due = pending.presses.filter { $0.host == host && $0.kind.readsBack && matches($0.kind) && !inFlight.contains($0.id) }
        var resolved: [(press: PendingPress, state: PressState)] = []
        for press in due {
            let truth: PressTruth?
            do {
                truth = try await read(press)
            } catch {
                continue
            }
            resolved.append((press, settle(press, truth: truth)))
        }
        try? save()
        return resolved
    }

    /// An item of a host as a push or a read just said it: a press on it whose answer was lost, and which waits on
    /// no socket, is read back by it now, not at the next link. Nil when no such press is out.
    @discardableResult
    public func heard(host: String, item: OutboxItem) -> PressState? {
        let ref = OutboxModel.key(item.ref)
        guard !unread, let press = pending.presses.first(where: { $0.host == host && $0.ref == ref && $0.kind.settledByItem && !inFlight.contains($0.id) }) else { return nil }
        let state = settle(press, truth: Self.truth(item, for: press))
        try? save()
        return state
    }

    /// A press read back by something the phone reads itself (a conversation's live rows): settled now, unless its
    /// request still waits on a socket. Nil when no such press is out.
    /// `final`: the truth is the thing's end, true whatever the request still parked on its socket says later (a
    /// request's last push): it settles a press in flight too, and its late answer reaches no one.
    @discardableResult
    public func settle(host: String, ref: String, truth: PressTruth?, final: Bool = false) -> PressState? {
        guard !unread, let press = pending.presses.first(where: { $0.host == host && $0.ref == ref && (final || !inFlight.contains($0.id)) }) else { return nil }
        if final, truth != nil { inFlight.remove(press.id) }
        let state = settle(press, truth: truth)
        try? save()
        return state
    }

    /// One press's truth, read back: its record goes unless nothing is known yet, its item says the state, and its
    /// kind's hearer is told.
    private func settle(_ press: PendingPress, truth: PressTruth?) -> PressState {
        let key = Self.key(press.host, press.ref)
        // Settled meanwhile (a push, another read): its screen already heard the truth; nothing is said twice.
        guard pending.press(press.id)?.at == press.at else { return states[key] ?? .checking }
        let state = pending.resolve(press.id, truth: truth)
        if state.line == nil || state == .sending { states.removeValue(forKey: key) } else { states[key] = state }
        if pending.press(press.id) == nil { watches.removeValue(forKey: press.id)?.cancel() }
        if state != .checking { hearers[press.kind]?(press, state) }
        return state
    }

    /// An answer that came after its press site stopped waiting: the item's row says it, and its hearer is told.
    private func late(_ press: PendingPress, _ state: PressState) {
        if state.line != nil { states[Self.key(press.host, press.ref)] = state }
        hearers[press.kind]?(press, state)
    }

    /// An answer as a state: done, or the host's refusal in its words.
    static func state<T>(of result: Result<T, any Error>) -> PressState {
        switch result {
        case .success: return .done
        case .failure(let error):
            let words = ActionError.wrap(error).message
            // The host's own "it may have gone" (a reply LifeOS may have taken) is that, late or not: never a refusal.
            return words.hasPrefix(Self.mayHaveGonePrefix) ? .mayHaveGone : .failed(words)
        }
    }

    /// How the host starts an answer that says a press may have gone (messages/replies.ts `REPLY_MAY_HAVE_GONE`).
    public static let mayHaveGonePrefix = "It may have gone"
    /// How the host starts an answer whose outcome it cannot say (mail/index.ts `OUTCOME_UNKNOWN`): Checking, read back.
    public static let unknownPrefix = "outcome unknown: "

    /// His next press on the item, or the item read whole again: its old words go.
    public func clear(host: String, ref: String) {
        guard !busy(host: host, ref: ref) else { return }
        states.removeValue(forKey: Self.key(host, ref))
    }

    /// What the item says of the press. An edit that landed moves the item's revision: that is the edit
    /// done, not a change made by someone else.
    static func truth(_ item: OutboxItem?, for press: PendingPress) -> PressTruth? {
        // A mail he timed and sent now is read by its time, not its state (it stays on its way through LifeOS's undo time).
        if press.kind == .mailSendNow { return MailRules.sendNowTruth(item, rev: press.rev) }
        if press.kind == .outboxSendNow { return PressTruth.sendNow(item, rev: press.rev) }
        if press.kind == .mailSend { return PressTruth.mailItem(item) }
        let truth = PressTruth.outbox(item, kind: press.kind)
        if press.kind == .outboxEdit, case .waiting(let rev)? = truth, rev != press.rev { return .done }
        return truth
    }

    /// The request reached the host and it answered (done, or no in its own words). A lost socket, a
    /// request never sent and a cancelled wait did not: the press may or may not have landed. Nor did the box's
    /// `linkDown` for a Mac it relays: it fails what it had already passed on, which may have run there. Nor did a
    /// yes whose words the phone could not read: it may have done its work.
    static func reached(_ error: any Error) -> Bool {
        if error is NotYetKnown { return false }
        if error is ActionError { return true }
        guard let transport = error as? TransportError else { return true }
        switch transport {
        case .server(_, let message): return RelayRefusal(message: message)?.kind != .linkDown && !message.hasPrefix(unknownPrefix)
        case .decoding, .notConnected, .closed, .cancelled: return false
        }
    }

    /// The host's words for a ref it does not hold (outbox.ts `NO_SUCH_ITEM`).
    static func noSuchItem(_ error: any Error) -> Bool {
        if case .server(_, let message)? = error as? TransportError { return message.contains("no such held item") }
        return false
    }

    private func save() throws {
        guard let file, !unread else { return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try pending.save(to: file)
    }
}

/// Resumes a continuation once: the host's answer or the fifteen seconds, whichever comes first.
@MainActor
private final class Once<T: Sendable> {
    private var continuation: CheckedContinuation<T, any Error>?

    func arm(_ continuation: CheckedContinuation<T, any Error>) {
        self.continuation = continuation
    }

    /// False: the press site already had its answer (the fifteen seconds), and this one reached no one.
    @discardableResult
    func finish(_ result: Result<T, any Error>) -> Bool {
        guard let continuation else { return false }
        continuation.resume(with: result)
        self.continuation = nil
        return true
    }
}
