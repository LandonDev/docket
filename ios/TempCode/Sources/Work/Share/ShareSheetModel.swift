import SwiftUI
import TempCodeClient
import TempCodeContract
import ImageIO

/// One thing he shared: a file the sheet holds a copy of until Save queues it.
struct SharePick: Identifiable, Hashable {
    let id = UUID()
    /// The sheet's own copy, in its temporary folder.
    var url: URL
    var name: String
    var size: Int
    var kind: ShareSummary.Kind
    /// A small picture of a photo, for the row.
    var thumbnail: UIImage?
}

/// A photo's picture for its row, decoded small.
enum SharePickThumbnail {
    static func of(_ url: URL) -> UIImage? {
        let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 176] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A host the sheet can talk to: its socket, opened when the sheet first needs it. Not `ShareLink`: that name is
/// SwiftUI's, which five of the app's screens use.
@MainActor
final class ShareHostLink {
    let host: ShareTargets.Host
    private let socket: TempCodeSocket

    init(host: ShareTargets.Host, keys: any KeyStore) {
        self.host = host
        socket = TempCodeSocket(environment: host.environment, keys: keys)
    }

    /// Opens the socket and waits for it, a few seconds at most: an extension has no time to keep trying.
    func open(within seconds: Double = 8) async -> Bool {
        if await socket.isOpen { return true }
        await socket.start()
        for _ in 0..<Int(seconds * 10) {
            if await socket.isOpen { return true }
            if await socket.status.transport == .unauthorized { return false }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return await socket.isOpen
    }

    /// The socket is an actor: its stop is sent, not waited for, as the sheet closes.
    func close() {
        let socket = socket
        Task { await socket.stop() }
    }

    func uploader(_ inbox: ShareInbox) -> ShareUploader {
        ShareUploader(inbox: inbox, socket: socket, hostName: host.name)
    }

    func folders(inside folder: ShareFolder, workspaceId: String) async throws -> [ShareFolder] {
        try await ShareFolders.inside(folder, workspaceId: workspaceId) { try await self.socket.request(Methods.WorkFilesList.self, $0) }
    }
}

/// The share sheet's state (docs/IOS-DESIGN.md "Save to TempCode"): what was shared, where it goes, and
/// how the save went. The extension makes one for its sheet; the app makes one for the proofs.
@MainActor @Observable
final class ShareSheetModel {
    let inbox: ShareInbox
    /// The App Group's share folder: the queue and the list of places.
    let root: URL
    private let keys: any KeyStore
    private(set) var targets: ShareTargets
    var picks: [SharePick]
    /// One file's name, which he may change before Save.
    var name: String
    private(set) var target: ShareTargets.Target?
    private(set) var folder: ShareFolder?
    private(set) var phase: SharePhase = .picking
    /// What an earlier save left refused: the host's words, Try Again, Discard.
    private(set) var earlier: [ShareItem] = []
    /// The folder whose inside is being read, for the spinner in its row.
    private(set) var loading: ShareFolder?
    /// Why a folder's inside could not be read.
    private(set) var folderFailure: String?
    @ObservationIgnored private var links: [String: ShareHostLink] = [:]

    init(inbox: ShareInbox, root: URL, keys: any KeyStore, picks: [SharePick]) {
        self.inbox = inbox
        self.root = root
        self.keys = keys
        self.picks = picks
        name = picks.first?.name ?? ""
        targets = ShareTargets.read(root: root)
        // The last place used leads the list and is the one checked.
        target = targets.ordered.first
        folder = target?.workspace.folder
        earlier = inbox.items().filter { $0.state == .refused }
    }

    var ordered: [ShareTargets.Target] { targets.ordered }
    var severalHosts: Bool { targets.hosts.count > 1 }
    var canSave: Bool { target != nil && !picks.isEmpty && (picks.count > 1 || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }

    func choose(_ target: ShareTargets.Target) {
        guard phase == .picking else { return }
        self.target = target
        folder = target.workspace.folder
        folderFailure = nil
    }

    func choose(_ folder: ShareFolder) {
        self.folder = folder
    }

    private func link(_ host: ShareTargets.Host) -> ShareHostLink {
        if let link = links[host.id] { return link }
        let link = ShareHostLink(host: host, keys: keys)
        links[host.id] = link
        return link
    }

    /// The folders inside one, read from the host as he goes down.
    func folders(inside folder: ShareFolder) async -> [ShareFolder]? {
        guard let target else { return nil }
        loading = folder
        defer { loading = nil }
        folderFailure = nil
        let link = link(target.host)
        guard await link.open() else {
            folderFailure = SharePhase.unreachable(target.host.name)
            return nil
        }
        do {
            return try await link.folders(inside: folder, workspaceId: target.workspace.id)
        } catch {
            folderFailure = ActionError.wrap(error).message
            return nil
        }
    }

    /// Queues every file, then sends what the host will take now. A host that cannot be reached leaves the
    /// files queued for the app; nothing is lost when the sheet closes.
    func save() async {
        guard let target, phase == .picking else { return }
        let destination = target.destination(folder)
        phase = .saving(0)
        var queued: [ShareItem] = []
        for (index, pick) in picks.enumerated() {
            let wanted = picks.count == 1 ? name : pick.name
            do {
                queued.append(try inbox.add(pick.url, to: destination, name: ShareSummary.name(wanted, kind: pick.kind, at: Date().addingTimeInterval(Double(index)))))
            } catch {
                phase = .refused("\(pick.name) could not be read.")
                return
            }
        }
        targets.used(hostId: target.host.id, workspaceId: target.workspace.id, folder: destination.folder, at: Date().timeIntervalSince1970 * 1000)
        try? targets.write(root: root)
        let link = link(target.host)
        guard await link.open() else {
            phase = .waiting(SharePhase.unreachable(target.host.name))
            return
        }
        let uploader = link.uploader(inbox)
        var results: [ShareItem] = []
        for item in queued {
            let done = results.count
            results.append(await uploader.send(item) { [weak self] share in
                self?.phase = .saving(SharePhase.share(done: done, of: queued.count, current: share))
            })
        }
        phase = SharePhase.after(results, host: target.host.name)
        earlier = inbox.items().filter { $0.state == .refused && !results.map(\.id).contains($0.id) }
    }

    /// An earlier refusal, tried once more on its own host.
    func retry(_ item: ShareItem) async {
        guard let host = targets.hosts.first(where: { $0.id == item.hostId }) else { return discard(item) }
        try? inbox.mark(item.id, .queued)
        let link = link(host)
        if await link.open(), let queued = inbox.item(item.id) { _ = await link.uploader(inbox).send(queued) }
        earlier = inbox.items().filter { $0.state == .refused }
    }

    func discard(_ item: ShareItem) {
        inbox.discard(item.id)
        earlier.removeAll { $0.id == item.id }
    }

    /// The sheet is closing: the sockets go, and the sheet's own copies with them.
    func finish() {
        for link in links.values { link.close() }
        links = [:]
        for pick in picks { try? FileManager.default.removeItem(at: pick.url) }
    }

    #if DEBUG
    /// The proofs' states that no host is asked for (`TC_TEST_SHARE`).
    func show(_ phase: SharePhase, earlier: [ShareItem] = []) {
        self.phase = phase
        if !earlier.isEmpty { self.earlier = earlier }
    }
    #endif
}
