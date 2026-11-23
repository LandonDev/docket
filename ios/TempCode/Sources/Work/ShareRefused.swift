import SwiftUI
import TempCodeClient
import TempCodeContract

/// What Save to TempCode left refused (docs/agents/work-phone-files.md "Save to TempCode"): the files a host
/// would not take, read from the share queue. Their workspace's Files screen leads with them, so a save that
/// failed after its sheet closed is not lost from sight; nothing else tells him.
@MainActor @Observable
final class ShareRefused {
    static let shared = ShareRefused()

    /// Every refused file in the queue, whichever workspace it was for.
    private(set) var items: [ShareItem] = []
    private(set) var trying: Set<String> = []
    /// The queue's folder: the App Group's. A proof hands in its own.
    @ObservationIgnored private var root = ShareInbox.groupRoot()

    func of(hostId: String, workspaceId: String) -> [ShareItem] {
        items.filter { $0.hostId == hostId && $0.workspaceId == workspaceId }
    }

    /// Reads the queue again: when a Files screen shows, and after each press here.
    func read(client: EnvironmentClient, workspaceId: String) {
        #if DEBUG
        seedForProof(client: client, workspaceId: workspaceId)
        #endif
        items = root.map { ShareInbox(root: $0).items().filter { $0.state == .refused } } ?? []
    }

    /// Once more, on the file's own host; its row goes when the host takes it, else it stays with the new words.
    func retry(_ item: ShareItem, client: EnvironmentClient) async {
        guard let root, !trying.contains(item.id) else { return }
        trying.insert(item.id)
        defer { trying.remove(item.id) }
        let inbox = ShareInbox(root: root)
        try? inbox.mark(item.id, .queued)
        if let queued = inbox.item(item.id) {
            _ = await ShareUploader(inbox: inbox, hostId: client.environment.id, hostName: client.environment.name, request: .client(client)).send(queued)
        }
        read(client: client, workspaceId: item.workspaceId)
    }

    func discard(_ item: ShareItem) {
        if let root { ShareInbox(root: root).discard(item.id) }
        items.removeAll { $0.id == item.id }
    }

    #if DEBUG
    /// The Files proof (`TC_TEST_ACTION=files-refused`): one refused picture for this workspace, in a queue of
    /// its own under the temporary folder, so the App Group's is never touched.
    private func seedForProof(client: EnvironmentClient, workspaceId: String) {
        guard TestHooks.action == "files-refused", TestHooks.once("files-refused") else { return }
        let folder = FileManager.default.temporaryDirectory.appending(path: "share-refused-\(UUID().uuidString)", directoryHint: .isDirectory)
        let file = folder.appending(path: "Receipt March.pdf")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? Data("dummy".utf8).write(to: file)
        let inbox = ShareInbox(root: folder.appending(path: "queue", directoryHint: .isDirectory))
        let workspace = client.workspaces.first { $0.id == workspaceId }
        let destination = ShareDestination(hostId: client.environment.id, workspaceId: workspaceId, folder: .top(name: workspace?.name ?? "Files"))
        guard let item = try? inbox.add(file, to: destination, name: "Receipt March.pdf") else { return }
        try? inbox.mark(item.id, .refused, words: "There is a file named Receipt March.pdf in that folder already.")
        root = inbox.root
    }
    #endif
}

/// The section at the head of a workspace's Files screen: a row for each file a save left refused, with the
/// host's words, Try Again and a swipe to Discard. Nothing when there is none.
struct ShareRefusedSection: View {
    let client: EnvironmentClient
    let workspaceId: String
    /// The mark slot of the Files screen's rows (`FilesRowLabel`), so the names line up.
    @ScaledMetric(relativeTo: .subheadline) private var mark: CGFloat = 28

    private var refused: ShareRefused { .shared }

    var body: some View {
        let items = refused.of(hostId: client.environment.id, workspaceId: workspaceId)
        if !items.isEmpty {
            Section {
                ForEach(items) { item in
                    HStack(spacing: Layout.rowGap + 2) {
                        Image(systemName: "arrow.up.doc")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(width: mark, height: mark)
                            .accessibilityHidden(true)
                        ShareRefusedRow(item: item, trying: refused.trying.contains(item.id)) { Task { await refused.retry(item, client: client) } }
                    }
                    .padding(.vertical, Layout.rowVertical)
                    .frame(minHeight: Layout.rowHeight)
                    .swipeActions(edge: .trailing) {
                        Button("Discard", systemImage: "trash", role: .destructive) { refused.discard(item) }
                    }
                    .listRowInsets(Layout.rowInsets)
                }
            } header: {
                Text("Not saved").textStep(.meta, weight: .semibold)
            }
        }
    }
}
