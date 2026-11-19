import Foundation
import TempCodeContract

/// The Outbox's words and shapes, with no SwiftUI: the phone's copy of the
/// desktop's `src/renderer/src/work/outbox/model.ts` (docs/agents/work-outbox.md,
/// "The screens"). The views draw what these answer; the tests read them.
public enum OutboxModel {
    /// Work Chats' grant scope and held rows' workspace (`WORK_HOME`).
    public nonisolated static let workChatsKey = "~work"

    /// The states the Outbox lists as waiting: held, live, sending and failed.
    public nonisolated static func waits(_ state: OutboxItem.State) -> Bool {
        switch state {
        case .held, .live, .sending, .failed: true
        case .sent, .discarded, .stale, .unknown: false
        }
    }

    /// Kinds whose payload a person may change while it waits (the host refuses the rest).
    public nonisolated static func editable(_ kind: OutboxItem.Kind) -> Bool {
        switch kind {
        case .mailSend, .addonCall, .teamsPost, .officeMailSend: true
        default: false
        }
    }

    /// A failed send that may have gone (`outcomeUnknown`): what he checks before Send Again, as the desktop says it.
    public nonisolated static func checkFirst(_ item: OutboxItem) -> String? {
        guard item.state == .failed, item.outcomeUnknown == true else { return nil }
        return item.kind == .mailSend || item.kind == .officeMailSend ? "Check Sent first" : "Check whether it went first"
    }

    /// The held detail's line for a failed send: the reason, then what to check when it may have gone.
    public nonisolated static func failureLine(_ item: OutboxItem) -> String {
        let reason = item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let check = checkFirst(item) else { return reason.isEmpty ? "Didn’t send." : reason }
        guard !reason.isEmpty else { return "It may have gone. \(check)." }
        return (reason.hasSuffix(".") ? reason : reason + ".") + " \(check)."
    }

    /// "Send" → "Sent", "Post" → "Posted", "Make link" → "Made link".
    public nonisolated static func pastOf(_ verb: String) -> String {
        var words = verb.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard let head = words.first, !head.isEmpty else { return verb }
        let irregular = ["Send": "Sent", "Post": "Posted", "Make": "Made", "Accept": "Accepted", "Submit": "Submitted", "Share": "Shared", "Book": "Booked", "Run": "Ran", "Publish": "Published", "Decline": "Declined"]
        words[0] = irregular[head] ?? (head.hasSuffix("e") ? head + "d" : head + "ed")
        return words.joined(separator: " ")
    }

    /// "Sending to events booking": the undo capsule's line while a press waits its five seconds.
    public nonisolated static func pendingLine(_ item: OutboxItem) -> String {
        let summary = item.summary
        guard summary.hasPrefix(item.verb) else { return summary }
        let rest = summary.dropFirst(item.verb.count)
        return progressive(item.verb) + rest
    }

    private nonisolated static func progressive(_ verb: String) -> String {
        var words = verb.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard let head = words.first, !head.isEmpty else { return verb }
        let irregular = ["Run": "Running", "Submit": "Submitting"]
        words[0] = irregular[head] ?? (head.hasSuffix("e") ? String(head.dropLast()) + "ing" : head + "ing")
        return words.joined(separator: " ")
    }

    // MARK: - the payload, exactly as it will go

    /// A field a person reads, with its path for the editor.
    public struct Field: Sendable, Hashable, Identifiable {
        public enum Edit: Sendable, Hashable { case text, addresses }
        public var key: String
        public var path: [String]
        public var label: String
        public var value: String
        /// The address under a named one ("events@purdue.edu" under "Events booking"); nil otherwise.
        public var detail: String?
        public var edit: Edit?
        public var id: String { path.joined(separator: ".") }
    }

    public struct PayloadView: Sendable, Hashable {
        /// The body as plain text, with its path for the editor.
        public struct Body: Sendable, Hashable {
            public var path: [String]
            public var text: String
            public var id: String { path.joined(separator: ".") }
        }

        public var fields: [Field]
        public var body: Body?
    }

    /// Keys that are the host's bookkeeping, never what goes.
    private nonisolated static let quiet: Set<String> = ["id", "status", "kind", "accountId", "html", "addonId", "specDigest", "hints", "mark", "targets", "picture", "read", "proposed", "error", "words", "addon", "tool", "why", "host"]
    /// Keys whose text is the body: drawn as one plain-text block, not a field.
    private nonisolated static let bodyKeys = ["text", "body", "message", "content"]
    private nonisolated static let labels = ["to": "To", "cc": "Cc", "bcc": "Bcc", "from": "From", "subject": "Subject", "channel": "In", "title": "Title", "app": "App", "window": "Window", "label": "Act"]
    /// A payload object has no key order once decoded: these lead, in a mail's order; the rest follow by name.
    private nonisolated static let leading = ["from", "to", "cc", "bcc", "subject", "channel", "title"]

    nonisolated static func label(_ key: String) -> String {
        if let known = labels[key] { return known }
        var out = ""
        var previous: Character?
        for ch in key {
            if ch == "_" || ch == "-" { out.append(" ") } else {
                if ch.isUppercase, let p = previous, p.isLowercase { out.append(" ") }
                out.append(ch)
            }
            previous = ch
        }
        return out.prefix(1).uppercased() + out.dropFirst()
    }

    private struct Address { var name: String?; var address: String }

    private nonisolated static func address(_ value: JSONValue) -> Address? {
        guard case .object(let o) = value, case .string(let address)? = o["address"] else { return nil }
        if case .string(let name)? = o["name"], !name.isEmpty { return Address(name: name, address: address) }
        return Address(name: nil, address: address)
    }

    private nonisolated static func addresses(_ value: JSONValue) -> [Address]? {
        guard case .array(let list) = value, !list.isEmpty else { return nil }
        let out = list.compactMap(address)
        return out.count == list.count ? out : nil
    }

    /// "Dana Lee <dlee@purdue.edu>, sam@purdue.edu"
    private nonisolated static func addressWords(_ list: [Address]) -> String {
        list.map { a in a.name.map { "\($0) <\(a.address)>" } ?? a.address }.joined(separator: ", ")
    }

    private nonisolated static func ordered(_ object: [String: JSONValue]) -> [(String, JSONValue)] {
        let lead = leading.compactMap { key in object[key].map { (key, $0) } }
        let rest = object.filter { !leading.contains($0.key) }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        return lead + rest
    }

    private nonisolated static func text(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): String(b)
        case .null: ""
        case .array, .object:
            (try? String(decoding: JSONEncoder.sorted.encode(value), as: UTF8.self)) ?? ""
        }
    }

    /// The payload as the held detail draws it: each field a person would
    /// read, with its path for the editor, and the body as plain text. A mail
    /// (`message`) and an add-on call (`arguments`) open one level, so the
    /// detail reads as the act, not as its wrapper.
    public nonisolated static func payloadView(_ payload: JSONValue?) -> PayloadView {
        var view = PayloadView(fields: [])
        func walk(_ value: JSONValue, _ path: [String], _ depth: Int) {
            guard case .object(let object) = value else { return }
            for (key, v) in ordered(object) {
                if quiet.contains(key) { continue }
                let at = path + [key]
                switch v {
                case .null:
                    continue
                case .string(let s):
                    if view.body == nil, bodyKeys.contains(key), s.contains("\n") || s.count > 80 {
                        view.body = .init(path: at, text: s)
                    } else if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: s, edit: .text))
                    }
                case .number, .bool:
                    view.fields.append(Field(key: key, path: at, label: label(key), value: text(v), edit: nil))
                case .array(let list):
                    if let people = addresses(v) {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: addressWords(people), edit: .addresses))
                    } else if !list.isEmpty {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: list.map(text).joined(separator: ", "), edit: nil))
                    }
                case .object(let o):
                    if let one = address(v) {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: one.name ?? one.address, detail: one.name == nil ? nil : one.address, edit: nil))
                    } else if depth < 1, ["message", "arguments", "args"].contains(key) {
                        walk(v, at, depth + 1)
                    } else if case .string(let name)? = o["name"] {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: name, edit: nil))
                    } else {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: text(v), edit: nil))
                    }
                }
            }
        }
        if let payload { walk(payload, [], 0) }
        return view
    }

    /// "Dana Lee <dlee@purdue.edu>, sam@purdue.edu" back to addresses; nil when one is not an address.
    public nonisolated static func parseAddresses(_ text: String) -> JSONValue? {
        var out: [JSONValue] = []
        let parts = text.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        for part in parts {
            if part.hasSuffix(">"), let open = part.lastIndex(of: "<") {
                let address = String(part[part.index(after: open)..<part.index(before: part.endIndex)])
                guard isAddress(address) else { return nil }
                let name = part[..<open].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                out.append(.object(name.isEmpty ? ["address": .string(address)] : ["name": .string(name), "address": .string(address)]))
            } else if isAddress(part) {
                out.append(.object(["address": .string(part)]))
            } else {
                return nil
            }
        }
        return .array(out)
    }

    private nonisolated static func isAddress(_ s: String) -> Bool {
        let pieces = s.split(separator: "@", omittingEmptySubsequences: false)
        return pieces.count == 2 && !pieces[0].isEmpty && !pieces[1].isEmpty && !s.contains(where: { $0.isWhitespace || $0 == "<" || $0 == ">" })
    }

    /// Plain text as the html a mail carries beside it: a paragraph per blank-line block.
    public nonisolated static func htmlOfText(_ text: String) -> String {
        func escape(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        return text.components(separatedBy: "\n\n").filter { !$0.isEmpty || text.isEmpty }.map { paragraph in
            "<p>" + escape(paragraph.trimmingCharacters(in: CharacterSet(charactersIn: "\n"))).replacingOccurrences(of: "\n", with: "<br>") + "</p>"
        }.joined()
    }

    private nonisolated static func value(_ root: JSONValue?, at path: [String]) -> JSONValue? {
        var current = root
        for key in path {
            guard case .object(let o)? = current else { return nil }
            current = o[key]
        }
        return current
    }

    private nonisolated static func set(_ root: JSONValue?, at path: [String], to next: JSONValue) -> JSONValue {
        guard let head = path.first else { return next }
        var object: [String: JSONValue] = [:]
        if case .object(let o)? = root { object = o }
        object[head] = set(object[head], at: Array(path.dropFirst()), to: next)
        return .object(object)
    }

    /// The payload with the person's edits in place (keyed by `Field.id`, the
    /// body by its path). A text beside an `html` (a mail) carries a fresh html
    /// with it, so what goes matches what he read.
    public nonisolated static func applyEdits(_ payload: JSONValue?, _ edits: [String: String]) -> (payload: JSONValue?, error: String?) {
        let view = payloadView(payload)
        var editable: [(path: [String], label: String, edit: Field.Edit)] = view.fields.compactMap { f in f.edit.map { (f.path, f.label, $0) } }
        if let body = view.body { editable.append((body.path, "Message", .text)) }
        var next = payload
        for field in editable {
            guard let text = edits[field.path.joined(separator: ".")] else { continue }
            switch field.edit {
            case .addresses:
                guard let list = parseAddresses(text) else { return (payload, "\(field.label): one of these is not an address") }
                next = set(next, at: field.path, to: list)
            case .text:
                next = set(next, at: field.path, to: .string(text))
                let parent = Array(field.path.dropLast())
                if field.path.last == "text", case .string? = value(next, at: parent + ["html"]) {
                    next = set(next, at: parent + ["html"], to: .string(htmlOfText(text)))
                }
            }
        }
        return (next, nil)
    }

    // MARK: - grants: made only from a held item, narrow

    /// The grant a held item offers in its Send menu, and its name; nil where
    /// the kind takes none. A mail's fixes its account and every recipient; an
    /// add-on call's fixes the server and the tool (the desktop's `grantFor`).
    public nonisolated static func grantFor(_ kind: OutboxItem.Kind, payload: JSONValue?) -> (matcher: JSONValue, label: String)? {
        guard case .object(let p)? = payload else { return nil }
        switch kind {
        case .mailSend:
            guard case .object(let m)? = p["message"] else { return nil }
            let people = ["to", "cc", "bcc"].flatMap { key in m[key].flatMap(addresses) ?? [] }
            guard !people.isEmpty else { return nil }
            let names = people.map { $0.name ?? $0.address }
            let label = names.count <= 2 ? "Mail to \(names.joined(separator: " and "))" : "Mail to \(names[0]) and \(names.count - 1) more"
            var matcher: [String: JSONValue] = ["recipients": .array(people.map { .string($0.address.lowercased()) })]
            if case .string(let account)? = m["accountId"] { matcher["accountId"] = .string(account) }
            return (.object(matcher), label)
        case .addonCall:
            guard case .string(let addonId)? = p["addonId"], case .string(let tool)? = p["tool"] else { return nil }
            let words: String = if case .string(let w)? = p["words"] { w } else { tool }
            let addon: String = if case .string(let a)? = p["addon"] { a } else { "the add-on" }
            return (.object(["addonId": .string(addonId), "tool": .string(tool)]), "\(words) with \(addon)")
        default:
            return nil
        }
    }

    // MARK: - the transcript's held line

    /// A Work thread's call the host held for the owner's press ("Held as item
    /// 12: Send to Dana Lee: Re: budget. It waits…", work/outbox/words.ts): its
    /// number and the act in his words; nil for any other result. Only a call
    /// the hold answers (an add-on's tool, the bridge's addon_call, a computer
    /// step): a shell echoing the words draws nothing.
    public nonisolated static func heldOf(tool: String, result: String) -> (n: Int, act: String)? {
        guard tool.hasPrefix("mcp__") || tool == "addon_call" || tool.hasPrefix("computer_") else { return nil }
        guard let start = result.range(of: "Held as item "),
              let end = result.range(of: ". It waits for the owner's press.", range: start.upperBound..<result.endIndex) else { return nil }
        let body = result[start.upperBound..<end.lowerBound]
        guard let colon = body.firstIndex(of: ":"), let n = Int(body[..<colon]) else { return nil }
        let act = body[body.index(after: colon)...].trimmingCharacters(in: .whitespacesAndNewlines)
        return act.isEmpty ? nil : (n, act)
    }

    // MARK: - the list

    /// One held item and the host it waits on.
    public struct Entry: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var item: OutboxItem
        public var id: String { "\(environmentId):\(OutboxModel.key(item.ref))" }

        public init(environmentId: String, item: OutboxItem) {
            self.environmentId = environmentId
            self.item = item
        }
    }

    /// A band of the list: one workspace's held items (or Work Chats'), on one host.
    public struct Band: Sendable, Hashable, Identifiable {
        public var id: String
        public var environmentId: String
        /// Nil for Work Chats.
        public var workspaceId: String?
        public var sector: String?
        public var entries: [Entry]
    }

    /// A held ref as one string: "host:<id>" or "lifeos:<table>:<id>".
    public nonisolated static func key(_ ref: HeldRef) -> String {
        switch ref {
        case .host(let r): "host:\(r.id)"
        case .lifeos(let r): "lifeos:\(r.table.rawValue):\(r.id)"
        case .unknown(let v): "unknown:\(text(v))"
        }
    }

    /// A key back to its ref (a held item's route); nil for one this build cannot name.
    public nonisolated static func ref(_ key: String) -> HeldRef? {
        let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        switch parts.first {
        case "host" where parts.count >= 2: return .host(.init(id: parts.dropFirst().joined(separator: ":")))
        case "lifeos" where parts.count == 3: return .lifeos(.init(table: .init(rawValue: parts[1]), id: parts[2]))
        default: return nil
        }
    }

    /// Held items under their workspace, newest first, bands in the order of
    /// their newest item. Work Chats' items are one band per host.
    public nonisolated static func bands(_ entries: [Entry]) -> [Band] {
        var order: [String] = []
        var bands: [String: Band] = [:]
        for entry in entries.sorted(by: { ($0.item.createdAt, $0.id) > ($1.item.createdAt, $1.id) }) {
            let workspaceId = entry.item.workspaceId == workChatsKey ? nil : entry.item.workspaceId
            let id = "\(entry.environmentId):\(workspaceId ?? workChatsKey)"
            if bands[id] == nil {
                order.append(id)
                bands[id] = Band(id: id, environmentId: entry.environmentId, workspaceId: workspaceId, sector: entry.item.sector, entries: [])
            }
            bands[id]?.entries.append(entry)
        }
        return order.compactMap { bands[$0] }
    }

    // MARK: - the return from Away

    public struct AwayCounts: Sendable, Hashable {
        public var held: Int
        public var failed: Int
        public var decided: Int
        public var written: Int

        public init(held: Int = 0, failed: Int = 0, decided: Int = 0, written: Int = 0) {
            self.held = held
            self.failed = failed
            self.decided = decided
            self.written = written
        }
    }

    /// The notice's body: "7 held, 4 decided without you, 2 failed"; nil when nothing happened.
    public nonisolated static func awayLine(_ c: AwayCounts) -> String? {
        var parts: [String] = []
        if c.held > 0 { parts.append("\(c.held) held") }
        if c.decided > 0 { parts.append("\(c.decided) decided without you") }
        if c.failed > 0 { parts.append("\(c.failed) failed") }
        if parts.isEmpty { return c.written > 0 ? "Wrote on \(c.written) \(c.written == 1 ? "file" : "files") while you were away" : nil }
        return parts.joined(separator: ", ")
    }

    /// The review's sections, in the order he must act. Empty ones are left out.
    public enum AwaySection: String, Sendable, Hashable, CaseIterable {
        case held, failed, decided, written

        public var heading: String {
            switch self {
            case .held: "Held"
            case .failed: "Failed"
            case .decided: "Decided without you"
            case .written: "Written on your files"
            }
        }
    }

    public nonisolated static func awaySections(_ c: AwayCounts) -> [AwaySection] {
        AwaySection.allCases.filter { section in
            switch section {
            case .held: c.held > 0
            case .failed: c.failed > 0
            case .decided: c.decided > 0
            case .written: c.written > 0
            }
        }
    }
}

extension JSONEncoder {
    /// Keys sorted, so a value prints the same every time.
    nonisolated static let sorted: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
