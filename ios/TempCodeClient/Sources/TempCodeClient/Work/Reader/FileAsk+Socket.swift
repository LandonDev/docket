import Foundation
import TempCodeContract

extension WorkHost {
    /// Ask from a file with no thread beside it: answers the thread his words went to.
    public func ask(workspaceId: String, item: CanvasItem, chip: ContextChip, text: String, into started: String? = nil, session: (String) -> SessionMeta?) async throws -> String {
        try await FileAsk.send(wire: SocketFilesWire(socket: socket), workspaceId: workspaceId, item: item, chip: chip, text: text, into: started, session: session)
    }
}
