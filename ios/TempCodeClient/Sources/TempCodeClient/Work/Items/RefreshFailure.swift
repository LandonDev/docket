import Foundation
import Observation

/// A read again over the rows kept on screen (the app's `ItemLoad`, whose own task does the reading): the reason it
/// failed, shown as the failed-read row until a read lands, and the wait that holds a pull's indicator or Try Again's
/// spinner until that read answers or fails, never only until it was asked for.
@MainActor @Observable
public final class RefreshFailure {
    public private(set) var error: String?
    @ObservationIgnored private var reading = false

    public init() {}

    /// A read answered: the rows are fresh.
    public func answered() { error = nil; reading = false }
    /// A read failed over the kept rows.
    public func failed(_ words: String) { error = words; reading = false }

    /// Asks for the read with `start` and returns once it has answered or failed, or the waiting task is cancelled.
    public func reread(_ start: () -> Void) async {
        reading = true
        start()
        while reading && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
    }
}
