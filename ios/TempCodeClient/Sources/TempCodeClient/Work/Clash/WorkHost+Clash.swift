import Foundation
import TempCodeContract

/// A clash through the host that reads every job (docs/agents/work-clashes.md "The phone"): the drive between its
/// events (read), This Is Fine (operate: it tells no one), and his answer to one event, a decline or a proposed
/// time (approve, his press alone: it goes to other people), written to the press ledger before it leaves.
extension WorkHost {
    public func miles(workspaceId: String, from: String, to: String) async throws -> ClashMiles? {
        try await socket.request(Methods.WorkClashesMiles.self, .init(workspaceId: workspaceId, from: .object(.init(event: from)), to: .object(.init(event: to))))
    }

    /// On, the clash goes quiet until either event changes; off takes that back.
    public func waive(_ clash: ClashPhoneRow, on: Bool) async throws {
        _ = try await socket.request(Methods.WorkClashesWaive.self, .init(id: clash.id, on: on, seen: ClashRules.seen(clash)))
    }

    /// His answer, through the ledger: a lost reply throws `PressLedger.Unknown` and is read back by the clash list
    /// on the next link. Answers whether LifeOS's sender queued it.
    public func answer(_ clash: ClashPhoneRow, eventId: String, way: ClashRules.Way, comment: String?, start: Double?, end: Double?, key: String? = nil) async throws -> Bool {
        let params = Methods.WorkClashesAnswer.Params(
            eventId: eventId,
            way: way.wire,
            comment: comment.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 },
            start: start.map { Int($0) },
            end: end.map { Int($0) },
            seen: start == nil ? nil : ClashRules.answerSeen(clash)
        )
        return try await presses.run(.clashAnswer, host: environment.id, hostName: environment.name, ref: ClashPress.ref(clash.id), rev: ClashPress.rev(clash), linked: linked, key: key) { [socket] in
            try await socket.request(Methods.WorkClashesAnswer.self, params).queued
        }
    }

    /// Each answer of his on this host whose reply was lost, read back by the clash list over its span.
    func checkClashPresses() async {
        _ = await presses.check(host: environment.id, where: { $0 == .clashAnswer }) { [socket] press in
            guard let id = ClashPress.clashId(ofRef: press.ref), let span = ClashPress.span(ofRev: press.rev) else { return .mayHaveGone }
            let list = try await socket.request(Methods.WorkClashesList.self, .init(from: span.from, to: span.to))
            return PressTruth.clash(listed: list.clashes.contains { $0.id == id })
        }
    }
}
