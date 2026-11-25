import Foundation
import TempCodeClient
import TempCodeContract

/// The Outbox's kept rows on this phone (`OutboxKept` over the SQLite file Today's rows share): written on each
/// answer of a host's list, read on a cold launch so the list and its count paint before any socket answers. A
/// kept row opens a read view only; nothing about it can be pressed.
@MainActor
enum OutboxKeeping {
    static let kept = OutboxKept(cache: OutboxDiskCache.opened())

    /// The rows kept for a host whose list has not answered on this link, while Work is on there and its key
    /// stands; none once the list has answered (the list is the truth then).
    static func rows(_ client: EnvironmentClient) -> [WorkCache.WaitingRow] {
        let work = client.work
        guard work.isOn, !work.listed, !work.keyRevoked else { return [] }
        return kept.rows(WorkCache.outboxKey(client.environment))
    }

    /// A host's list answered (or an item of it changed): its waiting rows as they stand now.
    static func keep(_ client: EnvironmentClient) {
        let work = client.work
        guard work.listed else { return }
        let held = work.items.map { TodaySources.HeldItem(environmentId: client.environment.id, item: $0) }
        var names: [TodayPlace: String] = [:]
        for workspaceId in Set(work.items.compactMap(\.workspaceId)) where workspaceId != OutboxModel.workChatsKey {
            names[TodayPlace(environmentId: client.environment.id, workspaceId: workspaceId)] = client.workPlace(workspaceId).name
        }
        kept.keep(WorkCache.waiting(held, names: names), at: WorkCache.outboxKey(client.environment))
    }
}
