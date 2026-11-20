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

    /// Why nothing shows, when the host gave no reason of its own.
    public static func missingWords(changesWaiting: Bool) -> String {
        changesWaiting ? "The proposed changes have not been drawn yet." : "The deck has not been drawn yet."
    }
}
