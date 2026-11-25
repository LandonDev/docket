import TempCodeContract

/// One Send of a held item as it waits its five seconds (`SendWait`'s payload): the item as he saw it,
/// what the press does when the wait ends (send it, send it later, send a timed one now), the grant
/// "Send and stop holding" makes, and whether it is his Send Again.
///
/// The grant is made when the wait ends, not before (plan "The hold on the phone"): at dispatch, after
/// the link, key and revision checks, the grant is asked first and then the send; Undo inside the five
/// seconds takes back both, since neither has left. A grant the host refuses cancels the send and says
/// the host's words. A press made from a group or a request never carries a grant and never `again`.
public struct HeldPress: Sendable, Hashable {
    public struct Grant: Sendable, Hashable {
        public var matcher: JSONValue
        public var label: String

        public init(matcher: JSONValue, label: String) {
            self.matcher = matcher
            self.label = label
        }
    }

    /// What the press does once its five seconds end.
    public enum Act: Sendable, Hashable {
        case send
        /// Send later, at this time (ms) in his zone (`work.outbox.decide` `do: later`).
        case later(at: Int)
        /// A scheduled item, sent now (`work.outbox.sendNow`).
        case sendNow
        /// A mail he timed in Mail, sent now (`work.mail.sendNow`, its LifeOS id): LifeOS's own time, not the hold's.
        case mailNow(id: String)
    }

    /// Where the press was made.
    public enum Source: Sendable, Hashable {
        /// One item's own Send: the list's row, the detail's bar, a transcript's line.
        case item
        /// Several items at once.
        case group(Int)
        /// A thread's request card.
        case request
    }

    /// The grant refused: nothing was sent. `line` is the host's words.
    public struct GrantRefused: Error, Sendable, Hashable {
        public var words: String
        public var line: String { "Not sent: no grant made: \(words)" }
    }

    public var entry: OutboxModel.Entry
    public private(set) var act: Act
    public private(set) var grant: Grant?
    /// His own Send Again on one item the host says may have gone (`work.outbox.send`'s `again`).
    public private(set) var again: Bool

    public init(entry: OutboxModel.Entry, act: Act = .send, grant: Grant? = nil, from source: Source = .item) {
        self.entry = entry
        self.act = act
        let one = source == .item
        // A grant is made only from one held item's Send menu, on a plain Send.
        self.grant = one && act == .send && entry.item.state == .held ? grant : nil
        let items = if case .group(let n) = source { n } else { 1 }
        again = act == .send && PendingPresses.again(outcomeUnknown: entry.item.outcomeUnknown == true, hisPress: true, items: items, request: source == .request)
    }

    /// The capsule's line while it waits.
    public var line: String {
        if case .later(let at) = act { return OutboxModel.laterLine(entry.item, at: at) }
        return OutboxModel.pendingLine(entry.item)
    }

    /// The method the owner's check and the wait's key check are for.
    public var method: KeyMethod {
        if case .mailNow = act { return .mailSendNow }
        return .outboxSend
    }

    /// The word a refusal starts with.
    public var notDone: String {
        if case .later = act { return "Not scheduled" }
        return "Not sent"
    }

    /// The dispatch, once the wait's checks have passed: the grant (if any), then the send. A refused
    /// grant throws `GrantRefused` and the send never leaves.
    /// `ready` is asked before the grant leaves and again before the send leaves (`SendWait.mayStart`): a press whose
    /// phone went to the background, or whose host or key changed, never starts its next request; it throws `NotStarted`.
    public func dispatch(
        grant ask: (Grant) async throws -> Void,
        ready: () -> SendWait<HeldPress>.Why? = { nil },
        send: (_ act: Act, _ again: Bool) async throws -> Void
    ) async throws {
        // Asked before each request that has not left: the grant's, and the send's after the grant answered.
        if let grant {
            if let why = ready() { throw NotStarted(why: why, granted: false) }
            do {
                try await ask(grant)
            } catch let error where Self.lost(error) {
                // A socket that closed under the grant: the grant may stand, and nothing was sent.
                throw GrantLost()
            } catch {
                throw GrantRefused(words: Self.words(error))
            }
        }
        if let why = ready() { throw NotStarted(why: why, granted: grant != nil) }
        try await send(act, again)
    }

    /// The grant's answer was lost: it may have been made; the send never left.
    public struct GrantLost: Error, Sendable, Hashable {
        public var line: String { "Not sent: the grant’s answer was lost" }
    }

    /// A transport fault, not the host's words: the request may have reached it.
    static func lost(_ error: any Error) -> Bool {
        guard let transport = error as? TransportError else { return false }
        switch transport {
        case .notConnected, .closed, .cancelled, .decoding: return true
        case .server(_, let message): return RelayRefusal(message: message)?.kind == .linkDown
        }
    }

    /// The send did not start after its grant: why, in the wait's words.
    public struct NotStarted: Error, Sendable, Hashable {
        public var why: SendWait<HeldPress>.Why
        /// The grant was made before the send could not start: it stands.
        public var granted: Bool = false
    }

    private static func words(_ error: any Error) -> String {
        ActionError.wrap(error).message
    }
}
