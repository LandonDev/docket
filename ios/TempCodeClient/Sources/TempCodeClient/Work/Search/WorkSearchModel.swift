import Foundation
import TempCodeContract

/// Work search's names and words (docs/agents/work-search.md), the port of
/// src/shared/work/search.ts and the few words the window's model borrows:
/// the kinds' order and headings, the caps, and how a host's quiet line reads.
public nonisolated enum WorkSearch {
    /// The order the kinds' groups stand in; a kind not named here follows them, in the order it came.
    public static let order = ["person", "mail", "message", "chat", "task", "event", "file", "doc", "project", "thread", "item", "held", "routine", "card", "msform"]

    public static let labels: [String: String] = [
        "person": "People", "mail": "Mail", "message": "Messages", "chat": "Conversations", "task": "Tasks",
        "event": "Agenda", "file": "Files", "doc": "Documents", "project": "Projects", "thread": "Threads",
        "item": "Items", "held": "Outbox", "routine": "Routines", "card": "Cards", "money": "Money",
        "msform": "Microsoft forms", "recent": "Recent",
    ]

    static let nouns: [String: String] = [
        "person": "people", "mail": "mail", "message": "messages", "chat": "conversations", "task": "tasks",
        "event": "events", "file": "files", "doc": "documents", "project": "projects", "thread": "threads",
        "item": "items", "held": "held items", "routine": "routines", "card": "cards", "money": "ledger rows",
        "msform": "Microsoft forms",
    ]

    /// Rows a kind shows among the others, and alone.
    public static let perGroup = 4
    public static let all = 30
    /// Recent results shown before he types.
    public static let recents = 8
    public static let textMax = 200
    public static let recentKind = "recent"
    /// The network tier waits this long after his last key, and for this many characters.
    public static let networkWait: Duration = .milliseconds(120)
    public static let networkMinChars = 2
    /// How long a host has to answer one ask: its own four seconds for a source, and the road.
    public static let askWait: Duration = .seconds(6)

    public static func rank(_ kind: String) -> Int { order.firstIndex(of: kind) ?? order.count }
    public static func label(_ kind: String, fallback: String? = nil) -> String { labels[kind] ?? fallback ?? kind }
    public static func noun(_ kind: String, label: String? = nil) -> String { nouns[kind] ?? (label ?? Self.label(kind)).lowercased() }

    /// Two characters or more: the network sources are asked.
    public static func asksNetwork(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count >= networkMinChars
    }

    /// `mentionMatches`: every word he typed is in one of the fields, case and accents aside.
    public static func matches(_ text: String, _ fields: String?...) -> Bool {
        let words = fold(text).split(whereSeparator: \.isWhitespace)
        if words.isEmpty { return true }
        let hay = fold(fields.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " "))
        return words.allSatisfy { hay.contains($0) }
    }

    static func fold(_ text: String) -> String {
        var kept = String.UnicodeScalarView()
        for scalar in text.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: kept.append(scalar)
            }
        }
        return String(kept).lowercased()
    }

    /// `nameInLine`: "The box" reads "the box" mid-line, "This Mac" "this Mac"; a proper name stays.
    public static func nameInLine(_ name: String) -> String {
        guard name.hasPrefix("This ") || (name.hasPrefix("The ") && name.dropFirst(4).first?.isLowercase == true) else { return name }
        return "t" + name.dropFirst()
    }

    /// `lifeosStateOf`: the LifeOS state a host's own sentence names, or nil.
    static func lifeosState(of reason: String) -> String? {
        let text = reason.lowercased()
        if text.contains("work is off on this host") { return "off" }
        if text.contains("not signed in to lifeos") { return "signed-out" }
        if text.contains("lifeos sign-in waits for approval") { return "pairing" }
        if text.contains("lifeos is still connecting") { return "connecting" }
        if text.contains("lifeos refused this host's sign-in") { return "refused" }
        if text.contains("lifeos is unreachable") || text.range(of: #"\btimed out\b|^timeout\b|no answer in \d|fetch failed|\b(econnrefused|econnreset|ehostunreach|enetunreach|etimedout)\b"#, options: .regularExpression) != nil { return "unreachable" }
        return nil
    }

    /// `lifeosDownWords` with no withholding: what a down LifeOS session says, the computer named.
    static func lifeosDownWords(_ state: String, host: String?) -> String {
        let at = host.map(nameInLine) ?? "this host"
        switch state {
        case "unreachable": return host != nil ? "LifeOS did not answer \(at)" : "LifeOS did not answer"
        case "refused": return "LifeOS refused \(at)'s sign-in"
        case "off": return "Work is off on \(at)"
        case "pairing": return host != nil ? "The LifeOS sign-in on \(at) waits for your approval" : "The LifeOS sign-in waits for your approval"
        default: return host != nil ? "Not signed in to LifeOS on \(at)" : "Not signed in to LifeOS"
        }
    }
}

/// Work search on the phone as plain data (docs/agents/work-search.md "The
/// window"), the port of src/renderer/src/work/search/model.ts, held to it by
/// Fixtures/search/model.json (scripts/ios-work-search-fixture.test.ts):
///
/// - A generation a keystroke; an answer of an older generation is dropped.
/// - Groups stand in `WorkSearch.order`, never by speed; rows on screen keep
///   their order, and a row that lands later goes under its kind's rows.
/// - A thing is shown once, in the first group that has it, whichever host found it.
/// - The highlight stays on the first row until he moves it, then on his row.
public nonisolated struct WorkSearchModel: Sendable, Equatable {
    /// A host asked: the Work home first. `workspaceId` is its workspace of the job the search is held to.
    public struct Host: Sendable, Hashable {
        public var id: String
        public var name: String
        /// The one host asked for what LifeOS holds.
        public var home: Bool
        public var workspaceId: String?

        public init(id: String, name: String, home: Bool, workspaceId: String? = nil) {
            self.id = id
            self.name = name
            self.home = home
            self.workspaceId = workspaceId
        }
    }

    public enum Tier: Sendable, Hashable { case instant, network }

    /// What one source of one host answered.
    public struct Slot: Sendable, Equatable {
        public var host: String
        public var source: String
        public var kind: String
        public var label: String
        public var tier: Tier
        public var hits: [WorkSearchHit]
        public var more: Bool
        /// The generation it answered, and its words.
        public var gen: Int
        public var text: String
    }

    public struct Quiet: Sendable, Hashable {
        public var key: String
        public var line: String
    }

    /// A network source a host named, to ask on its own.
    public struct Pending: Sendable, Hashable {
        public var source: String
        public var kind: String

        public init(source: String, kind: String) {
            self.source = source
            self.kind = kind
        }
    }

    public var gen = 0
    /// His words, trimmed.
    public var text = ""
    /// One kind alone, or nil.
    public var kind: String?
    /// The job the search is held to (its key), or nil for every job.
    public var scope: String?
    public var hosts: [Host] = []
    public var slots: [Slot] = []
    /// What was asked this generation and has not answered: `<host>\n*`, `<host>\n<source>`.
    public var out: Set<String> = []
    public var quiet: [Quiet] = []
    /// Kinds in the order they were first seen.
    public var seen: [String] = []
    /// Each kind's rows by key, in the order they came to stand.
    public var order: [String: [String]] = [:]
    public var orderGen = 0
    /// A source searched and answered this generation.
    public var searched = false
    /// Kinds a host can search further when asked alone.
    public var deeper: [String] = []
    /// He moved the highlight: it stays on `active`.
    public var moved = false
    public var active: String?

    public init() {}

    static func outKey(_ host: String, _ source: String = "*") -> String { "\(host)\n\(source)" }

    // MARK: Asks and answers

    /// A new generation: his words, the kind, the hosts. Every host's first answer is out. A change of scope keeps
    /// only what is still in reach (`within`, the job's workspaces); widened, every row stays.
    public func begin(text raw: String, kind: String?, scope: String? = nil, within: [String]? = nil, hosts: [Host], offline: [String] = [], unsearched: String? = nil) -> Self {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = trimmed.utf16.count > WorkSearch.textMax ? String(trimmed.utf16.prefix(WorkSearch.textMax)) ?? String(trimmed.prefix(WorkSearch.textMax)) : trimmed
        let same = text == self.text && kind == self.kind && scope == self.scope
        let back = self.kind != nil && kind == nil && text == self.text && scope == self.scope ? "all:\(self.kind!)" : nil
        var next = self
        next.gen = gen + 1
        next.text = text
        next.kind = kind
        next.scope = scope
        next.hosts = hosts
        let kept = slots.filter { slot in hosts.contains { $0.id == slot.host } }
        next.slots = Self.inScope(kept, within: scope == self.scope || scope == nil ? nil : (within ?? []))
        next.out = Set(hosts.map { Self.outKey($0.id) })
        next.quiet = offline.map { Quiet(key: "offline:\($0)", line: $0.hasSuffix("…") ? $0 : "\($0).") } + (unsearched.map { [Quiet(key: "unsearched", line: $0)] } ?? [])
        next.orderGen = same && orderGen == gen ? gen + 1 : orderGen
        next.searched = false
        next.deeper = hosts.count == self.hosts.count && hosts.allSatisfy { h in self.hosts.contains { $0.id == h.id } } ? deeper : []
        next.moved = same ? moved : back != nil
        next.active = same ? active : back
        return next
    }

    static func inScope(_ slots: [Slot], within: [String]?) -> [Slot] {
        guard let within else { return slots }
        return slots.compactMap { slot in
            var slot = slot
            slot.hits = slot.hits.filter { $0.workspaceId.map(within.contains) ?? false }
            return slot.hits.isEmpty ? nil : slot
        }
    }

    /// What a host is asked first (the instant tier), then for one source: `own` to every host but the Work home.
    public func params(for host: Host, sources: [String]? = nil) -> Methods.WorkSearchQuery.Params {
        Methods.WorkSearchQuery.Params(text: text, workspaceId: host.workspaceId, tier: sources == nil ? "instant" : nil, sources: sources, kind: kind, own: host.home ? nil : true)
    }

    /// A host's first answer: its instant groups stand in place of that host's instant rows, and the network
    /// sources it named are out (none under two characters).
    public func landInstant(gen: Int, host hostId: String, _ answer: WorkSearchAnswer) -> (model: Self, ask: [Pending]) {
        guard gen == self.gen, let host = hosts.first(where: { $0.id == hostId }) else { return (self, []) }
        let ask = WorkSearch.asksNetwork(text) ? answer.pending.map { Pending(source: $0.source, kind: $0.kind) } : []
        var next = self
        next.out.remove(Self.outKey(hostId))
        for one in ask { next.out.insert(Self.outKey(hostId, one.source)) }
        let kept = slots.filter { slot in slot.host != hostId || (slot.tier == .network && ask.contains { $0.source == slot.source }) }
        next.slots = kept + answer.groups.map { slot(hostId, $0, .instant) }
        next.quiet = withQuiet(host, answer.quiet)
        next.seen = withSeen(answer.groups)
        next.searched = searched || Self.didSearch(answer)
        next.deeper = deeper + (answer.deeper ?? []).filter { !deeper.contains($0) }
        return (next.settled(), ask)
    }

    /// One network source's answer: its rows stand in place of that source's, or leave when it found none.
    public func landSource(gen: Int, host hostId: String, source: String, _ answer: WorkSearchAnswer) -> Self {
        guard gen == self.gen, let host = hosts.first(where: { $0.id == hostId }) else { return self }
        var next = self
        next.out.remove(Self.outKey(hostId, source))
        next.slots = slots.filter { !($0.host == hostId && $0.source == source) } + answer.groups.map { slot(hostId, $0, .network) }
        next.quiet = withQuiet(host, answer.quiet)
        next.seen = withSeen(answer.groups)
        next.searched = searched || Self.didSearch(answer)
        return next.settled()
    }

    /// A host that did not answer its first ask (`source` nil): its rows leave, one line by its name. One source
    /// that did not answer: its rows leave and the line names the kind ("Mail did not answer.").
    public func failed(gen: Int, host hostId: String, source: Pending?) -> Self {
        guard gen == self.gen, let host = hosts.first(where: { $0.id == hostId }) else { return self }
        var next = self
        next.out.remove(Self.outKey(hostId, source?.source ?? "*"))
        next.slots = slots.filter { $0.host != hostId || (source != nil && $0.source != source!.source) }
        let said = source.map { Self.quietLine(cause: "source:\($0.source)", line: "\(WorkSearch.label($0.kind)) did not answer", host: host, hosts: hosts.count) }
            ?? Quiet(key: "host:\(hostId)", line: "\(host.name) did not answer.")
        if !quiet.contains(where: { $0.key == said.key || $0.line == said.line }) { next.quiet.append(said) }
        return next.settled()
    }

    /// Something asked this generation is still out: the field's spinner.
    public var busy: Bool { !out.isEmpty }

    private func slot(_ host: String, _ group: WorkSearchAnswer.Group, _ tier: Tier) -> Slot {
        Slot(host: host, source: group.source, kind: group.kind, label: group.label, tier: tier, hits: group.hits, more: group.more, gen: gen, text: text)
    }

    private static func didSearch(_ answer: WorkSearchAnswer) -> Bool { answer.searched.map { $0 > 0 } ?? true }

    private func withSeen(_ groups: [WorkSearchAnswer.Group]) -> [String] {
        var seen = seen
        for group in groups where !seen.contains(group.kind) { seen.append(group.kind) }
        return seen
    }

    private func withQuiet(_ host: Host, _ said: [WorkSearchAnswer.Quiet]) -> [Quiet] {
        var out = quiet
        for q in said {
            let line = Self.quietLine(cause: q.cause, line: q.line, host: host, hosts: hosts.count)
            if !out.contains(where: { $0.key == line.key || $0.line == line.line }) { out.append(line) }
        }
        return out
    }

    /// LifeOS's and a host's own words, as the list's foot says them.
    static func quietLine(cause: String, line: String, host: Host, hosts: Int) -> Quiet {
        let name = WorkSearch.nameInLine(host.name)
        if cause == "lifeos" {
            let state = WorkSearch.lifeosState(of: line)
            let words: String =
                if state == "connecting" { "LifeOS is still connecting on \(name)" }
                else if let state, state != "connected" { WorkSearch.lifeosDownWords(state, host: host.name) }
                else { line.hasSuffix(".") ? String(line.dropLast()) : line }
            return Quiet(key: "lifeos", line: "\(words).")
        }
        let said = line.hasSuffix(".") ? String(line.dropLast()) : line
        return Quiet(key: "\(cause)@\(host.id)", line: hosts > 1 ? "\(said) on \(name)." : "\(said).")
    }

    // MARK: Rows

    public struct Found: Sendable, Equatable {
        public var hit: WorkSearchHit
        public var host: String
    }

    struct Group {
        var kind: String
        var label: String
        var hits: [Found]
        var more: Bool
    }

    /// The kinds in the fixed order (Recent first), each with its rows, a thing listed once; within a kind the
    /// rows already standing keep their order and the rest follow.
    func groups(jobOf: (String?) -> String = { $0 ?? "" }) -> [Group] {
        let rank = { (kind: String) in kind == WorkSearch.recentKind ? -1 : WorkSearch.rank(kind) }
        let hostIndex = { (id: String) in hosts.firstIndex { $0.id == id } ?? -1 }
        let seenIndex = { (kind: String) in seen.firstIndex(of: kind) ?? -1 }
        let shown = slots.enumerated()
            .filter { !text.isEmpty ? $0.element.kind != WorkSearch.recentKind : $0.element.kind == WorkSearch.recentKind }
            .filter { kind == nil || $0.element.kind == kind || $0.element.kind == WorkSearch.recentKind }
            .sorted { a, b in
                let x = (rank(a.element.kind), seenIndex(a.element.kind), hostIndex(a.element.host), a.element.tier == .instant ? 0 : 1)
                let y = (rank(b.element.kind), seenIndex(b.element.kind), hostIndex(b.element.host), b.element.tier == .instant ? 0 : 1)
                if x != y { return x < y }
                if a.element.source != b.element.source { return a.element.source < b.element.source }
                return a.offset < b.offset
            }
            .map(\.element)

        var groups: [Group] = []
        var taken = Set<String>()
        var kinds: [String] = []
        for slot in shown where !kinds.contains(slot.kind) { kinds.append(slot.kind) }
        for kind in kinds {
            let mine = shown.filter { $0.kind == kind }
            var hits: [Found] = []
            var more = false
            if kind == WorkSearch.recentKind {
                // One list across hosts, each thing by its newest opening; two that would read the same are one row.
                let all = mine.flatMap { slot in slot.hits.map { Found(hit: $0, host: slot.host) } }
                    .filter { self.kind == nil || $0.hit.kind == self.kind }
                    .enumerated()
                    .sorted { ($0.element.hit.openedAt ?? 0, -$0.offset) > ($1.element.hit.openedAt ?? 0, -$1.offset) }
                    .map(\.element)
                var looks = Set<String>()
                for found in all {
                    let look = "\(found.hit.kind)\n\(found.hit.title)\n\(jobOf(found.hit.workspaceId))"
                    if taken.contains(found.hit.key) || looks.contains(look) { continue }
                    taken.insert(found.hit.key)
                    looks.insert(look)
                    hits.append(found)
                }
            } else {
                for slot in mine {
                    let stale = slot.gen != gen
                    for hit in slot.hits {
                        if taken.contains(hit.key) { continue }
                        // For the words it answered the host's verdict stands; an older answer only while it holds the new words.
                        if stale, !text.isEmpty, slot.text != text, !WorkSearch.matches(text, hit.title, hit.detail, hit.snippet) { continue }
                        taken.insert(hit.key)
                        hits.append(Found(hit: hit, host: slot.host))
                    }
                    more = more || (slot.more && (!stale || (moved && active == "all:\(kind)")))
                }
                if let stood = order[kind] {
                    let at = { (key: String) in stood.firstIndex(of: key) ?? stood.count }
                    hits = hits.enumerated().sorted { (at($0.element.hit.key), $0.offset) < (at($1.element.hit.key), $1.offset) }.map(\.element)
                }
            }
            if !hits.isEmpty { groups.append(Group(kind: kind, label: mine[0].label, hits: hits, more: more)) }
        }
        return groups
    }

    /// After an answer each kind's rows as they stand are the order the next goes under; the first answer to new
    /// words ranks afresh, unless he has moved to a row already standing.
    func settled() -> Self {
        var base = self
        if !(orderGen == gen || moved) { base.order = [:] }
        var next = self
        next.order = [:]
        for group in base.groups() where group.kind != WorkSearch.recentKind {
            next.order[group.kind] = group.hits.map(\.hit.key)
        }
        next.orderGen = gen
        return next
    }

    public enum Row: Sendable, Equatable, Identifiable {
        case heading(id: String, label: String)
        case hit(id: String, hit: WorkSearchHit, host: String)
        /// "All mail for …": a tap narrows the search to the kind.
        case all(id: String, kind: String, label: String)
        /// "Search all jobs", under nothing found in one job.
        case widen(id: String, label: String)
        /// `cause`: what could not be searched, said at the list's foot.
        case note(id: String, text: String, cause: Bool)

        public var id: String {
            switch self {
            case .heading(let id, _), .hit(let id, _, _), .all(let id, _, _), .widen(let id, _), .note(let id, _, _): id
            }
        }

        /// A row a tap can take.
        public var isOption: Bool {
            switch self {
            case .hit, .all, .widen: true
            case .heading, .note: false
            }
        }
    }

    /// The list, top to bottom: each kind's heading, its rows up to the cap, the row that opens all of it; then
    /// what was not found, and what could not be searched.
    public func rows(scoped: Bool = false, jobOf: (String?) -> String = { $0 ?? "" }) -> [Row] {
        var rows: [Row] = []
        var count = 0
        for group in groups(jobOf: jobOf) {
            let kind = group.kind
            let cap = kind == WorkSearch.recentKind ? WorkSearch.recents : self.kind != nil ? WorkSearch.all : WorkSearch.perGroup
            let more = group.more || group.hits.count > cap || (kind != WorkSearch.recentKind && deeper.contains(kind))
            var shown = Array(group.hits.prefix(cap))
            // The row he chose is never the one the cap cuts.
            if moved, let active, let chosen = group.hits.firstIndex(where: { "hit:\($0.hit.key)" == active }), chosen >= cap { shown[cap - 1] = group.hits[chosen] }
            if self.kind == nil || kind == WorkSearch.recentKind { rows.append(.heading(id: "heading:\(kind)", label: group.label)) }
            for found in shown { rows.append(.hit(id: "hit:\(found.hit.key)", hit: found.hit, host: found.host)) }
            count += shown.count
            if more, self.kind == nil, kind != WorkSearch.recentKind {
                rows.append(.all(id: "all:\(kind)", kind: kind, label: "All \(WorkSearch.noun(kind, label: group.label)) for “\(text)”"))
            }
        }
        if count == 0, WorkSearch.asksNetwork(text), !busy, searched {
            rows.append(.note(id: "nothing", text: "Nothing for “\(text)”", cause: false))
            if scoped { rows.append(.widen(id: "widen", label: "Search all jobs")) }
        }
        if self.kind == nil, WorkSearch.asksNetwork(text) {
            for kind in deeper where !rows.contains(where: { if case .all(_, kind, _) = $0 { true } else { false } }) {
                rows.append(.all(id: "all:\(kind)", kind: kind, label: "All \(WorkSearch.noun(kind)) for “\(text)”"))
            }
        }
        for q in quiet { rows.append(.note(id: "quiet:\(q.key)", text: q.line, cause: true)) }
        return rows
    }

    /// What kept a search that found nothing short, a line a cause: the empty screen's words in place of the
    /// spelling hint, so the list draws them no second time. Nil while anything was found or no cause stands.
    public static func emptyCauses(_ rows: [Row]) -> String? {
        guard rows.contains(where: { $0.id == "nothing" }) else { return nil }
        let causes = rows.compactMap { row -> String? in if case .note(_, let text, true) = row { text } else { nil } }
        return causes.isEmpty ? nil : causes.joined(separator: "\n")
    }

    /// Whether rows of more than one place stand together, so each must say where it is.
    public static func placesMix(jobs: Int, rows: [Row]) -> Bool {
        jobs > 1 || (jobs == 1 && rows.contains { if case .hit(_, let hit, _) = $0 { hit.workspaceId == nil } else { false } })
    }

    // MARK: The highlight

    /// The first row a tap can take until he moves the highlight, then his; none when his was taken away.
    public func active(in rows: [Row]) -> String? {
        let options = rows.filter(\.isOption)
        if moved, let active {
            if options.contains(where: { $0.id == active }) { return active }
            if active.hasPrefix("hit:") { return nil }
        }
        return options.first?.id
    }

    /// An arrow key on the open Duo's keyboard: the next or the previous row, round the ends.
    public func step(_ rows: [Row], by: Int) -> Self {
        let options = rows.filter(\.isOption)
        guard !options.isEmpty else { return self }
        let at = options.firstIndex { $0.id == active(in: rows) } ?? -1
        var next = self
        next.moved = true
        next.active = options[at < 0 ? 0 : (at + by + options.count) % options.count].id
        return next
    }

    /// The pointer, or a finger, on a row.
    public func point(_ id: String) -> Self {
        if moved, active == id { return self }
        var next = self
        next.moved = true
        next.active = id
        return next
    }
}
