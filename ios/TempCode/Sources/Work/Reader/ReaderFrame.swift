import SwiftUI
import TempCodeClient
import TempCodeContract

/// A sheet an open file presents: its comments, the changes that wait, or a new comment on picked words.
enum ReaderSheet: Identifiable, Hashable {
    case comments
    case review
    case comment(quote: String)

    var id: String {
        switch self {
        case .comments: "comments"
        case .review: "review"
        case .comment(let quote): "comment:\(quote)"
        }
    }
}

/// What a file's page adds around the kind's own view, wherever the file shows (the reader page, a
/// thread's Item segment): the review row while an agent's changes wait, the sheets for comments and
/// review, and Comment in the hosted editor's edit menu. The row only counts and opens Review Changes:
/// the page draws none of a document's or a sheet's changes, so he decides them where he can read them. The host owns `file` and `sheet`, since its More
/// reads the one and sets the other.
struct ReaderFrame<Content: View>: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let commands: ReaderCommands
    @Binding var file: ReaderFile?
    @Binding var sheet: ReaderSheet?
    /// The bars are hidden (a tap on the page): the review row goes with them.
    var immersive = false
    @ViewBuilder let content: Content

    private var canWrite: Bool { client.work.canOperate }
    /// The file's parts, only once they are this item's: on a switch of items the host still holds the last one's
    /// for a frame, and its row and its Comment must not show over the new one.
    private var own: ReaderFile? { file?.item.id == item.id ? file : nil }

    var body: some View {
        VStack(spacing: 0) {
            if let review = own?.review, (own?.waiting ?? 0) > 0, !immersive {
                // The deck's row with no buttons: how many wait, and a tap lists them.
                DeckReviewRow(words: review.words, decides: false, open: { sheet = .review }) { _ in }
                Divider()
            }
            content
        }
        .task(id: item.id) {
            let opened = ReaderFile(work: client.work, item: item)
            file = opened
            await opened.load()
        }
        // The one place a push reloads a file's comments and changes; the sheets read the same models.
        .onChange(of: own?.rev) { Task { await own?.load() } }
        // Comment joins the edit menu once the host has answered with the document's threads.
        .onChange(of: own?.takesComments == true && canWrite, initial: true) { _, takes in
            commands.comment = takes ? { sheet = .comment(quote: $0) } : nil
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .comments:
                if let comments = own?.comments { CommentsSheet(comments: comments, canWrite: canWrite) }
            case .review:
                if let review = own?.review { ReviewSheet(review: review, canDecide: canWrite) }
            case .comment(let quote):
                if let comments = own?.comments { CommentSheet(comments: comments, quote: quote) }
            }
        }
    }
}
