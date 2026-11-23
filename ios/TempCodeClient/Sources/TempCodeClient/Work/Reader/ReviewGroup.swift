import Foundation

/// The changes that came together, under one heading: a sheet's change set under the agent's reason, a
/// document's branch under its label. Review Changes lists the groups in the host's order.
public struct ReviewGroup: Identifiable, Equatable, Sendable {
    public let id: String
    /// What the agent said the change is for; nil where it said nothing worth a heading.
    public let heading: String?
    public let rows: [ReviewRow]

    /// Consecutive rows of one change set or one branch are one group.
    public static func of(_ rows: [ReviewRow]) -> [ReviewGroup] {
        var groups: [(id: String, heading: String?, rows: [ReviewRow])] = []
        for row in rows {
            let id = row.group.map { "set:\($0)" } ?? "label:\(row.reason ?? "")"
            if let last = groups.indices.last, groups[last].id == id {
                groups[last].rows.append(row)
            } else {
                groups.append((id, heading(row.reason), [row]))
            }
        }
        return groups.map { ReviewGroup(id: $0.id, heading: $0.heading, rows: $0.rows) }
    }

    /// The host names an agent's branch "Suggestions" when the agent gave no reason, and a restore's branch by
    /// its time ("Restore 1763…"): neither is a reason, and neither heads its rows.
    static func heading(_ reason: String?) -> String? {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty, reason != "Suggestions" else { return nil }
        if reason.hasPrefix("Restore "), reason.dropFirst("Restore ".count).allSatisfy(\.isNumber) { return nil }
        return reason
    }
}

extension WorkReview {
    public var groups: [ReviewGroup] { ReviewGroup.of(rows) }
}
