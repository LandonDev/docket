import Foundation

/// How the Outbox says each host's read (the desktop's error rows above the list): a host whose read failed is named
/// with its error and Retry above the bands, whatever the other hosts hold, and the rows it read before stay. The
/// empty state speaks only when no band has a row and no host failed.
public extension OutboxModel {
    struct FailedRead: Sendable, Hashable, Identifiable {
        public var id: String
        public var name: String
        public var error: String
        /// "Box did not answer".
        public var line: String { "\(name) did not answer" }
        /// The failed-read row's words: the host, then its error ("Box: Not connected"), never "did not answer" twice.
        public var words: String { "\(name): \(error)" }
    }

    nonisolated static func failedReads(_ hosts: [(id: String, name: String, error: String?)]) -> [FailedRead] {
        hosts.compactMap { host in host.error.map { FailedRead(id: host.id, name: host.name, error: $0) } }
    }

    /// The words a Work host's failed-read row says, or nil. A link down past its first try is "Not connected",
    /// whether or not the host listed before the drop (the rows it gave stay below); else the list read's failure,
    /// else the requests read's, since Waiting is both.
    nonisolated static func readError(list: String?, requests: String?, open: Bool) -> String? {
        open ? list ?? requests : TodaySources.notConnected
    }

    /// What a failed `work.outbox.requests` read leaves for that row: its words, or nil for a host from before
    /// requests, which refuses the method as unknown and so has none to read.
    @MainActor static func requestsError(_ error: any Error) -> String? {
        HostCan.saysUnknown(error) ? nil : ActionError.wrap(error).message
    }

    enum EmptyOutbox: Sendable, Hashable { case reading, nothingHeld }

    /// Nil while any row shows. With no rows: still reading whenever any host reads, even under another host's
    /// failed row, so the screen says a read is running; nothing held only when no host failed and none reads; nil
    /// when the failed rows are all there is to say.
    nonisolated static func emptyState(bandsEmpty: Bool, anyReading: Bool, anyFailed: Bool) -> EmptyOutbox? {
        guard bandsEmpty else { return nil }
        if anyReading { return .reading }
        return anyFailed ? nil : .nothingHeld
    }
}
