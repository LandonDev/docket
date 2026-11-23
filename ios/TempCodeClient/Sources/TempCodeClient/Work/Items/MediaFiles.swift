import Foundation

/// The phone's copies of media it plays (milestone 47): written under a `.part` name and moved
/// into place only when whole, so a read cut off halfway is never played as if complete. A copy lasts as
/// long as the view that plays it: the player reads a video from disk, and nothing of a file stays on the
/// phone after it closes (`remove`), or past the next launch where a crash left one (`sweepAtLaunch`).
public enum MediaFiles {
    static let prefix = "tc-media-"

    public static func file(item: String, version: String, ext: String = "mp4", base: URL = FileManager.default.temporaryDirectory) -> URL {
        base.appending(path: "\(prefix)\(item)-\(version).\(ext)")
    }

    /// The copy and its half-written twin, gone.
    public static func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: file.appendingPathExtension("part"))
    }

    /// Every copy a past run left: the count removed.
    @discardableResult
    public static func sweep(base: URL = FileManager.default.temporaryDirectory) -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: base.path())) ?? []
        let left = names.filter { $0.hasPrefix(prefix) }
        for name in left { try? FileManager.default.removeItem(at: base.appending(path: name)) }
        return left.count
    }

    @MainActor private static var swept = false

    /// `sweep` once a process, before any view has made a copy.
    @MainActor public static func sweepAtLaunch() {
        guard !swept else { return }
        swept = true
        sweep()
    }

    public static func write(to file: URL, _ fill: (FileHandle) async throws -> Void) async throws {
        let part = file.appendingPathExtension("part")
        let manager = FileManager.default
        try? manager.removeItem(at: part)
        guard manager.createFile(atPath: part.path(), contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let handle = try FileHandle(forWritingTo: part)
            defer { try? handle.close() }
            try await fill(handle)
        } catch {
            try? manager.removeItem(at: part)
            throw error
        }
        try? manager.removeItem(at: file)
        try manager.moveItem(at: part, to: file)
    }
}
