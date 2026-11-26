import Foundation
import TempCodeContract

/// A meeting's recording on the phone (docs/agents/work-phone-files.md "A meeting"): played as it is read, by
/// range through `work.meetings.recording`, never kept on the phone's disk.
public enum MeetingRecording {
    /// The most one `work.meetings.recording` answers (`ATTACHMENT_CHUNK_BYTES`).
    public static let chunk = 2 * 1024 * 1024

    /// The type the system's player opens a recording as, by its file's extension; nil for one it cannot play
    /// (WebM, Ogg, Matroska), which plays on the computer.
    public static func type(of name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "m4a": "com.apple.m4a-audio"
        case "mp3": "public.mp3"
        case "aac": "public.aac-audio"
        case "wav": "com.microsoft.waveform-audio"
        case "aif", "aiff": "public.aiff-audio"
        case "caf": "com.apple.coreaudio-format"
        case "flac": "org.xiph.flac"
        case "mp4": "public.mpeg-4"
        case "m4v": "com.apple.m4v-video"
        case "mov": "com.apple.quicktime-movie"
        default: nil
        }
    }

    /// The reads that answer a player's request for `length` bytes from `offset`: each at most `chunk`, none past
    /// the end. A request past the end reads nothing.
    public static func ranges(offset: Int, length: Int, size: Int, chunk: Int = chunk) -> [Range<Int>] {
        guard offset >= 0, length > 0, chunk > 0, offset < size else { return [] }
        let end = min(size, offset + length)
        return stride(from: offset, to: end, by: chunk).map { $0..<min(end, $0 + chunk) }
    }
}

/// The tasks a meeting yielded, on the phone: each waits on his word, then is filed in LifeOS or dropped
/// (`work.meetings.decide`, approve: it files and sends to no one).
public enum MeetingActions {
    public typealias Action = MeetingPhone.Notes.Action

    /// The ones that wait on him, in the order the notes give them.
    public static func waiting(_ meeting: MeetingPhone) -> [Action] {
        (meeting.notes?.actions ?? []).filter { $0.state == .proposed }
    }

    /// Every task, those that wait first; a dropped one is not shown.
    public static func shown(_ meeting: MeetingPhone) -> [Action] {
        let all = (meeting.notes?.actions ?? []).filter { $0.state != .rejected }
        return all.filter { $0.state == .proposed } + all.filter { $0.state != .proposed }
    }

    /// The bar's press for the ones that wait: "Add 3 Tasks".
    public static func addWords(_ count: Int) -> String {
        count == 1 ? "Add 1 Task" : "Add \(count) Tasks"
    }

    /// What LifeOS would not file, as one line: the one's words, else how many.
    public static func failedWords(_ failed: [(id: String, error: String)]) -> String? {
        guard let first = failed.first else { return nil }
        return failed.count == 1 ? first.error : "\(failed.count) tasks were not added. \(first.error)"
    }

    /// The moment a task rests on, to play from; nil for a meeting with no times.
    public static func seek(_ action: Action) -> Double? { action.at.map { max(0, $0) } }
}

/// History's Restore (docs/agents/work-history.md "Restore"). On his own document the host writes the version
/// back at once and names the version cut just before, which Undo restores. On a document others can open it is a
/// branch of suggestions, which wait in Review Changes for his Accept: nothing reaches anyone by the press itself.
public enum HistoryRestore {
    public enum Outcome: Equatable, Sendable {
        /// Written; `undo` is the version to go back to.
        case written(undo: String?)
        /// Waits as suggestions in Review Changes.
        case suggested
        /// An answer this build does not know: the document is read again.
        case unknown
    }

    /// The newest version is the document as it stands: it has nothing to restore.
    public static func restores(_ versionId: String, in versions: [String]) -> Bool {
        versions.first != versionId && versions.contains(versionId)
    }

    public static func outcome(_ write: HistoryWritePhone) -> Outcome {
        switch write {
        case .direct(let done): .written(undo: done.beforeVersionId)
        case .branch: .suggested
        case .unknown: .unknown
        }
    }

    /// The line under the version after the press.
    public static func words(_ outcome: Outcome) -> String {
        switch outcome {
        case .written: "Restored"
        case .suggested: "Waiting in Review Changes"
        case .unknown: "Restore sent"
        }
    }

    /// A compare's head: only the counts above zero ("2 changed"), nil when nothing changed.
    public static func counts(added: Int, removed: Int, changed: Int) -> String? {
        let parts = [(added, "added"), (removed, "removed"), (changed, "changed")].filter { $0.0 > 0 }
        return parts.isEmpty ? nil : parts.map { "\($0.0) \($0.1)" }.joined(separator: ", ")
    }
}

/// Ask lands him on the thread's Chat (docs/IOS-DESIGN.md "A file on the phone"). Seating the file in a new
/// thread makes the host announce it as just opened (`work.canvas`'s `opened`), which would select the Item
/// segment: that one announcement, for that file, opens nothing.
public enum AskLanding {
    public static func swallows(opened: String, items: [CanvasItem], file: CanvasSource) -> Bool {
        items.first { $0.id == opened }?.source == file
    }
}

/// The tab a sheet's changed cell names in Review Changes: only where the open rows reach more than one tab, since
/// two tabs can each hold a "C4", and only by the name the host sent (`SheetPhoneView.tabs`). A sheet's own id is
/// never shown; an older host's rows read the cell alone.
public enum ReviewTabs {
    public static func name(_ sheet: String, among sheets: [String], tabs: [String: String]?) -> String? {
        guard Set(sheets).count > 1, let name = tabs?[sheet], !name.isEmpty else { return nil }
        return name
    }
}
