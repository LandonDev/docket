import Foundation
import Observation
import TempCodeClient
import TempCodeContract

/// The one Today store of the app and what feeds it (docs/IOS-DESIGN.md "Today"). It watches what the phone
/// already holds of each host (the Outbox's items, the digest's rows, the catalog, the push counters, the link)
/// through Observation, and LifeOS's lists while Today is on screen, and hands each change to the store whole.
/// Started by the Work list and by Today, once; nothing here reads a socket.
@MainActor
enum TodayFeed {
    static let store = TodayStore(cache: TodayDiskCache.opened())
    private static var registry: ClientRegistry?
    /// The tracking that is current: an older one's change is not followed.
    private static var generation = 0
    /// What the Outbox's kept rows were last told of each host: its key stands, Work is on, it is paired.
    private static var outboxHeard: [String: (revoked: Bool, workOn: Bool)] = [:]

    /// The feed starts; a second call does nothing.
    static func start(_ registry: ClientRegistry) {
        guard self.registry == nil else { return }
        self.registry = registry
        store.readsOf = { [weak registry] id in registry?.client(id)?.work }
        store.retryLife = { [weak registry] retry in await TodayLife.retry(retry, registry?.ordered ?? []) }
        // A host's LifeOS signing out, heard by its Get or push whether or not Today shows: its sessions end (their
        // late answers land nowhere) and Today forgets what they gave.
        WorkHost.heardLifeosSignOut = { host in
            WorkLifeHost.signedOut(host: host)
            store.lifeosSignedOut(host: host)
        }
        track()
    }

    /// Today came on screen or left it: its LifeOS queries are held or let go.
    static func onScreen(_ on: Bool) {
        TodayLife.onScreen(on)
        if on { track() }
    }

    /// Reads every input under Observation, hands it to the store, and reads again at the next change.
    private static func track() {
        guard let registry else { return }
        generation += 1
        let mine = generation
        let (hosts, life) = withObservationTracking {
            let clients = registry.ordered
            return (clients.map(input), TodayLife.input(clients))
        } onChange: {
            Task { @MainActor in
                guard mine == generation else { return }
                track()
            }
        }
        forgetOutbox(hosts)
        // The clock, where the minute moved since the page was built: the Work list's line says it while Today is off
        // screen too (`TodayScreen` ticks it each minute while on).
        store.tick(now: Date().timeIntervalSince1970 * 1000, ifMoved: true)
        store.update(hosts: hosts)
        if let life { store.update(life: life) }
    }

    /// A host whose key was refused, whose Work went off or that left takes its Outbox rows with it, from memory and
    /// disk, as Today's own go (`TodayStore.purge`).
    private static func forgetOutbox(_ hosts: [TodayHostInput]) {
        for id in outboxHeard.keys where !hosts.contains(where: { $0.environmentId == id }) {
            OutboxKeeping.kept.drop(.hostRemoved(host: id))
            outboxHeard[id] = nil
        }
        for host in hosts {
            let was = outboxHeard[host.environmentId]
            if host.revoked, was?.revoked != true {
                OutboxKeeping.kept.drop(.capabilityLost(host: host.environmentId))
            } else if !host.revoked, was?.workOn == true, !host.workOn {
                OutboxKeeping.kept.drop(.workOff(host: host.environmentId))
            }
            outboxHeard[host.environmentId] = (host.revoked, host.workOn)
        }
    }

    /// The host's link is open, or its first one is still being made: a list it has not given yet is still coming.
    /// Otherwise it is offline, and a list it never gave on this launch is "Not connected" (Today, the Outbox).
    /// A first try counts: a cold launch's, and a return from the background's (the socket reads suspended, then
    /// connecting or reconnecting, with no failed attempt), so a return never blanks Today's sections for the
    /// second it takes to link. A failed attempt, a halt, no network or a refused key does not.
    static func open(_ client: EnvironmentClient) -> Bool {
        let status = client.status
        let firstTry = status.attempts == 0 && status.halt == nil && status.transport != .offline && status.transport != .unauthorized
        return client.work.linked || firstTry
    }

    /// One host as Today reads it. A host still on its first connect counts as there, so the first frame names
    /// no host offline; Today reads it only once its link is live.
    static func input(_ client: EnvironmentClient) -> TodayHostInput {
        let work = client.work
        var revs = TodayHostInput.Revs()
        revs.messages = work.messagesRev
        revs.money = work.moneyRev
        revs.prep = work.prepRev
        revs.msforms = work.msformsRev
        revs.clashes = work.clashesRev
        revs.review = work.reviewRev
        // What a Send holds back for its five seconds is not counted, as on the Work list's Outbox row.
        let presses = OutboxPresses.shared
        let held = work.items.filter { !presses.hides(OutboxModel.Entry(environmentId: client.environment.id, item: $0)) }
        return TodayHostInput(
            environmentId: client.environment.id, name: client.environment.name, workOn: work.isOn, open: open(client), linked: work.linked,
            workspaces: client.workspaces, held: held, requests: work.requests, threads: threads(client, work.requests),
            heldLoaded: work.listed, heldError: work.listError,
            tells: work.digest.ledger?.rows, tellsError: work.digest.error, revs: revs, key: TodayHostInput.key(client.environment),
            revoked: work.keyRevoked
        )
    }

    /// The titles of the threads that asked, as the phone holds them.
    private static func threads(_ client: EnvironmentClient, _ requests: [OutboxRequest]) -> [String: String] {
        var out: [String: String] = [:]
        for request in requests { if let title = client.session(request.sessionId)?.title { out[request.sessionId] = title } }
        return out
    }
}
