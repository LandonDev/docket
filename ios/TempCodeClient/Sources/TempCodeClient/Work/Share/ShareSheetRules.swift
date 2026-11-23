import Foundation
import TempCodeContract

/// Where the share sheet stands (docs/IOS-DESIGN.md "Save to TempCode"): what Save shows in its place, and
/// the one line under the workspace or the file.
public enum SharePhase: Equatable, Sendable {
    /// Nothing sent yet: Save.
    case picking
    /// The bytes are going: a bar at this share, 0 to 1, over every file together.
    case saving(Double)
    /// The host has every file: a check, then the sheet closes itself.
    case saved
    /// The host could not be reached: the files wait in the queue and the app sends them. Save reads Done.
    case waiting(String)
    /// The host refused a file, in its own words. Save reads Done.
    case refused(String)

    /// What the sheet shows once every file has been tried. A refusal outranks a wait: he should read why.
    public static func after(_ items: [ShareItem], host: String) -> SharePhase {
        if let refused = items.first(where: { $0.state == .refused }) { return .refused(refused.words ?? "\(host) did not take \(refused.name).") }
        if items.contains(where: { $0.state != .done }) { return .waiting(unreachable(host)) }
        return .saved
    }

    public static func unreachable(_ host: String) -> String {
        "\(host) can’t be reached. TempCode will save this when it can."
    }

    /// The share of the whole that has gone: files already done, plus the one going now.
    public static func share(done: Int, of count: Int, current: Double) -> Double {
        guard count > 0 else { return 0 }
        return min(1, (Double(done) + min(1, max(0, current))) / Double(count))
    }
}

/// What is being saved, in the words the sheet leads with when it is more than one thing.
public enum ShareSummary {
    public enum Kind: Sendable, Equatable { case file, photo, video }

    /// "3 photos", "2 videos", "4 files" (a mix is files).
    public static func title(_ kinds: [Kind]) -> String {
        let count = kinds.count
        let noun: String
        if kinds.allSatisfy({ $0 == .photo }) { noun = count == 1 ? "photo" : "photos" }
        else if kinds.allSatisfy({ $0 == .video }) { noun = count == 1 ? "video" : "videos" }
        else { noun = count == 1 ? "file" : "files" }
        return "\(count) \(noun)"
    }

    /// A name the host takes for a file shared with none, or with one it would refuse: one path component.
    public static func name(_ suggested: String?, kind: Kind, at date: Date, calendar: Calendar = .current) -> String {
        let cleaned = (suggested ?? "")
            .components(separatedBy: CharacterSet(charactersIn: "/\\\0:"))
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty, cleaned != ".", cleaned != ".." { return cleaned }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let stamp = String(format: "%04d-%02d-%02d %02d.%02d.%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
        switch kind {
        case .photo: return "Photo \(stamp).jpg"
        case .video: return "Video \(stamp).mov"
        case .file: return "File \(stamp)"
        }
    }
}

/// The folders inside one folder of a workspace's own place, for the sheet's folder picker: folders only,
/// every page, in the host's order. A place others can open is never listed: a `ShareFolder` cannot name one.
public enum ShareFolders {
    /// The most pages one level is read to: a folder of thousands of folders shows its first ones.
    public static let pageCap = 20

    public static func inside(_ folder: ShareFolder, workspaceId: String, list: (Methods.WorkFilesList.Params) async throws -> FilesListing) async throws -> [ShareFolder] {
        var out: [ShareFolder] = []
        var cursor: String?
        for _ in 0..<pageCap {
            let page = try await list(.init(workspaceId: workspaceId, at: folder.at, cursor: cursor, sort: nil, foldersOnly: true))
            for entry in page.entries where entry.kind == .folder {
                if let ref = entry.folder, let child = ShareFolder(ref, name: entry.name), !child.isTop { out.append(child) }
            }
            guard let next = page.next, !next.isEmpty else { break }
            cursor = next
        }
        return out
    }
}

extension ShareInbox {
    /// What a host refused for one workspace, in the queue's order: the rows its Files screen leads with.
    public func refused(hostId: String, workspaceId: String) -> [ShareItem] {
        items().filter { $0.state == .refused && $0.hostId == hostId && $0.workspaceId == workspaceId }
    }

    /// The App Group both the app and the share extension hold.
    public static let appGroup = "group.dev.landon.tempcode"

    /// Where the queue and the sheet's list live: the App Group's own folder, nil where the group is missing
    /// (a build signed without it).
    public static func groupRoot() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appending(path: "share", directoryHint: .isDirectory)
    }
}

extension ShareUploader.Send {
    /// The calls through a host's client, for the app's own drain.
    @MainActor
    public static func client(_ client: EnvironmentClient) -> Self {
        Self(
            settings: { try await client.request(Methods.AttachmentSettings.self, .init()) },
            begin: { try await client.request(Methods.WorkFilesUpload.self, $0).uploadId },
            chunk: { uploadId, index, data in
                _ = try await client.request(Methods.AttachmentChunk.self, .init(uploadId: uploadId, index: index, dataBase64: data))
            },
            commit: { uploadId in
                do {
                    _ = try await client.request(Methods.AttachmentCommit.self, .init(uploadId: uploadId))
                } catch TransportError.decoding(_, _) {
                    // As over a bare socket: the host said yes and the file landed.
                }
            },
            abort: { uploadId in _ = try? await client.request(Methods.AttachmentAbort.self, .init(uploadId: uploadId)) }
        )
    }
}
