import Foundation

/// One read of a file at a `rev` however many views open it (M17): the Item segment and the file's page, or a
/// view drawn again while its read runs, join the one seat already reading. The seat asks for the first picture
/// once (or takes the one kept for that `rev`, so a second open draws nothing on the host), hands it to every view
/// that waits, and reads the rest beside it. It goes when the rest is in, or is stopped when every view left.
@MainActor
public final class ReaderOpens {
    public static let shared = ReaderOpens(cache: .shared)

    @MainActor
    private final class Seat {
        var task: Task<any Sendable, any Error>?
        var picture: FirstPicture?
        var watchers: [@MainActor (FirstPicture) -> Void] = []
        /// The views that joined, and those of them that went away before the read was in.
        var joined = 0
        var left = 0
    }

    private let cache: ReaderCache
    private var seats: [String: Seat] = [:]

    public init(cache: ReaderCache) { self.cache = cache }

    /// The reads under way, one a file and `rev`.
    public var reading: Int { seats.count }

    /// Opens `key` at `rev`. `show` hears the first picture once it is here (at once when one is kept for this
    /// `rev`); `first` asks the host for it, and an answer of another `rev` is never shown; `rest` reads, checks
    /// and keeps the whole file. A failed or absent first picture leaves the open to `rest` alone.
    public func open<Value: Sendable>(
        _ key: String,
        rev: String,
        show: @escaping @MainActor (FirstPicture) -> Void,
        first: @escaping @MainActor () async -> FirstPicture?,
        rest: @escaping @MainActor () async throws -> Value
    ) async throws -> Value {
        let name = "\(key)\n\(rev)"
        let seat: Seat
        if let joined = seats[name] {
            seat = joined
            if let picture = seat.picture { show(picture) } else { seat.watchers.append(show) }
        } else {
            seat = Seat()
            seat.watchers.append(show)
            seats[name] = seat
            let kept = cache.picture(key, rev: rev)
            seat.task = Task { @MainActor in
                defer { if self.seats[name] === seat { self.seats[name] = nil } }
                let drawing: Task<Void, Never>? = kept == nil ? Task { @MainActor in
                    guard let picture = await first(), picture.rev == rev, !Task.isCancelled else { return }
                    self.cache.keep(picture: picture, for: key)
                    self.hand(picture, to: seat)
                } : nil
                defer { drawing?.cancel() }
                return try await rest()
            }
            if let kept { hand(kept, to: seat) }
        }
        guard let task = seat.task else { throw CancellationError() }
        seat.joined += 1
        let value = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            Task { @MainActor in self.leave(name, seat) }
        }
        guard let value = value as? Value else { throw CancellationError() }
        return value
    }

    /// A view that waited went away: the read stops once none waits for it.
    private func leave(_ name: String, _ seat: Seat) {
        seat.left += 1
        guard seat.left >= seat.joined else { return }
        seat.task?.cancel()
        if seats[name] === seat { seats[name] = nil }
    }

    private func hand(_ picture: FirstPicture, to seat: Seat) {
        seat.picture = picture
        let watchers = seat.watchers
        seat.watchers = []
        for watcher in watchers { watcher(picture) }
    }
}
