import SwiftUI
import TempCodeClient
import TempCodeContract

/// Send on the phone waits its whole five seconds before the host hears it,
/// with Undo in a capsule over the list (phone-outbox.html, "After Send").
/// The rule is the client package's `SendWait`: a second Send waits its own
/// turn, never hurrying the first; the app leaving the screen, or the link to
/// the press's host dropping, cancels what waits and puts it back, and the
/// capsule says so; when the five seconds end the link, the key and the
/// item's revision are checked again. This is its adapter: the clock, the
/// clients, the wire.
///
/// Before the wait: with no link the press is refused at once ("Not connected
/// to <host>"), and the owner's check (`PressGates`) runs once per attempt, so
/// the five seconds start only after a pass. The payload is an `OutboxPress`:
/// one item's `HeldPress` (a grant rides the wait and is made at dispatch, just
/// before the send), or a press on the ticked rows (`GroupPress`), which waits
/// in the same line as one press, asks the owner's check once and goes as one
/// `work.outbox.decide` per host.
@MainActor @Observable
final class OutboxPresses {
    typealias Wait = SendWait<OutboxPress>

    static let shared = OutboxPresses()

    private(set) var wait = Wait()
    /// A press refused before its wait (no link, the check cancelled): the capsule's line, as a notice is.
    private(set) var refusal: String?
    /// Why an item of a press on many did not go, by entry id, in its row until his next press on it.
    private(set) var reasons: [String: String] = [:]
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var clients: (String) -> EnvironmentClient? = { _ in nil }

    private init() {}

    func attach(_ clients: @escaping (String) -> EnvironmentClient?) {
        self.clients = clients
        // Each answer of a host's list keeps its waiting rows for the next cold launch.
        WorkHost.itemsChanged = { host in
            if let client = clients(host.environment.id) { OutboxKeeping.keep(client) }
        }
    }

    /// The press counting its five seconds: the capsule's line and its Undo.
    var pending: Wait.Press? { wait.counting }

    /// The entries the list hides: counting, waiting their turn, or on their way, alone or in a press on many.
    func hides(_ entry: OutboxModel.Entry) -> Bool {
        if wait.holds(entry.id) { return true }
        return ([wait.counting, wait.inFlight].compactMap { $0 } + wait.queued).contains { $0.payload.entries.contains { $0.id == entry.id } }
    }

    /// The last cancel's line when it names this item (the app left the screen, a link or key lost), for the surface
    /// the press was made on: a thread's held line says it as the list's capsule does.
    func notice(for entry: OutboxModel.Entry) -> String? {
        guard let notice = wait.notice, notice.presses.contains(where: { $0.id == entry.id || $0.payload.entries.contains { $0.id == entry.id } }) else { return nil }
        return notice.line
    }

    /// Why this item did not go in his last press on many, while it still waits.
    func reason(_ entry: OutboxModel.Entry) -> String? { reasons[entry.id] }

    /// His Send on one item. Nil: it waits its five seconds. Else the line that says why it did not start, which
    /// the capsule also says unless the press site shows it in its own line (`quiet`: the detail's state line).
    @discardableResult
    func send(_ entry: OutboxModel.Entry, act: HeldPress.Act = .send, grant: HeldPress.Grant? = nil, quiet: Bool = false) async -> String? {
        guard let line = await refused(entry, act: act, grant: grant) else { return nil }
        if !quiet { refusal = line }
        return line
    }

    private func refused(_ entry: OutboxModel.Entry, act: HeldPress.Act, grant: HeldPress.Grant?) async -> String? {
        guard let client = clients(entry.environmentId) else { return "Not sent: the host is not paired" }
        let ref = OutboxModel.key(entry.item.ref)
        // No link: refused at once, the item stays where it is.
        guard Self.linked(client) else { return PendingPresses.notConnected(client.environment.name) }
        // One already out on this item: no second Send until it is read back.
        if client.work.presses.busy(host: entry.environmentId, ref: ref) { return PressState.checking.line }
        guard !hides(entry) else { return nil }
        let gates = PressGates.shared
        let gatePress = PressGates.press(client, HeldPress(entry: entry, act: act).method, ref: ref, rev: String(entry.item.updatedAt))
        guard await gates.allow(gatePress, reason: entry.item.summary) else { return gates.line }
        refusal = nil
        reasons[entry.id] = nil
        let payload = OutboxPress.one(HeldPress(entry: entry, act: act, grant: grant))
        start(Wait.Press(
            id: entry.id,
            host: entry.environmentId,
            hostName: client.environment.name,
            rev: Double(entry.item.updatedAt),
            line: payload.line,
            payload: payload,
            // The key the owner's check passed: another one on the host when the seconds end sends nothing.
            key: gatePress.key
        ))
        return nil
    }

    private func start(_ press: Wait.Press) {
        let counted = wait.counting
        wait.press(press, now: Self.now)
        if wait.counting != counted, let line = wait.counting?.line {
            AccessibilityNotification.Announcement("\(line). Undo for five seconds.").post()
        }
        schedule()
        watchLinks()
    }

    // MARK: - a press on many

    /// The hosts of a press on many, each paired and linked, or the line that says which is not.
    private func groupHosts(_ press: GroupPress) -> Result<[EnvironmentClient], Refusal> {
        var out: [EnvironmentClient] = []
        for host in press.hosts {
            guard let client = clients(host) else { return .failure(Refusal(line: "Not sent: the host is not paired")) }
            guard Self.linked(client) else { return .failure(Refusal(line: PendingPresses.notConnected(client.environment.name))) }
            out.append(client)
        }
        // One already out on any of them: no second press until it is read back.
        if press.entries.contains(where: { entry in out.contains { $0.work.presses.busy(host: entry.environmentId, ref: OutboxModel.key(entry.item.ref)) } }) {
            return .failure(Refusal(line: PressState.checking.line ?? "Checking…"))
        }
        return .success(out)
    }

    private struct Refusal: Error { var line: String }

    /// The owner's check, once for the whole press: every host and key, every item and the revision he saw of each.
    private func gate(_ press: GroupPress, clients: [EnvironmentClient]) async -> Bool {
        let check = PressGate.Press(
            host: clients.map(\.environment.id).joined(separator: ","),
            key: clients.map { PressGates.key($0.environment, revoked: $0.work.keyRevoked) }.joined(separator: ";"),
            action: KeyMethod.outboxDecide.rawValue,
            ref: press.gateRef,
            rev: press.gateRev
        )
        return await PressGates.shared.allow(check, reason: press.head)
    }

    /// His Send on the ticked rows: the links, the owner's check once, then the same five seconds with Undo as one
    /// press, after which each host hears one `work.outbox.decide`. Nil: it waits. Else the line that says why it
    /// did not start (the summary's own line shows it).
    func sendGroup(_ press: GroupPress) async -> String? {
        guard case .send = press.act else { return nil }
        let hosts: [EnvironmentClient]
        switch groupHosts(press) {
        case .failure(let refusal): return refusal.line
        case .success(let list): hosts = list
        }
        guard !press.entries.contains(where: hides) else { return nil }
        guard await gate(press, clients: hosts) else { return PressGates.shared.line }
        refusal = nil
        for entry in press.entries { reasons[entry.id] = nil }
        let names = hosts.map(\.environment.name)
        start(Wait.Press(
            id: press.id,
            host: hosts[0].environment.id,
            hostName: names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names.last!,
            rev: 0,
            line: press.waitingLine,
            payload: .group(press),
            also: Set(hosts.dropFirst().map(\.environment.id)),
            key: Self.keys(hosts.map(\.environment.id))
        ))
        return nil
    }

    /// His Discard on the ticked rows, after its prompt: the links and the owner's check once, then each host's
    /// `work.outbox.decide` at once, as one item's Discard goes; the capsule says the sum ("Discarded 2, 1 not
    /// discarded") and an item that stayed keeps its reason in its row. Nil: it went. Else why nothing started.
    func discardGroup(_ press: GroupPress) async -> String? {
        let hosts: [EnvironmentClient]
        switch groupHosts(press) {
        case .failure(let refusal): return refusal.line
        case .success(let list): hosts = list
        }
        // The key each host is pressed under, frozen before the owner's check: a later host's part is held to it.
        let keys = Dictionary(hosts.map { ($0.environment.id, PressGates.key($0.environment, revoked: $0.work.keyRevoked)) }, uniquingKeysWith: { first, _ in first })
        guard await gate(press, clients: hosts) else { return PressGates.shared.line }
        let outcome = await decide(press, on: hosts, keys: keys)
        if !outcome.head.isEmpty { refusal = outcome.head }
        return nil
    }

    /// Each host's part of a press on many, at once; each item's result lands in `reasons` as its host answers.
    /// `keys`: the key each host was pressed under (frozen before the owner's check). Each host's part is asked again
    /// just before its own request (`SendWait.mayStart`): one the app left, lost or rekeyed while an earlier host
    /// answered never starts, and its items say why beside those that went.
    private func decide(_ press: GroupPress, on hosts: [EnvironmentClient], keys: [String: String] = [:]) async -> GroupOutcome {
        var outcome = GroupOutcome(did: press.act)
        let discard = if case .discard = press.act { true } else { false }
        for client in hosts {
            let host = client.environment.id
            if let why = Self.mayStart(host, key: keys[host], method: .outboxDecide) {
                outcome.fail(host: host, Wait.line(why, hostName: client.environment.name), of: press)
                continue
            }
            do {
                let results = try await client.work.decide(press.decisions(host: host), discard: discard, key: keys[host])
                outcome.take(host: host, results, of: press)
            } catch is PressLedger.Unknown {
                // Lost on its way: each row says Checking… until the host is read back.
                continue
            } catch {
                outcome.fail(host: host, Self.line(error, prefix: discard ? "Not discarded" : "Not sent") ?? "", of: press)
            }
        }
        for entry in press.entries { reasons[entry.id] = outcome.reason(entry.id) }
        return outcome
    }

    /// The press record's last word before any request leaves (`PressLedger.mayLeave`): the app in front, the host
    /// linked, and the key he pressed under still the host's. Set at the root.
    static func mayLeave(_ host: String, key: String?, method: KeyMethod) -> String? {
        guard let client = PressGates.shared.client(host) else { return Wait.line(.notPaired, hostName: "the host") }
        let why = Wait.mayStart(
            foreground: UIApplication.shared.applicationState != .background,
            linked: linked(client),
            maySend: client.work.may(method),
            key: key,
            liveKey: PressGates.shared.liveKey(host)
        )
        return why.map { Wait.line($0, hostName: client.environment.name) }
    }

    /// Whether a part of a press not yet started may start now (`SendWait.mayStart`), on the host's live client.
    static func mayStart(_ host: String, key: String?, method: KeyMethod) -> Wait.Why? {
        guard let client = PressGates.shared.client(host) else { return .notPaired }
        return Wait.mayStart(
            foreground: UIApplication.shared.applicationState != .background,
            linked: linked(client),
            maySend: client.work.may(method),
            key: key,
            liveKey: PressGates.shared.liveKey(host)
        )
    }

    /// Words for a press that went out and did not come back done: nil when its answer was lost (the item's
    /// row says Checking…), else the host's words.
    static func line(_ error: any Error, prefix: String) -> String? {
        if error is PressLedger.Unknown { return nil }
        if let refused = error as? HeldPress.GrantRefused { return refused.line }
        if let stopped = error as? HeldPress.NotStarted { return SendWait<HeldPress>.line(stopped.why, hostName: "the host") }
        if let lost = error as? HeldPress.GrantLost { return lost.line }
        let words = ActionError.wrap(error).message
        // "Not connected to Mac" says itself.
        return words.hasPrefix("Not connected") || words.hasPrefix("Not sent") ? words : "\(prefix): \(words)"
    }

    /// Discard, after its prompt (`outboxDiscardPrompt`): the link and the owner's check, then the host, with his
    /// reason for the thread when he wrote one. Nil: it went, or its answer was lost and the row says Checking…;
    /// else the line to say.
    func discard(_ entry: OutboxModel.Entry, reason: String?) async -> String? {
        guard let client = clients(entry.environmentId) else { return "Not discarded: the host is not paired" }
        let item = entry.item
        // The key the owner's check passes for, carried to where the request leaves (`PressLedger.mayLeave`).
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .outboxDiscard, ref: OutboxModel.key(item.ref), rev: String(item.updatedAt), reason: "Discard \(item.summary)") {
            return line
        }
        do {
            try await client.work.discard(item, reason: reason, key: key)
            return nil
        } catch {
            return Self.line(error, prefix: "Not discarded")
        }
    }

    /// A line in the capsule, from a press the list made (a Discard).
    func say(_ line: String) {
        refusal = line
    }

    func undo() {
        wait.undo(now: Self.now)
        schedule()
    }

    /// TempCode left the screen: nothing waiting goes; each item comes back, and the capsule says so.
    func leftScreen() {
        wait.leftScreen()
        schedule()
    }

    func clearNotice() {
        wait.clearNotice()
        refusal = nil
    }

    /// What the capsule says when nothing counts: the last refusal or cancel.
    var noticeLine: String? { refusal ?? wait.notice?.line }

    // MARK: - the clock

    private static var now: Double { Date().timeIntervalSince1970 }

    /// One sleep, to the counting press's deadline.
    private func schedule() {
        timer?.cancel()
        guard let deadline = wait.deadline else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline - Self.now)))
            guard !Task.isCancelled else { return }
            self?.fire()
        }
    }

    private func fire() {
        guard let counting = wait.counting else { return }
        guard let client = clients(counting.host) else {
            wait.drop(counting.id, why: .notPaired, now: Self.now)
            return schedule()
        }
        let held: HeldPress
        switch counting.payload {
        case .group(let group):
            return fireGroup(counting, group)
        case .one(let one):
            held = one
        }
        let key = OutboxModel.key(held.entry.item.ref)
        let check = Wait.Check(
            linked: Self.linked(client),
            maySend: client.work.may(held.method),
            rev: client.work.items.first { OutboxModel.key($0.ref) == key }.map { Double($0.updatedAt) },
            key: PressGates.shared.liveKey(counting.host)
        )
        guard let press = wait.due(now: Self.now, check: check) else { return schedule() }
        Task {
            let item = held.entry.item
            do {
                // The grant (if one rides the press), then the send: neither left before the five seconds ended.
                try await held.dispatch(
                    // The grant's frame is asked again as the socket releases it, as the send's is.
                    grant: { grant in
                        _ = try await client.work.presses.guarded(host: press.host, key: press.key, method: .outboxGrant) {
                            try await client.work.grant(item, matcher: grant.matcher, label: grant.label)
                        }
                    },
                    // After the grant's answer, the send starts only if the app, the link and the key still hold.
                    ready: { SendWait<HeldPress>.mayStart(foreground: UIApplication.shared.applicationState != .background, linked: Self.linked(client), maySend: client.work.may(held.method), key: press.key, liveKey: PressGates.shared.liveKey(press.host)) },
                    send: { act, again in
                        switch act {
                        // The key he pressed under rides to where the request leaves (`PressLedger.mayLeave`).
                        case .send: _ = try await client.work.send(item, again: again, key: press.key)
                        case .later(let at): _ = try await client.work.later(item, at: at, key: press.key)
                        case .sendNow: _ = try await client.work.sendNow(item, key: press.key)
                        case .mailNow(let id): try await client.work.sendMailNow(item, id: id, key: press.key)
                        }
                    }
                )
            } catch let stopped as HeldPress.NotStarted {
                // Named by its host; after a grant that was made, said so, since the grant stands.
                let line = SendWait<HeldPress>.line(stopped.why, hostName: press.hostName)
                FleetToastCenter.shared.post(message: stopped.granted ? "The grant was made; the send did not start: \(line.dropFirst("Not sent: ".count))" : line)
            } catch {
                // Seen wherever he is by then (the list, a thread, another place), as before.
                if let line = Self.line(error, prefix: held.notDone) { FleetToastCenter.shared.post(message: line) }
            }
            wait.landed(press.id, now: Self.now)
            schedule()
            watchLinks()
        }
    }

    /// A press on many whose five seconds ended: every host still linked and the key still able to decide there,
    /// and some of its items still waiting (the host checks each one's revision itself); then one
    /// `work.outbox.decide` per host, and the capsule says the sum ("Sent 2, 1 not sent").
    private func fireGroup(_ counting: Wait.Press, _ group: GroupPress) {
        let hosts = group.hosts.compactMap(clients)
        guard hosts.count == group.hosts.count else {
            wait.drop(counting.id, why: .notPaired, now: Self.now)
            return schedule()
        }
        let listed = Set(hosts.flatMap { client in client.work.items.map { "\(client.environment.id):\(OutboxModel.key($0.ref))" } })
        let check = Wait.Check(
            linked: hosts.allSatisfy(Self.linked),
            maySend: hosts.allSatisfy { $0.work.may(.outboxDecide) },
            rev: group.entries.contains { listed.contains($0.id) } ? counting.rev : nil,
            key: Self.keys(group.hosts)
        )
        guard let press = wait.due(now: Self.now, check: check) else { return schedule() }
        // The key each host was pressed under, in the press's order (`keys`).
        let frozen = Dictionary(zip(group.hosts, (press.key ?? "").split(separator: ";", omittingEmptySubsequences: false).map(String.init)), uniquingKeysWith: { first, _ in first })
        Task {
            let outcome = await decide(group, on: hosts, keys: frozen)
            if !outcome.head.isEmpty { refusal = outcome.head }
            wait.landed(press.id, now: Self.now)
            schedule()
            watchLinks()
        }
    }

    /// The live keys of a press's hosts, in its order (`PressGates.key`); nil when one left the phone.
    static func keys(_ hosts: [String]) -> String? {
        let keys = hosts.map(PressGates.shared.liveKey)
        return keys.contains { $0 == nil } ? nil : keys.compactMap { $0 }.joined(separator: ";")
    }

    // MARK: - the link

    /// A live socket, and through the box a host awake and reachable.
    static func linked(_ client: EnvironmentClient) -> Bool {
        client.status.transport == .open && client.relayBlock == nil
    }

    /// Hears a waiting press's link or key change; a lost one cancels that host's presses.
    private func watchLinks() {
        let hosts = Set(([wait.counting].compactMap { $0 } + wait.queued).flatMap { [$0.host] + $0.also })
        guard !hosts.isEmpty else { return }
        withObservationTracking {
            for host in hosts {
                if let client = clients(host) { _ = (Self.linked(client), client.work.may(.outboxSend), client.work.may(.outboxDecide)) }
            }
        } onChange: { [weak self] in
            Task { @MainActor in self?.recheck(hosts) }
        }
    }

    /// A press on many waits on this host: its key must still be able to decide there.
    private func groupWaits(on host: String) -> Bool {
        ([wait.counting].compactMap { $0 } + wait.queued).contains { press in
            if case .group = press.payload { press.reaches(host) } else { false }
        }
    }

    private func recheck(_ hosts: Set<String>) {
        for host in hosts {
            guard let client = clients(host) else {
                wait.linkLost(host: host, now: Self.now)
                continue
            }
            if !Self.linked(client) {
                wait.linkLost(host: host, now: Self.now)
            } else if !client.work.may(.outboxSend) || !client.work.may(.outboxDecide) && groupWaits(on: host) {
                wait.keyLost(host: host, now: Self.now)
            }
        }
        schedule()
        watchLinks()
    }
}

/// The capsule while a Send waits: one line and Undo, on glass, 44 pt tall,
/// over the bottom of the list. It enters and leaves from the same edge;
/// with Reduce Motion it only fades.
struct OutboxUndoInset: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// False: the capsule is another surface's (an item's page beside a list that shows it).
    var enabled = true

    func body(content: Content) -> some View {
        let presses = OutboxPresses.shared
        let notice = presses.noticeLine
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Group {
                    if !enabled {
                        EmptyView()
                    } else if let pending = presses.pending {
                        UndoCapsule(line: pending.line) { presses.undo() }
                    } else if let notice {
                        // What did not go and why, in the capsule's own line, until it has been seen.
                        UndoCapsule(line: notice, undo: nil)
                    }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
                .ignoresSafeArea(.keyboard, edges: .bottom)
            }
            .animation(Motion.base, value: presses.pending)
            .animation(Motion.base, value: notice)
            // Seen once the app is back on screen for a toast's time; a new press clears it sooner.
            .task(id: notice.map { "\($0)-\(scenePhase == .active)" }) {
                guard enabled, notice != nil, scenePhase == .active else { return }
                try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
                guard !Task.isCancelled else { return }
                presses.clearNotice()
            }
    }
}

/// One line and Undo on glass (the Outbox's Send, the Files place's Delete).
struct UndoCapsule: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let line: String
    var identifier = "outbox-undo"
    /// Nil: the line alone, with nothing to take back.
    let undo: (() -> Void)?

    var body: some View {
        // At accessibility sizes the line wraps and Undo sits under it: the item, the person or the cause is the
        // tail that would be cut. Line and Undo stay two elements for VoiceOver.
        let large = typeSize.isAccessibilitySize
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Text(line)
                .font(.footnote)
                .lineLimit(large ? 4 : 1)
                .truncationMode(.tail)
            if !large { Spacer(minLength: 0) }
            if let undo {
                Button("Undo", action: undo)
                    .keyboardShortcut("z", modifiers: .command)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tint)
                    .frame(minHeight: 44)
                    .buttonStyle(.pressable)
                    .accessibilityIdentifier(identifier)
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, large ? Layout.rowVertical : 0)
        .frame(minHeight: 44)
        .tcGlass(in: large ? AnyShape(RoundedRectangle(cornerRadius: Radius.field, style: .continuous)) : AnyShape(Capsule()))
        .padding(.horizontal, ComposerBar.edge)
        .frame(maxWidth: ToastMeasure.maxWidth)
        .frame(maxWidth: .infinity)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
    }
}

extension View {
    /// The Outbox's undo capsule, on the list that a Send returns to.
    func outboxUndoInset(_ enabled: Bool = true) -> some View {
        modifier(OutboxUndoInset(enabled: enabled))
    }
}
