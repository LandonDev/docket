import Foundation

/// The phone's copies of media it plays (milestone 47): written under a `.part` name and moved
/// into place only when whole, so a read cut off halfway is never played as if complete.
public enum MediaFiles {
    public static func file(item: String, version: String, ext: String = "mp4") -> URL {
        FileManager.default.temporaryDirectory.appending(path: "tc-media-\(item)-\(version).\(ext)")
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
