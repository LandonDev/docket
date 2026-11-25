/// The Outbox's Send on the phone (plan "Send waits its whole five seconds"):
/// a press waits five seconds with Undo before the host hears it, and nothing
/// leaves early. A second Send waits its own turn: its five seconds start
/// once the first has gone or been undone, so two are never in flight. The
/// app leaving the screen, or the link to the press's host dropping, cancels
/// what waits and puts it back, saying so. When the five seconds end the
/// press goes only if the link, the key and the item's revision still hold.
///
/// Pure and clock-free: the app's `OutboxPresses` passes the time in and
/// sleeps until `deadline`. `Payload` is what the dispatch needs (the item).
public struct SendWait<Payload: Sendable & Hashable>: Sendable, Hashable {
    public static var seconds: Double { 5 }

    public struct Press: Sendable, Hashable, Identifiable {
        /// The entry's id (host and item).
        public var id: String
        /// The host's environment id.
        public var host: String
        public var hostName: String
        /// The item's `updatedAt` as the screen showed it.
        public var rev: Double
        /// "Sending to Dana…", the capsule's line while it waits.
        public var line: String
        public var payload: Payload
        /// The other hosts a press on many reaches: a lost link or key on any of them puts the whole press back.
        public var also: Set<String>
        /// The key he pressed under (`PressGates.key`, frozen before the owner's check): another key on the host when
        /// the seconds end (a client replaced, the same capability or not) puts the press back. Nil: not checked.
        public var key: String?

        public init(id: String, host: String, hostName: String, rev: Double, line: String, payload: Payload, also: Set<String> = [], key: String? = nil) {
            self.id = id
            self.host = host
            self.hostName = hostName
            self.rev = rev
            self.line = line
            self.payload = payload
            self.also = also
            self.key = key
        }

        /// The press goes to this host.
        public func reaches(_ host: String) -> Bool { self.host == host || also.contains(host) }
    }

    /// The press's host as it is when the five seconds end.
    public struct Check: Sendable, Hashable {
        /// A live socket to the host (and, through the box, the host awake and reachable).
        public var linked: Bool
        /// The key may still send there (KeyMay `.outboxSend`).
        public var maySend: Bool
        /// The item's `updatedAt` now; nil when it no longer waits on the host.
        public var rev: Double?
        /// The key on the host now (`PressGates.key`).
        public var key: String?

        public init(linked: Bool, maySend: Bool, rev: Double?, key: String? = nil) {
            self.linked = linked
            self.maySend = maySend
            self.rev = rev
            self.key = key
        }
    }

    /// Why one part of a press that has not left yet may not start now, or nil: each host's part of a press on many,
    /// and the send after a grant, are asked again just before their own request (the app back in front, the link,
    /// the key still able to send and still the one he pressed under). A part not started is reported, never sent.
    public static func mayStart(foreground: Bool, linked: Bool, maySend: Bool, key: String?, liveKey: String?) -> Why? {
        if !foreground { return .leftScreen }
        if !linked { return .linkLost }
        if !maySend { return .keyLost }
        return keyWhy(frozen: key, live: liveKey)
    }

    /// The frozen key against the live one (`PressGates.key`: the key's id and words, then `|f<n>`, the foreground the
    /// press was approved in). The same key in a later foreground is the app having left and come back since: the
    /// press is not his any more (`.leftScreen`), even with the same key, link and app in front now. Another key is
    /// `.keyLost`. Nil when no key was frozen, or both match.
    public static func keyWhy(frozen: String?, live: String?) -> Why? {
        guard let frozen, frozen != live else { return nil }
        guard let live else { return .keyLost }
        let base = { (key: String) -> Substring in key.range(of: "|f", options: .backwards).map { key[..<$0.lowerBound] } ?? key[...] }
        return base(frozen) == base(live) ? .leftScreen : .keyLost
    }

    /// Why a press whose seconds ended may not go, or nil: the link, the key (still able to send, and still the key
    /// he pressed under), the item's revision.
    public static func why(_ check: Check, rev: Double, key: String?) -> Why? {
        if !check.linked { return .linkLost }
        if !check.maySend { return .keyLost }
        if let why = keyWhy(frozen: key, live: check.key) { return why }
        if check.rev == nil { return .gone }
        if check.rev != rev { return .changed }
        return nil
    }

    public enum Why: Sendable, Hashable {
        case leftScreen, linkLost, keyLost, changed, gone, notPaired
    }

    /// What did not go, and the one line that says so.
    public struct Notice: Sendable, Hashable {
        public var presses: [Press]
        public var why: Why

        public var line: String {
            SendWait.line(why, hostName: presses.first?.hostName ?? "the host", count: presses.count)
        }
    }

    /// "Not sent: lost the link to Mac", "2 not sent: TempCode left the screen".
    public static func line(_ why: Why, hostName: String, count: Int = 1) -> String {
        let cause = switch why {
        case .leftScreen: "TempCode left the screen"
        case .linkLost: "lost the link to \(hostName)"
        case .keyLost: "this iPhone’s key can’t send on \(hostName)"
        case .changed: "it changed after you pressed Send"
        case .gone: "it no longer waits"
        case .notPaired: "the host is not paired"
        }
        return count > 1 ? "\(count) not sent: \(cause)" : "Not sent: \(cause)"
    }

    /// The press counting its five seconds, and when they end.
    public private(set) var counting: Press?
    public private(set) var deadline: Double?
    /// Pressed after it, each waiting its turn.
    public private(set) var queued: [Press] = []
    /// Gone to the host; its answer has not landed.
    public private(set) var inFlight: Press?
    /// The last cancel, for the bar to say until the next press.
    public private(set) var notice: Notice?

    public init() {}

    /// The list hides every press it holds: counting, queued and in flight.
    public func holds(_ id: String) -> Bool {
        counting?.id == id || inFlight?.id == id || queued.contains { $0.id == id }
    }

    /// A Send. A press it already holds is not taken twice.
    public mutating func press(_ press: Press, now: Double) {
        guard !holds(press.id) else { return }
        notice = nil
        queued.append(press)
        startNext(now: now)
    }

    /// Undo: the counting press goes back, nothing sent; the next in line starts its own five seconds.
    @discardableResult
    public mutating func undo(now: Double) -> Press? {
        guard let press = counting else { return nil }
        counting = nil
        deadline = nil
        startNext(now: now)
        return press
    }

    /// The press counting now when no page that offers its Undo is on screen (`shown` says whether one is): the tab's
    /// foot then offers it, so Undo stays in reach through the whole wait, a queued press's own too.
    public func countingOffScreen(_ shown: (Press) -> Bool) -> Press? {
        guard let counting, !shown(counting) else { return nil }
        return counting
    }

    /// The countdown to put Undo up for: the one counting, unless its capsule is the one already up (`offered`).
    public func toOffer(after offered: String?) -> Press? {
        guard let counting, counting.id != offered else { return nil }
        return counting
    }

    /// How a press that left the wait ended, for an Undo that comes after it (a shake or ⌘Z once the seconds ran out).
    public enum Ended: Sendable, Hashable { case sent, notSent, unknown }

    /// What a late Undo says: nil while the press still waits (Undo takes it back); else why nothing was undone, so a
    /// late Undo never does nothing in silence and never claims a mail came back.
    public func lateUndo(_ id: String, ended: Ended?) -> String? {
        if counting?.id == id || queued.contains(where: { $0.id == id }) { return nil }
        if inFlight?.id == id { return "Already on its way" }
        switch ended {
        case .sent?: return "Already sent"
        case .notSent?: return "It was not sent"
        case .unknown?: return "Checking whether it went"
        case nil: return "Too late to undo"
        }
    }

    /// Undo of one press by its id, counting or still in line (a capsule that names it): it goes back, nothing sent,
    /// and says nothing. Nil once it is in flight or gone.
    @discardableResult
    public mutating func undo(_ id: String, now: Double) -> Press? {
        let gone = cancel { $0.id == id }
        startNext(now: now)
        return gone.first
    }

    /// The five seconds may have ended: the press to send now, or nil. A failed check cancels it and says why.
    public mutating func due(now: Double, check: Check) -> Press? {
        guard let press = counting, let deadline, now >= deadline else { return nil }
        counting = nil
        self.deadline = nil
        if let why = Self.why(check, rev: press.rev, key: press.key) {
            notice = Notice(presses: [press], why: why)
            startNext(now: now)
            return nil
        }
        inFlight = press
        return press
    }

    /// The press could not start at all (its host left the phone).
    public mutating func drop(_ id: String, why: Why, now: Double) {
        let gone = cancel { $0.id == id }
        if !gone.isEmpty { notice = Notice(presses: gone, why: why) }
        startNext(now: now)
    }

    /// The host answered the press in flight (sent, or refused in its own words): the next one starts.
    public mutating func landed(_ id: String, now: Double) {
        guard inFlight?.id == id else { return }
        inFlight = nil
        startNext(now: now)
    }

    /// TempCode left the screen: everything not yet sent goes back.
    public mutating func leftScreen() {
        let gone = cancel { _ in true }
        if !gone.isEmpty { notice = Notice(presses: gone, why: .leftScreen) }
    }

    /// The link to one host dropped: its presses go back; another host's next press starts.
    public mutating func linkLost(host: String, now: Double) {
        let gone = cancel { $0.reaches(host) }
        if !gone.isEmpty { notice = Notice(presses: gone, why: .linkLost) }
        startNext(now: now)
    }

    /// The key on one host lost the right to send: its presses go back.
    public mutating func keyLost(host: String, now: Double) {
        let gone = cancel { $0.reaches(host) }
        if !gone.isEmpty { notice = Notice(presses: gone, why: .keyLost) }
        startNext(now: now)
    }

    public mutating func clearNotice() {
        notice = nil
    }

    /// Takes the counting and queued presses that match out of the line, in order.
    private mutating func cancel(_ matches: (Press) -> Bool) -> [Press] {
        var gone: [Press] = []
        if let press = counting, matches(press) {
            gone.append(press)
            counting = nil
            deadline = nil
        }
        gone += queued.filter(matches)
        queued.removeAll(where: matches)
        return gone
    }

    private mutating func startNext(now: Double) {
        guard counting == nil, inFlight == nil, !queued.isEmpty else { return }
        counting = queued.removeFirst()
        deadline = now + Self.seconds
    }
}

/// Where his Send's countdown and Undo show once he pressed it on an item's own page (plan "Send waits its whole five
/// seconds": Undo is on screen for the whole wait). The Outbox's list wears the capsule; the item's page wears it
/// only when no list would be seen.
public enum SendUndoPlace: Sendable, Hashable {
    /// The item gives way to the Outbox's list (popped back to it, or the list brought up over where he was).
    case list
    /// The item stays, with the capsule over its foot: the Duo's sidebar is hidden, so a list there is out of sight.
    case item

    /// `split`: the detail sits beside a sidebar column; `sidebarVisible`: that column shows now (his toggle, a wide
    /// route, the overlay); `outboxBeside`: what it shows is the Outbox's list (else Today, a thread, another place,
    /// which wears no capsule, and the item keeps it). In a stack the list comes up over where he was.
    public static func of(split: Bool, sidebarVisible: Bool, outboxBeside: Bool = true) -> SendUndoPlace {
        split && !(sidebarVisible && outboxBeside) ? .item : .list
    }
}
