import Foundation
import TempCodeContract

/// Search's Work scope through one host (docs/agents/work-search.md "The wire"). Both methods are approve and
/// relay only while the host's screen is unlocked (`KeyMay.searchQuery`, `.searchOpened`). Search sends,
/// posts, shares and files nothing: a hit he taps is reported back for Recent, and a file is seated in its
/// job's Files pane as one he opened from Files is.
extension WorkHost {
    /// One ask, at either speed: `{text, tier: 'instant'}` first, then `{text, sources: [id]}` a pending source.
    public func searchWork(_ params: Methods.WorkSearchQuery.Params) async throws -> WorkSearchAnswer {
        try await socket.request(Methods.WorkSearchQuery.self, params)
    }

    /// He opened this hit: its own host keeps it for Recent (a title, a kind, an id, a job). Never waited on by the
    /// screen; a failure loses one Recent row and nothing else.
    public func searchOpened(_ hit: WorkSearchHit) async {
        _ = try? await socket.request(Methods.WorkSearchOpened.self, .init(hit: hit))
    }

    /// A file found by search, seated in its job's Files pane (`work.files.open` with Files' own ref, as the
    /// desktop's `openInFiles` does), so the reader opens on the item the host made.
    public func openFound(workspaceId: String, ref: JSONValue, name: String, key: String) async throws -> CanvasItem {
        let source = try JSONDecoder().decode(CanvasSource.self, from: JSONEncoder().encode(ref))
        let opened = try await socket.request(Methods.WorkFilesOpen.self, .init(workspaceId: workspaceId, ref: source, name: name, key: key))
        if let item = opened.item { return item }
        if let held = opened.held {
            let items = try await socket.request(Methods.WorkCanvasList.self, .init(sessionId: held.sessionId)).items
            if let item = items.first(where: { $0.id == held.itemId }) { return item }
        }
        throw ActionError.refused(message: "\(name) did not open.", forbidden: false)
    }
}
