import Foundation
import Synchronization
import TempCodeContract

/// What the phone keeps of Work on its disk, as values (the SQLite half writes these through `CacheWriter`; plan
/// TE_fWkYrofJc §5 "The cache"): display rows only, so the app opens on yesterday's rows. A cached row opens a read
/// view; a press needs the item read fresh on this link.
///
/// Kept: Today's rows with no verbs, the Outbox's waiting rows as the act's words, its target and its time, the
/// Digest's newest days with the rows each drew (`digest`, Work/Digest/DigestKept.swift), and each Files folder's last page of names. Never a held body, an attachment, a guest secret or a
/// ticket: the waiting row is made from the item's summary and kind alone, never its payload's contents.
public enum WorkCache {
    /// What a set of kept rows is for.
    public enum Scope: Hashable, Sendable, Codable {
        case today
        case outbox
        case digest
        /// One Files folder, by its id on its host.
        case folder(String)
    }

    /// Whose rows these are: the host, the account its key reads as, the key's generation, the workspace (nil for
    /// rows of every job) and the scope.
    public struct Key: Hashable, Sendable, Codable {
        public var host: String
        public var account: String
        public var keyGeneration: Int
        public var workspaceId: String?
        public var scope: Scope

        public init(host: String, account: String, keyGeneration: Int, workspaceId: String? = nil, scope: Scope) {
            self.host = host
            self.account = account
            self.keyGeneration = keyGeneration
            self.workspaceId = workspaceId
            self.scope = scope
        }
    }

    /// One Outbox row that waits: what he would decide, where it is, when it was held, and the item it opens.
    public struct WaitingRow: Hashable, Sendable, Codable, Identifiable {
        public var environmentId: String
        /// `OutboxModel.key` of the item's ref: the target a press reads fresh.
        public var ref: String
        public var kind: String
        public var act: String
        public var about: String?
        public var place: String?
        public var at: Int
        public var id: String { "\(environmentId):\(ref)" }
    }

    /// One Files folder's last page: its names, and each row as the list draws it (`rows`, absent in a page kept
    /// before rows were): the name, the kind's glyph, the stamp's time, and a folder's ref so it still opens.
    /// Never a file's ref or bytes: a kept file row opens nothing until its folder is read fresh.
    public struct FolderPage: Hashable, Sendable, Codable {
        public var folder: String
        public var names: [String]
        public var rows: [FolderRow]?
        public init(folder: String, names: [String], rows: [FolderRow]? = nil) {
            self.folder = folder
            self.names = names
            self.rows = rows
        }
    }

    /// One kept row of a folder.
    public struct FolderRow: Hashable, Sendable, Codable {
        public var key: String
        public var name: String
        public var kind: String
        public var folder: FolderRef?
        public var changed: Double?
        public init(key: String, name: String, kind: String, folder: FolderRef? = nil, changed: Double? = nil) {
            self.key = key
            self.name = name
            self.kind = kind
            self.folder = folder
            self.changed = changed
        }
    }

    /// Today's rows as kept: their words, marks and targets, with no verbs (a press needs the row read fresh) and no
    /// live line ("Now", "in 25 min", "Leave 5:10 PM"), which is true only of the minute it was said.
    public static func today(_ rows: [TodayRow]) -> [TodayRow] {
        rows.map { row in
            var kept = row
            kept.acts = []
            kept.whenLine = nil
            return kept
        }
    }

    /// The sections LifeOS's session fills.
    static let lifeosSections: Set<String> = ["meetings", "due", "waiting"]

    /// A host's LifeOS signed out: its session's rows go, and LifeOS rows kept before a supplier was known (whose
    /// supplier cannot be told); every other row stays.
    public static func withoutLifeos(_ rows: [TodayRow], suppliedBy host: String) -> [TodayRow] {
        rows.filter { row in !lifeosSections.contains(row.section) || (row.suppliedBy != nil && row.suppliedBy != host) }
    }

    /// The sections whose rows are of one day: a meeting, a task due, and Also's tells and review are not shown on a
    /// later day from the disk; what waits (held, mail, chat, money, responses) is.
    static let ofTheDay: Set<String> = ["meetings", "due", "also"]

    /// The kept rows a launch on `today` paints: those of another day's sections are left out when they were kept on
    /// another local day, or on a day not known (a row kept before the day was).
    public static func todayShown(_ rows: [TodayRow], keptOn: String?, today: String) -> [TodayRow] {
        keptOn == today ? rows : rows.filter { !ofTheDay.contains($0.section) }
    }

    /// The host a Today row came from, so a host's rows go with it: the host its press opens on (a held item's, a
    /// request's, a teller's, a job's place), else its workspace's; nil for a row of none (the review's).
    public static func hostOf(_ row: TodayRow) -> String? {
        switch row.open {
        case .held(let environmentId, _)?, .request(let environmentId, _)?, .tell(let environmentId, _)?: environmentId
        case .event(let place, _)?, .task(let place, _, _)?, .mail(let place, _)?, .chat(let place, _)?, .money(let place)?, .form(let place, _, _)?, .prep(let place, _)?:
            place.environmentId
        case .review?, nil: row.workspace?.environmentId
        }
    }

    /// Today's rows by the host each came from (`hostOf`); the rest (the review's) under the page's LifeOS host.
    public static func todayByHost(_ rows: [TodayRow], lifeosHost: String) -> [String: [TodayRow]] {
        Dictionary(grouping: today(rows)) { hostOf($0) ?? lifeosHost }
    }

    /// The Outbox's waiting rows as kept: the act's words from its summary, its place and its time. The payload is
    /// read for nothing: a mail's body, an attachment, a guest link's secret and a ticket stay on the host.
    public static func waiting(_ items: [TodaySources.HeldItem], names: [TodayPlace: String]) -> [WaitingRow] {
        items.filter { TodaySources.needsHim($0.item) }.map { held in
            let (act, about) = OutboxModel.splitSummary(held.item.summary)
            return WaitingRow(environmentId: held.environmentId, ref: OutboxModel.key(held.item.ref), kind: held.item.kind.rawValue, act: act, about: about,
                              place: TodaySources.placeOf(held, names: names), at: held.item.createdAt)
        }
    }

}

/// The one gate every disk write of Work's kept rows passes (`WorkCacheStore.put`), shared by Today's, the Outbox's,
/// the Digest's and the folders' writers, which each queue on their own. A host whose key was refused is closed:
/// nothing of it is written until a link to it truly opens. Each close moves the host's epoch, and a write carries
/// the epoch it was queued at (`stamp`), so a write queued before a purge is refused even after the host opens again.
public enum WorkCacheFence {
    private static let hosts = Mutex<[String: (epoch: Int, closed: Bool)]>([:])

    /// The host's epoch now: taken when a write is queued.
    public static func stamp(_ host: String) -> Int {
        hosts.withLock { $0[host]?.epoch ?? 0 }
    }

    /// The host refused the key: its writes stop, and every write queued before now is refused.
    public static func close(_ host: String) {
        hosts.withLock { all in
            let was = all[host]?.epoch ?? 0
            all[host] = (was + 1, true)
        }
    }

    /// Something of the host went with its key standing (Work off, a key paired again): every write queued before
    /// now is refused; writes queued from now on pass.
    public static func purge(_ host: String) {
        hosts.withLock { all in
            let was = all[host]
            all[host] = ((was?.epoch ?? 0) + 1, was?.closed ?? false)
        }
    }

    /// A link to the host opened: writes queued from now on pass.
    public static func open(_ host: String) {
        hosts.withLock { all in
            if let was = all[host] { all[host] = (was.epoch, false) }
        }
    }

    /// Whether a write of `host`, queued at `stamp` (nil: not stamped), may reach the disk.
    public static func admits(_ host: String, stamp: Int?) -> Bool {
        hosts.withLock { all in
            guard let state = all[host] else { return stamp == nil || stamp == 0 }
            return !state.closed && (stamp == nil || stamp == state.epoch)
        }
    }
}

/// What changed, and so which kept rows go.
public enum WorkCacheDrop: Hashable, Sendable, Codable {
    /// The host's key was replaced: every row read under an older generation goes.
    case keyReplaced(host: String, generation: Int)
    /// The key lost a capability on the host: everything of that host goes.
    case capabilityLost(host: String)
    /// He signed the account out: its rows go on every host.
    case signedOut(account: String)
    /// Work was turned off on the host.
    case workOff(host: String)
    /// The host was removed from the phone.
    case hostRemoved(host: String)
    /// The host's LifeOS signed out: the Today rows its session read go out of every host's kept rows, and rows kept
    /// with no known supplier with them (`WorkCache.withoutLifeos`); a row, not a key: no key is dropped whole.
    case lifeosSignedOut(host: String)

    /// The host it names; nil for a sign-out, which names an account.
    public var host: String? {
        switch self {
        case .keyReplaced(let host, _), .capabilityLost(let host), .workOff(let host), .hostRemoved(let host), .lifeosSignedOut(let host): host
        case .signedOut: nil
        }
    }

    /// The host whose LifeOS session's rows go from every host's Today rows, wherever they were kept (a row is kept
    /// under the host its press opens on, not the one whose session read it): its LifeOS signed out, its key refused,
    /// it was removed, its Work went off, or its key was really replaced (a key of another generation was kept). The
    /// rows its session read are facts that key may no longer see.
    public var supplier: String? {
        switch self {
        case .keyReplaced(let host, _), .capabilityLost(let host), .workOff(let host), .hostRemoved(let host), .lifeosSignedOut(let host): host
        case .signedOut: nil
        }
    }

    /// The keys to drop of those kept.
    public func drops(_ keys: some Sequence<WorkCache.Key>) -> Set<WorkCache.Key> {
        Set(keys.filter { key in
            switch self {
            case .keyReplaced(let host, let generation): key.host == host && key.keyGeneration != generation
            case .capabilityLost(let host), .workOff(let host), .hostRemoved(let host): key.host == host
            case .signedOut(let account): key.account == account
            case .lifeosSignedOut: false
            }
        })
    }
}

/// Purges made while the cache's file would not open (a launch while the phone was locked: the caches ran in memory),
/// kept in the app's defaults and run on the file the next time it opens, before any write, so a refused key, Work
/// off or a removed host never leaves its rows for a later launch to paint.
public struct WorkCachePurges: Sendable {
    public static let key = "work.cache.pendingPurges"
    private let defaults: @Sendable () -> UserDefaults

    public init(defaults: @escaping @Sendable () -> UserDefaults = { .standard }) {
        self.defaults = defaults
    }

    public func add(_ reason: WorkCacheDrop) {
        var all = list()
        guard !all.contains(reason) else { return }
        all.append(reason)
        if let data = try? JSONEncoder().encode(all) { defaults().set(data, forKey: Self.key) }
    }

    public func list() -> [WorkCacheDrop] {
        defaults().data(forKey: Self.key).flatMap { try? JSONDecoder().decode([WorkCacheDrop].self, from: $0) } ?? []
    }

    /// The kept purges, in the order they were made, and none kept after.
    public func take() -> [WorkCacheDrop] {
        let all = list()
        defaults().removeObject(forKey: Self.key)
        return all
    }
}
