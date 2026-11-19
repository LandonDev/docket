import Foundation
import Observation
import TempCodeContract

/// What the phone knows of Work on one host (milestone 46): the switch, the
/// Outbox's waiting items, LifeOS's state and Away. One per
/// `EnvironmentClient`, built from its socket. It reads everything at each
/// open (`connected()`) and keeps it current from the pushes; every press
/// goes to the host and lands back here as the item the host answered.
///
/// Work off on a host (or a host from before Work, which answers no
/// `work.get`) is `isOn == false`: nothing of Work shows for it, so Home is
/// what it was.
@MainActor @Observable
public final class WorkHost {
    /// Away turned off after a stretch: the review's span and the host's tally of it.
    public struct AwayEnd: Sendable, Hashable {
        public var since: Int
        public var until: Int
        public var decided: AwayDecided

        public init(since: Int, until: Int, decided: AwayDecided) {
            self.since = since
            self.until = until
            self.decided = decided
        }
    }

    public let environment: PairedEnvironment
    public private(set) var settings: WorkSettings?
    /// The Outbox's own count, as the host keeps it (`work.outbox`'s `waiting`).
    public private(set) var waiting = 0
    /// Add-on tools a Work thread can reach with no rule yet.
    public private(set) var unreviewed = 0
    /// The waiting items (held, live, sending, failed), newest first.
    public private(set) var items: [OutboxItem] = []
    /// `work.outbox.list` answered at least once on this socket.
    public private(set) var listed = false
    public private(set) var listError: String?
    public private(set) var lifeos: LifeosStatus?
    public private(set) var away: AwaySnapshot?
    /// Set when this host's Away ended and nobody has reviewed it here yet.
    public private(set) var awayEnd: AwayEnd?

    @ObservationIgnored private let socket: TempCodeSocket
    @ObservationIgnored private let defaults: UserDefaults

    public init(socket: TempCodeSocket, environment: PairedEnvironment, defaults: UserDefaults = .standard) {
        self.socket = socket
        self.environment = environment
        self.defaults = defaults
    }

    public var isOn: Bool { settings?.enabled == true }
    public var awayOn: Bool { away?.state.enabled == true }
    /// The key can press Send, Edit and Discard.
    public var canApprove: Bool { environment.caps.contains(.approve) || environment.caps.contains(.admin) }
    public var canAdmin: Bool { environment.caps.contains(.admin) }

    // MARK: - the connection

    /// A new socket: the switch and Away first, then, with Work on, the Outbox and LifeOS.
    public func connected() async {
        async let work = try? socket.request(Methods.WorkGet.self, .init())
        async let awayAnswer = try? socket.request(Methods.AwayGet.self, .init())
        settings = await work
        if let answer = await awayAnswer { take(answer, live: false) }
        guard isOn else { return clear() }
        async let outbox: Void = refreshOutbox()
        async let status: Void = refreshLifeos()
        _ = await (outbox, status)
    }

    public func refreshOutbox() async {
        do {
            let answer = try await socket.request(Methods.WorkOutboxList.self, .init())
            items = answer.items.filter { OutboxModel.waits($0.state) }.sorted { $0.createdAt > $1.createdAt }
            waiting = answer.waiting
            listed = true
            listError = nil
        } catch {
            listError = ActionError.wrap(error).message
        }
    }

    public func refreshLifeos() async {
        if let status = try? await socket.request(Methods.WorkLifeosStatus.self, .init()) { lifeos = status }
    }

    // MARK: - pushes

    /// `work`, `work.outbox`, `work.lifeos` and `away`; everything else is the client's.
    public func applyPush(_ push: ServerPush) {
        switch push {
        case .work(let value):
            let was = isOn
            settings = value.settings
            if !isOn { clear() } else if !was { Task { await self.refreshOutbox(); await self.refreshLifeos() } }
        case .workOutbox(let value):
            waiting = value.waiting
            unreviewed = value.unreviewed
            if let item = value.item { merge(item) } else { Task { await self.refreshOutbox() } }
        case .workLifeos(let value):
            lifeos = value.status
        case .away(let value):
            take(AwaySnapshot(state: value.state, decided: value.decided), live: true)
        default:
            break
        }
    }

    private func clear() {
        items = []
        waiting = 0
        unreviewed = 0
        listed = false
        lifeos = nil
    }

    /// The host's answer for one item: kept while it waits, dropped once decided.
    func merge(_ item: OutboxItem) {
        let key = OutboxModel.key(item.ref)
        let index = items.firstIndex { OutboxModel.key($0.ref) == key }
        if OutboxModel.waits(item.state) {
            if let index { items[index] = item } else { items.insert(item, at: 0) }
        } else if let index {
            items.remove(at: index)
        }
    }

    // MARK: - Away

    private var reviewedKey: String { "work.away.reviewed.\(environment.id)" }

    /// The state the host sent. An end is one the phone saw happen (`live`),
    /// or one found at an open that is newer than the last one reviewed here.
    /// The first open on a phone reviews nothing that came before it.
    private func take(_ snapshot: AwaySnapshot, live: Bool) {
        let previous = away
        away = snapshot
        let state = snapshot.state
        guard !state.enabled else { return }
        let at = Int(state.at)
        let reviewed = defaults.object(forKey: reviewedKey) as? Int
        let ended = live ? previous?.state.enabled == true : (reviewed.map { at > $0 } ?? false)
        if reviewed == nil { defaults.set(at, forKey: reviewedKey) }
        guard ended, snapshot.decided.since > 0, Int(snapshot.decided.since) < at else { return }
        awayEnd = AwayEnd(since: Int(snapshot.decided.since), until: at, decided: snapshot.decided)
    }

    /// The review was opened (or set aside): the end is not offered again.
    public func reviewedAway() {
        if let end = awayEnd { defaults.set(end.until, forKey: reviewedKey) }
        awayEnd = nil
    }

    public func setAway(_ enabled: Bool) async throws {
        let answer = try await socket.request(Methods.AwaySet.self, .init(enabled: enabled))
        take(AwaySnapshot(state: answer.state, decided: away?.decided ?? AwayDecided(since: 0, threads: [])), live: true)
    }

    // MARK: - the presses

    /// The item with its whole payload.
    public func item(_ ref: HeldRef) async throws -> OutboxItem {
        let item = try await socket.request(Methods.WorkOutboxGet.self, .init(ref: ref))
        merge(item)
        return item
    }

    /// Sends exactly what was shown: `rev` is the item's `updatedAt` as the screen read it.
    @discardableResult
    public func send(_ item: OutboxItem) async throws -> OutboxItem {
        let out = try await socket.request(Methods.WorkOutboxSend.self, .init(ref: item.ref, rev: item.updatedAt))
        merge(out)
        return out
    }

    @discardableResult
    public func discard(_ item: OutboxItem) async throws -> OutboxItem {
        let out = try await socket.request(Methods.WorkOutboxDiscard.self, .init(ref: item.ref))
        merge(out)
        return out
    }

    @discardableResult
    public func edit(_ item: OutboxItem, payload: JSONValue?) async throws -> OutboxItem {
        let out = try await socket.request(Methods.WorkOutboxEdit.self, .init(ref: item.ref, payload: payload))
        merge(out)
        return out
    }

    /// Every Result since a time, newest first (the return from Away).
    public func results(since: Int) async throws -> [WorkResult] {
        try await socket.request(Methods.WorkOutboxResults.self, .init(since: since)).results
    }

    public func undo(_ result: WorkResult) async throws -> WorkResult {
        try await socket.request(Methods.WorkOutboxUndo.self, .init(id: result.id))
    }

    // MARK: - Settings → Work

    public func setWork(_ enabled: Bool) async throws {
        settings = try await socket.request(Methods.WorkSet.self, .init(enabled: enabled))
        if isOn { await refreshOutbox(); await refreshLifeos() } else { clear() }
    }

    public func grants() async throws -> [OutboxGrant] {
        try await socket.request(Methods.WorkOutboxGrants.self, .init()).grants
    }

    public func ungrant(_ grant: OutboxGrant) async throws {
        _ = try await socket.request(Methods.WorkOutboxUngrant.self, .init(id: grant.id))
    }

    public func rules() async throws -> [ToolRulesCard] {
        try await socket.request(Methods.WorkOutboxRules.self, .init()).addons
    }

    public func setRule(_ card: ToolRulesCard, tool: String, rule: Methods.WorkOutboxSetRules.Params.Rule) async throws -> ToolRulesCard {
        try await socket.request(Methods.WorkOutboxSetRules.self, .init(addonId: card.addonId, rules: [tool: rule]))
    }
}
