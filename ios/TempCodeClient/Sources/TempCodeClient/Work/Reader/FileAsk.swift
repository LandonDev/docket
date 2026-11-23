import Foundation
import TempCodeContract

/// Ask on a file open from Files, where no thread stands beside it (the phone-files build's PF5,
/// docs/agents/work-phone-files.md "Ask with no thread"). His words go to the thread that already holds
/// the file; where none does, a thread is started in the workspace with the file as its own item, the way
/// the desktop's docked chat does it (docs/agents/work-files.md "Ask"): create, open the file in it, send.
public enum FileAsk {
    /// The thread that holds the file, of those the host names: the newest the phone knows that is not
    /// archived. A thread the phone has not listed is passed over, since it may be archived.
    public static func holder(_ threads: [Methods.WorkFilesThreads.Output.Thread], session: (String) -> SessionMeta?) -> String? {
        threads
            .compactMap { session($0.sessionId) }
            .filter { !$0.archived }
            .max { $0.updatedAt < $1.updatedAt }?
            .id
    }

    /// Sends his words about the file and answers the thread that took them.
    public static func send(wire: any FilesWire, workspaceId: String, item: CanvasItem, chip: ContextChip, text: String, session: (String) -> SessionMeta?) async throws -> String {
        let words = ChipWords.message([chip], text: text)
        // A host that cannot say who holds the file is asked nothing more of it: a new thread takes the words.
        let threads = (try? await wire.request(Methods.WorkFilesThreads.self, .init(workspaceId: workspaceId, ref: item.source)).threads) ?? []
        if let held = holder(threads, session: session) {
            _ = try await wire.request(Methods.SessionSend.self, .init(sessionId: held, text: words))
            return held
        }
        let made = try await wire.request(Methods.SessionCreate.self, .init(workspaceId: .set(workspaceId), threadType: .set(.chat), scope: .work, about: chip))
        // The file is the thread's own item before the first turn starts. An open the host refuses does not
        // stop the words: they still name the file.
        _ = try? await wire.request(Methods.WorkCanvasOpen.self, .init(sessionId: made.id, kind: Methods.WorkCanvasOpen.Params.Kind(rawValue: item.kind.rawValue), source: item.source, title: item.title))
        _ = try await wire.request(Methods.SessionSend.self, .init(sessionId: made.id, text: words))
        return made.id
    }
}
