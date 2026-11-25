import Foundation
import TempCodeContract

/// One clicker's link to a host's show: keeps the show's id from the first read, so each press names it.
@MainActor
public final class ShowLink {
    public let host: WorkHost
    public let itemId: String?
    public private(set) var showId: String?

    public init(host: WorkHost, itemId: String? = nil) {
        self.host = host
        self.itemId = itemId
    }

    public var wire: ClickerWire {
        ClickerWire(state: { [self] in try await self.state() }, press: { [self] press, rev in try await self.press(press, rev: rev) })
    }

    func state() async throws -> ClickerShow? {
        let live = ShowRows.running(try await host.readShows(itemId: itemId), itemId: itemId)
        showId = live?.showId
        return live.flatMap { ClickerShow($0) }
    }

    func press(_ press: ClickerPress, rev: Int) async throws -> ClickerShow? {
        guard let showId else { return nil }
        let answer = try await host.pressShow(showId, act: press.act, rev: rev)
        // Ended: the clicker says so. Moved on (another device pressed first): the show as it is now, by its rev.
        if answer.dropped == .ended { return nil }
        guard let live = answer.live else { return nil }
        return ClickerShow(live)
    }

    /// A push of `showId` is for the show this link steps.
    public func owns(_ pushed: String) -> Bool { pushed == showId }
}

extension WorkHost {
    /// The shows running on windows of this host that the key may see, of one deck or of all; kept in `shows`.
    public func readShows(itemId: String? = nil) async throws -> [ShowLive] {
        let shows = try await socket.request(Methods.WorkSlidesShowState.self, .init(itemId: itemId)).shows
        takeShows(shows, itemId: itemId)
        return shows
    }

    /// His press on a running show, made on the `rev` he saw.
    public func pressShow(_ showId: String, act: Methods.WorkSlidesShowPress.Params.Act, rev: Int) async throws -> Methods.WorkSlidesShowPress.Output {
        let answer = try await socket.request(Methods.WorkSlidesShowPress.self, .init(showId: showId, act: act, rev: rev))
        if let live = answer.live { takeShow(showId: live.showId, live) } else if answer.dropped == .ended { takeShow(showId: showId, nil) }
        return answer
    }
}
