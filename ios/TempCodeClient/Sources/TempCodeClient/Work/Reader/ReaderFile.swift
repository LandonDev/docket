import Foundation
import Observation
import TempCodeContract

/// What one open file carries beside its own view (the phone's reader, PF2): a document's comments and the
/// changes an agent proposed, a sheet's proposed cells. A deck reviews in its own row and keeps none here.
/// Each part counts only once its host has answered for it: a host from before these calls, or a document
/// it keeps no threads for, simply has no row.
@MainActor @Observable
public final class ReaderFile {
    public let item: CanvasItem
    public let review: WorkReview?
    public let comments: WorkComments?

    public init(work: WorkHost, item: CanvasItem) {
        self.item = item
        let parts = Self.parts(item)
        review = parts.review.map { WorkReview(work: work, subject: $0) }
        comments = parts.comments.map { WorkComments(work: work, source: $0) }
    }

    /// An item and where it is kept: a file renamed or moved on the host is a new reader, so nothing is read from or
    /// written to the old path, where another file may now stand.
    public struct Identity: Hashable, Sendable {
        public let id: String
        public let source: CanvasSource
        public init(_ item: CanvasItem) {
            id = item.id
            source = item.source
        }
    }

    /// The item as the host last pushed it (`work.canvas`, whose list carries a moved file's new path), else as it was
    /// handed over: a page holds the item it opened with, and the push is what says the file moved.
    public static func current(_ item: CanvasItem, in listed: [CanvasItem]?) -> CanvasItem {
        live(item, in: listed) ?? item
    }

    /// The same, failing closed: nil once the host's list for the item's thread no longer holds it (he closed it, or
    /// its tab went). Its page then reads, asks, previews and writes nothing more. With no list heard yet, the item
    /// stands as it was handed over.
    public static func live(_ item: CanvasItem, in listed: [CanvasItem]?) -> CanvasItem? {
        guard let listed else { return item }
        return listed.first { $0.id == item.id && $0.state == .open }
    }

    /// Where the host's list stands on an item: not heard yet, holding it open, or without it (closed, its tab gone).
    public enum Presence: Equatable, Sendable {
        case unheard, listed, gone
    }

    /// The item's presence in its thread's list. A page that saw it `listed` and then sees it `gone` closes: a list
    /// that never held it yet (one read before the item was seated) closes nothing.
    public static func presence(_ item: CanvasItem, in listed: [CanvasItem]?) -> Presence {
        guard let listed else { return .unheard }
        return listed.contains { $0.id == item.id && $0.state == .open } ? .listed : .gone
    }

    /// What a file takes, by its kind and where it is kept.
    public static func parts(_ item: CanvasItem) -> (review: WorkReview.Subject?, comments: CanvasSource?) {
        switch item.kind {
        case .document:
            // The docs pillar keeps threads and branches for LifeOS's documents and for documents kept as `.tcdoc`
            // files (docs/target.ts). A Word file is no source of its: asked, the host refuses, so it is not asked.
            switch item.source {
            case .lifeos(let row) where row.table == .docs || row.table == .projectDocs: return (.document(item.source), item.source)
            case .file(let file) where file.path.lowercased().hasSuffix(".tcdoc"): return (.document(item.source), item.source)
            default: return (nil, nil)
            }
        case .sheet:
            return (.sheet(itemId: item.id), nil)
        default:
            return (nil, nil)
        }
    }

    public func load() async {
        async let changes: Void? = review?.load()
        async let threads: Void? = comments?.load()
        _ = await (changes, threads)
    }

    /// Changes that wait for him, once the host has listed them.
    public var waiting: Int { review?.loaded == true ? (review?.count ?? 0) : 0 }
    /// The host keeps threads for this document and has answered with them.
    public var takesComments: Bool { comments?.loaded == true }
    /// Moves when the host says the document's threads or changes, or the sheet, moved.
    public var rev: Int { (review?.rev ?? 0) &+ (comments?.rev ?? 0) }
}
