import Foundation
import Observation
import TempCodeContract

/// Keeps only the newest reply: each ask takes the next number, and a reply is applied only when its number is
/// above every one applied before. A reply asked before a later one was applied is dropped.
public struct NewestReply: Sendable {
    private var asked = 0
    private var applied = 0

    public init() {}

    /// The number of an ask made now.
    public mutating func ask() -> Int {
        asked += 1
        return asked
    }

    /// Whether the reply to ask `ticket` is still the newest; true marks it applied.
    public mutating func apply(_ ticket: Int) -> Bool {
        guard ticket > applied else { return false }
        applied = ticket
        return true
    }
}

/// The browser item's state on the phone (milestone 47's `work.browser.state` and `work.browser.drive`): its reads
/// and his Take Over and Hand Back, in the order they were asked. A read that was out when Take Over answered is
/// older than that answer, so it can never bring back "The agent is driving": the drive call's state counts as newer
/// than every read asked before it returned.
@MainActor @Observable
public final class BrowserStateModel {
    public private(set) var state: BrowserState?
    /// why the first read failed; a later failure keeps what was shown
    public private(set) var error: String?
    /// a read that failed while a state was shown: the state stays, with this line and Retry; the next applied reply clears it
    public private(set) var refreshError: String?
    /// reads out now: Retry shows it is busy
    public private(set) var reading = 0
    public private(set) var driving = false

    @ObservationIgnored private var replies = NewestReply()
    @ObservationIgnored private let readState: () async throws -> BrowserState
    @ObservationIgnored private let driveState: (Bool) async throws -> BrowserState
    @ObservationIgnored private let describe: (any Error) -> String

    public init(
        read: @escaping () async throws -> BrowserState,
        drive: @escaping (_ owner: Bool) async throws -> BrowserState,
        describe: @escaping (any Error) -> String = { ActionError.wrap($0).message }
    ) {
        readState = read
        driveState = drive
        self.describe = describe
    }

    public convenience init(client: EnvironmentClient, sessionId: String) {
        self.init(
            read: { [weak client] in
                guard let client else { throw CancellationError() }
                return try await client.work.canvas.browser(sessionId)
            },
            drive: { [weak client] owner in
                guard let client else { throw CancellationError() }
                return try await client.work.canvas.drive(sessionId, owner: owner)
            }
        )
    }

    public func read() async {
        let ticket = replies.ask()
        reading += 1
        defer { reading -= 1 }
        do {
            let read = try await readState()
            if replies.apply(ticket) {
                state = read
                error = nil
                refreshError = nil
            }
        } catch {
            if state == nil { self.error = describe(error) } else { refreshError = describe(error) }
        }
    }

    /// Take Over (`owner` true) or Hand Back; throws what the host said, for the view's line.
    public func drive(owner: Bool) async throws {
        driving = true
        defer { driving = false }
        let answer = try await driveState(owner)
        // numbered when it returned: newer than every read asked before, older than any asked after
        if replies.apply(replies.ask()) {
            state = answer
            error = nil
            refreshError = nil
        }
    }
}
