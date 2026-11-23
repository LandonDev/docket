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
    /// The speaker notes of slide `notesSlide`; empty when it has none.
    public var notes: String
    /// The slide `notes` belong to. A press moves `slide` at once; the notes stay the last slide's until the host
    /// says the new one's, so the two can differ.
    public var notesSlide: Int
    /// Every slide's notes, first slide first, when the host sends them all: a press then takes the new slide's
    /// notes at once. Nil when the host sends one slide's at a time.
    public var allNotes: [String]?
    /// Wall-clock milliseconds the show started, for the timer.
    public var startedAt: Double?
    /// The screen shows black instead of the slide.
    public var blank: Bool
    /// Moves with every change of the show; a press names the one it was made on, so the host drops a stale press.
    public var rev: Int

    /// `notesSlide`: the slide the notes are for; nil is `slide`.
    public init(itemId: String, name: String, slide: Int, count: Int, notes: String = "", notesSlide: Int? = nil, allNotes: [String]? = nil, startedAt: Double? = nil, blank: Bool = false, rev: Int) {
        self.itemId = itemId
        self.name = name
        self.slide = slide
        self.count = count
        self.notes = notes
        self.notesSlide = notesSlide ?? slide
        self.allNotes = allNotes
        self.startedAt = startedAt
        self.blank = blank
        self.rev = rev
    }

    /// "4 / 12".
    public var position: String { "\(slide) / \(count)" }
    public var isFirst: Bool { slide <= 1 }
    public var isLast: Bool { slide >= count }

    /// The notes of the slide the count shows; nil while they are on their way.
    public var slideNotes: String? { notesSlide == slide ? notes : nil }

    /// Takes the notes of slide `slide` from `allNotes`, when it holds them.
    mutating func noteSlide() {
        guard notesSlide != slide, let all = allNotes, all.indices.contains(slide - 1) else { return }
        notes = all[slide - 1]
        notesSlide = slide
    }
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

/// The clicker's state (PF6). A press answers at once: the count follows his finger, and the press joins one
/// queue that sends a press only once the one before it is answered, made on the `rev` that answer left. The
/// host's answers and pushes are taken by `rev`, so an older one never overwrites a newer; while his own presses
/// are on the way the screen keeps what he pressed. A refusal drops the presses still queued.
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
    /// His presses not yet sent, oldest first.
    @ObservationIgnored private var queue: [ClickerPress] = []
    /// The task that sends the queue, one press at a time; nil while the queue is empty.
    @ObservationIgnored private var sender: Task<Void, Never>?
    @ObservationIgnored private let wire: ClickerWire

    public init(wire: ClickerWire) {
        self.wire = wire
    }

    nonisolated public var id: ObjectIdentifier { ObjectIdentifier(self) }

    /// The notes of the slide the count shows; nil while the host has not said them.
    public var notes: String? { show?.slideNotes }

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
    /// sent. Otherwise the show moves now and the press joins the queue.
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
        // The host moves `rev` by one for each change it takes; the screen's show runs ahead of it by his presses.
        if press != .end {
            moved.rev += 1
            moved.noteSlide()
            show = moved
        }
        queue.append(press)
        // The first press is made on the show he saw; each later one on the rev the answer before it left.
        if sender == nil { sender = Task { await self.drain(from: madeOn) } }
        return true
    }

    /// Waits for every press made so far to be answered (tests, proofs).
    public func settle() async {
        while let task = sender { await task.value }
    }

    // MARK: - answers

    /// Sends the queue in order, each press once the one before it is answered.
    private func drain(from first: Int) async {
        var rev = first
        while !queue.isEmpty {
            let press = queue.removeFirst()
            do {
                let after = try await wire.press(press, rev)
                guard let after else {
                    queue = []
                    sender = nil
                    return finish()
                }
                refusal = nil
                rev = after.rev
                if host.map({ after.rev >= $0.rev }) ?? true { host = after }
                takeNotes()
            } catch {
                // What he pressed after a refused press was made on a show that never came: none of it is sent.
                queue = []
                refusal = Self.words(error)
            }
        }
        sender = nil
        show = host
    }

    /// A show the host said: kept when it is not older than the one held, and shown unless his own presses on
    /// the way are ahead of it.
    private func take(_ said: ClickerShow) {
        if let host, said.rev < host.rev { return }
        host = said
        ended = false
        if sender == nil || said.rev >= (show?.rev ?? 0) {
            show = said
        } else {
            takeNotes()
        }
    }

    /// While his presses are on the way: the host's notes, once they are for the slide the count shows.
    private func takeNotes() {
        guard let host, var shown = show, shown.notesSlide != shown.slide, host.notesSlide == shown.slide else { return }
        shown.notes = host.notes
        shown.notesSlide = host.notesSlide
        show = shown
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
