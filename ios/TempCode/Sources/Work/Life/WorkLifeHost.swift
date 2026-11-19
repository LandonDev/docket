import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// LifeOS's Mail, Tasks and Agenda inside one Work workspace (milestone 47):
/// one `LifeClient` and one `LifeStore` narrowed to the workspace's sector,
/// signed in with the JWT the workspace's host signs (`work.lifeos.jwt`), so
/// there is no second sign-in. It is the screens' `LifeActions`: a pressed
/// Send goes to the host, and Start Thread opens a new thread with the item
/// as its chip. One per workspace, kept while the app runs.
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
    let workspaceId: String
    let sector: Sector?
    private(set) var phase: Phase = .loading
    private(set) var store: LifeStore?
    private(set) var scene: LifeScene?
    var sheet: Presented? {
        didSet { scene?.sheetSide = sheet?.side }
    }
    /// Start Thread pressed on an item: the sheet with its chip.
    var starting: ContextChip?
    /// The thread Start made, for the screen to open.
    var started: SessionMeta?

    @ObservationIgnored private let tokens: LifeTokenSource
    @ObservationIgnored private var signIn: Task<Void, Never>?

    private static var hosts: [String: WorkLifeHost] = [:]

    /// The workspace's host, made on first use.
    static func of(_ client: EnvironmentClient, workspace: WorkspaceMeta) -> WorkLifeHost {
        let key = "\(client.environment.id):\(workspace.id)"
        if let host = hosts[key] { return host }
        let host = WorkLifeHost(client: client, workspace: workspace)
        hosts[key] = host
        return host
    }

    private init(client: EnvironmentClient, workspace: WorkspaceMeta) {
        self.client = client
        workspaceId = workspace.id
        sector = workspace.sector.flatMap(Sector.init(rawValue:))
        tokens = LifeTokenSource(client: client, sector: workspace.sector)
    }

    /// Builds the store once the host has signed a token; again after a refusal (Retry).
    func prepare() async {
        guard store == nil else { return }
        phase = .loading
        let sectors = sector.map { [$0] } ?? Sector.allCases
        #if DEBUG
        if TestHooks.lifeFixtures {
            var book = FixtureBook(now: Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: Date()) ?? Date())
            book.addLifeKitFixtures()
            install(LifeStore(fixtures: book, sectors: sectors))
            return
        }
        #endif
        do {
            let token = try await tokens.token(force: false)
            let life = LifeClient(session: WorkLifeSession(deployment: token.deployment, tokens: tokens))
            let store = LifeStore(client: life, sectors: sectors)
            install(store)
            signIn = Task { [weak self] in
                try? await life.signIn()
                for await on in life.authenticated.values {
                    self?.store?.setAuthenticated(on)
                }
            }
        } catch let refusal as LifeToken.Refusal {
            phase = .unavailable(Self.words(refusal))
        } catch {
            phase = .unavailable("LifeOS did not answer.")
        }
    }

    private func install(_ store: LifeStore) {
        self.store = store
        scene = LifeScene(writes: store.makeWrites(), actions: self)
        store.start()
        phase = .ready
    }

    private static func words(_ refusal: LifeToken.Refusal) -> String {
        switch refusal {
        case .host("unreachable"): "LifeOS did not answer."
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

    /// The draft as LifeOS saved it goes to the host, which sends it only if it still says that.
    func hold(_ send: LifeHeldSend) async throws -> String {
        let message = try await draft(send.draftId).row.message
        let seen = Methods.WorkMailSend.Params.Seen(
            to: (message.to ?? []).map(\.address),
            cc: (message.cc ?? []).map(\.address),
            bcc: (message.bcc ?? []).map(\.address),
            subject: message.subject ?? "",
            text: message.text ?? ""
        )
        let answer = try await client.work.sendMail(draftId: send.draftId, seen: seen, sendAt: send.sendAt)
        return answer.via == .hold ? "Waiting in the Outbox" : "Sending"
    }

    var startsThreads: Bool { client.work.canApprove }

    func startThread(about item: LifeItem) {
        let kind: ContextChip.Kind
        let table: ContextChip.RefCase0.Table
        switch item.kind {
        case .task: (kind, table) = (.task, .tasks)
        case .event: (kind, table) = (.event, .events)
        case .thread: (kind, table) = (.mail, .mailThreads)
        }
        sheet = nil
        starting = ChipWords.lifeos(kind, table: table, id: item.id, label: item.title)
    }

    func handoff(of item: LifeItem) -> LifeHandoff? { nil }
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
