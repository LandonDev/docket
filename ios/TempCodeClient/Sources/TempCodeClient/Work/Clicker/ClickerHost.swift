import Foundation
import TempCodeContract

/// The clicker on the host's show wire (docs/agents/work-slides.md "The clicker"): `work.slides.show.state` reads
/// the shows running on windows of this host, `work.slides.show.press` hands his press to the window that runs one,
/// and the `work.slides.show` push says each change. Everything the screen needs maps onto `ClickerWire`.
extension ClickerShow {
    /// A running show as the host said it; nil once it ended.
    public init?(_ live: ShowLive, now: Date = Date()) {
        guard !live.ended else { return nil }
        self.init(
            itemId: live.itemId,
            name: live.title,
            slide: live.slide,
            count: live.count,
            notes: live.notes,
            startedAt: now.timeIntervalSince1970 * 1000 - live.timer.elapsed,
            blank: live.blank,
            rev: live.rev
        )
    }
}

extension ClickerPress {
    /// The host's word for the press (`SHOW_PRESS_ACTS`).
    public var act: Methods.WorkSlidesShowPress.Params.Act {
        switch self {
        case .next: .next
        case .previous: .prev
        case .blank: .blank
        case .end: .end
        }
    }
}

/// Which show the phone steps, and what the Work list says while one runs.
public enum ShowRows {
    /// The show to step: of `itemId` when one is named, else the newest that runs.
    public static func running(_ shows: [ShowLive], itemId: String? = nil) -> ShowLive? {
        shows.filter { !$0.ended && (itemId == nil || $0.itemId == itemId) }.max { $0.rev < $1.rev }
    }

    /// "Showing on MacBook".
    public static func title(computer: String) -> String { "Showing on \(computer)" }

    /// "Nationals kickoff · 4 of 12".
    public static func detail(_ live: ShowLive) -> String { "\(live.title) · \(live.slide) of \(live.count)" }
}
