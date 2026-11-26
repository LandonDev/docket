import Foundation
import TempCodeContract

/// Select, ticks and one press on many on the phone's Outbox (docs/IOS-DESIGN.md "Work on the phone"; Outbox 2's
/// "Bulk"; the prototype `work-ios/outbox.html`), with no SwiftUI: which rows take a tick, the ticks themselves, the
/// press frozen at his Send or Discard, its one sentence and the sum of its results. The views draw what these
/// answer; the tests read them.
public extension OutboxModel {
    // MARK: - what takes a tick

    /// A row he may tick: it waits on his plain press (held, not timed), its last send never may have gone, and its
    /// list row is enough to judge it. A failed send (Send Again is his own press on one item), an out-of-date item
    /// (Discard or Ask Again alone), an act read from a live screen and a computer act (each sent from its own page)
    /// take no tick, as the prototype draws them.
    nonisolated static func tickable(_ item: OutboxItem) -> Bool {
        item.state == .held && item.scheduledFor == nil && item.outcomeUnknown != true && item.kind != .computerAct
    }

    /// A LifeOS mail read whole that quotes the mail it answers: it goes only from its own page, alone (the host
    /// refuses it inside a press on many, outbox.ts `OPEN_TO_SEND`), so the summary says "Open to send" and keeps
    /// it out of Send; Discard still takes it.
    nonisolated static func quotesItsMail(_ whole: OutboxItem) -> Bool {
        guard whole.kind == .mailSend, case .object(let p)? = whole.payload, case .string(let quote)? = p["quote"] else { return false }
        return !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The summary row's word for one that only its own page sends.
    nonisolated static let openToSend = "Open to send"

    // MARK: - the one count

    /// The Outbox's one count on the phone: what waits on him (`needsHim`, master's shared rule), less what a Send
    /// holds back right now (`holds`: counting its five seconds, waiting its turn, or on its way). The Work list's
    /// Outbox row, Today's line and any badge read this and nothing else.
    nonisolated static func waitingCount(_ entries: [Entry], holds: (Entry) -> Bool) -> Int {
        entries.count(where: { needsHim($0.item) && !holds($0) })
    }

    /// The count across hosts: a host whose list has answered on this link counts its items; one that has not yet
    /// counts the rows the phone kept of it (`WorkCache.waiting`, written only from rows that need him).
    nonisolated static func waitingCount(_ hosts: [CountedHost], holds: (Entry) -> Bool) -> Int {
        hosts.reduce(0) { sum, host in sum + (host.listed ? waitingCount(host.entries, holds: holds) : host.kept) }
    }

    /// One host as the count reads it.
    struct CountedHost: Sendable, Hashable {
        public var listed: Bool
        public var entries: [Entry]
        /// Rows kept on the phone from its last list (`WorkCache.waiting`).
        public var kept: Int

        public init(listed: Bool, entries: [Entry], kept: Int = 0) {
            self.listed = listed
            self.entries = entries
            self.kept = kept
        }
    }

    // MARK: - the next pick on the open Duo

    /// The rows the open Duo's detail may take next, in order (`ShellSelection.decide`'s `first`). `now`: the rows
    /// that need him as the list draws them now, less any a Send holds back. `seen`: the same before this change,
    /// with the held-back ones still in place, since he saw them there. `shown`: the detail's row.
    ///
    /// With nothing shown, or the shown row still listed, the list's own order. When the shown row left (sent once
    /// its wait ended, discarded, scheduled), the next row after it that he saw and that still waits; at the end of
    /// the list the nearest one before it; none when nothing he saw is left, so the detail clears rather than open a
    /// row he never saw.
    nonisolated static func pickOrder(now: [String], seen: [String], shown: String?) -> [String] {
        guard let shown, !now.contains(shown) else { return now }
        let still = Set(now)
        guard let at = seen.firstIndex(of: shown) else { return seen.first(where: still.contains).map { [$0] } ?? [] }
        let next = seen[(at + 1)...].first(where: still.contains) ?? seen[..<at].last(where: still.contains)
        return next.map { [$0] } ?? []
    }
}

/// His ticks on the Outbox, in the order he made them (the summary lists them so). A tick is an entry's id
/// (`OutboxModel.Entry.id`, host and item). Pure: the list and the summary both write it.
public struct OutboxSelection: Sendable, Hashable {
    /// The ticked rows.
    public private(set) var ticked: Set<String> = []
    /// Every row the summary lists, in the order first ticked: a row he unticks in the summary stays listed, so he
    /// can tick it again; one he unticks in the list leaves it.
    public private(set) var listed: [String] = []

    public init() {}

    public var count: Int { ticked.count }
    public var isEmpty: Bool { ticked.isEmpty }

    public func contains(_ id: String) -> Bool { ticked.contains(id) }

    /// A tick in the list.
    public mutating func toggle(_ id: String) {
        if ticked.remove(id) != nil {
            listed.removeAll { $0 == id }
        } else {
            ticked.insert(id)
            if !listed.contains(id) { listed.append(id) }
        }
    }

    /// A tick in the summary: the row stays listed either way.
    public mutating func toggleInSummary(_ id: String) {
        guard listed.contains(id) else { return }
        if ticked.remove(id) == nil { ticked.insert(id) }
    }

    /// Select All on a section's heading: every tickable row of it; with all of them ticked already, Deselect All.
    public mutating func toggleAll(_ ids: [String]) {
        if allTicked(ids) {
            for id in ids { if ticked.remove(id) != nil { listed.removeAll { $0 == id } } }
        } else {
            for id in ids where !ticked.contains(id) { toggle(id) }
        }
    }

    /// Every row of these is ticked (a heading reads Deselect All).
    public func allTicked(_ ids: [String]) -> Bool {
        !ids.isEmpty && ids.allSatisfy(ticked.contains)
    }

    public mutating func clear() {
        ticked = []
        listed = []
    }

    /// The ticks that still hold on the list as it stands: a row that left, or no longer takes a tick (decided
    /// elsewhere, changed to failed, out of date), loses its tick and its place in the summary.
    public mutating func keep(_ tickable: Set<String>) {
        ticked.formIntersection(tickable)
        listed.removeAll { !tickable.contains($0) }
    }
}

/// His Send or Discard on the ticked rows, frozen at his press: each item exactly as he saw it, one sentence of what
/// goes, and the decisions each host hears in `work.outbox.decide`. A group never carries a grant and never `again`
/// (`HeldPress.Source.group`): each item is a `HeldPress` made from the group.
public struct GroupPress: Sendable, Hashable {
    public enum Act: Sendable, Hashable {
        case send
        case discard(reason: String?)
    }

    /// The items, in the summary's order, each as a press made from the group.
    public let presses: [HeldPress]
    public let act: Act

    /// Nil with nothing to press. `entries` are the ticked rows as the summary drew them; for a Send, those only
    /// their own page sends (`openOnly`) are left out.
    public init?(_ entries: [OutboxModel.Entry], act: Act, openOnly: Set<String> = []) {
        let taken = if case .send = act { entries.filter { !openOnly.contains($0.id) } } else { entries }
        guard !taken.isEmpty else { return nil }
        presses = taken.map { HeldPress(entry: $0, from: .group(taken.count)) }
        self.act = act
    }

    public var entries: [OutboxModel.Entry] { presses.map(\.entry) }
    public var hosts: [String] { Self.unique(entries.map(\.environmentId)) }
    /// The press's own id in the wait: the items' ids, sorted.
    public var id: String { "group:" + entries.map(\.id).sorted().joined(separator: ",") }

    /// One sentence of everything it does: "Send 2 mails to 2 people and post 1 message", "Discard 3".
    public var head: String { Self.head(entries.map(\.item), act: act) }

    /// The summary's head for these items and this act (master's `summaryHead`, the desktop's words).
    public static func head(_ items: [OutboxItem], act: Act) -> String {
        switch act {
        case .send: OutboxModel.summaryHead(items)
        case .discard: OutboxModel.summaryHead([], discard: items.count)
        }
    }

    /// The capsule's line while it waits: the head turned to its progressive ("Sending 2 mails to 2 people and
    /// posting 1 message").
    public var waitingLine: String { Self.progressiveHead(head) }

    /// "Send 2 mails and post 1 message" → "Sending 2 mails and posting 1 message": each part's leading verb, as
    /// `summaryHead` joins its parts (", " and " and ").
    static func progressiveHead(_ head: String) -> String {
        let parts = head.components(separatedBy: ", ").flatMap { $0.components(separatedBy: " and ") }
        var out = head
        for part in parts {
            guard let verb = part.split(separator: " ").first, Int(verb) == nil else { continue }
            let turned = OutboxModel.progressive(String(verb))
            if let range = out.range(of: part) { out.replaceSubrange(range, with: turned + part.dropFirst(verb.count)) }
        }
        return out
    }

    /// What one host hears: each of its items with what to do and the revision he saw, never `again` (a group is
    /// not his Send Again of one item, even a group of one) and never a grant.
    public func decisions(host: String) -> [Methods.WorkOutboxDecide.Params.Item] {
        entries.filter { $0.environmentId == host }.map { entry in
            let item = entry.item
            return switch act {
            case .send: .init(ref: item.ref, do: .send, rev: item.updatedAt)
            case .discard(let reason): .init(ref: item.ref, do: .discard, rev: item.updatedAt, reason: Self.trimmed(reason))
            }
        }
    }

    /// The owner's check is asked once for the whole press, bound to every item and the revision he saw of each.
    public var gateRef: String { entries.map { OutboxModel.key($0.item.ref) }.sorted().joined(separator: ",") }
    public var gateRev: String {
        entries.sorted { OutboxModel.key($0.item.ref) < OutboxModel.key($1.item.ref) }.map { String($0.item.updatedAt) }.joined(separator: ",")
    }

    static func trimmed(_ reason: String?) -> String? {
        guard let words = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty else { return nil }
        return String(words.prefix(500))
    }

    static func unique(_ list: [String]) -> [String] {
        var seen = Set<String>()
        return list.filter { seen.insert($0).inserted }
    }
}

/// What a press on many came to, item by item, as each host answers (`work.outbox.decide`'s results): a done
/// item's word, or why it did not go. An item that did not go stays in the list with its reason.
public struct GroupOutcome: Sendable, Hashable {
    public enum Result: Sendable, Hashable {
        /// Its word where it adds one ("Queued in LifeOS", "Posted", "Discarded"); empty for a plain Sent.
        case done(String)
        case failed(String)
        /// The host tried and could not confirm (`outcomeUnknown`): it may have gone, never "not sent".
        case mayHaveGone
        /// Its host's answer was lost: the row says Checking… from the press record until it is read back.
        case checking
    }

    public let did: GroupPress.Act
    /// By entry id.
    public private(set) var results: [String: Result] = [:]

    public init(did: GroupPress.Act) {
        self.did = did
    }

    /// One host's answer, matched to the press's items by their refs.
    public mutating func take(host: String, _ answers: [DecisionResult], of press: GroupPress) {
        for answer in answers {
            let key = OutboxModel.key(answer.ref)
            guard let entry = press.entries.first(where: { $0.environmentId == host && OutboxModel.key($0.item.ref) == key }) else { continue }
            // One reading of an item's answer, on time or late (`DecisionResult.state`).
            switch answer.state {
            case .done: results[entry.id] = .done(Self.doneWord(answer.item ?? entry.item, did: did))
            case .mayHaveGone: results[entry.id] = .mayHaveGone
            default: results[entry.id] = .failed(Self.reason(answer.error ?? answer.item?.error, did: did))
            }
        }
    }

    /// A host that did not answer at all (no link at dispatch, a refusal of the whole call): each of its items
    /// says why.
    public mutating func fail(host: String, _ why: String, of press: GroupPress) {
        for entry in press.entries where entry.environmentId == host && results[entry.id] == nil {
            results[entry.id] = .failed(why)
        }
    }

    /// A host whose answer was lost (`PressLedger.Unknown`): its items count as checking in the sum, so a two-host
    /// press never reads "Sent 1" as if it were the whole.
    public mutating func lost(host: String, of press: GroupPress) {
        for entry in press.entries where entry.environmentId == host && results[entry.id] == nil {
            results[entry.id] = .checking
        }
    }

    /// The reason an item did not go, by entry id ("May have gone" for one the host could not confirm); nil for one
    /// that went.
    public func reason(_ id: String) -> String? {
        switch results[id] {
        case .failed(let why)?: return why
        case .mayHaveGone?: return PressState.mayHaveGone.line
        default: return nil
        }
    }

    /// The head once it answered (the desktop's `resultsHead`): "Sent 2, 1 not sent", "Sent 1, queued 2 in LifeOS",
    /// "Discarded 3"; empty before any answer.
    public var head: String {
        let done = results.values.compactMap { if case .done(let w) = $0 { w } else { nil } }
        let failed = results.values.count(where: { if case .failed = $0 { true } else { false } })
        let unknown = results.values.count(where: { $0 == .mayHaveGone })
        let checking = results.values.count(where: { $0 == .checking })
        let discard = if case .discard = did { true } else { false }
        let queued = discard ? 0 : done.count(where: { $0 == "Queued in LifeOS" })
        let went = done.count - queued
        let (yes, no) = discard ? ("Discarded", "not discarded") : ("Sent", "not sent")
        let line = [went > 0 ? "\(yes) \(went)" : nil, queued > 0 ? "queued \(queued) in LifeOS" : nil, unknown > 0 ? "\(unknown) may have gone" : nil, failed > 0 ? "\(failed) \(no)" : nil, checking > 0 ? "\(checking) checking" : nil]
            .compactMap { $0 }.joined(separator: ", ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }

    /// The desktop's `doneWords`: what an item that went now is, where that adds to "Sent".
    static func doneWord(_ after: OutboxItem, did: GroupPress.Act) -> String {
        if case .discard = did { return "Discarded" }
        if let held = OutboxModel.lifeosWords(after) { return held }
        if after.state == .sending { return "Sending" }
        let past = OutboxModel.pastOf(after.verb.split(separator: " ").first.map(String.init) ?? after.verb, kind: after.kind)
        return past == "Sent" ? "" : past
    }

    static func reason(_ error: String?, did: GroupPress.Act) -> String {
        if let words = error?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty { return words }
        if case .discard = did { return "It was not discarded" }
        return "It did not go"
    }
}

/// What waits the Outbox's five seconds (`SendWait`'s payload): one item's Send, or a Send on the ticked rows. One
/// line of presses, so a group and a single Send never go at once and the capsule always speaks for one of them.
public enum OutboxPress: Sendable, Hashable {
    case one(HeldPress)
    case group(GroupPress)

    /// The capsule's line while it waits.
    public var line: String {
        switch self {
        case .one(let press): press.line
        case .group(let press): press.waitingLine
        }
    }

    /// Every item it holds back from the list while it waits.
    public var entries: [OutboxModel.Entry] {
        switch self {
        case .one(let press): [press.entry]
        case .group(let press): press.entries
        }
    }
}

public extension DecisionResult {
    /// What the host did with each item of a press on many, by the ledger's ref (`OutboxModel.key`): done, or its
    /// refusal in the host's words (an item that may have gone says so). An answer after the fifteen seconds tells each
    /// item's row this, not one word for the whole press.
    static func states(_ answer: Methods.WorkOutboxDecide.Output) -> [String: PressState] {
        Dictionary((answer.results ?? []).map { (OutboxModel.key($0.ref), $0.state) }, uniquingKeysWith: { first, _ in first })
    }

    /// One item's answer: done, may have gone (`outcomeUnknown`), or refused in the host's words. The group's own
    /// summary (`GroupOutcome.take`) and a late answer's rows read it the same way.
    var state: PressState {
        if ok { return .done }
        if item?.outcomeUnknown == true { return .mayHaveGone }
        return .failed(error ?? item?.error ?? "")
    }
}
