import Foundation

public extension HomeSections.WorkspaceScreen {
    /// The "Chats" fold heads a workspace's chats when something sits above
    /// them: its project cards, or a Work workspace's view rows (Mail, Tasks,
    /// Agenda, Routines and House Rules), so threads never run on under those
    /// rows. The Chats entry is chats alone, and its title already says so.
    var showsChatsFold: Bool {
        guard let workspace, !chats.isEmpty else { return false }
        return !projects.isEmpty || workspace.members.contains { $0.workspace.kind == .work }
    }
}
