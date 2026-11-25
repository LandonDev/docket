import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// LifeOS's Mail, Tasks and Agenda, for one Work workspace (milestone 47) or
/// for every job at once (a place of the Work tab, M1c): one `LifeClient`
/// signed in with the JWT the host signs (`work.lifeos.jwt`), so there is no
/// second sign-in, and a `LifeStore` for the sectors on screen. A job's is
/// narrowed to its own sector on its own token (`LifeReach.sectors(ofJob:)`);
/// the every-job host reads the whole session and keeps a store for each
/// pick of the job filter, all on the one client (`narrow(to:)`). It is the
/// screens' `LifeActions`: a pressed Send goes to the host, and Start Thread
/// opens a new thread with the item as its chip, in the item's job. One per
/// workspace, and one every-job host per signing host, kept while the app runs.
@MainActor @Observable
final class WorkLifeHost: LifeActions {
    enum Phase: Equatable {
        case loading
        case ready
        /// The host's LifeOS state, in words for a status row.
        case unavailable(String)
    }

    struct Presented: Identifiable {
        let sheet: LifeSheet
        let side: Side
        let id = UUID()
    }

    let client: EnvironmentClient
    /// The job's workspace; nil on the every-job host.
    let workspaceId: String?
    /// The job's sector; nil on the every-job host, and for a workspace with none.
    let sector: Sector?
    /// The sectors on screen: the job's own, or the filter's pick (`LifeReach`).
    private(set) var sectors: [Sector]
    /// On the every-job host: each sector's job on this host, where Start Thread starts.
    var jobs: [String: String] = [:]
    /// On the every-job host: the host would not sign the whole session (an older host, a refusal of the
    /// call itself), so the places go per job (`LifeReach.reach`'s `refused`).
    private(set) var refusedWhole = false
    private(set) var phase: Phase = .loading
    /// While `unavailable`: the host's LifeOS state as it refused the token ("signed-out", "connecting", "pairing",
    /// "refused", "off", "unreachable"), or nil where the host itself did not answer. Today maps it as the desktop's
    /// `downOf` does.
    private(set) var refusedState: String?
    private(set) var store: LifeStore?
    private(set) var scene: LifeScene?
    var sheet: Presented? {
        didSet { scene?.sheetSide = sheet?.side }
    }
    /// Start Thread pressed on an item: the sheet with its chip.
    var starting: ContextChip?
    /// The job the sheet's thread starts in.
    private(set) var startIn: String?
    /// The thread Start made, for the screen to open.
    var started: SessionMeta?
    /// Mail shows Waiting on in its place (the bar's hourglass), kept here so a fold keeps it.
    var waitingOn = false
    /// A thread a Nudge started or Ask found, for the screen to open.
    var opening: String?
    /// A project's LifeOS document or sheet he tapped, for the screen to open in the hosted editor (M5b).
    var openingDocument: CanvasItem?
    /// Ask on a mail with no chat about it yet: the sheet whose first send makes the chat beside it.
    var asking: AskDraft?
    /// The host's marks on Agenda's events (clash lines, when to leave), by event id (`MailRules.marks`).
    private(set) var marks: [String: LifeEventMark] = [:]

    @ObservationIgnored private let tokens: LifeTokenSource
    @ObservationIgnored private var preparing = false
    @ObservationIgnored private var signIn: Task<Void, Never>?
    /// Makes the store for a set of sectors once the client is signed in (or the fixtures are up).
    @ObservationIgnored private var makeStore: (([Sector]) -> LifeStore)?
    /// The every-job host's stores and scenes by pick, so a filter flip back is instant and keeps its place.
    @ObservationIgnored private var kept: [String: (store: LifeStore, scene: LifeScene)] = [:]
    @ObservationIgnored private var authenticated = false
    /// Moves when the host says its LifeOS signed out: a session made before it, or a sign-in still out, is done.
    @ObservationIgnored private var session = 0

    /// The host said its LifeOS signed out (`WorkHost.heardLifeosSignOut`): this session ends now, whether or not a
    /// screen shows it. Its stores stop and forget every query and value (a late answer has nowhere to land), the
    /// token goes, and it reads as signed out until a fresh session is made (the host saying LifeOS connected again).
    func signedOut() {
        session &+= 1
        signIn?.cancel()
        signIn = nil
        for held in kept.values where !held.store.isFixture {
            held.store.setAuthenticated(false)
            held.store.live.reset()
        }
        kept = [:]
        makeStore = nil
        store = nil
        scene = nil
        sheet = nil
        authenticated = false
        tokens.forget()
        refusedState = "signed-out"
        phase = .unavailable(Self.words(.host("signed-out")))
    }

    /// Every session made of one host: the every-job one and each job's.
    static func signedOut(host: String) {
        for life in hosts.values where life.client.environment.id == host { life.signedOut() }
    }

    private static var hosts: [String: WorkLifeHost] = [:]

    /// His own draft read back on the first session this run made for its host (`WorkHost.mailDraftTruth`): any job's
    /// LifeOS session reads its compose rows. With none made yet it throws, and the press stays Checking until one is.
    static func draftTruth(host: String, draftId: String) async throws -> PressTruth {
        guard let life = hosts.first(where: { $0.value.client.environment.id == host })?.value else { throw HeldSendRefusal.checking }
        return PressTruth.mail(status: try await life.draft(draftId).row.status.rawValue)
    }

    /// The workspace's host, made on first use.
    static func of(_ client: EnvironmentClient, workspace: WorkspaceMeta) -> WorkLifeHost {
        let key = "\(client.environment.id):\(workspace.id)"
        if let host = hosts[key] { return host }
        let host = WorkLifeHost(client: client, workspace: workspace)
        hosts[key] = host
        return host
    }

    /// The every-job host on the host that signs the whole session, made on first use.
    static func every(_ client: EnvironmentClient) -> WorkLifeHost {
        let key = "every:\(client.environment.id)"
        if let host = hosts[key] { return host }
        let host = WorkLifeHost(every: client)
        hosts[key] = host
        return host
    }

    private init(client: EnvironmentClient, workspace: WorkspaceMeta) {
        self.client = client
        workspaceId = workspace.id
        sector = workspace.sector.flatMap(Sector.init(rawValue:))
        // The job's own sector alone: never every sector for a workspace whose sector is missing or unknown.
        sectors = LifeReach.sectors(ofJob: workspace.sector).compactMap(Sector.init(rawValue:))
        tokens = LifeTokenSource(client: client, sector: workspace.sector)
    }

    private init(every client: EnvironmentClient) {
        self.client = client
        workspaceId = nil
        sector = nil
        sectors = []
        tokens = LifeTokenSource(client: client, sector: nil)
    }

    /// The every-job host's filter moved: the store for those sectors, on the same signed-in client.
    func narrow(to sectors: [Sector]) {
        guard workspaceId == nil, sectors != self.sectors else { return }
        self.sectors = sectors
        if makeStore != nil { install() }
    }

    /// Builds the store once the host has signed a token; again after a refusal (Retry).
    func prepare() async {
        // One at a time: the screen's task and Try Again may both ask.
        guard store == nil, !preparing else { return }
        preparing = true
        defer { preparing = false }
        phase = .loading
        refusedState = nil
        #if DEBUG
        if TestHooks.lifeFixtures {
            let book = Self.fixtureBook()
            makeStore = { LifeStore(fixtures: book, sectors: $0) }
            install()
            fixtureHooks()
            return
        }
        #endif
        let asked = session
        do {
            let token = try await tokens.token(force: false)
            // The host signed LifeOS out while the token was out: that session never opens.
            guard asked == session else { return }
            let life = LifeClient(session: WorkLifeSession(deployment: token.deployment, tokens: tokens))
            makeStore = { [weak self] sectors in
                let store = LifeStore(client: life, sectors: sectors)
                // A query LifeOS refused: the token is spent or revoked, so ask the host again, at most twice a minute.
                store.live.onUnauthenticated = { [weak self] in self?.recheck(life) }
                return store
            }
            install()
            signIn = Task { [weak self] in
                try? await life.signIn()
                for await on in life.authenticated.values {
                    // A session that ended (the host's sign-out) hears nothing more.
                    guard let self, self.session == asked else { return }
                    self.authenticated = on
                    self.store?.setAuthenticated(on)
                }
            }
        } catch let refusal as LifeToken.Refusal {
            if case .host(let state) = refusal { refusedState = state }
            phase = .unavailable(Self.words(refusal))
        } catch {
            // The every-job host's call itself refused (an older host, a key the host turns away): the places go per job.
            if workspaceId == nil { refusedWhole = true }
            phase = .unavailable("LifeOS did not answer.")
        }
    }

    #if DEBUG
    /// LifeKit's fixture day. Its mail list ignores the cursor and says more is coming while it holds more
    /// threads than a page, so with one sector on screen Mail's fill asked for pages forever: here the list
    /// answers its first page as the last, and the store shows only the sectors on screen.
    private static func fixtureBook() -> FixtureBook {
        var book = FixtureBook(now: Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: Date()) ?? Date())
        book.addLifeKitFixtures()
        let lifeKit = book
        book.on("mail:list") { args in
            lifeKit.answer("mail:list", args, as: Page<MailThread>.self).map { Page(page: $0.page, isDone: true, continueCursor: "") }
        }
        return book
    }
    #endif

    #if DEBUG
    /// The work set on LifeKit's fixture day: `TC_TEST_OPEN=mail-waiting` shows Waiting on, `mail-thread` opens the Purdue thread
    /// (th3) once the list is up, `TC_TEST_SHEET=start-thread-mail|start-thread-task` raises Start Thread on that thread
    /// or the Purdue task t6, as the screens' own Start Thread does.
    private func fixtureHooks() {
        // `TC_TEST_OPEN=mail-waiting` shows Mail's Waiting on, as the bar's hourglass does.
        if TestHooks.open == "mail-waiting" { waitingOn = true }
        // Three seconds after the list is up, as a tap on the row would open it.
        if TestHooks.open == "mail-thread" {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                self?.scene?.mail = .init(thread: "th3")
            }
        }
        switch TestHooks.sheet {
        case "start-thread-mail": startThread(about: LifeItem(kind: .thread, id: "th3", title: "Spring LAN arena hold", sector: .purdue))
        case "start-thread-task": startThread(about: LifeItem(kind: .task, id: "t6", title: "Book the arena for the spring LAN", sector: .purdue))
        default: break
        }
    }
    #endif

    @ObservationIgnored private var lastRecheck = Date.distantPast

    private func recheck(_ life: LifeClient) {
        guard Date().timeIntervalSince(lastRecheck) > 30 else { return }
        lastRecheck = Date()
        tokens.forget()
        Task { try? await life.signIn() }
    }

    /// The store and scene for the sectors on screen: kept from an earlier pick, or made now.
    private func install() {
        guard let makeStore else { return }
        let key = sectors.map(\.rawValue).joined(separator: ",")
        let shown: (store: LifeStore, scene: LifeScene)
        if let held = kept[key] {
            shown = held
        } else {
            let store = makeStore(sectors)
            shown = (store, LifeScene(writes: Self.fencedWrites(store), actions: self))
            kept[key] = shown
        }
        // The pick it leaves stops its live queries until it is shown again.
        if let left = store, left !== shown.store, !left.isFixture { left.setAuthenticated(false) }
        sheet = nil
        store = shown.store
        scene = shown.scene
        shown.store.start()
        if !shown.store.isFixture { shown.store.setAuthenticated(authenticated) }
        phase = .ready
        // A composer Send of this host whose answer was lost is read back now that a LifeOS session can read drafts.
        Task { [weak self] in
            guard let self else { return }
            await self.client.work.checkMailPresses { id in try await self.draft(id).row.status.rawValue }
        }
    }

    /// LifeOS's writes, as `makeWrites` makes them, less the ones that send as him (`LifeWriteFence`):
    /// a reply to a task's source goes straight to LifeOS, past the hold, so it never leaves the phone.
    private static func fencedWrites(_ store: LifeStore) -> Writes {
        Writes(run: { path, args in
            try LifeWriteFence.check(path)
            return try await store.mutate(path, args)
        })
    }

    private static func words(_ refusal: LifeToken.Refusal) -> String {
        switch refusal {
        case .host("unreachable"): "LifeOS did not answer."
        case .host("connecting"): "LifeOS is still connecting."
        case .host("pairing"): "The LifeOS sign-in waits for your approval."
        case .host("refused"): "LifeOS refused the sign-in."
        case .host("off"): "LifeOS is off on this computer."
        case .host: "Signed out of LifeOS"
        case .malformed: "LifeOS did not answer."
        }
    }

    // MARK: - LifeActions

    func present(_ sheet: LifeSheet, facing side: Side) {
        self.sheet = Presented(sheet: sheet, side: side)
    }

    func dismissSheet() {
        sheet = nil
    }

    func open(_ link: LifeLink) {
        if case .thread(let id) = link { scene?.mail = .init(thread: id) }
    }

    /// A project's LifeOS document or sheet opens in the hosted editor, as a thread's item does (`work.guests.ticket`),
    /// for a key that may ask its ticket and a workspace to open it in; a note stays a plain row.
    func offers(document: LifeDocument) -> Bool {
        document.kind != .note && workspaceId != nil && client.work.may(.guestsTicket)
    }

    func open(document: LifeDocument) {
        guard offers(document: document), let workspaceId else { return }
        let item = LifeDocItem.item(document.kind == .sheet ? .sheet : .document, id: document.id, title: document.title, workspaceId: workspaceId)
        client.work.canvas.warmTicket(item)
        openingDocument = item
    }

    /// A mail thread opens in Mail; quick add, Activity and LifeOS's settings are LifeOS's own app's.
    func offers(_ link: LifeLink) -> Bool {
        if case .thread = link { return true }
        return false
    }

    var holdsSends: Bool { true }

    /// A draft as LifeOS holds it now (`compose:get`), read with the workspace's token.
    func draft(_ id: String) async throws -> ComposeDoc {
        let token = try await tokens.token(force: false)
        let args = try JSONSerialization.data(withJSONObject: ["id": id])
        return try await QueryHTTP.fetch("compose:get", argsJSON: args, as: ComposeDoc.self, deploymentURL: token.deployment, jwt: token.jwt)
    }

    /// The mail the composer showed goes to the host as `seen`, and the host sends the saved draft only
    /// if it still says exactly that: a change after the save (another client, a late write) is refused,
    /// never sent unseen. A composer from before the snapshot hands none: the draft is read and its
    /// subject and recipients checked against the press, as before.
    func hold(_ send: LifeHeldSend) async throws -> String {
        let message: Draft.Message
        if let shown = send.message {
            message = shown
        } else {
            message = try await draft(send.draftId).row.message
            let to = (message.to ?? []).map(\.address), cc = (message.cc ?? []).map(\.address), bcc = (message.bcc ?? []).map(\.address)
            guard HeldSendCheck.matches(pressedSubject: send.subject, pressedTo: send.to, subject: message.subject, to: to, cc: cc, bcc: bcc) else {
                throw HeldSendRefusal.changed
            }
        }
        let to = (message.to ?? []).map(\.address), cc = (message.cc ?? []).map(\.address), bcc = (message.bcc ?? []).map(\.address)
        // The HTML, the files and the sender too: the host refuses a draft whose HTML, files, account or From are not the ones named here.
        let files = (message.attachments ?? []).map { Methods.WorkMailSend.Params.Seen.Attachment(id: $0.storageId, name: $0.name) }
            + (message.forwardParts ?? []).map { Methods.WorkMailSend.Params.Seen.Attachment(id: "part:\($0.partId)", name: $0.name) }
        let seen = Methods.WorkMailSend.Params.Seen(
            to: to,
            cc: cc,
            bcc: bcc,
            subject: message.subject ?? "",
            text: message.text ?? "",
            html: message.html ?? "",
            attachments: files,
            accountId: message.accountId,
            from: message.from.map { Methods.WorkMailSend.Params.Seen.From(name: $0.name, address: $0.address) }
        )
        // His Send in LifeKitUI's composer is an outward press: the link and the owner's check first, bound to the
        // draft and what it says. A no is the composer's own error line; nothing went.
        // A Send of this draft whose answer was lost is read back first, by its status in LifeOS, before the owner's
        // check: one that went is said, never sent again; one LifeOS never had leaves this press free to go. Nothing
        // is awaited between the check's pass (bound to this host and key) and the five seconds' start.
        let before = await client.work.checkMailPresses { [weak self] id in
            guard let self else { return nil }
            return try await self.draft(id).row.status.rawValue
        }
        // LifeKit's composer says "Not sent" for anything `hold` throws: what is not a refusal is answered in words,
        // and the composer closes on them (the draft stays as LifeOS holds it).
        if before[send.draftId] == .done { return HeldSendRefusal.went.errorDescription ?? "" }
        // One still out on this draft (its read could not run yet): no owner's check for a press that cannot go.
        if client.work.presses.busy(host: client.environment.id, ref: PendingPress.mailRef(send.draftId)) {
            return HeldSendRefusal.checking.errorDescription ?? ""
        }
        // His earlier Send of it still counts its five seconds, or is on its way: this one adds nothing.
        if MailPresses.shared.holds(host: client.environment.id, draftId: send.draftId) { return "Already sending" }
        // A key that cannot send mail is told so before any owner's check: a pass could not help.
        guard client.work.may(.mailSend) else { throw HeldSendRefusal.gate("This iPhone’s key can’t send mail.") }
        let words = "\(seen.subject)|\(seen.to.joined(separator: ","))"
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .mailSend, ref: send.draftId, rev: words, reason: seen.to.isEmpty ? "Send this mail" : "Send to \(seen.to.joined(separator: ", "))") {
            throw HeldSendRefusal.gate(line)
        }
        // Five seconds with Undo in Mail's capsule before the host hears of it (`MailPresses`); the frozen key and the
        // draft as he saw it go with it, and the socket asks the press again where it releases the frame.
        let mail = MailPresses.Mail(draftId: send.draftId, sendAt: send.sendAt, sendZone: send.sendZone)
        return MailPresses.shared.press(client: client, scene: scene, mail: mail, seen: seen, key: key)
    }

    /// Start Thread makes a Work thread (`session.create`, operate), in a job this host holds.
    var startsThreads: Bool { client.work.may(.sessionCreate) && (workspaceId != nil || !jobs.isEmpty) }

    /// The job a thread about an item of `sector` starts in: the job's own, or on the every-job host the
    /// item's sector's job on this host.
    private func workspace(for sector: Sector?) -> String? {
        if let workspaceId { return workspaceId }
        return sector.flatMap { jobs[$0.rawValue] }
    }

    func startThread(about item: LifeItem) {
        let kind: ContextChip.Kind
        let table: ContextChip.RefCase0.Table
        switch item.kind {
        case .task: (kind, table) = (.task, .tasks)
        case .event: (kind, table) = (.event, .events)
        case .thread: (kind, table) = (.mail, .mailThreads)
        }
        guard let job = workspace(for: item.sector) else { return }
        sheet = nil
        startIn = job
        starting = ChipWords.lifeos(kind, table: table, id: item.id, label: item.title)
    }

    /// New Thread about something the item kinds above do not name (a person's chip, People's page): the same sheet,
    /// in the job given.
    func startThread(about chip: ContextChip, in job: String) {
        sheet = nil
        startIn = job
        starting = chip
    }

    func handoff(of item: LifeItem) -> LifeHandoff? { nil }

    // MARK: - Mail as a place (M2a)

    /// Agenda's marks, from this host's clashes over the next fortnight (`work.clashes.list`, read): each clash in
    /// the desktop's words from the event's side, and the host's leave time. Read again on the `work.clashes` push.
    func loadMarks() async {
        guard client.work.may(.clashesList) else { return marks = [:] }
        let span = ClashRules.window(around: nil, now: Date().timeIntervalSince1970 * 1000, calendar: .current)
        guard let list = try? await client.work.clashes(from: span.from, to: span.to) else { return }
        let names = Dictionary(client.workspaces.compactMap { w in w.sector.map { ($0, w.name) } }, uniquingKeysWith: { first, _ in first })
        marks = MailRules.marks(clashes: list.clashes, leaves: list.leaves, jobName: { names[$0] ?? $0.capitalized })
            .mapValues { LifeEventMark(leave: $0.leave, lines: $0.lines) }
    }

    func mark(of event: EventItem) -> LifeEventMark? { marks[event.id] }

    /// Nudge on Waiting on: a key that may start the nudge thread (`work.mail.nudge`, operate), in a job this host holds.
    var nudgesWaits: Bool { client.work.may(.mailNudge) && (workspaceId != nil || !jobs.isEmpty) }

    /// Starts the thread that drafts the nudge, and opens it; nothing goes until he sends the draft.
    func nudge(_ thread: MailThread) {
        guard let job = workspace(for: thread.sector) else { return }
        Task {
            do {
                opening = try await client.work.nudge(thread.id, workspaceId: job)
            } catch {
                scene?.writes.fail("Couldn’t start the nudge: \(ActionError.wrap(error).message)")
            }
        }
    }

    /// Ask on an open mail: a key that may adopt a chat, the sector not withheld, a job of it on this host.
    func asks(about item: LifeItem) -> Bool {
        item.kind == .thread && askJob(item) != nil
    }

    private func askJob(_ item: LifeItem) -> String? {
        MailRules.askIn(sector: item.sector?.rawValue, mayAdopt: client.work.may(.mailChatAdopt), workspaceId: workspaceId, jobs: jobs)
    }

    /// The chat beside the mail: the one there is (`work.mail.chat.find`), else the sheet whose first send makes it.
    func ask(about item: LifeItem) {
        guard item.kind == .thread, let job = askJob(item) else { return }
        let draft = AskDraft(chip: ChipWords.lifeos(.mail, table: .mailThreads, id: item.id, label: item.title), workspaceId: job, mailThreadId: item.id)
        Task {
            let found = client.work.may(.mailChatFind) ? (try? await client.work.mailChats(workspaceId: job, mailThreadId: item.id)) ?? [] : []
            if let id = MailRules.chatToOpen(found: found, known: Set(found.filter { client.session($0) != nil })) {
                opening = id
            } else {
                sheet = nil
                asking = draft
            }
        }
    }
}

/// Ask on a mail with no chat yet: the mail as the chip, the job, and the mail thread the chat is adopted for.
struct AskDraft: Identifiable {
    let chip: ContextChip
    let workspaceId: String
    let mailThreadId: String
    var id: String { mailThreadId }
}

/// The JWT for LifeOS's screens, from the workspace's host. `deployment` is the address the host's
/// first answer named; a refusal (`force`) asks the host again.
nonisolated struct WorkLifeSession: LifeSession {
    let deployment: URL
    let tokens: LifeTokenSource

    func jwt(force: Bool) async throws -> String {
        do {
            return try await tokens.token(force: force).jwt
        } catch LifeToken.Refusal.host {
            throw LifeAuthError.refused
        }
    }
}

/// The LifeOS screen on show, for the shell's split (`lifeHostEnvironment`). On the phone
/// LifeKitUI's `SplitScreen` opens a mail thread through a `NavigationStack` of its own inside
/// the shell's, and SwiftUI hoists that destination to the shell's stack, outside `lifeChrome`:
/// without these objects there, opening a thread traps (no `LifeScene` in the environment).
@MainActor @Observable
final class ShownLifeHost {
    static let shared = ShownLifeHost()
    var host: WorkLifeHost?
}

extension View {
    /// The shown LifeOS screen's store, scene, writes, clock and connection, optional so the tree never changes shape.
    func lifeHostEnvironment() -> some View {
        modifier(LifeHostEnvironment())
    }
}

private struct LifeHostEnvironment: ViewModifier {
    @State private var shown = ShownLifeHost.shared

    func body(content: Content) -> some View {
        let store = shown.host?.store
        let scene = shown.host?.scene
        content
            .environment(store)
            .environment(scene)
            .environment(scene?.writes)
            .environment(store?.clock)
            .environment(store?.connection)
    }
}

/// Why a held Send did not go.
enum HeldSendRefusal: LocalizedError {
    case changed
    /// No link, or the owner's check said no (`PressGates`): its line.
    case gate(String)
    /// The answer was lost: it may have gone, and is read back before any second Send.
    case checking
    /// A lost Send read back as gone: LifeOS has it on its way.
    case went
    var errorDescription: String? {
        switch self {
        case .changed: "This draft changed. Look it over again."
        case .gate(let line): line
        case .checking: "Checking whether it went. Look in Sent before you send it again."
        case .went: "This mail already went."
        }
    }
}
