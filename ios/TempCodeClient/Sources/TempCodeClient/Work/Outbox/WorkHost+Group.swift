import Foundation
import TempCodeContract

extension WorkHost {
    /// His press on several of this host's items (Select, the summary's Send or Discard): one
    /// `work.outbox.decide {items, via: phone, many: true}`. `many`, so the host treats even a group's one item on
    /// this host as part of a press on many: it earns no offered grant and refuses what only its own page sends.
    /// Each item is written down before the call leaves (`PressLedger.runMany`), read back by its ref if the
    /// answer is lost. Answers each item's result in the order asked; what the host answered for an item is
    /// merged into the list.
    public func decide(_ items: [Methods.WorkOutboxDecide.Params.Item], discard: Bool, key: String? = nil) async throws -> [DecisionResult] {
        let records = items.map { (ref: OutboxModel.key($0.ref), rev: $0.rev.map(String.init)) }
        // Each item's result merged inside the press, and said per item, so an answer after the fifteen seconds keeps
        // what the host did with each (`DecisionResult.states`), never one word for all.
        let answer = try await presses.runMany(discard ? .outboxDiscard : .outboxSend, host: environment.id, hostName: environment.name, items: records, linked: linked, key: key, outcome: DecisionResult.states) { [socket, weak self] in
            let answer = try await socket.request(Methods.WorkOutboxDecide.self, .init(items: items, via: .phone, many: true))
            for result in answer.results ?? [] { if let item = result.item { self?.merge(item) } }
            return answer
        }
        return answer.results ?? []
    }
}
