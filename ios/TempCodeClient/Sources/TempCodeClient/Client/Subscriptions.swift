import Foundation
import TempCodeContract

/// What `Subscriptions` asks of the connection: a request, and whether the
/// socket is up. The socket is it (Subscriptions+Socket.swift); a test hands
/// in a stand-in that counts each ask.
public protocol SubscriptionWire: Sendable {
    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output
    var isOpen: Bool { get async }
}

/// What the owner of one transcript gives the subscription set: where its
/// fold is, and how to take a page. `page.reset` is D2's rule: the gap
/// outgrew the replay budget and the host sent a fresh tail, so the owner
/// throws its fold away before folding the rows.
public struct SubscriptionHandlers: Sendable {
    /// The highest seq folded so far; the resume asks for what follows it.
    public var cursor: @MainActor @Sendable () -> Int
    /// The time of the row at the cursor, when known: a resume names it
    /// (`afterTs`), and a host that gave that seq to another row (a crash
    /// between a row's push and its write) answers `reset`.
    public var cursorTs: @MainActor @Sendable () -> Int?
    /// The thread is on screen: its ask says `shown`, and the host serves it
    /// on its interactive lane. It changes a lane, never a right.
    public var shown: @MainActor @Sendable () -> Bool
    public var page: @MainActor @Sendable (EventsPage, _ tailFirst: Bool) -> Void
    /// The host refused the ask that subscribes: the session is gone from it.
    public var gone: @MainActor @Sendable (String) -> Void
    /// Applies the pushes the owner still holds unapplied (`PushIngress`),
    /// asked before the cursor is read: a resume must start after every row
    /// that has arrived, or its gap page repeats them.
    public var settle: @MainActor @Sendable () -> Void

    public init(cursor: @escaping @MainActor @Sendable () -> Int, cursorTs: @escaping @MainActor @Sendable () -> Int? = { nil }, shown: @escaping @MainActor @Sendable () -> Bool = { false }, page: @escaping @MainActor @Sendable (EventsPage, Bool) -> Void, gone: @escaping @MainActor @Sendable (String) -> Void, settle: @escaping @MainActor @Sendable () -> Void = {}) {
        self.cursor = cursor
        self.cursorTs = cursorTs
        self.shown = shown
        self.page = page
        self.gone = gone
        self.settle = settle
    }
}

public let resumeConcurrency = 4

/// The durable subscription set of one environment, the desktop's
/// `Subscriptions` (src/renderer/src/lib/connection/subscriptions.ts). A
/// subscription belongs to the socket that made it, so on every replacement
/// session the set forgets what was subscribed and `resumeAll()` resumes each
/// member from its owner's cursor, a few at a time. A member not yet live on
/// the socket subscribes inside its read, `session.events {subscribe: true}`:
/// one ask, answered `subscribed: true`. A host that predates the flag answers
/// without it, and the member subscribes then and folds the gap. The owner
/// decides what is in the set: it adds a transcript when it opens one and
/// removes it when it closes one, so a reconnect never replays transcripts
/// nobody is looking at.
@MainActor
public final class Subscriptions {
    private let wire: any SubscriptionWire
    private var handlers: [String: SubscriptionHandlers] = [:]
    /// Session ids subscribed on the CURRENT socket.
    private var live: Set<String> = []
    private var held: [String: [EventRow]] = [:]
    private var generation = 0
    private var resumeTokens: [String: UUID] = [:]
    private var inFlight: [String: Task<EventsPage, any Error>] = [:]

    public init(wire: any SubscriptionWire) {
        self.wire = wire
    }

    public var ids: [String] { Array(handlers.keys).sorted() }

    public func has(_ sessionId: String) -> Bool { handlers[sessionId] != nil }

    /// True when the current socket carries this session's pushes.
    public func isLive(_ sessionId: String) -> Bool { live.contains(sessionId) }

    /// The socket was replaced or lost: nothing is subscribed any more.
    public func sessionChanged() {
        generation += 1
        live.removeAll()
        for task in inFlight.values { task.cancel() }
        inFlight = [:]
        held = [:]
        resumeTokens = [:]
    }

    public func add(_ sessionId: String, _ handlers: SubscriptionHandlers) {
        self.handlers[sessionId] = handlers
    }

    /// Leaves the set; the socket is told when it is up.
    public func remove(_ sessionId: String) {
        handlers[sessionId] = nil
        held[sessionId] = nil
        resumeTokens[sessionId] = nil
        inFlight[sessionId]?.cancel()
        inFlight[sessionId] = nil
        guard live.remove(sessionId) != nil else { return }
        let wire = self.wire
        Task { _ = try? await wire.request(Methods.SessionUnsubscribe.self, .init(sessionId: sessionId)) }
    }

    /// A resume owns these pushes until its gap page lands. On failure they
    /// are discarded so the next resume still starts before the missing gap.
    public func hold(_ sessionId: String, rows: [EventRow]) -> Bool {
        guard held[sessionId] != nil else { return false }
        if resumeTokens[sessionId] != nil { held[sessionId]?.append(contentsOf: rows) }
        return true
    }

    /// Fetches what follows the owner's cursor (`tail` rows for a cold open),
    /// subscribing in the same ask when the current socket does not carry the
    /// session yet. The page goes to the owner; a second call while one is in
    /// flight joins it. Reads alone: nothing here is outward, and a failed
    /// resume is asked again only by its owner or the next session.
    @discardableResult
    public func resume(_ sessionId: String, tail: Int? = nil) -> Task<EventsPage, any Error> {
        if let pending = inFlight[sessionId] { return pending }
        let wire = self.wire
        handlers[sessionId]?.settle()
        let afterSeq = handlers[sessionId]?.cursor() ?? 0
        let afterTs = afterSeq > 0 ? handlers[sessionId]?.cursorTs() : nil
        let generation = self.generation
        let token = UUID()
        resumeTokens[sessionId] = token
        held[sessionId] = []
        let task = Task<EventsPage, any Error> { [weak self] in
            guard let self, let handlers = self.handlers[sessionId] else { throw TransportError.notConnected }
            var completed = false
            defer {
                if self.resumeTokens[sessionId] == token {
                    // Keep the gate closed after a failed gap fetch. Later
                    // pushes must not move the cursor before the next replay.
                    self.held[sessionId] = completed ? nil : []
                    self.resumeTokens[sessionId] = nil
                }
            }
            let current = { self.generation == generation && self.resumeTokens[sessionId] == token && self.handlers[sessionId] != nil }
            // The host subscribes before it reads: a row appended after the
            // subscription is pushed, one before it is in the page.
            let together = !self.live.contains(sessionId)
            let tailFirst = tail != nil && afterSeq == 0
            let page: EventsPage
            do {
                page = try await wire.request(Methods.SessionEvents.self, .init(
                    sessionId: sessionId,
                    afterSeq: tailFirst ? nil : afterSeq,
                    afterTs: tailFirst ? nil : afterTs,
                    tail: tailFirst ? tail : nil,
                    subscribe: together ? true : nil,
                    shown: handlers.shown() ? true : nil
                ))
                try Task.checkCancellation()
            } catch {
                if together {
                    // The host may have subscribed before the answer was lost.
                    self.letGo(sessionId, generation: generation, token: token)
                    self.refused(sessionId, error, handlers, unknownOnly: true)
                }
                throw error
            }
            guard current() else {
                // An owner that left while this was on its way has nobody to fold the pushes.
                if together, page.subscribed == true { self.letGo(sessionId, generation: generation, token: token) }
                throw TransportError.notConnected
            }
            handlers.page(page, tailFirst)
            if together, page.subscribed == true {
                self.live.insert(sessionId)
            } else if together {
                // A host that predates the flag read the page unsubscribed:
                // subscribe now and fold what landed between the two.
                do {
                    _ = try await wire.request(Methods.SessionSubscribe.self, .init(sessionId: sessionId))
                } catch {
                    self.refused(sessionId, error, handlers, unknownOnly: false)
                    throw error
                }
                try Task.checkCancellation()
                guard current() else { throw TransportError.notConnected }
                self.live.insert(sessionId)
                let cursor = handlers.cursor()
                let gap = try await wire.request(Methods.SessionEvents.self, .init(sessionId: sessionId, afterSeq: cursor, afterTs: cursor > 0 ? handlers.cursorTs() : nil, shown: handlers.shown() ? true : nil))
                try Task.checkCancellation()
                guard current() else { throw TransportError.notConnected }
                handlers.page(gap, false)
            }
            let cursor = handlers.cursor()
            var unique: [Int: EventRow] = [:]
            var ephemeral: [EventRow] = []
            for row in self.held.removeValue(forKey: sessionId) ?? [] {
                if row.ephemeral == true { ephemeral.append(row) }
                else if row.seq > cursor { unique[row.seq] = row }
            }
            let persisted = unique.values.sorted { $0.seq < $1.seq }
            let finishedCalls = Set((page.rows + persisted).compactMap { row -> String? in
                switch row.event {
                case .toolCall(let call) where call.partial != true: call.callId
                case .toolResult(let result): result.callId
                default: nil
                }
            })
            let previews = ephemeral.filter { row in
                if case .toolCall(let call) = row.event { return !finishedCalls.contains(call.callId) }
                return true
            }
            let rows = persisted + previews
            if !rows.isEmpty {
                handlers.page(EventsPage(rows: rows, moreBefore: false, moreAfter: false, reset: false), false)
            }
            completed = true
            return page
        }
        inFlight[sessionId] = task
        Task { [weak self] in
            _ = try? await task.value
            if self?.inFlight[sessionId] == task { self?.inFlight[sessionId] = nil }
        }
        return task
    }

    /// The host refused the ask that subscribes: the session is gone from it.
    /// A read is refused for other causes too (a log it could not read), so
    /// there only the host's own words for an id it does not show
    /// (`unknown session`, wire.ts `sessionEvents`) say gone; a refused
    /// `session.subscribe` says it whatever the words, as before.
    private func refused(_ sessionId: String, _ error: any Error, _ owner: SubscriptionHandlers, unknownOnly: Bool) {
        guard let error = error as? TransportError, case .server(_, let message) = error, handlers[sessionId] != nil else { return }
        guard !unknownOnly || message.hasPrefix(Self.unknownSession) else { return }
        owner.gone(message)
    }

    /// How the host begins its refusal of an id it shows no row for.
    static let unknownSession = "unknown session"

    /// The host may hold a subscription the set never took (its answer lost,
    /// or its owner gone): it is let go, unless a newer resume on this socket
    /// owns the session by now.
    private func letGo(_ sessionId: String, generation: Int, token: UUID) {
        guard self.generation == generation, !live.contains(sessionId), resumeTokens[sessionId] == token || handlers[sessionId] == nil else { return }
        let wire = self.wire
        Task {
            guard await wire.isOpen else { return }
            _ = try? await wire.request(Methods.SessionUnsubscribe.self, .init(sessionId: sessionId))
        }
    }

    /// After a replacement session: every member subscribes and resumes
    /// again, a few at a time. `first` goes in the first batch, ahead of the
    /// rest: the thread on screen is the one the person is waiting on.
    public func resumeAll(tail: Int, first: String? = nil) async {
        var ids = self.ids
        if let first, let at = ids.firstIndex(of: first) {
            ids.remove(at: at)
            ids.insert(first, at: 0)
        }
        var start = 0
        while start < ids.count {
            let end = min(start + resumeConcurrency, ids.count)
            let tasks = ids[start..<end].compactMap { id in handlers[id] != nil ? resume(id, tail: tail) : nil }
            for task in tasks { _ = try? await task.value }
            start = end
        }
    }
}
