import Foundation

/// The last renders the reader drew (PF1), in memory only: a file opened again in the same run paints in
/// one frame. Three at most, each named by its file and the `rev` of its bytes, so a render that moved on
/// is never shown for the one before; all dropped on a memory warning. Nothing of a file is written to
/// the phone's disk.
@MainActor
public final class ReaderCache {
    public static let cap = 3
    public static let shared = ReaderCache()
    /// The owner's ruling (the plan's "For the owner" 1): nothing of a file is kept on the phone. True would
    /// keep his own places' renders across launches, never a file others can open.
    public static let keepsOnDisk = false

    public struct Kept: Sendable {
        public var rev: String
        public var data: Data
        /// What the view needs beside the bytes to draw its first frame (a deck's slide list), as the view kept it.
        public var note: (any Sendable)?
    }

    private struct Entry {
        var key: String
        var kept: Kept
    }

    /// Oldest first.
    private var entries: [Entry] = []

    public init() {}

    public var count: Int { entries.count }

    /// The bytes kept for a file, only at the `rev` the host names now.
    public func data(_ key: String, rev: String) -> Data? {
        guard let index = entries.firstIndex(where: { $0.key == key && $0.kept.rev == rev }) else { return nil }
        let entry = entries.remove(at: index)
        entries.append(entry)
        return entry.kept.data
    }

    /// What was last kept for a file, whatever the host says now: the first frame of a second open. The view
    /// that paints it asks the host at once and swaps the bytes when the `rev` moved on.
    public func latest(_ key: String) -> Kept? {
        entries.last { $0.key == key }?.kept
    }

    public func keep(_ data: Data, for key: String, rev: String, note: (any Sendable)? = nil) {
        entries.removeAll { $0.key == key }
        entries.append(Entry(key: key, kept: Kept(rev: rev, data: data, note: note)))
        if entries.count > Self.cap { entries.removeFirst(entries.count - Self.cap) }
    }

    /// A memory warning, or a host that was removed.
    public func drop() { entries = [] }

    public static func key(host: String, file: String) -> String { "\(host)\n\(file)" }
}
