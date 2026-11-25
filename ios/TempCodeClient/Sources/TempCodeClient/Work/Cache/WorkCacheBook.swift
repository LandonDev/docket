import Foundation
import TempCodeContract

/// One kept value: only what `WorkCache` allows, each made through its rule, so nothing else can be written.
public enum WorkCacheValue: Hashable, Sendable, Codable {
    /// Today's rows, with no verbs (`WorkCache.today`), kept before the day was.
    case today([TodayRow])
    /// Today's rows, with no verbs, and the local day ("2026-11-24") they were kept on.
    case todayOn(day: String, rows: [TodayRow])
    /// The Outbox's waiting rows, from the summary alone (`WorkCache.waiting`).
    case outbox([WorkCache.WaitingRow])
    /// The Digest's days, from before a day kept its rows (read as none).
    case digest([DigestDay])
    /// The Digest's newest days and the rows each drew, display data alone (`WorkCache.digest`).
    case digestDays(days: [DigestDay], rows: [TellRow])
    /// A Files folder's last page of names.
    case folder(WorkCache.FolderPage)

    /// Today's rows as kept: their verbs and live lines dropped, the day they were kept on beside them.
    public static func todayRows(_ rows: [TodayRow], day: String) -> WorkCacheValue { .todayOn(day: day, rows: WorkCache.today(rows)) }

    /// The Today rows a launch on `today` paints from this value (`WorkCache.todayShown`); none of another scope.
    public func todayShown(on today: String) -> [TodayRow] {
        switch self {
        case .today(let rows): WorkCache.todayShown(rows, keptOn: nil, today: today)
        case .todayOn(let day, let rows): WorkCache.todayShown(rows, keptOn: day, today: today)
        default: []
        }
    }

    /// The scope a value is kept under.
    public var scope: WorkCache.Scope {
        switch self {
        case .today, .todayOn: .today
        case .outbox: .outbox
        case .digest, .digestDays: .digest
        case .folder(let page): .folder(page.folder)
        }
    }
}

extension WorkCache.Scope {
    /// The scope as the store's column holds it.
    public var text: String {
        switch self {
        case .today: "today"
        case .outbox: "outbox"
        case .digest: "digest"
        case .folder(let id): "folder:\(id)"
        }
    }

    public init?(text: String) {
        switch text {
        case "today": self = .today
        case "outbox": self = .outbox
        case "digest": self = .digest
        default:
            guard text.hasPrefix("folder:") else { return nil }
            self = .folder(String(text.dropFirst("folder:".count)))
        }
    }
}

/// The rules of the kept rows with no disk: a write replaces what the same key held and drops the host's rows of
/// any other key generation (a replaced key); a drop takes every key `WorkCacheDrop` names; a read answers only the
/// key asked for, never another generation's or account's rows. `WorkCacheStore` keeps the same rules in SQLite;
/// this is the seam the rules are tested on, and Today's store reads through it in tests.
public struct WorkCacheBook: Sendable, Hashable {
    public private(set) var values: [WorkCache.Key: WorkCacheValue] = [:]

    public init() {}

    /// Writes `value` at `key`; answers the keys it dropped.
    @discardableResult
    public mutating func put(_ value: WorkCacheValue, at key: WorkCache.Key) -> Set<WorkCache.Key> {
        precondition(value.scope == key.scope, "a value is kept under its own scope")
        let dropped = WorkCacheDrop.keyReplaced(host: key.host, generation: key.keyGeneration).drops(values.keys)
        for gone in dropped { values[gone] = nil }
        values[key] = value
        return dropped
    }

    public func get(_ key: WorkCache.Key) -> WorkCacheValue? { values[key] }

    /// Every kept key of one host.
    public func keys(host: String) -> [WorkCache.Key] { values.keys.filter { $0.host == host } }

    /// Drops what `reason` names; answers the keys it dropped.
    @discardableResult
    public mutating func drop(_ reason: WorkCacheDrop) -> Set<WorkCache.Key> {
        if case .lifeosSignedOut(let host) = reason {
            for (key, value) in values where key.scope == .today {
                switch value {
                case .todayOn(let day, let rows): values[key] = .todayOn(day: day, rows: WorkCache.withoutLifeos(rows, suppliedBy: host))
                case .today(let rows): values[key] = .today(WorkCache.withoutLifeos(rows, suppliedBy: host))
                default: break
                }
            }
            return []
        }
        let dropped = reason.drops(values.keys)
        for gone in dropped { values[gone] = nil }
        return dropped
    }

    /// Today's kept rows of these hosts, each read under the key it has now: the first frame's rows, as a launch on
    /// `day` paints them.
    public func today(_ keys: [WorkCache.Key], day: String) -> [TodayRow] {
        keys.flatMap { values[$0]?.todayShown(on: day) ?? [] }
    }
}

/// What Today's store keeps its rows through: the SQLite store on the phone, a book in tests.
@MainActor
public protocol TodayRowsCache: AnyObject {
    /// Today's rows under each key, read at once (the first frame waits on nothing else), as a launch on `day` (the
    /// local day, "2026-11-24") paints them.
    func todayRows(_ keys: [WorkCache.Key], day: String) -> [TodayRow]
    /// Writes each host's rows at its key with the day they were kept on, in order, off the main actor.
    func keepToday(_ rows: [WorkCache.Key: [TodayRow]], day: String)
    func drop(_ reason: WorkCacheDrop)
}

/// A cache held in memory: tests, and a phone whose store could not open.
@MainActor
public final class TodayBookCache: TodayRowsCache {
    public private(set) var book = WorkCacheBook()
    /// Writes made, for a test that counts them.
    public private(set) var writes = 0

    public init(book: WorkCacheBook = WorkCacheBook()) {
        self.book = book
    }

    public func todayRows(_ keys: [WorkCache.Key], day: String) -> [TodayRow] { book.today(keys, day: day) }

    public func keepToday(_ rows: [WorkCache.Key: [TodayRow]], day: String) {
        for (key, list) in rows {
            book.put(.todayRows(list, day: day), at: key)
            writes += 1
        }
    }

    public func drop(_ reason: WorkCacheDrop) { book.drop(reason) }
}
