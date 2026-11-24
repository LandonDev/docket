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

    /// The same, when some of the files never reached the queue (the phone could not keep a copy to send, its disk
    /// full): those are named first, then what became of the rest, so he knows which went and which did not.
    public static func after(_ items: [ShareItem], host: String, notQueued: [String], total: Int) -> SharePhase {
        guard let first = notQueued.first else { return after(items, host: host) }
        let lost = notQueued.count == 1 ? "Could not send \(first) from this phone."
            : notQueued.count >= total ? "Could not send any of the \(notQueued.count) files from this phone."
            : "Could not send \(notQueued.count) of \(total) files from this phone."
        guard !items.isEmpty else { return .refused(lost) }
        switch after(items, host: host) {
        case .saved: return .refused(items.count == 1 ? "\(lost) \(items[0].name) is saved." : "\(lost) The other \(items.count) are saved.")
        case .waiting(let words), .refused(let words): return .refused("\(lost) \(words)")
        case .picking, .saving: return .refused(lost)
        }
    }

    public static func unreachable(_ host: String) -> String {
        "\(host) can’t be reached. TempCode will save this when it can."
    }

    /// The share of the whole that has gone, by bytes: the files already done, plus the part of the one
    /// going now. `sizes` are every file's, in the order they go. Files of no bytes count one each.
    public static func share(sizes: [Int], done: Int, current: Double) -> Double {
        let weights = sizes.allSatisfy({ $0 <= 0 }) ? sizes.map { _ in 1.0 } : sizes.map { Double(max(0, $0)) }
        let total = weights.reduce(0, +)
        guard total > 0 else { return 0 }
        let before = weights.prefix(max(0, done)).reduce(0, +)
        let now = done >= 0 && done < weights.count ? weights[done] * min(1, max(0, current)) : 0
        return min(1, (before + now) / total)
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

    /// The first group's line when some of what was shared could not be read: "Could not read Photo.heic."
    /// or "Could not read 2 of 3 files."; nil when every file was read. `total` counts every file shared.
    public static func unread(_ names: [String], of total: Int) -> String? {
        guard let first = names.first else { return nil }
        if names.count == 1 { return "Could not read \(first)." }
        if names.count >= total { return "Could not read any of the \(names.count) files." }
        return "Could not read \(names.count) of \(total) files."
    }

    /// A refused row's words when Try Again finds its host gone from the sheet's list.
    public static let hostGone = "That computer is no longer on this phone."

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
/// every page, in the host's order. The sheet starts it at the workspace's own folder, so it offers only that
/// folder and the folders under it.
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
            begin: { ShareUploader.Begun(try await client.request(Methods.WorkFilesUpload.self, $0)) },
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
