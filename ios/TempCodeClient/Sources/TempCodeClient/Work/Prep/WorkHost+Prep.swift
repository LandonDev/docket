import Foundation
import TempCodeContract

/// A meeting's page through the job's host (docs/agents/work-prep.md "The phone"). The page is read and kept on
/// the workspace's host; Prepare and Follow Up each start a Work thread that only drafts (operate), his notes are
/// kept as he types (operate), and the tasks he ticks are filed in LifeOS in the job's sector (approve, his press,
/// never sent to anyone). Every method is carried by the relay.
extension WorkHost {
    public func prepPage(workspaceId: String, eventId: String) async throws -> PrepPagePhone {
        try await socket.request(Methods.WorkPrepPage.self, .init(workspaceId: workspaceId, eventId: eventId)).page
    }

    /// Prepare: starts the brief thread, or answers the one still working. `restart` when the phone knows that
    /// thread has stopped.
    public func prepare(workspaceId: String, eventId: String, restart: Bool = false) async throws -> String {
        try await socket.request(Methods.WorkPrepBrief.self, .init(workspaceId: workspaceId, eventId: eventId, restart: restart ? true : nil)).sessionId
    }

    /// Follow Up: starts the follow-up thread from his notes, or answers the one still working.
    public func followUp(workspaceId: String, eventId: String, restart: Bool = false) async throws -> String {
        try await socket.request(Methods.WorkPrepFollowUp.self, .init(workspaceId: workspaceId, eventId: eventId, restart: restart ? true : nil)).sessionId
    }

    /// Keeps his notes; `base` is the words the page last held, and another window's newer words come back as a conflict.
    public func keepNotes(workspaceId: String, eventId: String, text: String, base: String) async throws -> Methods.WorkPrepNotes.Output {
        try await socket.request(Methods.WorkPrepNotes.self, .init(workspaceId: workspaceId, eventId: eventId, text: text, base: base))
    }

    /// Files the ticked suggestions in LifeOS (accept), or drops them (reject).
    public func decideTasks(workspaceId: String, eventId: String, taskIds: [String], accept: Bool) async throws -> Methods.WorkPrepDecide.Output {
        try await socket.request(Methods.WorkPrepDecide.self, .init(workspaceId: workspaceId, eventId: eventId, taskIds: taskIds, decision: accept ? .accept : .reject))
    }
}
