import Foundation
import TempCodeContract

/// Today's reads of one host, through the thin calls M1's wire added (`WorkHost`, "Today"). Each answer is the
/// wire's JSON read as the port's plain input, which decodes the same JSON the desktop reads.
extension WorkHost: TodayHostReads {
    public func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat] {
        try TodayRecode.as([TodaySources.Chat].self, try await unansweredMessages(workspaceId))
    }

    public func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed {
        try TodayRecode.as(TodaySources.Owed.self, try await moneyOwed(workspaceId: workspaceId))
    }

    /// None yet: the phone's Forms row (`MsFormPhoneRow`) carries no count of unseen answers, so Responses has
    /// nothing to say until the wire adds `unseen` and `lastAnswerAt`; no request is made for it.
    public func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form] { [] }

    public func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting] {
        try TodayRecode.as([TodaySources.PrepMeeting].self, try await upcomingPrep(from: from, to: to))
    }

    public func todayReview() async throws -> TodaySources.ReviewReady? {
        try TodayRecode.as(TodaySources.ReviewReady?.self, try await reviewReady())
    }

    public func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange {
        try TodayRecode.as(TodaySources.ClashRange.self, try await clashes(from: Int(from), to: Int(to)))
    }

    public func todayDigest() async {
        guard digest.ledger == nil else { return }
        await digest.load()
    }

    public func todayRelist() async {
        async let outbox: Void = refreshOutbox()
        async let ledger: Void = digest.load()
        _ = await (outbox, ledger)
    }
}
