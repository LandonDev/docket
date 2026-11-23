import Foundation
import TempCodeContract

/// A row of an open file's More menu (the phone's reader).
public enum ReaderVerb: String, CaseIterable, Sendable, Identifiable {
    case find, comments, review, preview, share, guestLink, close

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .find: "Find…"
        case .comments: "Comments"
        case .review: "Review Changes"
        case .preview: "Page Preview"
        case .share: "Share…"
        case .guestLink: "Make a Guest Link"
        case .close: "Close"
        }
    }

    public var symbol: String {
        switch self {
        case .find: "magnifyingglass"
        case .comments: "text.bubble"
        case .review: "checklist"
        case .preview: "doc.viewfinder"
        case .share: "square.and.arrow.up"
        case .guestLink: "person.badge.plus"
        case .close: "xmark.square"
        }
    }
}

/// What the host and the key allow for the file that shows: the rest of what decides a row.
public struct ReaderFacts: Equatable, Sendable {
    /// The key can press Send, Edit and Discard: a guest link is made through that door.
    public var canApprove: Bool
    /// The item sits in a thread's tab row, which Close takes it out of.
    public var inThread: Bool
    /// Changes an agent proposed that wait for him.
    public var waiting: Int
    /// The host draws this file's print pages (`work.formats.preview`, `work.sheets.preview`), or the file is its own.
    public var previews: Bool
    /// The host keeps comment threads for this file.
    public var comments: Bool
    /// One way to share this file exists for this key.
    public var shares: Bool

    public init(canApprove: Bool = false, inThread: Bool = false, waiting: Int = 0, previews: Bool = false, comments: Bool = false, shares: Bool = false) {
        self.canApprove = canApprove
        self.inThread = inThread
        self.waiting = waiting
        self.previews = previews
        self.comments = comments
        self.shares = shares
    }
}

/// More's rows for an open file, in the menu's order. A row is there only when it can act: a row for a
/// wire the host lacks, or a door the key cannot open, is absent.
public enum ReaderVerbs {
    public static func of(_ item: CanvasItem, _ facts: ReaderFacts) -> [ReaderVerb] {
        let body = ItemBody.of(item)
        var verbs: [ReaderVerb] = []
        // PDFKit finds words in a PDF and in a deck's render alike.
        if body == .pdf || body == .slides { verbs.append(.find) }
        if facts.comments { verbs.append(.comments) }
        if facts.waiting > 0 { verbs.append(.review) }
        if facts.previews { verbs.append(.preview) }
        if facts.shares { verbs.append(.share) }
        if body.guestSource != nil, facts.canApprove { verbs.append(.guestLink) }
        if facts.inThread { verbs.append(.close) }
        return verbs
    }

    /// The name in the bar: the file's own, without our two extensions, which name a format he never picks.
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
