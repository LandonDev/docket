import Foundation
import TempCodeContract

/// One computer being driven now, on one connected host (`ComputerTile` in src/renderer/src/lib/computers.ts): the
/// phone's Computers list draws one per live session.
public struct ComputerTile: Identifiable, Equatable, Sendable {
    /// the host and the thread, as one key
    public let id: String
    public let host: String
    public let threadId: String
    /// the thread's title, as the thread list says it
    public let title: String
    /// what it is doing now, in the step's own words; nil between calls and while he drives
    public let doing: String?
    /// where it runs, said once: the Mac a box thread drives, else the thread's host
    public let place: String
    /// he drives this page himself
    public let driving: Bool
    /// when it acted last, epoch ms: the tiles run newest first
    public let lastCallAt: Int
}

public enum ComputerTiles {
    public static func tileId(_ host: String, _ threadId: String) -> String { "\(host)\n\(threadId)" }

    /// The host a bridge key names (`macComputerKey` in contract-maccomputer.ts: `env_…:thread`), or nil.
    static func bridgedFrom(_ threadId: String) -> String? {
        guard let colon = threadId.firstIndex(of: ":") else { return nil }
        let env = String(threadId[..<colon])
        let tail = threadId[threadId.index(after: colon)...]
        let idChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard env.hasPrefix("env_"), env.count == 26, env.dropFirst(4).unicodeScalars.allSatisfy(idChars.contains), !tail.isEmpty else { return nil }
        return env
    }

    /// The tiles, the one that acted last first (`computerTiles`). A session a box thread drives on a Mac is on both
    /// hosts' rows when the phone reaches both: the box's under the thread, the Mac's under the bridge's key. It is one
    /// tile, the box's: the Mac's row is dropped while the box it names is one of the phone's hosts.
    public static func tiles(
        byHost: [String: [ComputerSessionRow]],
        titleOf: (String, String) -> String?,
        nameOf: (String) -> String
    ) -> [ComputerTile] {
        var tiles: [ComputerTile] = []
        for (host, rows) in byHost {
            for row in rows {
                if let box = bridgedFrom(row.threadId), box != host, byHost[box] != nil { continue }
                let owner = row.driver == "owner"
                tiles.append(ComputerTile(
                    id: tileId(host, row.threadId),
                    host: host,
                    threadId: row.threadId,
                    title: titleOf(host, row.threadId) ?? row.apps.first?.window ?? row.apps.first?.name ?? "Untitled",
                    doing: owner ? nil : row.running?.words,
                    place: row.macName ?? nameOf(host),
                    driving: owner,
                    lastCallAt: row.lastCallAt
                ))
            }
        }
        return tiles.sorted { $0.lastCallAt != $1.lastCallAt ? $0.lastCallAt > $1.lastCallAt : $0.id < $1.id }
    }
}
