import Foundation

public extension HomeSections.Home {
    /// Home's first section in the desktop rail's order: Chats, then Work
    /// Chats, then the code workspaces. The Work workspaces stay in their own
    /// band below.
    var mainEntries: [HomeSections.Entry] {
        let chats = entries.prefix { $0.kind == .chats }
        return Array(chats) + work.filter { $0.kind == .workChats } + entries.dropFirst(chats.count)
    }
}
