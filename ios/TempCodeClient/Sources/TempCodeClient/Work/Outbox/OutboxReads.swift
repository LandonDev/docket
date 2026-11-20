import Foundation

/// How the Outbox says each host's read (the desktop's error rows above the list): a host whose read failed is named
/// with its error and Retry above the bands, whatever the other hosts hold, and the rows it read before stay. The
/// empty state speaks only when no band has a row and no host failed.
public extension OutboxModel {
    struct FailedRead: Sendable, Hashable, Identifiable {
        public var id: String
        public var name: String
        public var error: String
        /// "Box did not answer", the error beside it in a quieter step.
        public var line: String { "\(name) did not answer" }
    }

    nonisolated static func failedReads(_ hosts: [(id: String, name: String, error: String?)]) -> [FailedRead] {
        hosts.compactMap { host in host.error.map { FailedRead(id: host.id, name: host.name, error: $0) } }
    }

    enum EmptyOutbox: Sendable, Hashable { case reading, nothingHeld }

    /// Nil while any row shows or any host failed (its row says so); else still reading, or nothing held.
    nonisolated static func emptyState(bandsEmpty: Bool, anyReading: Bool, anyFailed: Bool) -> EmptyOutbox? {
        guard bandsEmpty, !anyFailed else { return nil }
        return anyReading ? .reading : .nothingHeld
    }
}
