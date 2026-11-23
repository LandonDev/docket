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

    /// An empty Work workspace says "No threads here yet." as the list's last
    /// row, under its view rows: laid over the middle of the list, the note
    /// would lie across them. An empty workspace with no rows above shows it
    /// alone, over the empty list.
    var emptyNoteIsRow: Bool {
        guard let workspace, isEmpty else { return false }
        return workspace.members.contains { $0.workspace.kind == .work }
    }
}
