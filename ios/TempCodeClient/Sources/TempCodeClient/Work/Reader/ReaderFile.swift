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

    /// What a file takes, by its kind and where it is kept.
    public static func parts(_ item: CanvasItem) -> (review: WorkReview.Subject?, comments: CanvasSource?) {
        switch item.kind {
        case .document:
            // The docs pillar keeps threads and branches for LifeOS's documents and for documents kept as files.
            switch item.source {
            case .lifeos(let row) where row.table == .docs || row.table == .projectDocs: return (.document(item.source), item.source)
            case .file: return (.document(item.source), item.source)
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
