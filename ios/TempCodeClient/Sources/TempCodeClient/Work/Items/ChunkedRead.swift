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

    /// How much of a file has been read, 0 to 1, for a determinate bar.
    public static func share(read: Int, of size: Int) -> Double {
        size > 0 ? min(1, max(0, Double(read) / Double(size))) : 1
    }

    /// Every frame of a file of `size` bytes, in order; one `rev` throughout, and that one `expecting` when the view
    /// that named the file advertised it, so the bytes are the render the view described and no other.
    public static func all(size: Int, frame: Int = ChunkedRead.frame, expecting: String? = nil, read: (_ offset: Int, _ length: Int) async throws -> FileBytes) async throws -> Data {
        var data = Data(capacity: size)
        var rev: String? = expecting
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

    /// How many frames of one file are asked for at once: the next frame is on its way while one lands.
    public static let inFlight = 2

    /// Every frame of a file of `size` bytes at `rev`, `inFlight` asked at once and put together in order. Each frame
    /// must be of that `rev` and as long as asked, so the bytes are the one version the view named, never a mix: a
    /// frame of another fails the read (`changed`), and the frames still out are cancelled. `landed` hears the bytes
    /// in after each frame, on the caller's actor.
    public static func pinned(size: Int, rev: String, frame: Int = ChunkedRead.frame, inFlight: Int = ChunkedRead.inFlight, read: @escaping @Sendable (_ offset: Int, _ length: Int) async throws -> FileBytes, landed: ((Int) -> Void)? = nil) async throws -> Data {
        let offsets = Array(stride(from: 0, to: size, by: max(1, frame)))
        let wide = max(1, inFlight)
        return try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            func ask(_ index: Int) {
                let offset = offsets[index]
                let length = min(frame, size - offset)
                group.addTask {
                    let answer = try await read(offset, length)
                    guard answer.rev == rev else { throw Failure.changed }
                    guard let bytes = Data(base64Encoded: answer.data) else { throw Failure.notBase64 }
                    guard bytes.count == length else { throw Failure.short }
                    return (index, bytes)
                }
            }
            var next = 0
            while next < min(wide, offsets.count) { ask(next); next += 1 }
            var data = Data(capacity: size)
            var waiting: [Int: Data] = [:]
            var done = 0
            while let (index, bytes) = try await group.next() {
                waiting[index] = bytes
                while let part = waiting.removeValue(forKey: done) {
                    data.append(part)
                    done += 1
                }
                landed?(data.count + waiting.values.reduce(0) { $0 + $1.count })
                if next < offsets.count { ask(next); next += 1 }
            }
            return data
        }
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
