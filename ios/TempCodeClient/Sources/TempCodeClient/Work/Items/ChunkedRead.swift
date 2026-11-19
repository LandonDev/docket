import Foundation
import TempCodeContract

/// A file the host hands over in frames of base64 (`work.pdf.read`, `work.slides.read`).
public enum ChunkedRead {
    /// The host's cap on one frame.
    public static let frame = 4 * 1024 * 1024

    public enum Failure: Error, Equatable {
        case notBase64
        /// The file changed under the read: a frame came back with another `rev`.
        case changed
        case short
    }

    /// Every frame of a file of `size` bytes, in order; one `rev` throughout.
    public static func all(size: Int, frame: Int = ChunkedRead.frame, read: (_ offset: Int, _ length: Int) async throws -> FileBytes) async throws -> Data {
        var data = Data(capacity: size)
        var rev: String?
        var offset = 0
        while offset < size {
            let answer = try await read(offset, min(frame, size - offset))
            if let rev, rev != answer.rev { throw Failure.changed }
            rev = answer.rev
            guard let bytes = Data(base64Encoded: answer.data) else { throw Failure.notBase64 }
            guard !bytes.isEmpty else { throw Failure.short }
            data.append(bytes)
            offset += bytes.count
        }
        return data
    }

    /// A media file by its token (`media.read`), each range handed to `write` as it lands (a file
    /// handle, so a long recording never sits whole in memory); the first range says the whole size.
    public static func media(frame: Int = 2 * 1024 * 1024, read: (_ offset: Int, _ length: Int) async throws -> MediaRange?, write: (Data) throws -> Void) async throws {
        var done = 0
        var size = Int.max
        var mtime: Double?
        while done < size {
            guard let range = try await read(done, frame) else { throw Failure.short }
            if let mtime, mtime != range.mtimeMs { throw Failure.changed }
            mtime = range.mtimeMs
            size = Int(range.size)
            guard let bytes = Data(base64Encoded: range.dataBase64) else { throw Failure.notBase64 }
            guard !bytes.isEmpty || done >= size else { throw Failure.short }
            try write(bytes)
            done += bytes.count
        }
    }
}
