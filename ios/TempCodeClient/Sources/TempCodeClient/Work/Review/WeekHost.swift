import Foundation
import TempCodeContract

/// One host's weekly review and Money calls, as thin as the wire (docs/agents/work-review.md, work-money.md).
/// Every review method needs approve and refuses a thread; Money's reads need read and its writes operate
/// (`KeyMay`). None of them sends anything to anyone.
@MainActor public protocol WeekHost: AnyObject {
    var hostId: String { get }
    /// This host's part of the week `[from, to)` cut in `tz`.
    func reviewWeek(from: Int, to: Int, tz: String) async throws -> ReviewBody
    /// The weeks this host kept, newest first, and the zone its routine cuts weeks in.
    func reviewWeeks() async throws -> ReviewKeptList
    /// His press on a slipped row: the thing's own write on this host, with a token to take it back.
    func settle(_ ref: ReviewBody.Slipped.Row.Ref, how: WeekReview.SettleHow, tz: String, sector: String?) async throws -> ReviewSettled
    func undoSettle(token: String) async throws
    /// He opened the week: `work.review.ready` stops naming it.
    func reviewSeen(from: Int) async throws
    /// Each of this host's jobs' sums for local days `[from, to)`.
    func moneySums(from: String, to: String) async throws -> MoneySums
}
