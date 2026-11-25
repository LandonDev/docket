import Foundation

/// The last renders the reader drew (PF1), in memory only: a file opened again in the same run paints in
/// one frame. Three at most and 64 MB at most together (M17), each named by its file and the `rev` of its
/// bytes, so a render that moved on is never shown for the one before; a file larger than the cap is not kept.
/// Beside them, a file's first picture (`FirstPicture`) by the same rule, counted in the same bytes, so a second
/// open at that `rev` draws nothing on the host. All dropped on a memory warning. Nothing of a file is written
/// to the phone's disk.
@MainActor
public final class ReaderCache {
    public static let cap = 3
    /// What the renders and first pictures held hold together, at most.
    public static let byteCap = 64 * 1024 * 1024
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
    /// First pictures by file, oldest first.
    private var pictures: [(key: String, picture: FirstPicture)] = []
    private let byteCap: Int

    public init(byteCap: Int = ReaderCache.byteCap) { self.byteCap = byteCap }

    public var count: Int { entries.count }
    /// The bytes held now, renders and first pictures: never more than the cap.
    public var bytes: Int { entries.reduce(0) { $0 + $1.kept.data.count } + pictures.reduce(0) { $0 + $1.picture.data.count } }

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
        // A file larger than the cap is not kept, and its first picture stays for the next open.
        guard data.count <= byteCap else { return }
        // The whole file paints now: its first picture is no longer needed.
        pictures.removeAll { $0.key == key }
        entries.append(Entry(key: key, kept: Kept(rev: rev, data: data, note: note)))
        if entries.count > Self.cap { entries.removeFirst(entries.count - Self.cap) }
        trim()
    }

    /// A file's first picture, only at the `rev` it was drawn from.
    public func picture(_ key: String, rev: String) -> FirstPicture? {
        pictures.last { $0.key == key && $0.picture.rev == rev }?.picture
    }

    public func keep(picture: FirstPicture, for key: String) {
        pictures.removeAll { $0.key == key }
        guard picture.data.count <= byteCap else { return }
        pictures.append((key, picture))
        if pictures.count > Self.cap { pictures.removeFirst(pictures.count - Self.cap) }
        trim()
    }

    /// Over the byte cap, the oldest go: first pictures before renders, as they are worth less.
    private func trim() {
        var held = bytes
        while held > byteCap, !pictures.isEmpty { held -= pictures.removeFirst().picture.data.count }
        while held > byteCap, !entries.isEmpty { held -= entries.removeFirst().kept.data.count }
    }

    /// A memory warning (RootView). A removed host's renders are not dropped here: they go as newer ones push them out.
    public func drop() {
        entries = []
        pictures = []
    }

    public static func key(host: String, file: String) -> String { "\(host)\n\(file)" }
}
