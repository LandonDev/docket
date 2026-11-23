import CryptoKit
import Foundation

extension UploadSource {
    /// Picked bytes (a photo from the library).
    public static func data(_ data: Data, name: String) -> UploadSource {
        UploadSource(name: name, size: data.count, sha256: AttachmentUpload.sha256Hex(data)) { offset, length in
            data.subdata(in: offset ..< offset + length)
        }
    }

    /// A picked file, read a range at a time so a large one never sits whole in memory; its digest is read
    /// through once first. `url` is one the app may read (a security-scoped file is opened by the caller).
    public static func file(_ url: URL, name: String? = nil) throws -> UploadSource {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        var size = 0
        while let chunk = try handle.read(upToCount: AttachmentUpload.maxChunkBytes), !chunk.isEmpty {
            hash.update(data: chunk)
            size += chunk.count
        }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return UploadSource(name: name ?? url.lastPathComponent, size: size, sha256: digest) { offset, length in
            let reader = try FileHandle(forReadingFrom: url)
            defer { try? reader.close() }
            try reader.seek(toOffset: UInt64(offset))
            return try reader.read(upToCount: length) ?? Data()
        }
    }
}
