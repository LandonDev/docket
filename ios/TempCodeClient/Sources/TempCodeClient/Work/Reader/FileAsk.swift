import Foundation
import TempCodeContract

/// Ask on a file open from Files, where no thread stands beside it (the phone-files build's PF5,
/// docs/agents/work-phone-files.md "Ask with no thread"). His words go to the thread that already holds
/// the file; where none does, a thread is started in the workspace with the file as its own item, in the
/// order the desktop's docked chat keeps (docs/agents/work-files.md "Ask"): create, open the file in it,
/// send. The phone is stricter in one thing: where the file will not open in the new thread the words wait,
/// and Send again finishes the same thread.
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

    /// The file would not open in the thread started for it. The thread is kept, so Send again finishes it
    /// there and no second thread is made.
    public struct NotSeated: Error {
        public let threadId: String
        /// Why the host would not open it.
        public let cause: any Error
    }

    /// Sends his words about the file and answers the thread that took them. `into` is the thread an earlier
    /// try started (`NotSeated`): the file is opened in it again and the words go there.
    @MainActor
    public static func send(wire: any FilesWire, workspaceId: String, item: CanvasItem, chip: ContextChip, text: String, into started: String? = nil, session: (String) -> SessionMeta?) async throws -> String {
        let words = ChipWords.message([chip], text: text)
        var thread = started
        if thread == nil {
            let threads: [Methods.WorkFilesThreads.Output.Thread]
            do {
                threads = try await wire.request(Methods.WorkFilesThreads.self, .init(workspaceId: workspaceId, ref: item.source)).threads
            } catch {
                // Only a host from before this call has no holder to name. Any other failure is said: a
                // read that failed for a moment must not send his words into a second thread.
                guard HostCan.saysUnknown(error) else { throw error }
                threads = []
            }
            if let held = holder(threads, session: session) {
                _ = try await wire.request(Methods.SessionSend.self, .init(sessionId: held, text: words))
                return held
            }
            thread = try await wire.request(Methods.SessionCreate.self, .init(workspaceId: .set(workspaceId), threadType: .set(.chat), scope: .work, about: chip)).id
        }
        guard let thread else { throw CancellationError() }
        // The file is the thread's own item before the first turn starts: his words are about what he sees.
        do {
            _ = try await wire.request(Methods.WorkCanvasOpen.self, .init(sessionId: thread, kind: Methods.WorkCanvasOpen.Params.Kind(rawValue: item.kind.rawValue), source: item.source, title: item.title))
        } catch {
            throw NotSeated(threadId: thread, cause: error)
        }
        _ = try await wire.request(Methods.SessionSend.self, .init(sessionId: thread, text: words))
        return thread
    }
}
