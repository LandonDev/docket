import Foundation

/// What the Outbox's capsule says when nothing counts (`OutboxPresses`): a refusal before any wait (no link, the check
/// cancelled), and the results of presses on many, each kept until a capsule on screen has shown it for its whole time.
/// A countdown in front hides a result but never spends it, and a later result waits behind an earlier one.
public struct OutboxNotices: Sendable, Hashable {
    public struct Line: Sendable, Hashable, Identifiable {
        public let id: String
        public let text: String

        public init(id: String, text: String) {
            self.id = id
            self.text = text
        }
    }

    /// The last refusal before a wait: the next press replaces it.
    public private(set) var refusal: Line?
    /// Results of presses on many, oldest first, each until it has been seen.
    public private(set) var results: [Line] = []
    private var made = 0

    public init() {}

    /// A refusal before any wait, or none (a new press that started).
    public mutating func refuse(_ text: String?) {
        refusal = text.map { Line(id: fresh(), text: $0) }
    }

    /// A press on many answered: its sum waits its turn to be shown.
    public mutating func result(_ text: String) {
        guard !text.isEmpty else { return }
        results.append(Line(id: fresh(), text: text))
    }

    /// The line the capsule shows now: a refusal first, then the oldest unseen result, then the wait's own notice.
    public func shown(wait: Line?) -> Line? { refusal ?? results.first ?? wait }

    /// The line with this id was shown its whole time: it goes. False when it is none of these (the wait's notice).
    @discardableResult
    public mutating func seen(_ id: String) -> Bool {
        if refusal?.id == id { refusal = nil; return true }
        if let index = results.firstIndex(where: { $0.id == id }) { results.remove(at: index); return true }
        return false
    }

    private mutating func fresh() -> String {
        made += 1
        return "n\(made)"
    }
}
