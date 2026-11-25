import Foundation
import TempCodeContract

/// A row of an open file's More menu (the phone's reader).
public enum ReaderVerb: String, CaseIterable, Sendable, Identifiable {
    case undo, redo, clicker, find, comments, review, preview, print, guestLink, keep, close

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .undo: "Undo"
        case .redo: "Redo"
        case .clicker: "Clicker"
        case .find: "Find…"
        case .comments: "Comments"
        case .review: "Review Changes"
        case .preview: "Page Preview"
        case .print: "Print…"
        case .guestLink: "Share…"
        case .keep: "Save to Workspace"
        case .close: "Close"
        }
    }

    public var symbol: String {
        switch self {
        case .undo: "arrow.uturn.backward"
        case .redo: "arrow.uturn.forward"
        case .clicker: "av.remote"
        case .find: "magnifyingglass"
        case .comments: "text.bubble"
        case .review: "checklist"
        case .preview: "doc.viewfinder"
        case .print: "printer"
        case .guestLink: "person.crop.circle.badge.plus"
        case .keep: "square.and.arrow.down"
        case .close: "xmark.square"
        }
    }
}

/// What the host and the key allow for the file that shows: the rest of what decides a row.
public struct ReaderFacts: Equatable, Sendable {
    /// The key may close a thread's item (`work.canvas.close`, operate).
    public var mayClose: Bool
    /// The key may make a guest link (`work.guests.create`, approve).
    public var mayGuestLink: Bool
    /// The item sits in a thread's tab row, which Close takes it out of.
    public var inThread: Bool
    /// Changes an agent proposed that wait for him.
    public var waiting: Int
    /// The host draws this file's print pages (`work.formats.preview`, `work.sheets.preview`): a document, a sheet.
    public var previews: Bool
    /// The host keeps comment threads for this file.
    public var comments: Bool
    /// The hosted editor's page finds words for the frame (its `drawn` offered find).
    public var finds: Bool
    /// The hosted editor's page has something to undo, and to redo.
    public var undo: Bool
    public var redo: Bool
    /// A show of this deck runs on one of his computers: the clicker steps it.
    public var showing: Bool
    /// The key may copy a fetched file into its workspace's folder (`work.canvas.keep`, operate).
    public var mayKeep: Bool

    public init(mayClose: Bool = false, mayGuestLink: Bool = false, inThread: Bool = false, waiting: Int = 0, previews: Bool = false, comments: Bool = false, finds: Bool = false, undo: Bool = false, redo: Bool = false, showing: Bool = false, mayKeep: Bool = false) {
        self.mayClose = mayClose
        self.mayGuestLink = mayGuestLink
        self.inThread = inThread
        self.waiting = waiting
        self.previews = previews
        self.comments = comments
        self.finds = finds
        self.undo = undo
        self.redo = redo
        self.showing = showing
        self.mayKeep = mayKeep
    }
}

/// More's rows for an open file, in the menu's order. A row is there only when it can act: a row for a
/// wire the host lacks, or a door the key cannot open, is absent.
public enum ReaderVerbs {
    public static func of(_ item: CanvasItem, _ facts: ReaderFacts) -> [ReaderVerb] {
        let body = ItemBody.of(item)
        var verbs: [ReaderVerb] = []
        // The hosted editor's, as its page says: there only while there is something to undo or redo.
        if facts.undo { verbs.append(.undo) }
        if facts.redo { verbs.append(.redo) }
        // A deck that is showing: the clicker first, the way in from the deck itself.
        if body == .slides, facts.showing { verbs.append(.clicker) }
        // PDFKit finds words in a PDF and in a deck's render alike; the hosted page finds its own.
        if body == .pdf || body == .slides || facts.finds { verbs.append(.find) }
        if facts.comments { verbs.append(.comments) }
        if facts.waiting > 0 { verbs.append(.review) }
        // A PDF and a deck already show the pages that print, so they have Print and no second look at
        // the same pages; a document's pages are drawn for it, so it has Page Preview, with Print inside.
        if body == .pdf || body == .slides { verbs.append(.print) } else if facts.previews { verbs.append(.preview) }
        // Share: the one sheet, for a LifeOS document or sheet and a TempCode one kept as a file.
        if ShareSource.of(item) != nil, facts.mayGuestLink { verbs.append(.guestLink) }
        // A mail's file, fetched onto its host: Save to Workspace copies it into the job's folder.
        if MailRules.keeps(item, mayKeep: facts.mayKeep) { verbs.append(.keep) }
        if facts.inThread, facts.mayClose { verbs.append(.close) }
        return verbs
    }

    /// The name in the bar: the file's own, without our two extensions, which name a format he never picks.
    /// An open file's title: the file's own name where it is a file, so the page, Files and the thread's item all
    /// name it alike (an item's title can be a thread's words, "Nationals kickoff", for "Nationals kickoff.pptx");
    /// anything else by its item's title. Our own two formats drop their extension.
    public static func title(of item: CanvasItem) -> String {
        if case .file(let file) = item.source {
            let name = (file.path as NSString).lastPathComponent
            if !name.isEmpty { return title(name) }
        }
        return title(item.title)
    }

    public static func title(_ name: String) -> String {
        for ours in [".tcdoc", ".tcsheet"] where name.lowercased().hasSuffix(ours) { return String(name.dropLast(ours.count)) }
        return name
    }

    /// A tap on these hides the bars: a page, a slide, a picture. A hosted editor and a video keep theirs.
    public static func immerses(_ item: CanvasItem) -> Bool {
        switch ItemBody.of(item) {
        case .pdf, .slides: true
        case .media: true
        default: false
        }
    }

    /// A paper kind keeps the reading measure in a wide column; the hosted editor takes the whole width.
    public static func keepsMeasure(_ item: CanvasItem) -> Bool {
        switch ItemBody.of(item) {
        case .hosted, .browser: false
        default: true
        }
    }
}
