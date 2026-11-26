import Foundation
import Observation

/// How the Capture sheet opens (docs/agents/work-capture.md "The phone"): with the note's field focused for
/// typing, or with the keyboard down so the hold control is under the thumb.
public nonisolated enum CaptureMode: String, Sendable, Hashable, Identifiable {
    case typed
    case voice

    public var id: String { rawValue }
}

/// The one Capture sheet's door. The Work list's and Today's `plus`, and the "Capture" and "Voice Note" App
/// Shortcuts (the Action button, Control Center, the Lock Screen), all open it here, and nothing else:
/// opening files nothing, sends nothing and starts no thread. Only his Save in the sheet does.
@MainActor @Observable
public final class CaptureDesk {
    public static let shared = CaptureDesk()

    /// The sheet on screen, and how it opened.
    public var shown: CaptureMode?
    /// The receipt camera waits for the sheet to close (VisionKit's is a full-screen view of its own).
    public var receiptNext = false

    public init() {}

    public func open(_ mode: CaptureMode) {
        // A second press while it is up keeps the sheet and its draft as they are.
        if shown == nil { shown = mode }
    }

    /// Scan Receipt in the sheet: the sheet closes, then the camera opens.
    public func scanReceipt() {
        receiptNext = true
        shown = nil
    }

    /// The sheet closed; true once when the camera should open now.
    public func closed() -> Bool {
        defer { receiptNext = false }
        return receiptNext
    }
}

/// What Save does with what is in the sheet: the words file as his own quick add (`work.capture.file`, as the
/// voice note always has), and each photo or file is queued for the job's own folder through Save to
/// TempCode's queue (`ShareInbox`, `ShareUploader`: its own item, its own op key, sent once). Nothing is shared
/// or posted; a queue never writes into a place others can open, since only a workspace's own folder is a
/// target.
public nonisolated enum CaptureRules {
    /// What the sheet holds when Save is pressed.
    public struct Draft: Sendable, Hashable {
        public var hasWords: Bool
        public var files: Int
        /// The job the files go to, when one is set.
        public var job: String?
        /// A save, a take or a pick is still on its way.
        public var busy: Bool

        public init(hasWords: Bool, files: Int, job: String?, busy: Bool) {
            self.hasWords = hasWords
            self.files = files
            self.job = job
            self.busy = busy
        }
    }

    /// What one press of Save does.
    public struct Plan: Sendable, Hashable {
        /// File the words through the first host whose LifeOS answers.
        public var note: Bool
        /// Queue the files for the job's folder.
        public var files: Bool
    }

    public static func plan(_ draft: Draft) -> Plan? {
        guard !draft.busy else { return nil }
        let files = draft.files > 0 && draft.job != nil
        // Files with no job to go to hold Save off: nothing of the draft is sent half.
        guard draft.files == 0 || files else { return nil }
        guard draft.hasWords || files else { return nil }
        return Plan(note: draft.hasWords, files: files)
    }

    /// The job a photo or file goes to: the one he picked; else the job of the note's sector; else the last a
    /// file went to (`ShareTargets.ordered`, the last used first). Nil when no host's key may upload.
    public static func job(picked: String?, sector: String?, targets: [ShareTargets.Target]) -> ShareTargets.Target? {
        if let picked, let target = targets.first(where: { $0.id == picked }) { return target }
        if let sector, let target = targets.first(where: { $0.workspace.sector == sector }) { return target }
        return targets.first
    }

    /// The files' failure line: picks that would not copy in, and files still in the sheet that the last Save
    /// could not queue, out of every file he added (`files` counts the ones still in the sheet). Only the second
    /// kind holds the note back; a failed pick is told here and nowhere else.
    public static func failedLine(unpicked: [String], unqueued: [String], files: Int) -> String? {
        ShareSummary.unread(unpicked + unqueued, of: unpicked.count + files)
    }

    /// The line under the files once Save has queued them and the note is still to file (or failed).
    public static func queuedLine(_ count: Int, job: String) -> String {
        "\(count == 1 ? "1 file goes" : "\(count) files go") to \(job)."
    }
}
