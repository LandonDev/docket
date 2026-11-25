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
public final class WorkHost: CaptureHost {
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
    /// What Waiting lists (`OutboxModel.listed`: what waits on him, one on its way, the sends he timed), newest first.
    public private(set) var items: [OutboxItem] = []
    /// A thread's requests for his press that are still open, oldest first (`work.outbox.requests`, the
    /// `work.outbox.request` push). Empty for a key without approve: the host shows them to approve alone.
    public private(set) var requests: [OutboxRequest] = []
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
    /// Moves on each `work.docs` push, per document (the service's `doc`): its comments and review read again.
    public private(set) var docsRev: [String: Int] = [:]
    /// Moves on each `work.sheets` push, per item: its review reads again.
    public private(set) var sheetsRev: [String: Int] = [:]
    /// Work lists can read again when their host or workspace's counter moves.
    public private(set) var messagesRev: [String: Int] = [:]
    public private(set) var moneyRev: [String: Int] = [:]
    public private(set) var prepRev: [String: Int] = [:]
    public private(set) var clashesRev = 0
    public private(set) var reviewRev = 0
    public private(set) var msformsRev: [String: Int] = [:]
    /// M5b: the job's plays read again on the `work.routines.plays` push, per workspace.
    public private(set) var playsRev: [String: Int] = [:]
    /// M5b: the Windows VM this host keeps, as `work.winvm.state` and its push last said (nil: not asked yet).
    public internal(set) var winvm: WinvmStatePhone?
    /// The slideshows running on windows of this host, by show (`work.slides.show.state` and its push): the Work
    /// list's "Showing on" row and the clicker read them.
    public private(set) var shows: [String: ShowLive] = [:]
    /// Moves on each `work.slides.show` push: an open clicker takes the show it steps.
    public private(set) var showsRev = 0
    /// The last show a push said, with its id (nil `live`: it ended).
    public private(set) var showPushed: (showId: String, live: ShowLive?)?
    public private(set) var outboxRequestsRev = 0
    /// Set when this host's Away ended and nobody has reviewed it here yet.
    public private(set) var awayEnd: AwayEnd?

    @ObservationIgnored let socket: TempCodeSocket
    /// A Work thread's items and the Routines counter (Work/Items/WorkCanvas.swift, milestone 47).
    public let canvas: WorkCanvas
    /// The Files place of this host's Work workspaces (Work/Files/FilesHost.swift, the files pillar's F9).
    public let files: FilesHost
    /// The digest's ledger and settings on this host (Work/Digest/WorkDigest.swift).
    public let digest: WorkDigest
    /// The methods this host refused as unknown since its socket opened (Work/Reader/HostCan.swift).
    public let can: HostCan
    @ObservationIgnored private let defaults: UserDefaults
    /// The phone's record of outward presses whose answer is not known yet (one for every host).
    public let presses: PressLedger

    public init(socket: TempCodeSocket, environment: PairedEnvironment, defaults: UserDefaults = .standard, presses: PressLedger = .shared) {
        self.socket = socket
        self.presses = presses
        let can = HostCan()
        self.can = can
        let key = KeyMay(caps: environment.caps, lane: .of(relayed: environment.isRelayed, locked: Self.relayLocked?(environment.id) == true))
        // A preview is made on the host (`work.formats.preview`, operate): approve alone does not make one.
        canvas = WorkCanvas(socket: socket, can: can, mayAct: key(.formatsPreview))
        // A file others can open takes the word approve itself (files/policy.ts `admitWrite`), and Put Back (Delete's
        // Undo with it) the word operate itself (files/handle.ts `admitRestore`): admin stands in for neither, so an
        // admin-only key is never offered a Delete it could not take back.
        files = FilesHost(wire: SocketFilesWire(socket: socket), environmentId: environment.id, caps: .init(operate: KeyMay(caps: environment.caps)(.filesRestore), approve: environment.caps.contains(.approve)))
        #if canImport(SQLite3)
        // Each folder's last page of names, for the cold paint (Work/Files/FolderKept.swift).
        files.kept = FolderKept(cache: FolderDiskCache.shared, environment: environment)
        #endif
        // An original a past launch was showing when it ended goes now.
        OriginalFiles.sweepAtLaunch()
        MediaFiles.sweepAtLaunch()
        digest = WorkDigest(socket: socket)
        #if canImport(SQLite3)
        // The Digest's newest days with their rows, for a cold open while the host is away (Work/Digest/DigestKept.swift).
        digest.keeping = DigestKept(cache: DigestDiskCache.shared, key: WorkCache.digestKey(environment))
        // A key paired again starts a new generation (`addedAt`): what an older key kept goes, with any write of it
        // still queued.
        WorkCacheStore.purge(.keyReplaced(host: environment.id, generation: Int(environment.addedAt)), close: false)
        #endif
        self.environment = environment
        self.defaults = defaults
        // The cached paint has the Work band: the switch as last read, until this open's answer.
        if let known = defaults.object(forKey: "work.on.\(environment.id)") as? Bool { settings = WorkSettings(enabled: known) }
        // What became of a press after its site stopped waiting (an answer after fifteen seconds, a read-back) reaches
        // the screen that holds it: a reply's desk by its attempt key, a Create link's sheet by its item.
        presses.listen(.chatReply) { press, state in
            if let attempt = press.attempt { MessagesDesks.shared.readBack(attempt: attempt, state: state, host: press.host, ref: press.ref) }
        }
        presses.listen(.guestLink) { press, state in GuestAttempts.shared.heard(host: press.host, ref: press.ref, state: state) }
        presses.listen(.guestRekey) { press, state in GuestAttempts.shared.heard(host: press.host, ref: press.ref, state: state) }
        presses.listen(.outboxDecide) { press, state in
            if let id = PendingPress.request(ofRef: press.ref) { Self.requestHeard?(press.host, id, state, nil) }
        }
        presses.listen(.mailSend) { press, state in
            if let draft = PendingPress.draft(ofRef: press.ref) { Self.mailHeard?(press.host, draft, state) }
        }
    }

    /// A composer Send of a draft, once the phone knows what became of it after Checking (a late answer, a read-back):
    /// its host, the draft's id and the state. Mail says it (the app sets it, `MailPresses`).
    public static var mailHeard: (@MainActor (String, String, PressState) -> Void)?

    /// Whether the box last said a relayed Mac's screen is locked, by environment id (the app's registry answers it):
    /// a `screen` method is then not drawn (`KeyMay.Lane.relayedLocked`).
    public static var relayLocked: (@MainActor (String) -> Bool)?

    /// His own mail draft read back on the job's LifeOS session, by host and draft id (the app sets it; it throws while
    /// no session can read it, and the press stays Checking).
    public static var mailDraftTruth: (@MainActor (String, String) async throws -> PressTruth)?

    /// A thread's request a press was for, once the phone knows what became of the press: its host, its id, the
    /// press's state, and the request as the host now answers it when it was read (the request sheet's wait hears it).
    public static var requestHeard: (@MainActor (String, String, PressState, OutboxRequest?) -> Void)?

    private var switchKey: String { "work.on.\(environment.id)" }

    public var isOn: Bool { settings?.enabled == true }
    /// Some kind of thread is away on this host (`AwayKinds`).
    public var awayOn: Bool { away.map { AwayKinds.any($0.state) } == true }
    /// The host refused this key (revoked or deleted): its client's socket said so, and it holds until a link to the
    /// host truly opens (`refused`, `opened`). A Retry that only starts a new connect does not lift it.
    public internal(set) var keyRevoked = false
    /// A live socket to this host (its client's status): with none, an outward press is refused at once.
    public internal(set) var linked = false

    /// This key, as the host judges its presses (KeyMay.swift).
    public var key: KeyMay {
        KeyMay(caps: environment.caps, revoked: keyRevoked, lane: .of(relayed: environment.isRelayed, locked: Self.relayLocked?(environment.id) == true))
    }

    /// Whether a press of `method` is drawn: the host would allow it on this lane.
    public func may(_ method: KeyMethod) -> Bool { key(method) }

    // MARK: - the connection

    /// A new socket: the switch and Away first, then, with Work on, the Outbox and LifeOS.
    public func connected() async {
        opened()
        can.connected()
        async let work = try? socket.request(Methods.WorkGet.self, .init())
        async let awayAnswer = try? socket.request(Methods.AwayGet.self, .init())
        // A host that does not answer (asleep, a timeout) keeps the switch it had: its Work rows stay on Home.
        if let answer = await work { settings = answer }
        if let answer = await awayAnswer { take(answer, live: false) }
        guard isOn else {
            wentOff()
            // A press lost just before Work went off here is read back all the same, never left Checking.
            return await checkPresses()
        }
        async let outbox: Void = refreshOutbox()
        async let status: Void = refreshLifeos()
        async let ledger: Void = digest.reconnected()
        async let running: Void = refreshShows()
        _ = await (outbox, status, ledger, running)
        await checkPresses()
    }

    /// Each press on this host whose answer was lost, read back by its item's ref.
    func checkPresses() async {
        await presses.check(host: environment.id) { [socket] press in
            guard let ref = OutboxModel.ref(press.ref) else { return nil }
            let item = try await socket.request(Methods.WorkOutboxGet.self, .init(ref: ref))
            self.merge(item)
            return item
        }
        // His Send on a thread's request, by the request (claimed before anything goes, so answered is his press).
        await presses.check(host: environment.id, where: { $0 == .outboxDecide }) { [socket] press in
            guard let id = PendingPress.request(ofRef: press.ref) else { return .mayHaveGone }
            do {
                let request = try await socket.request(Methods.WorkOutboxRequestGet.self, .init(id: id))
                self.mergeRequest(request)
                if request.running != true { Self.requestHeard?(self.environment.id, id, PressState.request(request.state), request) }
                return PressTruth.request(request, rev: press.rev)
            } catch let error where Self.noSuchRequest(error) {
                return PressTruth.request(nil, rev: press.rev)
            }
        }
        // His composer's mail Sends: by the Outbox's item for a thread's draft, else by the draft's status in LifeOS,
        // read on the job's own LifeOS session where the app has one (`mailDraftTruth`).
        await presses.check(host: environment.id, where: { $0 == .mailSend }) { [socket] press in
            guard let id = PendingPress.draft(ofRef: press.ref), let ref = OutboxModel.ref(press.ref) else { return .mayHaveGone }
            do {
                let item = try await socket.request(Methods.WorkOutboxGet.self, .init(ref: ref))
                self.merge(item)
                return PressTruth.mailItem(item)
            } catch let error where PressLedger.noSuchItem(error) {
                guard let read = Self.mailDraftTruth else { throw error }
                return try await read(self.environment.id, id)
            }
        }
        // His chat replies, by their attempt keys (Work/Messages/WorkHost+Messages.swift).
        await checkChatPresses()
        // His clash answers, by the clash list (Work/Clash/WorkHost+Clash.swift).
        await checkClashPresses()
        // His Create link presses, by their attempt keys (Work/Guests/WorkHost+Guests.swift).
        await checkGuestPresses()
    }

    /// The host's words for a request it does not hold (requests.ts `NO_SUCH_REQUEST`).
    static func noSuchRequest(_ error: any Error) -> Bool {
        if case .server(_, let message)? = error as? TransportError { return message.contains("no such request") }
        return false
    }

    /// Moves on each `clear` (Work off, a refused key): a list read that left before it lands nowhere.
    @ObservationIgnored private var cleared = 0

    public func refreshOutbox() async {
        let asked = cleared
        do {
            let answer = try await socket.request(Methods.WorkOutboxList.self, .init())
            // An answer that lands after the host refused the key, or after Work went off, shows nothing of it.
            guard !keyRevoked, asked == cleared else { return }
            items = answer.items.filter(OutboxModel.listed).sorted { $0.createdAt > $1.createdAt }
            waiting = answer.waiting
            listed = true
            listError = nil
            Self.itemsChanged?(self)
        } catch {
            listError = ActionError.wrap(error).message
        }
        await refreshRequests()
    }

    /// The open requests, read only by a key the host lets list them (`KeyMethod.outboxRequests`: approve, the
    /// person's own word). A host from before requests refuses the method: then there are none.
    public func refreshRequests() async {
        guard may(.outboxRequests) else { return requests = [] }
        if let answer = try? await socket.request(Methods.WorkOutboxRequests.self, .init()), !keyRevoked {
            requests = answer.requests.filter { $0.state == .open }
        }
    }

    /// The shows running now; a host from before the clicker's wire, or a key that may not read them, has none.
    public func refreshShows() async {
        guard may(.slidesShowState) else { return shows = [:] }
        _ = try? await readShows()
    }

    /// The host's whole list of running shows (of one deck when `itemId` is named): it replaces what was held.
    func takeShows(_ live: [ShowLive], itemId: String?) {
        var next = shows.filter { itemId != nil && $0.value.itemId != itemId }
        for show in live where !show.ended { next[show.showId] = show }
        if next != shows { shows = next }
    }

    /// One show as the host said it: kept while it runs, dropped once it ended; an older word never replaces a newer.
    func takeShow(showId: String, _ live: ShowLive?) {
        guard let live, !live.ended else { return shows[showId] = nil }
        if let held = shows[showId], held.rev > live.rev { return }
        shows[showId] = live
    }

    public func refreshLifeos() async {
        if let status = try? await socket.request(Methods.WorkLifeosStatus.self, .init()) { heardLifeos(status) }
    }

    /// The host's LifeOS status, from its Get at each link or its push, through one door: a sign-out heard either
    /// way (a first status after a link counts, since `clear` forgets the last) drops what its session kept.
    private func heardLifeos(_ status: LifeosStatus) {
        let wasSignedOut: Bool = if case .signedOut? = lifeos?.lifeos { true } else { false }
        lifeos = status
        if case .signedOut = status.lifeos, !wasSignedOut { lifeosSignedOut() }
    }

    // MARK: - pushes

    /// Apply the host's Work pushes to the state and lists that read them.
    public func applyPush(_ push: ServerPush) {
        switch push {
        case .workCanvas, .workCanvasFetch, .workRoutines:
            canvas.apply(push)
        case .workFiles:
            files.apply(push)
        case .workDigest(let value):
            digest.apply(value)
        case .work(let value):
            let was = isOn
            settings = value.settings
            if !isOn {
                wentOff()
            } else if !was {
                Task { await self.refreshOutbox(); await self.refreshLifeos() }
                // A day he saw while Work was off here is said now.
                Task { await self.digest.reconnected() }
            }
        case .workOutbox(let value):
            waiting = value.waiting
            unreviewed = value.unreviewed
            if let item = value.item {
                merge(item)
                // A press on it whose answer was lost is read back by the pushed item now, not at the next link.
                presses.heard(host: environment.id, item: item)
            } else {
                Task { await self.refreshOutbox() }
            }
        case .workLifeos(let value):
            heardLifeos(value.status)
        case .workOutboxRequest(let value):
            mergeRequest(value.request)
            outboxRequestsRev += 1
            // A press on it whose answer was lost hears its end from the push, not only at the next link.
            requestEnded(value.request)
        case .workOutboxResult:
            resultsRev += 1
        case .workRules(let value):
            rulesRev[value.workspaceId, default: 0] += 1
        case .workGuests:
            guestsRev += 1
        case .workDocs(let value):
            docsRev[value.doc, default: 0] += 1
        case .workSheets(let value):
            sheetsRev[value.itemId, default: 0] += 1
        case .workMessages(let value):
            messagesRev[value.workspaceId, default: 0] += 1
        case .workMoney(let value):
            moneyRev[value.workspaceId, default: 0] += 1
        case .workPrep(let value):
            prepRev[value.workspaceId, default: 0] += 1
        case .workClashes:
            clashesRev += 1
        case .workReview:
            reviewRev += 1
        case .workMsforms(let value):
            msformsRev[value.workspaceId, default: 0] += 1
        case .workRoutinesPlays(let value):
            playsRev[value.workspaceId, default: 0] += 1
        case .workWinvm(let value):
            winvm = value.state
        case .workSlidesShow(let value):
            takeShow(showId: value.showId, value.live)
            showPushed = (value.showId, value.live)
            showsRev += 1
        case .away(let value):
            take(AwaySnapshot(state: value.state, decided: value.decided), live: true)
        default:
            break
        }
    }

    /// The host refused this key: everything read of it goes from memory and disk (the Outbox's items and requests,
    /// the Digest's ledger and kept days, Files' listings and kept folders, every kept row under the host), and the
    /// cache fence holds its writes shut, so no writer's queued write or late read puts them back.
    func refused() {
        guard !keyRevoked else { return }
        keyRevoked = true
        keyEpoch &+= 1
        clear()
        files.revoked()
        files.kept?.drop(.capabilityLost(host: environment.id))
        #if canImport(SQLite3)
        // The fence closes and every scope of the host goes in one statement on the shared connection, now.
        WorkCacheStore.purge(.capabilityLost(host: environment.id), close: true)
        #endif
        // The hosts relayed through this one ride its key: they go too (the registry answers which).
        Self.carrierRefused?(environment.id)
    }

    /// The app's answer to a host's LifeOS signing out: its sessions end, and Today forgets what they gave.
    public static var heardLifeosSignOut: (@MainActor (String) -> Void)?

    /// The registry's answer to a carrier refusing the key: each host relayed through it is refused as well.
    public static var carrierRefused: (@MainActor (String) -> Void)?

    /// Work went off on the host: what was read goes, Files' listings and kept folders with it (a folder read still
    /// out lands nowhere), and its kept rows on disk, with any write still queued for it (the fence moves, open:
    /// the key stands).
    private func wentOff() {
        clear()
        files.revoked()
        files.kept?.drop(.workOff(host: environment.id))
        #if canImport(SQLite3)
        WorkCacheStore.purge(.workOff(host: environment.id), close: false)
        #endif
    }

    /// The host's LifeOS signed out: what was kept of its LifeOS session's rows goes from disk (the fence moves).
    private func lifeosSignedOut() {
        // The disk first: its drop refuses every Today write queued before it, so Today's own writes after the hook
        // below pass.
        #if canImport(SQLite3)
        WorkCacheStore.purge(.lifeosSignedOut(host: environment.id), close: false)
        #endif
        // The app ends this host's LifeOS sessions and Today forgets what they gave, whether or not Today shows.
        Self.heardLifeosSignOut?(environment.id)
    }

    /// A link to the host opened: the key stands, and its rows may be read and kept again.
    func opened() {
        // The fence opens for any link that opens: a host removed and paired again in this run writes again.
        WorkCacheFence.open(environment.id)
        keyRevoked = false
    }

    private func clear() {
        cleared &+= 1
        shows = [:]
        items = []
        requests = []
        waiting = 0
        unreviewed = 0
        listed = false
        listError = nil
        lifeos = nil
        digest.clear()
    }

    /// The host's answer for one item: kept while it waits, dropped once decided.
    func merge(_ item: OutboxItem) {
        // An answer that lands after the host refused the key, or with Work off, shows nothing of it.
        guard !keyRevoked, isOn else { return }
        let key = OutboxModel.key(item.ref)
        let index = items.firstIndex { OutboxModel.key($0.ref) == key }
        if OutboxModel.listed(item) {
            if let index { items[index] = item } else { items.insert(item, at: 0) }
        } else if let index {
            items.remove(at: index)
        }
        if listed { Self.itemsChanged?(self) }
    }

    /// Each change to the listed items once the list has answered on this link (its answer, a push, a press's
    /// answer): the Outbox keeps its waiting rows from here (Work/Cache/OutboxRowsCache.swift).
    public static var itemsChanged: (@MainActor (WorkHost) -> Void)?

    /// A request as the host answered or pushed it: kept while open, dropped once answered, declined or void.
    func mergeRequest(_ request: OutboxRequest) {
        guard !keyRevoked, isOn else { return }
        let index = requests.firstIndex { $0.id == request.id }
        if request.state == .open {
            if let index { requests[index] = request } else { requests.append(request); requests.sort { $0.createdAt < $1.createdAt } }
        } else if let index {
            requests.remove(at: index)
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
        guard !AwayKinds.any(state) else { awayEnd = nil; return }
        let at = Int(state.at)
        // The same end heard again (the push after the phone's own press, which may carry the stretch's
        // tally the press's answer did not): the end keeps its span and takes the newer tally.
        if let end = awayEnd, end.until == at {
            if Int(snapshot.decided.since) >= end.since { awayEnd?.decided = snapshot.decided }
            return
        }
        let reviewed = defaults.object(forKey: reviewedKey) as? Int
        let ended = live ? previous.map { AwayKinds.any($0.state) } == true : (reviewed.map { at > $0 } ?? false)
        if reviewed == nil { defaults.set(at, forKey: reviewedKey) }
        guard ended else { return }
        // The stretch began when the first kind went on. A tally from before that stretch (the press's answer can
        // land before the push that resets it) is not this one's: then the span is from the on.
        let onAt = previous.flatMap { AwayKinds.since($0.state) }
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

    /// Both kinds at once (`enabled`), as every host takes it.
    public func setAway(_ enabled: Bool) async throws {
        try await setAway(nil, enabled)
    }

    /// One kind's switch; nil, or a host one release behind that names no kind, sets both (`AwayKinds.params`).
    public func setAway(_ kind: AwayKinds.Kind?, _ on: Bool) async throws {
        let byKind = away.map { AwayKinds.byKind($0.state) } ?? false
        let answer = try await socket.request(Methods.AwaySet.self, AwayKinds.params(kind, on: on, byKind: byKind))
        take(AwaySnapshot(state: answer.state, decided: away?.decided ?? AwayDecided(since: 0, threads: [])), live: true)
    }

    /// The host menu's Away switches, each with its stretch's tally: a decided thread is counted under its
    /// row's kind as the lists hold it.
    public func awaySwitches(scope: (String) -> SessionScope?) -> [AwayKinds.Switch] {
        guard let away else { return [] }
        return AwayKinds.switches(away, scope: scope)
    }

    /// "Open on <computer>": this host's own window goes to a place the key can already read
    /// (`work.reveal`, docs/agents/work.md). His press, in the foreground; the host navigates and
    /// does nothing else, and refuses in words when its screen is locked or no window is open.
    public func reveal(_ target: RevealTarget) async throws {
        _ = try await socket.request(Methods.WorkReveal.self, .init(target: target))
    }

    // MARK: - the presses

    /// The item with its whole payload.
    public func item(_ ref: HeldRef) async throws -> OutboxItem {
        let epoch = keyEpoch
        let item = try await socket.request(Methods.WorkOutboxGet.self, .init(ref: ref))
        // Read under a key the host has refused since (even one opened again meanwhile): nothing of it is shown.
        guard epoch == keyEpoch, !keyRevoked else { throw ActionError.refused(message: Self.refusedLine(environment.name), forbidden: false) }
        merge(item)
        return item
    }

    /// Counts the host's refusals of this key: a read started before one is never shown after it.
    @ObservationIgnored public private(set) var keyEpoch = 0

    /// The line where something of a refused key's would be.
    public nonisolated static func refusedLine(_ hostName: String) -> String { "\(hostName) refused this iPhone’s key." }

    /// Sends exactly what was shown: `rev` is the item's `updatedAt` as the screen read it. `again` comes from
    /// the press site alone (`HeldPress`: his own Send Again on one item that may have gone), never decided here.
    /// Recorded before it leaves (`presses`); with no link it throws at once and nothing is recorded.
    @discardableResult
    public func send(_ item: OutboxItem, again: Bool, key: String? = nil) async throws -> OutboxItem {
        let out = try await pressed(.outboxSend, item, key: key) { [socket] in
            try await socket.request(Methods.WorkOutboxSend.self, .init(ref: item.ref, rev: item.updatedAt, again: again ? true : nil, via: .phone))
        }
        merge(out)
        return out
    }

    /// Discard; `reason` is his line for the thread ("Why, for the thread"), sent only when he wrote one. `rev` is the
    /// item's `updatedAt` as his screen read it: one that moved since is not discarded on this press.
    @discardableResult
    public func discard(_ item: OutboxItem, reason: String? = nil, key: String? = nil) async throws -> OutboxItem {
        let words = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let out = try await pressed(.outboxDiscard, item, key: key) { [socket] in
            try await socket.request(Methods.WorkOutboxDiscard.self, .init(ref: item.ref, reason: words?.isEmpty == false ? String(words!.prefix(500)) : nil, via: .phone, rev: item.updatedAt))
        }
        merge(out)
        return out
    }

    /// Send later: the item goes at `at` (ms), the time he picked in his own zone, bound to what he saw.
    @discardableResult
    public func later(_ item: OutboxItem, at: Int, zone: String = TimeZone.current.identifier, key: String? = nil) async throws -> OutboxItem {
        // Through the record: a lost answer is Checking and is read back by the item (scheduled is done).
        // The item's own result is judged inside the press, so an answer that comes after the fifteen seconds says the
        // host's refusal in its words too, not "done".
        return try await presses.run(.outboxLater, host: environment.id, hostName: environment.name, ref: OutboxModel.key(item.ref), rev: String(item.updatedAt), linked: linked, key: key) { [socket, weak self] in
            let answer = try await socket.request(Methods.WorkOutboxDecide.self, .init(items: [.init(ref: item.ref, do: .later, rev: item.updatedAt, at: at, zone: zone)], via: .phone))
            guard let result = answer.results?.first else { throw ActionError.refused(message: "The host did not answer for it", forbidden: false) }
            if let after = result.item { self?.merge(after) }
            guard result.ok, let after = result.item else { throw ActionError.refused(message: result.error ?? "Not scheduled", forbidden: false) }
            return after
        }
    }

    /// Cancel send on a send he timed: back to held. `rev` binds it to the item as his screen read it.
    @discardableResult
    public func cancelSend(_ item: OutboxItem) async throws -> OutboxItem {
        let out = try await socket.request(Methods.WorkOutboxCancelSend.self, .init(ref: item.ref, rev: item.updatedAt))
        merge(out)
        return out
    }

    /// Send now on a send he timed, on its own claim, bound to the item as his screen read it.
    @discardableResult
    public func sendNow(_ item: OutboxItem, key: String? = nil) async throws -> OutboxItem {
        // Read back by the item's time: still timed for the time he saw is the host never got it.
        let out = try await presses.run(.outboxSendNow, host: environment.id, hostName: environment.name, ref: OutboxModel.key(item.ref), rev: item.scheduledFor.map(String.init), linked: linked, key: key) { [socket] in
            try await socket.request(Methods.WorkOutboxSendNow.self, .init(ref: item.ref, rev: item.updatedAt))
        }
        merge(out)
        return out
    }

    /// Takes a LifeOS mail back while LifeOS still holds it in its undo time: true when it is back as held.
    public func undoSend(_ item: OutboxItem) async throws -> Bool {
        let out = try await socket.request(Methods.WorkOutboxUndoSend.self, .init(ref: item.ref))
        if let after = out.item { merge(after) }
        return out.back
    }

    /// An out-of-date item put away, and its thread asked to draft it again from what is true now.
    @discardableResult
    public func askAgain(_ item: OutboxItem) async throws -> OutboxItem {
        let out = try await socket.request(Methods.WorkOutboxAskAgain.self, .init(ref: item.ref))
        merge(out)
        return out
    }

    // MARK: - a thread's request

    /// One request as its sheet draws it, with a receipt for each row he may press as drawn. Read under a key the host
    /// has refused since, nothing of it is shown.
    public func request(_ id: String) async throws -> OutboxRequest {
        let epoch = keyEpoch
        let out = try await socket.request(Methods.WorkOutboxRequestGet.self, .init(id: id))
        guard epoch == keyEpoch, !keyRevoked else { throw ActionError.refused(message: Self.refusedLine(environment.name), forbidden: false) }
        mergeRequest(out)
        requestEnded(out)
        return out
    }

    /// A request as a push or a fresh read says it: a press of his on it whose end this is (answered and no longer
    /// running, declined, void) is settled now, even while his own request still waits on its socket, and the sheet's
    /// wait hears it. An end is final: a running answer that comes after it changes nothing.
    func requestEnded(_ request: OutboxRequest) {
        let ref = PendingPress.requestRef(request.id)
        guard let press = presses.pending.presses.first(where: { $0.host == environment.id && $0.ref == ref }),
              let truth = PressTruth.request(request, rev: press.rev) else { return }
        Self.requestHeard?(environment.id, request.id, PressState.request(request.state), request)
        presses.settle(host: environment.id, ref: ref, truth: truth, final: truth != .waiting(rev: press.rev))
    }

    /// He opened a row that changed since the ask: a fresh receipt at what he sees now.
    public func viewRow(_ request: String, ref: HeldRef) async throws -> OutboxRequestRow {
        let epoch = keyEpoch
        let row = try await socket.request(Methods.WorkOutboxRequestView.self, .init(id: request, ref: ref))
        // A receipt read under a key refused since is shown to no one.
        guard epoch == keyEpoch, !keyRevoked else { throw ActionError.refused(message: Self.refusedLine(environment.name), forbidden: false) }
        return row
    }

    /// His Send on the sheet: exactly the ticked rows' receipts, through the record (`PressLedger.run`, the request's
    /// ref): a lost answer throws `PressLedger.Unknown` and the request is read back on the next link. Answers the
    /// request as it stands after; one that comes late reaches the sheet's wait too (`requestHeard`).
    public func answer(_ request: String, receipts: [String], key: String? = nil) async throws -> OutboxRequest {
        let host = environment.id
        let rev = receipts.sorted().joined(separator: ",")
        return try await presses.run(.outboxDecide, host: host, hostName: environment.name, ref: PendingPress.requestRef(request), rev: rev, linked: linked, key: key) { [socket, weak self] in
            let out = try await socket.request(Methods.WorkOutboxDecide.self, .init(request: request, receipts: receipts))
            guard let after = out.request else { throw ActionError.refused(message: "The host did not answer for the request", forbidden: false) }
            self?.mergeRequest(after)
            // Claimed and still going (another device's press, or ours on a slow item): not the end. The record stays
            // Checking and the end comes by the request's push or the next read.
            if after.running == true { throw PressLedger.NotYetKnown() }
            Self.requestHeard?(host, request, .done, after)
            return after
        }
    }

    /// Not now: the items still wait in his Outbox.
    public func decline(_ request: String) async throws -> OutboxRequest {
        let out = try await socket.request(Methods.WorkOutboxDecline.self, .init(request: request))
        mergeRequest(out)
        return out
    }

    /// Edit binds to the item as his screen read it: `rev` is its `updatedAt`, and the host refuses an edit over a
    /// newer one (another device's) rather than overwrite it.
    @discardableResult
    public func edit(_ item: OutboxItem, payload: JSONValue?, key: String? = nil) async throws -> OutboxItem {
        let out = try await pressed(.outboxEdit, item, key: key) { [socket] in
            try await socket.request(Methods.WorkOutboxEdit.self, .init(ref: item.ref, payload: payload, rev: item.updatedAt))
        }
        merge(out)
        return out
    }

    /// One press on a held item through the phone's record of presses (PressLedger.swift).
    private func pressed(_ kind: PendingPress.Kind, _ item: OutboxItem, key: String? = nil, request: @escaping @Sendable @MainActor () async throws -> OutboxItem) async throws -> OutboxItem {
        try await presses.run(kind, host: environment.id, hostName: environment.name, ref: OutboxModel.key(item.ref), rev: String(item.updatedAt), linked: linked, key: key, request: request)
    }

    /// Every Result since a time, newest first (the return from Away).
    public func results(since: Int) async throws -> [WorkResult] {
        try await socket.request(Methods.WorkOutboxResults.self, .init(since: since)).results
    }

    /// Undo of a Result acts outward again: asked under the key the owner's check passed before the request starts and
    /// again where the socket releases its frame (`PressLedger.guarded`).
    public func undo(_ result: WorkResult, key: String? = nil) async throws -> WorkResult {
        try await presses.guarded(host: environment.id, key: key, method: .outboxUndo) { [socket] in
            try await socket.request(Methods.WorkOutboxUndo.self, .init(id: result.id))
        }
    }

    /// "Send and stop holding": a standing grant made from this held item (admin), asked when the Send's
    /// five seconds end and just before it (`HeldPress.dispatch`).
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

    // MARK: - capture (docs/agents/work-capture.md "The phone")

    public var hostId: String { environment.id }

    /// Where his last capture on this host went and whether its LifeOS answers.
    public func captureState() async throws -> CaptureState {
        try await socket.request(Methods.WorkCaptureState.self, .init())
    }

    /// His own quick add in LifeOS: `sector` nil is Unsorted. `key` names this
    /// capture, so a retry with the same one files nothing twice.
    public func capture(text: String, sector: String?, start: Bool = false, key: String = UUID().uuidString) async throws -> CaptureFiled {
        try await socket.request(Methods.WorkCaptureFile.self, .init(key: key, text: text, sector: sector, start: start ? true : nil))
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
    /// Replace Address, his press: written to the ledger under `attempt` before it leaves, as Create is. Answers the new
    /// address, or nil when the host had already replaced it under this key (a repeat after a lost answer: the address
    /// showed nowhere, and nothing is replaced again). A lost answer throws `PressLedger.Unknown`, read back by the key.
    public func rekey(_ link: GuestLinkRow, attempt: String, key: String? = nil) async throws -> String? {
        let host = environment.id
        let answer = try await presses.run(.guestRekey, host: host, hostName: environment.name, ref: ShareRules.rekeyRef(link.id), rev: nil, attempt: attempt, linked: linked, key: key) { [socket] in
            let out = try await socket.request(Methods.WorkGuestsRekey.self, .init(linkId: link.id, attempt: attempt))
            // Kept as it lands, whoever still waits for it (`GuestAttempts.unseen`): the host sends it once.
            if out.again != true, let url = out.url { GuestAttempts.shared.delivered(host: host, ref: ShareRules.rekeyRef(link.id), attempt: attempt, address: url) }
            return out
        }
        return answer.again == true ? nil : answer.url
    }

    public func revoke(_ link: GuestLinkRow) async throws {
        _ = try await socket.request(Methods.WorkGuestsRevoke.self, .init(linkId: link.id))
    }

    // MARK: - Settings → Work

    public func setWork(_ enabled: Bool) async throws {
        settings = try await socket.request(Methods.WorkSet.self, .init(enabled: enabled))
        if isOn { await refreshOutbox(); await refreshLifeos(); await digest.reconnected() } else { wentOff() }
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

// MARK: - Today

extension WorkHost {
    /// The host checks approve and matches the task to the workspace's linked LifeOS sector.
    public func completeTask(_ taskId: String, workspaceId: String) async throws -> TasksDone {
        try await socket.request(Methods.WorkTasksDone.self, .init(workspaceId: workspaceId, taskId: taskId))
    }

    /// The host checks operate on the caller's own key and reads the mail in this job's sector.
    /// It starts a Work thread that can draft a nudge for the Outbox.
    public func nudge(_ threadId: String, workspaceId: String) async throws -> String {
        try await socket.request(Methods.WorkMailNudge.self, .init(workspaceId: workspaceId, threadId: threadId)).sessionId
    }

    public func unansweredMessages(_ workspaceId: String) async throws -> [ChatWaiting] {
        try await socket.request(Methods.WorkMessagesUnanswered.self, .init(workspaceId: workspaceId)).rows
    }

    public func moneyOwed(workspaceId: String? = nil) async throws -> MoneyOwed {
        try await socket.request(Methods.WorkMoneyOwed.self, .init(workspaceId: workspaceId))
    }

    public func upcomingPrep(from: Double, to: Double) async throws -> [PrepUpcoming] {
        try await socket.request(Methods.WorkPrepUpcoming.self, .init(from: from, to: to)).meetings
    }

    public func reviewReady() async throws -> Methods.WorkReviewReady.Output {
        try await socket.request(Methods.WorkReviewReady.self, .init())
    }

    public func clashes(from: Int, to: Int) async throws -> Methods.WorkClashesList.Output {
        try await socket.request(Methods.WorkClashesList.self, .init(from: from, to: to))
    }

    public func leave(_ eventId: String) async throws -> ClashLeave? {
        try await socket.request(Methods.WorkClashesLeave.self, .init(eventId: eventId))
    }
}

// MARK: - Money (docs/agents/work-money.md; the phone's receipt, Work/Money/Receipt.swift)

extension WorkHost: MoneyHost {
    /// The jobs this host keeps, with their sectors and starting categories.
    public func moneyState() async throws -> MoneyState {
        try await socket.request(Methods.WorkMoneyState.self, .init())
    }

    /// The host's one parser on the phone's own lines.
    public func parse(lines: [ReceiptTextLine], sector: String?, workspaceId: String?) async throws -> MoneyReceiptFields {
        try await socket.request(Methods.WorkMoneyParse.self, .init(lines: ReceiptPart.parseLines(lines), workspaceId: workspaceId, sector: sector.map { .set($0) }))
    }

    /// One part of a receipt, under its one key.
    public func receive(_ part: ReceiptPart) async throws -> MoneyReceived {
        try await socket.request(Methods.WorkMoneyReceive.self, part.params)
    }
}
