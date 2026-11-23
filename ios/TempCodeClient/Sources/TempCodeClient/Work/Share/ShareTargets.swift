import Foundation

/// What the app writes into the app group for Save to TempCode, so the sheet is whole in its first frame:
/// each paired host the phone may operate on and its Work workspaces, with the folder last saved into and
/// when. Only Work workspaces go in; a folder is a `ShareFolder`, so never a Teams or OneDrive library.
public struct ShareTargets: Codable, Equatable, Sendable {
    public struct Host: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        /// As the phone labels the host ("The box").
        public var name: String
        /// The pairing, so the extension can open the host's socket (its key is `ShareKeys`'s copy).
        public var environment: PairedEnvironment
        public var workspaces: [Workspace]

        public init(id: String, name: String, environment: PairedEnvironment, workspaces: [Workspace]) {
            self.id = id
            self.name = name
            self.environment = environment
            self.workspaces = workspaces
        }
    }

    public struct Workspace: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public var name: String
        /// The sector's key, for the row's dot; nil for Unsorted.
        public var sector: String?
        /// The workspace's own folder as the Folder row first says it.
        public var folderName: String
        /// The folder last saved into here; nil until the first save.
        public var lastFolder: ShareFolder?
        /// Wall-clock milliseconds of the last save here.
        public var lastUsedAt: Double?

        public init(id: String, name: String, sector: String? = nil, folderName: String, lastFolder: ShareFolder? = nil, lastUsedAt: Double? = nil) {
            self.id = id
            self.name = name
            self.sector = sector
            self.folderName = folderName
            self.lastFolder = lastFolder
            self.lastUsedAt = lastUsedAt
        }

        /// Where a save goes first: the last folder used, else the workspace's top.
        public var folder: ShareFolder { lastFolder ?? .top(name: folderName) }
    }

    /// One row of the sheet's Workspace group.
    public struct Target: Equatable, Sendable, Identifiable {
        public let host: Host
        public let workspace: Workspace

        public var id: String { "\(host.id)/\(workspace.id)" }

        public func destination(_ folder: ShareFolder? = nil) -> ShareDestination {
            ShareDestination(hostId: host.id, workspaceId: workspace.id, folder: folder ?? workspace.folder)
        }
    }

    public static let fileName = "share-targets.json"

    public var hosts: [Host]

    public init(hosts: [Host] = []) {
        self.hosts = hosts
    }

    /// What the app last wrote; empty when it never wrote or the file does not read.
    public static func read(root: URL) -> ShareTargets {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(fileName)) else { return ShareTargets() }
        return (try? JSONDecoder().decode(ShareTargets.self, from: data)) ?? ShareTargets()
    }

    public func write(root: URL) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(self).write(to: root.appendingPathComponent(Self.fileName), options: .atomic)
    }

    /// Every workspace of every host, the last used first; those never used after, by name.
    public var ordered: [Target] {
        hosts.flatMap { host in host.workspaces.map { Target(host: host, workspace: $0) } }.sorted { a, b in
            switch (a.workspace.lastUsedAt, b.workspace.lastUsedAt) {
            case let (x?, y?) where x != y: return x > y
            case (.some, nil): return true
            case (nil, .some): return false
            default:
                let byName = a.workspace.name.localizedCaseInsensitiveCompare(b.workspace.name)
                if byName != .orderedSame { return byName == .orderedAscending }
                return a.id < b.id
            }
        }
    }

    /// A save went to `folder` of the workspace at `at` (wall-clock milliseconds).
    public mutating func used(hostId: String, workspaceId: String, folder: ShareFolder, at: Double) {
        guard let h = hosts.firstIndex(where: { $0.id == hostId }),
              let w = hosts[h].workspaces.firstIndex(where: { $0.id == workspaceId })
        else { return }
        hosts[h].workspaces[w].lastFolder = folder
        hosts[h].workspaces[w].lastUsedAt = at
    }

    /// The app's fresh list with each workspace's last folder and last use kept from what was written
    /// before (the extension records a save there).
    public func keepingUse(from earlier: ShareTargets) -> ShareTargets {
        var out = self
        for h in out.hosts.indices {
            guard let was = earlier.hosts.first(where: { $0.id == out.hosts[h].id }) else { continue }
            for w in out.hosts[h].workspaces.indices {
                guard let old = was.workspaces.first(where: { $0.id == out.hosts[h].workspaces[w].id }) else { continue }
                out.hosts[h].workspaces[w].lastFolder = out.hosts[h].workspaces[w].lastFolder ?? old.lastFolder
                out.hosts[h].workspaces[w].lastUsedAt = out.hosts[h].workspaces[w].lastUsedAt ?? old.lastUsedAt
            }
        }
        return out
    }
}
