import Foundation
import Observation

/// A slideshow running on one of his computers, as the clicker reads it (PF6).
public struct ClickerShow: Equatable, Sendable {
    public let itemId: String
    /// The deck's name.
    public var name: String
    /// From 1.
    public var slide: Int
    public var count: Int
    /// The slide's speaker notes; empty when it has none.
    public var notes: String
    /// Wall-clock milliseconds the show started, for the timer.
    public var startedAt: Double?
    /// The screen shows black instead of the slide.
    public var blank: Bool
    /// Moves with every change of the show; a press names the one it was made on, so the host drops a stale press.
    public var rev: Int

    public init(itemId: String, name: String, slide: Int, count: Int, notes: String = "", startedAt: Double? = nil, blank: Bool = false, rev: Int) {
        self.itemId = itemId
        self.name = name
        self.slide = slide
        self.count = count
        self.notes = notes
        self.startedAt = startedAt
        self.blank = blank
        self.rev = rev
    }

    /// "4 / 12".
    public var position: String { "\(slide) / \(count)" }
    public var isFirst: Bool { slide <= 1 }
    public var isLast: Bool { slide >= count }
}

/// What a press asks of the show.
public enum ClickerPress: String, Sendable, CaseIterable {
    case next, previous, blank, end
}

/// The host's words for a press or a read it refused. The adapter from the wire throws it, so the screen shows
/// the host's own sentence.
public struct ClickerRefusal: Error, Equatable, Sendable {
    public let words: String

    public init(_ words: String) {
        self.words = words
    }
}

/// The show's wire as closures, so the model needs no socket: the slides build's `work.slides.show.state` and
/// `press` (SLD9) map onto it in one adapter, and a test or a proof passes its own.
public struct ClickerWire: Sendable {
    /// The show running now; nil when none runs.
    public var state: @MainActor @Sendable () async throws -> ClickerShow?
    /// The show after the press, made on `rev`; nil when it ended.
    public var press: @MainActor @Sendable (ClickerPress, _ rev: Int) async throws -> ClickerShow?

    public init(
        state: @escaping @MainActor @Sendable () async throws -> ClickerShow?,
        press: @escaping @MainActor @Sendable (ClickerPress, _ rev: Int) async throws -> ClickerShow?
    ) {
        self.state = state
        self.press = press
    }
}

/// The clicker's state (PF6). A press answers at once: the count follows his finger, and the press goes to the
/// host in a task of its own, made on the `rev` it saw. The host's answers and pushes are taken by `rev`, so an
/// older one never overwrites a newer; while his own presses are on the way the screen keeps what he pressed.
@MainActor @Observable
public final class ClickerModel: Identifiable {
    /// What the screen shows: the host's show with his presses on the way laid over it.
    public private(set) var show: ClickerShow?
    /// A show that ran here stopped, or moved to another machine.
    public private(set) var ended = false
    /// The host's words for the last press it refused; cleared by the next press that lands.
    public private(set) var refusal: String?
    /// The host answered the first read.
    public private(set) var loaded = false
    /// Why the first read failed; nil once one succeeds.
    public private(set) var failure: String?

    /// The newest show the host has said, by `rev`.
    @ObservationIgnored private var host: ClickerShow?
    /// His presses sent and not yet answered.
    @ObservationIgnored private var inFlight = 0
    /// The presses on the way, by the order they were made; each removes itself when answered.
    @ObservationIgnored private var tasks: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private var made = 0
    @ObservationIgnored private let wire: ClickerWire

    public init(wire: ClickerWire) {
        self.wire = wire
    }

    nonisolated public var id: ObjectIdentifier { ObjectIdentifier(self) }

    public func load() async {
        do {
            let read = try await wire.state()
            loaded = true
            failure = nil
            guard let read else { return finish() }
            take(read)
        } catch {
            failure = Self.words(error)
        }
    }

    /// The push: another device stepped the show, or it ended. One older than what is held is ignored.
    public func apply(_ pushed: ClickerShow?) {
        guard let pushed else {
            if show != nil || host != nil { finish() }
            return
        }
        take(pushed)
    }

    /// False when the press can do nothing (Next on the last slide, Previous on the first, no show): nothing is
    /// sent. Otherwise the show moves now and the press goes to the host.
    @discardableResult
    public func press(_ press: ClickerPress) -> Bool {
        guard !ended, var moved = show else { return false }
        let madeOn = moved.rev
        switch press {
        case .next:
            guard !moved.isLast else { return false }
            moved.slide += 1
        case .previous:
            guard !moved.isFirst else { return false }
            moved.slide -= 1
        case .blank:
            moved.blank.toggle()
        case .end:
            break
        }
        // The host moves `rev` by one for each change it takes; a second press made before the first is
        // answered is made on the show the first will leave.
        if press != .end {
            moved.rev += 1
            show = moved
        }
        inFlight += 1
        made += 1
        let order = made
        tasks[order] = Task {
            await self.send(press, madeOn)
            self.tasks[order] = nil
        }
        return true
    }

    /// Waits for every press sent so far to be answered (tests, proofs).
    public func settle() async {
        while let next = tasks.keys.min(), let task = tasks[next] {
            await task.value
        }
    }

    // MARK: - answers

    private func send(_ press: ClickerPress, _ rev: Int) async {
        do {
            let after = try await wire.press(press, rev)
            inFlight -= 1
            guard let after else { return finish() }
            refusal = nil
            if host.map({ after.rev >= $0.rev }) ?? true { host = after }
            if inFlight == 0 { show = host }
        } catch {
            inFlight -= 1
            refusal = Self.words(error)
            if inFlight == 0 { show = host }
        }
    }

    /// A show the host said: kept when it is not older than the one held, and shown unless his own presses on
    /// the way are ahead of it.
    private func take(_ said: ClickerShow) {
        if let host, said.rev < host.rev { return }
        host = said
        ended = false
        if inFlight == 0 || said.rev >= (show?.rev ?? 0) { show = said }
    }

    private func finish() {
        show = nil
        host = nil
        ended = true
    }

    private static func words(_ error: any Error) -> String {
        if let refusal = error as? ClickerRefusal { return refusal.words }
        return (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
}
