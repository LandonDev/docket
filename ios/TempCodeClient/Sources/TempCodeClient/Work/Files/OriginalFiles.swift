import Foundation
import TempCodeContract

/// Open the original (docs/IOS-DESIGN.md "Files"): a workspace-folder file read whole through
/// `work.files.read`, by version, into a temp file Quick Look shows. The file lives only while its preview
/// does: it goes when the preview closes, on a cancel or a failed read, and at the next launch.
public enum OriginalFiles {
    /// The host's cap on one read frame.
    public static let frame = 4 * 1024 * 1024

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case notBase64
        /// The file changed while it was read: a frame named another version.
        case changed
        case short
        case tooBig

        public var description: String {
            switch self {
            case .notBase64: "The host sent bytes the phone could not read."
            case .changed: "The file changed while it was read. Try again."
            case .short: "The file ended early. Try again."
            case .tooBig: "This file is over 50 MB, too big to open on the phone."
            }
        }
    }

    /// Where the originals wait while shown.
    public static func root(_ base: URL = FileManager.default.temporaryDirectory) -> URL {
        base.appendingPathComponent("files-originals", isDirectory: true)
    }

    /// A fresh place for one original, named as the file is (so Quick Look picks its viewer by extension).
    public static func place(for name: String, base: URL = FileManager.default.temporaryDirectory) throws -> URL {
        let dir = root(base).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = name.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        return dir.appendingPathComponent(safe.isEmpty ? "File" : safe)
    }

    /// The original's own folder goes with it.
    public static func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    /// Everything a past launch left (a preview the app was killed under).
    public static func sweep(base: URL = FileManager.default.temporaryDirectory) {
        try? FileManager.default.removeItem(at: root(base))
    }

    @MainActor private static var swept = false

    /// `sweep` once a process: the first host's Files store at launch, never under a preview shown since.
    @MainActor public static func sweepAtLaunch() {
        guard !swept else { return }
        swept = true
        sweep()
    }

    /// Reads every frame of a file of `size` bytes into `file`, in order, all of one version: the first frame
    /// names it and every later read asks for it, so a file that changes midway fails the read rather than
    /// mixing two versions. A failed or cancelled read leaves no file behind.
    public static func read(size: Int, to file: URL, frame: Int = OriginalFiles.frame, read: (_ offset: Int, _ length: Int, _ version: String?) async throws -> FileRead) async throws {
        guard size <= FilesRules.originalMax else { throw Failure.tooBig }
        let part = file.appendingPathExtension("part")
        FileManager.default.createFile(atPath: part.path, contents: nil)
        do {
            let handle = try FileHandle(forWritingTo: part)
            defer { try? handle.close() }
            var version: String?
            var offset = 0
            var total = size
            repeat {
                try Task.checkCancellation()
                let answer = try await read(offset, max(1, min(frame, total - offset)), version)
                if let version, version != answer.version { throw Failure.changed }
                version = answer.version
                total = Int(answer.size)
                guard total <= FilesRules.originalMax else { throw Failure.tooBig }
                guard let bytes = Data(base64Encoded: answer.data) else { throw Failure.notBase64 }
                try handle.write(contentsOf: bytes)
                offset += bytes.count
                if answer.end { break }
                guard !bytes.isEmpty else { throw Failure.short }
            } while offset < total
            guard offset == total else { throw Failure.short }
            try handle.close()
            try? FileManager.default.removeItem(at: file)
            try FileManager.default.moveItem(at: part, to: file)
        } catch {
            try? FileManager.default.removeItem(at: part)
            throw error
        }
    }
}
