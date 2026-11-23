#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation

/// A folder inside a Work workspace's own folder, as Save to TempCode names it: the workspace's top
/// (`{at: 'place', id: 'folder'}`) or a folder under it (`{at: 'file', host, path}`, as the host listed it).
/// Nothing else can be said here, so a Teams or OneDrive library is never a place to save into.
public struct ShareFolder: Codable, Hashable, Sendable {
    /// The folder's name, as the sheet's row says it.
    public let name: String
    /// The host's own name for the folder's machine and its path there; both nil for the workspace's top.
    public let host: String?
    public let path: String?

    /// The workspace's own folder, named as the workspace names it.
    public static func top(name: String) -> ShareFolder {
        ShareFolder(name: name, host: nil, path: nil)
    }

    public init(name: String, host: String?, path: String?) {
        self.name = name
        if let host, let path {
            self.host = host
            self.path = path
        } else {
            self.host = nil
            self.path = nil
        }
    }

    public var isTop: Bool { path == nil }
}

/// Where one share goes: a host, a Work workspace on it, a folder of that workspace.
public struct ShareDestination: Codable, Hashable, Sendable {
    public let hostId: String
    public let workspaceId: String
    public let folder: ShareFolder

    public init(hostId: String, workspaceId: String, folder: ShareFolder) {
        self.hostId = hostId
        self.workspaceId = workspaceId
        self.folder = folder
    }
}

/// One file he shared in, waiting for or past its upload.
public struct ShareItem: Codable, Identifiable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        /// Waiting for its host: the next drain sends it.
        case queued
        /// One process holds it and is sending it now.
        case sending
        /// The host said no; `words` are its words. Waits for Try Again or Discard.
        case refused
        /// The host has it. Its bytes are gone from the phone; the next sweep drops the rest.
        case done
    }

    public let id: String
    public let hostId: String
    public let workspaceId: String
    public let folder: ShareFolder
    public let name: String
    public let size: Int
    /// Lowercase hex, taken while the file was copied in.
    public let sha256: String
    public var state: State
    public var words: String?
    /// Wall-clock milliseconds of the share.
    public let createdAt: Double

    public init(id: String, hostId: String, workspaceId: String, folder: ShareFolder, name: String, size: Int, sha256: String, state: State, words: String? = nil, createdAt: Double) {
        self.id = id
        self.hostId = hostId
        self.workspaceId = workspaceId
        self.folder = folder
        self.name = name
        self.size = size
        self.sha256 = sha256
        self.state = state
        self.words = words
        self.createdAt = createdAt
    }

    public var destination: ShareDestination {
        ShareDestination(hostId: hostId, workspaceId: workspaceId, folder: folder)
    }
}

/// The share queue in the app group: a folder per item under `root/items`, its bytes in `payload` and what
/// it is in `manifest.json`, written last. A copy cut short leaves a folder with no manifest, which no list
/// shows and `sweep()` removes. The extension and the app both use it; a process takes an item to send by
/// renaming its manifest to `manifest.claimed.json`, which only one of them can do. Capture and Money may
/// queue a file with `add(_:to:)` too. It holds only what he shared in.
public final class ShareInbox: Sendable {
    /// A claim not touched for this long belongs to a process that died: the host drops an upload idle as long.
    public static let claimLease: TimeInterval = 10 * 60
    /// A folder still being copied into is left alone this long before a sweep takes it for a crash.
    public static let halfGrace: TimeInterval = 10 * 60
    static let copyBytes = 1024 * 1024

    public let root: URL
    private let now: @Sendable () -> Date

    /// `root`: the app group's container on the phone, a temp folder in tests.
    public init(root: URL, now: @escaping @Sendable () -> Date = { Date() }) {
        self.root = root
        self.now = now
    }

    private var itemsDir: URL { root.appendingPathComponent("items", isDirectory: true) }
    private func dir(_ id: String) -> URL { itemsDir.appendingPathComponent(id, isDirectory: true) }
    private func manifest(_ id: String) -> URL { dir(id).appendingPathComponent("manifest.json") }
    private func claimed(_ id: String) -> URL { dir(id).appendingPathComponent("manifest.claimed.json") }

    /// Where the item's bytes are.
    public func payload(_ item: ShareItem) -> URL {
        dir(item.id).appendingPathComponent("payload")
    }

    /// Copies `file` into the queue a megabyte at a time, taking its SHA-256 as it goes, and queues it for
    /// `destination`. `name` is what the host will call it (the file's own name when nil or blank). The
    /// caller holds any access the file needs while this runs.
    public func add(_ file: URL, to destination: ShareDestination, name: String? = nil) throws -> ShareItem {
        let id = UUID().uuidString.lowercased()
        let folder = dir(id)
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            let target = folder.appendingPathComponent("payload")
            guard fm.createFile(atPath: target.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            let output = try FileHandle(forWritingTo: target)
            defer { try? output.close() }
            var hash = SHA256()
            var size = 0
            while let chunk = try input.read(upToCount: Self.copyBytes), !chunk.isEmpty {
                hash.update(data: chunk)
                try output.write(contentsOf: chunk)
                size += chunk.count
            }
            try output.synchronize()
            let given = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let item = ShareItem(
                id: id,
                hostId: destination.hostId,
                workspaceId: destination.workspaceId,
                folder: destination.folder,
                name: given.isEmpty ? file.lastPathComponent : given,
                size: size,
                sha256: hash.finalize().map { String(format: "%02x", $0) }.joined(),
                state: .queued,
                createdAt: (now().timeIntervalSince1970 * 1000).rounded()
            )
            try write(item, to: manifest(id))
            return item
        } catch {
            try? fm.removeItem(at: folder)
            throw error
        }
    }

    /// Every whole item, oldest first. A claim whose process died reads as queued.
    public func items() -> [ShareItem] {
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: itemsDir.path)) ?? []
        return ids.compactMap(self.item).sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// One item as it is now; nil when it is gone or was never whole.
    public func item(_ id: String) -> ShareItem? {
        if let item = read(manifest(id)) { return item }
        guard var item = read(claimed(id)) else { return nil }
        if isStale(claimed(id)) { item.state = .queued }
        return item
    }

    /// Takes the item for this process to send: nil when another process holds it or it is gone. A claim
    /// left by a process that died is taken back first. The item comes back `sending`.
    public func claim(_ id: String) -> ShareItem? {
        if isStale(claimed(id)) { try? move(claimed(id), to: manifest(id)) }
        do {
            try move(manifest(id), to: claimed(id))
        } catch {
            return nil
        }
        guard var item = read(claimed(id)) else { return nil }
        item.state = .sending
        item.words = nil
        try? write(item, to: claimed(id))
        return item
    }

    /// Keeps this process's claim alive through a long upload.
    public func touch(_ id: String) {
        try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: claimed(id).path)
    }

    /// Sets an item's state and the host's words. Any state but `sending` lets go of a claim; `done`
    /// removes the bytes.
    public func mark(_ id: String, _ state: ShareItem.State, words: String? = nil) throws {
        let held = FileManager.default.fileExists(atPath: claimed(id).path)
        let at = held ? claimed(id) : manifest(id)
        guard var item = read(at) else { throw CocoaError(.fileNoSuchFile) }
        item.state = state
        item.words = words
        try write(item, to: at)
        if held && state != .sending { try move(at, to: manifest(id)) }
        if state == .done { try? FileManager.default.removeItem(at: payload(item)) }
    }

    /// Drops the item and its bytes.
    public func discard(_ id: String) {
        try? FileManager.default.removeItem(at: dir(id))
    }

    /// Removes what a crash left half copied and every item the host already has.
    public func sweep() {
        let fm = FileManager.default
        for id in (try? fm.contentsOfDirectory(atPath: itemsDir.path)) ?? [] {
            if let found = self.item(id) {
                if found.state == .done { discard(id) }
            } else if age(of: dir(id), now: now()) > Self.halfGrace {
                discard(id)
            }
        }
    }

    // MARK: - files

    private func read(_ url: URL) -> ShareItem? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ShareItem.self, from: data)
    }

    private func write(_ item: ShareItem, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(item).write(to: url, options: .atomic)
    }

    /// rename(2): fails when `from` is gone, so of two processes renaming the same manifest one wins.
    private func move(_ from: URL, to: URL) throws {
        guard rename(from.path, to.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    private func isStale(_ url: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        return age(of: url, now: now()) > Self.claimLease
    }

    /// Seconds since anything in `url` last changed (a folder: its newest file).
    private func age(of url: URL, now: Date) -> TimeInterval {
        let fm = FileManager.default
        var newest = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? .distantPast
        for name in (try? fm.contentsOfDirectory(atPath: url.path)) ?? [] {
            let date = try? fm.attributesOfItem(atPath: url.appendingPathComponent(name).path)[.modificationDate] as? Date
            if let date, date > newest { newest = date }
        }
        return now.timeIntervalSince(newest)
    }
}
