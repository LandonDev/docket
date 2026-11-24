import Foundation

/// Which render a deck item shows (milestone 47's slides on the phone). While the agent's changes
/// wait, only their proposed render may show, with the review row over it: never the file's own
/// render under live Reject and Accept, which would approve a deck he has not seen. A proposed
/// render that is missing is a failure the item says with Try Again; nil means nothing to show.
public enum DeckRender: Sendable, Hashable {
    case file
    case proposed

    public static func pick(changesWaiting: Bool, hasProposed: Bool, hasFile: Bool) -> DeckRender? {
        if changesWaiting { return hasProposed ? .proposed : nil }
        return hasFile ? .file : nil
    }

    /// The verdicts are released only once the fetched bytes open as a document with a page: bytes PDFKit cannot read
    /// (nil) or a document of no pages show the failure with Try Again, never Reject and Accept over nothing.
    public static func opens(pageCount: Int?) -> Bool {
        (pageCount ?? 0) > 0
    }

    /// Whether a render kept in memory may paint a second open's first frame, before the host answers. The file's
    /// own render is his older bytes; a proposed one is an agent's slides that are not in the file, and painted with
    /// no review row (that waits for the host) they would read as the deck itself.
    public static func paintsFromMemory(_ render: DeckRender) -> Bool {
        render == .file
    }

    public static let unreadable = "The slides did not open."

    /// Why nothing shows, when the host gave no reason of its own.
    public static func missingWords(changesWaiting: Bool) -> String {
        changesWaiting ? "The proposed changes have not been drawn yet." : "The deck has not been drawn yet."
    }
}
