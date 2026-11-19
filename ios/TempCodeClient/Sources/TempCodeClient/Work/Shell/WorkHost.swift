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
    /// The host's switch; the last one known (kept per host across launches) until the host answers.
    public private(set) var settings: WorkSettings? {
        didSet { if let settings { defaults.set(settings.enabled, forKey: switchKey) } }
    }
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
    /// Moves on each `work.outbox.result` push: a Results list on screen reads again.
    public private(set) var resultsRev = 0
    /// Moves on each `work.guests` push: Settings → Work's guest links read again.
    public private(set) var guestsRev = 0
    /// Moves on each `work.rules` push, per workspace: its rules page reads again.
    public private(set) var rulesRev: [String: Int] = [:]
    /// Set when this host's Away ended and nobody has reviewed it here yet.
    public private(set) var awayEnd: AwayEnd?

    @ObservationIgnored let socket: TempCodeSocket
    /// A Work thread's items and the Routines counter (Work/Items/WorkCanvas.swift, milestone 47).
    public let canvas: WorkCanvas
    @ObservationIgnored private let defaults: UserDefaults

    public init(socket: TempCodeSocket, environment: PairedEnvironment, defaults: UserDefaults = .standard) {
        self.socket = socket
        canvas = WorkCanvas(socket: socket)
        self.environment = environment
        self.defaults = defaults
        // The cached paint has the Work band: the switch as last read, until this open's answer.
        if let known = defaults.object(forKey: "work.on.\(environment.id)") as? Bool { settings = WorkSettings(enabled: known) }
    }

    private var switchKey: String { "work.on.\(environment.id)" }

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
        // A host that does not answer (asleep, a timeout) keeps the switch it had: its Work rows stay on Home.
        if let answer = await work { settings = answer }
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
        case .workCanvas, .workRoutines:
            canvas.apply(push)
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
        case .workOutboxResult:
            resultsRev += 1
        case .workRules(let value):
            rulesRev[value.workspaceId, default: 0] += 1
        case .workGuests:
            guestsRev += 1
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
        // An answer older than what is held (the open's `away.get`, landing after a flip the phone made
        // meanwhile) would hide the flip's on-to-off change: the newer state stands.
        if let held = away, snapshot.state.at < held.state.at { return }
        let previous = away
        away = snapshot
        let state = snapshot.state
        // A new stretch: an end not yet reviewed belongs to the stretch before; the next end brings its own.
        guard !state.enabled else { awayEnd = nil; return }
        let at = Int(state.at)
        // The same end heard again (the push after the phone's own press, which may carry the stretch's
        // tally the press's answer did not): the end keeps its span and takes the newer tally.
        if let end = awayEnd, end.until == at {
            if Int(snapshot.decided.since) >= end.since { awayEnd?.decided = snapshot.decided }
            return
        }
        let reviewed = defaults.object(forKey: reviewedKey) as? Int
        let ended = live ? previous?.state.enabled == true : (reviewed.map { at > $0 } ?? false)
        if reviewed == nil { defaults.set(at, forKey: reviewedKey) }
        guard ended else { return }
        // The stretch began when Away went on. A tally from before that stretch (the press's answer can
        // land before the push that resets it) is not this one's: then the span is from the on.
        let onAt = previous.flatMap { $0.state.enabled ? Int($0.state.at) : nil }
        let tallied = Int(snapshot.decided.since)
        let current = onAt.map { tallied >= $0 } ?? (tallied > 0)
        let since = current ? tallied : (onAt ?? 0)
        guard since > 0, since < at else { return }
        awayEnd = AwayEnd(since: since, until: at, decided: current ? snapshot.decided : AwayDecided(since: Double(since), threads: []))
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

    /// "Send and stop holding": a standing grant made from this held item (admin), then its Send.
    public func grant(_ item: OutboxItem, matcher: JSONValue, label: String) async throws -> OutboxGrant {
        try await socket.request(Methods.WorkOutboxGrant.self, .init(from: item.ref, matcher: matcher, label: label))
    }

    /// A thread's Results (its subagents' with it), newest first.
    public func results(sessionId: String) async throws -> [WorkResult] {
        try await socket.request(Methods.WorkOutboxResults.self, .init(sessionId: sessionId)).results
    }

    /// A Work workspace: the host makes its own folder; `sector` links it to LifeOS.
    public func createWorkspace(name: String, sector: String?) async throws -> WorkspaceMeta {
        try await socket.request(Methods.WorkspaceCreate.self, .init(name: name, kind: .work, sector: sector.map { .set($0) }))
    }

    /// A Work Chat: a Work thread in no workspace, started with its first message.
    public func newWorkChat(firstMessage: String) async throws -> SessionMeta {
        try await socket.request(Methods.SessionCreate.self, .init(workspaceId: .clear, threadType: .set(.chat), firstMessage: firstMessage, scope: .work))
    }

    // MARK: - house rules (milestone 39)

    public func rules(_ workspaceId: String) async throws -> Methods.WorkRulesList.Output {
        try await socket.request(Methods.WorkRulesList.self, .init(workspaceId: workspaceId))
    }

    @discardableResult
    public func addRule(_ workspaceId: String, text: String, proposalId: String? = nil) async throws -> HouseRule {
        try await socket.request(Methods.WorkRulesAdd.self, .init(workspaceId: workspaceId, text: text, proposalId: proposalId))
    }

    @discardableResult
    public func editRule(_ id: String, text: String? = nil, on: Bool? = nil) async throws -> HouseRule {
        try await socket.request(Methods.WorkRulesEdit.self, .init(id: id, text: text, on: on))
    }

    /// `reopen`: Undo after an add from a proposal puts the proposal back.
    public func removeRule(_ id: String, reopen: Bool = false) async throws {
        _ = try await socket.request(Methods.WorkRulesRemove.self, .init(id: id, reopen: reopen ? true : nil))
    }

    public func orderRules(_ workspaceId: String, ids: [String]) async throws {
        _ = try await socket.request(Methods.WorkRulesOrder.self, .init(workspaceId: workspaceId, ids: ids))
    }

    @discardableResult
    public func decide(_ proposalId: String, to: Methods.WorkRulesDecide.Params.To) async throws -> RuleProposal {
        try await socket.request(Methods.WorkRulesDecide.self, .init(id: proposalId, to: to))
    }

    // MARK: - guest links (milestone 31)

    /// Every link this host serves, live first; a host that does not serve LifeOS's documents answers `served elsewhere`.
    public func guestLinks() async throws -> [GuestLinkRow] {
        try await socket.request(Methods.WorkGuestsList.self, .init())
    }

    /// A new address for a live link, shown once; the one before opens nothing from now on.
    public func rekey(_ link: GuestLinkRow) async throws -> String {
        try await socket.request(Methods.WorkGuestsRekey.self, .init(linkId: link.id)).url
    }

    public func revoke(_ link: GuestLinkRow) async throws {
        _ = try await socket.request(Methods.WorkGuestsRevoke.self, .init(linkId: link.id))
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
