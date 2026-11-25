import Foundation
import TempCodeContract

/// What People asks the host (docs/agents/work-people.md "The phone"): the forms of the job a person answered, by
/// their addresses. The person and what is live with them are LifeOS's own reads through LifeKit; the guest links
/// are `guestLinks()`.
extension WorkHost {
    public func formsAnswered(workspaceId: String, emails: [String]) async throws -> [MsFormsByPerson] {
        let asked = Array(Set(emails.map { $0.lowercased() }).sorted().prefix(50))
        guard !asked.isEmpty else { return [] }
        return try await socket.request(Methods.WorkMsformsByPerson.self, .init(workspaceId: workspaceId, emails: asked))
    }
}
