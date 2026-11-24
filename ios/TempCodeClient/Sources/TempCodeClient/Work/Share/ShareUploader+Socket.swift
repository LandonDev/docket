import Foundation
import TempCodeContract

extension ShareUploader.Send {
    /// The calls over a host's socket.
    public static func socket(_ socket: TempCodeSocket) -> Self {
        Self(
            settings: { try await socket.request(Methods.AttachmentSettings.self, .init()) },
            begin: { ShareUploader.Begun(try await socket.request(Methods.WorkFilesUpload.self, $0)) },
            chunk: { uploadId, index, data in
                _ = try await socket.request(Methods.AttachmentChunk.self, .init(uploadId: uploadId, index: index, dataBase64: data))
            },
            commit: { uploadId in
                do {
                    _ = try await socket.request(Methods.AttachmentCommit.self, .init(uploadId: uploadId))
                } catch TransportError.decoding(_, _) {
                    // The host said yes and the file landed; only its answer's shape is not the one a thread's upload has.
                }
            },
            abort: { uploadId in _ = try? await socket.request(Methods.AttachmentAbort.self, .init(uploadId: uploadId)) }
        )
    }
}

extension ShareUploader {
    /// The uploader for the host behind `socket`; `hostName` as the phone labels it.
    public convenience init(inbox: ShareInbox, socket: TempCodeSocket, hostName: String) {
        self.init(inbox: inbox, hostId: socket.environmentId, hostName: hostName, request: .socket(socket))
    }
}
