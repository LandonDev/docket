import SwiftUI
import TempCodeClient
import TempCodeContract

/// The app's half of Save to TempCode (docs/agents/work-phone-files.md "Save to TempCode"). The share
/// extension is another process with no pairing of its own: the app leaves it the list of places a file
/// can go (`ShareTargets`, in the App Group) and a copy of each host's key that may act (`ShareKeys`, in
/// the group's keychain), and sends what the extension queued and could not send itself.
@MainActor
enum ShareBridge {
    private static var draining = false

    /// The places as the hosts list them now: Work workspaces on hosts with Work on, for a key that may act.
    /// A host that has not listed its workspaces yet keeps what was written for it before.
    static func targets(_ registry: ClientRegistry, earlier: ShareTargets) -> ShareTargets {
        let hosts = registry.ordered.compactMap { client -> ShareTargets.Host? in
            let id = client.environment.id
            guard client.hasShell else { return earlier.hosts.first { $0.id == id } }
            guard client.work.isOn, client.work.may(.filesUpload) else { return nil }
            let spaces = client.workspaces
                .filter { $0.kind == .work }
                .map { ShareTargets.Workspace(id: $0.id, name: $0.name, sector: $0.sector, folderName: $0.name) }
            guard !spaces.isEmpty else { return nil }
            return ShareTargets.Host(id: id, name: client.environment.name, environment: client.environment, workspaces: spaces)
        }
        return ShareTargets(hosts: hosts).keepingUse(from: earlier)
    }

    /// The Work workspace the app has open now, for the sheet's first check (`ShareTargets.open`): kept in the list
    /// the extension reads, written only when it changes.
    static func noteOpen(_ open: ShareTargets.Open?) {
        guard let open, let root = ShareInbox.groupRoot() else { return }
        var targets = ShareTargets.read(root: root)
        guard targets.open != open else { return }
        targets.open = open
        try? targets.write(root: root)
    }

    /// The Work workspace a route of the Work tab is in: a job's place, or a thread of a Work workspace.
    static func open(_ route: Route?, registry: ClientRegistry) -> ShareTargets.Open? {
        switch route {
        case .place(_, let job?)?:
            for client in registry.ordered {
                if let space = client.workspaces.first(where: { $0.kind == .work && ProjectPairs.key(client.environment.id, $0) == job }) {
                    return .init(hostId: client.environment.id, workspaceId: space.id)
                }
            }
            return nil
        case let route?:
            guard let thread = ShellPaths.thread(of: route), let client = registry.client(thread.environmentId),
                  let session = client.session(thread.sessionId) else { return nil }
            // A thread of a project is in its project's workspace.
            let workspaceId = session.workspaceId ?? session.projectId.flatMap { id in client.projects.first { $0.id == id }?.workspaceId }
            guard let workspaceId, client.workspaces.contains(where: { $0.id == workspaceId && $0.kind == .work }) else { return nil }
            return .init(hostId: thread.environmentId, workspaceId: workspaceId)
        case nil:
            return nil
        }
    }

    /// Writes the list and the keys for the extension. Called at launch and whenever a host's Work or its
    /// workspaces change.
    static func publish(_ registry: ClientRegistry) {
        guard let root = ShareInbox.groupRoot() else { return }
        let earlier = ShareTargets.read(root: root)
        let next = targets(registry, earlier: earlier)
        if next != earlier { try? next.write(root: root) }
        let keys = registry.store.keys
        ShareKeys.group.sync(registry.store.environments) { try? keys.key(for: $0) }
    }

    /// Sends what waits in the queue for each host that answers, oldest first, and clears what is done.
    static func drain(_ registry: ClientRegistry) async {
        guard !draining, let root = ShareInbox.groupRoot() else { return }
        draining = true
        defer { draining = false }
        let inbox = ShareInbox(root: root)
        inbox.sweep()
        for client in registry.ordered where client.work.isOn && client.work.may(.filesUpload) {
            let id = client.environment.id
            guard inbox.items().contains(where: { $0.hostId == id && $0.state == .queued }) else { continue }
            await ShareUploader(inbox: inbox, hostId: id, hostName: client.environment.name, request: .client(client)).drain()
        }
    }
}

#if DEBUG
/// The proofs' share sheet (`TC_TEST_SHARE=<state>`): the same view the extension shows, over Home, on a
/// queue of its own under the temporary folder so the App Group's is never touched. States: `one`,
/// `several`, `saving`, `saved`, `waiting`, `refused`, `earlier`, `unread` (one of three not read),
/// `unread-all`, `empty` draw the sheet with no host asked; `save` presses Save with no job checked (nothing may
/// queue), then picks the job `TC_TEST_SHARE_JOB` names and really saves a picture into its folder.
struct ShareProofSheet: View {
    let registry: ClientRegistry
    let state: String
    @Environment(\.dismiss) private var dismiss
    @State private var model: ShareSheetModel?

    var body: some View {
        Group {
            if let model {
                ShareSheetView(model: model, cancel: { dismiss() }, done: { dismiss() })
            } else {
                ProgressView()
            }
        }
        .tcSheet(.form)
        .task { await make() }
    }

    private func make() async {
        let root = FileManager.default.temporaryDirectory.appending(path: "share-proof-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if state != "empty" { try? ShareBridge.targets(registry, earlier: ShareTargets()).write(root: root) }
        let count = state == "several" ? 3 : state == "unread" ? 2 : state == "unread-all" ? 0 : 1
        let picks: [SharePick] = count == 0 ? [] : (1...count).compactMap { Self.picture(number: $0, in: root) }
        let unread = state.hasPrefix("unread") ? ["Photo.heic"] : []
        let inbox = ShareInbox(root: root)
        let made = ShareSheetModel(inbox: inbox, root: root, keys: registry.store.keys, picks: picks, unread: unread)
        let host = made.ordered.first?.host.name ?? "The host"
        switch state {
        case "saving": made.show(.saving(0.6))
        case "saved": made.show(.saved)
        case "waiting": made.show(.waiting(SharePhase.unreachable(host)))
        case "refused": made.show(.refused(ShareUploader.tooLarge(host: host, limit: 200 * 1024 * 1024)))
        case "earlier":
            if let target = made.ordered.first, let pick = picks.first, let item = try? inbox.add(pick.url, to: target.destination(), name: "Receipt March.pdf") {
                _ = inbox.claim(item.id)
                try? inbox.mark(item.id, .refused, words: ShareRefused.proofWords)
                if let refused = inbox.item(item.id) { made.show(.picking, earlier: [refused]) }
            }
        default: break
        }
        model = made
        if state == "save" {
            try? await Task.sleep(for: .seconds(2))
            // A fresh phone checks no job: Save is off and queues nothing until he picks one.
            let unpicked = made.target == nil && !made.canSave
            await made.save()
            let held = unpicked && made.phase == .picking && made.lastSave.isEmpty && inbox.items().isEmpty
            // Then the seeded job the proof names (TC_TEST_SHARE_JOB), chosen as his tap would, and Save.
            let job = ProcessInfo.processInfo.environment["TC_TEST_SHARE_JOB"].flatMap { $0.isEmpty ? nil : $0 } ?? "Purdue Esports"
            guard let pick = made.ordered.first(where: { $0.workspace.name == job }) else {
                return Self.report(Report(name: "", size: 0, sha256: "", state: "no-job", words: "no job named \(job) in the sheet", unpicked: held))
            }
            made.choose(pick)
            await made.save()
            // What this save left, for the proof's read-back on the host (Documents/share-report.json): `done` only
            // for a file the host took and the sheet said Saved.
            guard let item = made.lastSave.first else {
                return Self.report(Report(name: "", size: 0, sha256: "", state: "not-started", words: nil, unpicked: held, workspaceId: pick.workspace.id))
            }
            let state = item.state == .done && made.phase == .saved ? "done" : item.state == .done ? "not-saved" : item.state.rawValue
            Self.report(Report(name: item.name, size: item.size, sha256: item.sha256, state: state, words: item.words, unpicked: held, workspaceId: pick.workspace.id))
        }
    }

    private struct Report: Encodable {
        var name: String
        var size: Int
        var sha256: String
        var state: String
        var words: String?
        /// With no job checked, Save stayed off and queued nothing.
        var unpicked: Bool
        /// The job the save was asked to reach.
        var workspaceId: String?
    }

    private static func report(_ report: Report) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first, let data = try? JSONEncoder().encode(report) else { return }
        try? data.write(to: documents.appending(path: "share-report.json"), options: .atomic)
    }

    /// A small picture to share: dummy pixels, drawn here.
    private static func picture(number: Int, in root: URL) -> SharePick? {
        let size = CGSize(width: 320, height: 240)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor(hue: CGFloat(number) * 0.17, saturation: 0.45, brightness: 0.85, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        guard let data = image.pngData() else { return nil }
        let folder = root.appending(path: "picked-\(number)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = number == 1 ? "Bracket photo.png" : "Bracket photo \(number).png"
        let url = folder.appending(path: name)
        guard (try? data.write(to: url)) != nil else { return nil }
        return SharePick(url: url, name: name, size: data.count, kind: .photo, thumbnail: SharePickThumbnail.of(url))
    }
}
#endif
