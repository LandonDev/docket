import Foundation
import Observation
import TempCodeContract

/// The `@` a Work thread's composer offers (docs/agents/work-canvas.md "Mentions", the phone's half): the token the
/// box ends on, the host's answer to `work.canvas.mentions` a beat after the last key, and the chips a pick puts in
/// the box until the send takes them. The desktop's composerTriggers.ts `triggerAt`, chrome/useWorkMentions.ts and
/// work/canvas/chips.ts, ported.
public enum MentionTrigger {
    /// The longest text the host takes for a mention (`work.canvas.mentions`' `text`).
    public static let most = 200

    /// The words after the `@` that opens the box's last token (after a space or a new line, or at the start); nil when
    /// the last token is no mention (`a@b`, `@a@b`, a space after the words). `@` alone is the empty query.
    public static func query(in text: String) -> String? {
        let start = tokenStart(text)
        let token = text[start...]
        guard token.first == "@", !token.dropFirst().contains("@") else { return nil }
        return String(token.dropFirst().prefix(most))
    }

    /// The text with the last token's `@words` taken out, for a pick: what was typed before it stays as it was.
    public static func removing(from text: String) -> String {
        guard query(in: text) != nil else { return text }
        return String(text[..<tokenStart(text)])
    }

    private static func tokenStart(_ text: String) -> String.Index {
        text.lastIndex(where: { $0 == " " || $0 == "\n" }).map { text.index(after: $0) } ?? text.startIndex
    }
}

/// One thread's chips, waiting in its composer for the next send (the desktop's `addContextChip` and its store).
/// Each thread has its own box, so a chip added to one redraws no other thread's composer.
@MainActor @Observable
public final class ChipBox {
    /// The desktop's `CHIPS_MAX`.
    public static let most = 8
    public private(set) var chips: [ContextChip] = []

    public init() {}

    /// The same thing twice is one chip: its kind, its reference and its quoted words.
    public static func same(_ a: ContextChip, _ b: ContextChip) -> Bool {
        a.kind == b.kind && a.quote == b.quote && a.ref == b.ref
    }

    /// Adds a chip; one already there, or a ninth, adds nothing. True when it went in.
    @discardableResult
    public func add(_ chip: ContextChip) -> Bool {
        guard chips.count < Self.most, !chips.contains(where: { Self.same($0, chip) }) else { return false }
        chips.append(chip)
        return true
    }

    public func remove(at index: Int) {
        guard chips.indices.contains(index) else { return }
        chips.remove(at: index)
    }

    /// The send takes them all at the click.
    public func take() -> [ContextChip] {
        let taken = chips
        if !taken.isEmpty { chips = [] }
        return taken
    }

    /// A refused send gives its chips back ahead of any added meanwhile, as `ComposerDraft.restore` does the words.
    public func restore(_ sent: [ContextChip]) {
        guard !sent.isEmpty else { return }
        var next = sent
        for chip in chips where !next.contains(where: { Self.same($0, chip) }) { next.append(chip) }
        chips = Array(next.prefix(Self.most))
    }
}

/// Every thread's chip box, by host and thread: a thread's composer reads its own; Add to Thread and a drop write one.
@MainActor
public final class ComposerChips {
    public static let shared = ComposerChips()
    private var boxes: [String: ChipBox] = [:]

    public init() {}

    public func box(environmentId: String, sessionId: String) -> ChipBox {
        let key = "\(environmentId)/\(sessionId)"
        if let box = boxes[key] { return box }
        let box = ChipBox()
        boxes[key] = box
        return box
    }
}

/// The host's answer for the `@` words, kept for the list over the box. The first ask goes at once, the rest a beat
/// after the last key (`wait`); the task that asks is the view's, keyed on the words, so a new key cancels the ask
/// before it. The last answer stays on screen, cut to the rows whose names still hold every word typed, until the
/// next one lands, so the list never empties under the typing.
@MainActor @Observable
public final class MentionAsk {
    /// The desktop's `WORK_MENTION_WAIT_MS`.
    public static let wait: Duration = .milliseconds(120)
    public static let searchFailed = "Couldn't search Work"

    /// The rows the last answer gave, in the host's kind order.
    public private(set) var hits: [MentionHit] = []
    /// The words that answer was for; nil before the first.
    public private(set) var answered: String?
    /// One quiet line: the kinds the host could not search, or that the ask failed. Worded as it is read, so a line
    /// about LifeOS follows the host's LifeOS status as it lands, never what it was at the answer.
    public var note: String? {
        if askFailed { return Self.searchFailed }
        return failed.flatMap(failWords)
    }
    /// The kinds the last answer left out.
    private var failed: [MentionAnswer.Failed]?
    /// The last ask itself failed.
    private var askFailed = false

    @ObservationIgnored private let fetch: @MainActor (String) async throws -> MentionAnswer
    @ObservationIgnored private let failWords: @MainActor ([MentionAnswer.Failed]) -> String?
    @ObservationIgnored private let sleep: @MainActor (Duration) async throws -> Void

    public init(fetch: @escaping @MainActor (String) async throws -> MentionAnswer,
                failWords: @escaping @MainActor ([MentionAnswer.Failed]) -> String?,
                sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.fetch = fetch
        self.failWords = failWords
        self.sleep = sleep
    }

    /// Nothing has answered yet: the list says Loading….
    public var loading: Bool { answered == nil }

    /// What the list shows for the words typed now: the answer for them, else the last one's rows that still match.
    public func rows(for query: String) -> [MentionHit] {
        if answered == query { return hits }
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return hits.filter { hit in words.allSatisfy { hit.chip.label.lowercased().contains($0) } }
    }

    /// Asks for `query`, at once the first time, else after `wait`; a cancelled ask lands nothing.
    public func ask(_ query: String) async {
        if answered != nil {
            do { try await sleep(Self.wait) } catch { return }
        }
        guard !Task.isCancelled else { return }
        do {
            let answer = try await fetch(query)
            guard !Task.isCancelled else { return }
            hits = answer.hits
            failed = answer.failed
            askFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            hits = []
            failed = nil
            askFailed = true
        }
        answered = query
    }
}

/// How the `@` list words a row and its quiet line.
public enum MentionWords {
    /// The kinds the host reads from LifeOS (the desktop's mentionFail.ts `LIFEOS_KINDS`).
    public static let lifeosKinds: Set<String> = ["task", "mail", "event", "project", "card", "person", "doc", "chat"]

    /// The quiet line for kinds the host left out: LifeOS's state on that host when every one is LifeOS's
    /// (mentionFail.ts `mentionFailWords` over `lifeosHeardWords`), else that not everything was searched.
    public static func failed(_ kinds: [MentionAnswer.Failed], lifeos state: String?, host: String?) -> String? {
        guard !kinds.isEmpty else { return nil }
        guard kinds.allSatisfy({ lifeosKinds.contains($0.rawValue) }) else { return "Couldn't search everything" }
        if state == "connecting" {
            return "LifeOS is still connecting on \(host.map(WorkSearch.nameInLine) ?? "this host")"
        }
        return WorkSearch.lifeosDownWords(state == nil || state == "connected" ? "unreachable" : state!, host: host)
    }

    /// The state a host's LifeOS status names (`connected`, `signed-out`, …), nil before the host has said.
    public static func lifeosState(_ status: LifeosStatus?) -> String? {
        guard let status else { return nil }
        return switch status.lifeos {
        case .off: "off"
        case .signedOut: "signed-out"
        case .pairing: "pairing"
        case .connecting: "connecting"
        case .connected: "connected"
        case .unreachable: "unreachable"
        case .refused: "refused"
        case .unknown: nil
        }
    }

    /// A row's time as the desktop's `whenWords` says it: today's as a time, this year's as a day, an older one with
    /// its year.
    public static func when(_ at: Double, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: at / 1000)
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.isDate(date, inSameDayAs: now) {
            style = style.hour().minute()
        } else if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            style = style.month(.abbreviated).day()
        } else {
            style = style.month(.abbreviated).day().year()
        }
        return date.formatted(style)
    }

    /// The row's quiet line: its fact (a sender, a place, the canvas kind) and its time, whichever it has.
    public static func detail(_ hit: MentionHit, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String? {
        let parts = [hit.detail.flatMap { $0.isEmpty ? nil : $0 }, hit.at.map { when($0, now: now, calendar: calendar, locale: locale) }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A hit's identity in the list: its kind and its reference (the host answers each thing once).
    public static func id(_ hit: MentionHit) -> String {
        "\(hit.chip.kind.rawValue):\(ChipWords.refWords(hit.chip))"
    }
}

/// The chips a sent message carried, read back from its text (the desktop's work/canvas/sentChipsOf.ts): the
/// lines `ChipWords.line` writes lead the message, or follow his words when it opens with a slash command; the
/// bubble draws them as chips and the rest as his words. A message with no chip lines answers its text untouched.
public enum SentChips {
    public struct Chip: Hashable, Sendable {
        /// The chip's noun as written: "task", "held act".
        public let noun: String
        public let label: String
        /// Where it points, as written: "LifeOS tasks k1", "canvas item i1", a path.
        public let ref: String

        public init(noun: String, label: String, ref: String) {
            self.noun = noun
            self.label = label
            self.ref = ref
        }

        /// The kind its noun names, for its glyph.
        public var kind: ContextChip.Kind { ChipWords.kind(ofNoun: noun) }
    }

    public static func of(_ text: String) -> (chips: [Chip], text: String) {
        guard text.hasPrefix("About this ") || text.contains("\n\nAbout this ") else { return ([], text) }
        let lines = text.components(separatedBy: "\n")
        if let lead = read(lines, from: 0), lead.next == lines.count || lines[lead.next].isEmpty {
            return (lead.chips, lines.dropFirst(min(lead.next + 1, lines.count)).joined(separator: "\n"))
        }
        if text.hasPrefix("/") {
            // The last blank line that only chip lines follow: his words may hold blank lines of their own.
            var blank = lines.lastIndex(of: "")
            while let at = blank, at > 0 {
                if let tail = read(lines, from: at + 1), tail.next == lines.count {
                    return (tail.chips, lines[..<at].joined(separator: "\n"))
                }
                blank = lines[..<at].lastIndex(of: "")
            }
        }
        return ([], text)
    }

    private static func read(_ lines: [String], from: Int) -> (chips: [Chip], next: Int)? {
        var chips: [Chip] = []
        var at = from
        while at < lines.count, let chip = head(lines[at]) {
            chips.append(chip)
            at += 1
            while at < lines.count, lines[at].hasPrefix("> ") { at += 1 }
        }
        return chips.isEmpty ? nil : (chips, at)
    }

    /// `About this <noun>: <label> (<ref>)`, its noun lower-case words of at most 31 letters and its ref one that
    /// `ChipWords.refWords` writes; words in brackets that are none of those are his.
    static func head(_ line: String) -> Chip? {
        let prefix = "About this "
        guard line.hasPrefix(prefix), line.hasSuffix(")") else { return nil }
        let rest = line.dropFirst(prefix.count)
        guard let colon = rest.range(of: ": ") else { return nil }
        let noun = String(rest[..<colon.lowerBound])
        guard let first = noun.first, first.isASCII, first.isLowercase, noun.count <= 31,
              noun.allSatisfy({ ($0.isASCII && $0.isLowercase) || $0 == " " }) else { return nil }
        let body = rest[colon.upperBound...].dropLast()
        // The reference is the last bracket's words: no bracket and no new line inside it.
        guard let open = body.lastIndex(of: "("), open > body.startIndex, body[body.index(before: open)] == " " else { return nil }
        let ref = String(body[body.index(after: open)...])
        let label = String(body[..<body.index(before: open)])
        guard !label.isEmpty, !ref.isEmpty, !ref.contains(")"), !ref.contains("\n"), isRef(ref) else { return nil }
        return Chip(noun: noun, label: label, ref: ref)
    }

    /// A LifeOS row, a canvas item, a pillar's row, a path, a source as JSON (sentChipsOf.ts `REF`).
    static func isRef(_ ref: String) -> Bool {
        func word(_ s: Substring) -> Bool { !s.isEmpty && !s.contains(where: \.isWhitespace) }
        func split(_ s: String, _ prefix: String) -> [Substring]? {
            guard s.hasPrefix(prefix) else { return nil }
            return s.dropFirst(prefix.count).split(separator: " ", omittingEmptySubsequences: false)
        }
        if let parts = split(ref, "LifeOS "), parts.count == 2, parts[0].allSatisfy({ $0.isASCII && $0.isLetter }), !parts[0].isEmpty, word(parts[1]) { return true }
        if let parts = split(ref, "canvas item "), parts.count == 1, word(parts[0]) { return true }
        if let parts = split(ref, "Work "), parts.count == 2, parts[0].allSatisfy({ $0.isASCII && $0.isLowercase }), !parts[0].isEmpty, word(parts[1]) { return true }
        if ref.count > 1, ref.hasPrefix("/"), let second = ref.dropFirst().first, !second.isWhitespace { return true }
        return ref.hasPrefix("{") && ref.hasSuffix("}")
    }
}

/// A Files row as the `file` chip a message is about (src/shared/work/files.ts `fileChipOf`): its name, its source and,
/// where known, its place and its path inside it in words. Nothing from inside the file; a folder, and a thread's own
/// item, are no chip.
public enum FileChips {
    public struct Place: Sendable, Hashable {
        public let id: String
        public let name: String
        public let shared: Bool
        public let root: FolderRef

        public init(id: String, name: String, shared: Bool, root: FolderRef) {
            self.id = id
            self.name = name
            self.shared = shared
            self.root = root
        }

        public init(_ place: FilePlace) {
            self.init(id: place.id, name: place.name, shared: place.shared, root: place.root)
        }
    }

    public static func of(_ entry: FileEntry, place: Place? = nil) -> ContextChip? {
        guard let ref = entry.ref, entry.folder == nil else { return nil }
        if case .thread = ref { return nil }
        let shared = entry.shared ?? place?.shared ?? false
        let at: (place: String, name: String, path: String)? =
            if let w = entry.where { (w.place, w.name, (w.trail + [entry.name]).joined(separator: "/")) }
            else if let place { (place.id, place.name, path(in: place, ref: ref, name: entry.name)) }
            else { nil }
        return ContextChip(kind: .file, label: entry.name, ref: .canvasSource(ref),
                           where: at.map { .init(place: $0.place, name: $0.name, path: $0.path, shared: shared ? true : nil) })
    }

    /// The file's path under its place's top folder, else its name (files.ts `pathInPlace`).
    static func path(in place: Place, ref: CanvasSource, name: String) -> String {
        guard case .file(let root) = place.root else { return name }
        let top = String(root.path.reversed().drop(while: { $0 == "/" || $0 == "\\" }).reversed())
        let disk: String? = switch ref {
        case .file(let file): file.path
        case .microsoft(let source): if case .path(let p) = source.ref { p.path } else { nil }
        default: nil
        }
        guard let disk, disk.hasPrefix(top), let next = disk.dropFirst(top.count).first, next == "/" || next == "\\" else { return name }
        return disk.dropFirst(top.count).split(whereSeparator: { $0 == "/" || $0 == "\\" }).joined(separator: "/")
    }
}

/// The Item segment's order: one item moved up or down the thread's tab row, as `work.canvas.reorder` takes it.
public enum CanvasOrder {
    /// The ids with `id` moved by `by` places (negative: earlier), held inside the row; nil when it cannot move.
    public static func moved(_ ids: [String], _ id: String, by: Int) -> [String]? {
        guard let from = ids.firstIndex(of: id) else { return nil }
        let to = min(max(from + by, 0), ids.count - 1)
        guard to != from else { return nil }
        var next = ids
        next.remove(at: from)
        next.insert(id, at: to)
        return next
    }
}

/// Add to Thread's list (Files' row menu): the job's own Work threads that are open, pinned first, then the newest.
/// A thread of a project in the job is the job's; a subagent, an archived thread and any other job's are not.
public enum AddToThread {
    public static func threads(_ sessions: [SessionMeta], workspaceId: String, projectWorkspace: [String: String] = [:]) -> [SessionMeta] {
        sessions
            .filter { s in
                s.scope == .work && s.parentId == nil && !s.archived
                    && (s.workspaceId ?? s.projectId.flatMap { projectWorkspace[$0] }) == workspaceId
            }
            .sorted { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
    }
}

/// A list's row as the chip it is when dragged onto a thread's box, worded as the host's own `@` source words it.
public enum RowChips {
    /// A held act waiting on the host (outbox/mentions.ts): its summary, `Work outbox <id>`. LifeOS's own drafts are no chip.
    public static func held(_ item: OutboxItem) -> ContextChip? {
        guard case .host(let ref) = item.ref else { return nil }
        return ContextChip(kind: .held, label: item.summary, ref: .object3(.init(at: "work", pillar: .outbox, id: ref.id)))
    }

    /// A person of LifeOS (lifeos/mentions.ts): their name, `LifeOS people <id>`.
    public static func person(id: String, name: String) -> ContextChip {
        ChipWords.lifeos(.person, table: .people, id: id, label: name)
    }
}
