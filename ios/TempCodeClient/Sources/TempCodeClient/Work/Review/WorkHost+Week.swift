import Foundation
import TempCodeContract

/// The thin calls over the socket (`WeekHost` is the seam the review's store reads through).
extension WorkHost: WeekHost {
    // `hostId` is WorkHost's own (WorkHost.swift, Capture's), which this seam reads too.

    public func reviewWeek(from: Int, to: Int, tz: String) async throws -> ReviewBody {
        try await socket.request(Methods.WorkReviewWeek.self, .init(from: from, to: to, tz: tz))
    }

    public func reviewWeeks() async throws -> ReviewKeptList {
        try await socket.request(Methods.WorkReviewList.self, .init())
    }

    public func settle(_ ref: ReviewBody.Slipped.Row.Ref, how: WeekReview.SettleHow, tz: String, sector: String?) async throws -> ReviewSettled {
        try await socket.request(Methods.WorkReviewSettle.self, .init(row: try Self.recode(ref), how: .init(rawValue: how.rawValue), tz: tz, sector: sector))
    }

    public func undoSettle(token: String) async throws {
        _ = try await socket.request(Methods.WorkReviewUndo.self, .init(token: token))
    }

    public func reviewSeen(from: Int) async throws {
        _ = try await socket.request(Methods.WorkReviewSeen.self, .init(from: from))
    }

    public func moneySums(from: String, to: String) async throws -> MoneySums {
        try await socket.request(Methods.WorkMoneySums.self, .init(from: from, to: to))
    }

    // MARK: - a job's Money

    public func moneyRead(workspaceId: String, from: String, to: String) async throws -> MoneyReadPhone {
        try await socket.request(Methods.WorkMoneyRead.self, .init(workspaceId: workspaceId, from: from, to: to))
    }

    /// His accept of a waiting receipt with the fields he confirmed: the row is written and the receipt filed.
    public func moneyAccept(id: String, fields: MoneyAcceptFields) async throws -> MoneyActed {
        try await socket.request(Methods.WorkMoneyAccept.self, .init(id: id, fields: fields))
    }

    /// A waiting receipt dropped, or with `undo` put back as it was. `false`: an accept filed it first.
    public func moneyDrop(id: String, undo: Bool = false) async throws -> Bool {
        try await socket.request(Methods.WorkMoneyDrop.self, .init(id: id, undo: undo ? true : nil)).dropped
    }

    /// One part of a waiting receipt's picture.
    public func moneyPicture(id: String, part: Int) async throws -> MoneyPicture {
        try await socket.request(Methods.WorkMoneyPicture.self, .init(id: id, part: part))
    }

    /// An open row paid (or paid back) today, named as the phone last read it.
    public func moneyPaid(workspaceId: String, row: MoneyReadPhone.Owed) async throws -> MoneyActed {
        let at = Methods.WorkMoneyPaid.Params.At(ref: row.ref.map { .set($0) } ?? .clear, row: row.row, sig: row.sig)
        return try await socket.request(Methods.WorkMoneyPaid.self, .init(workspaceId: workspaceId, at: at))
    }

    /// The slipped row's ref as the settle method's own type: one JSON shape, two generated names.
    static func recode(_ ref: ReviewBody.Slipped.Row.Ref) throws -> Methods.WorkReviewSettle.Params.Row {
        try JSONDecoder().decode(Methods.WorkReviewSettle.Params.Row.self, from: JSONEncoder().encode(ref))
    }
}
