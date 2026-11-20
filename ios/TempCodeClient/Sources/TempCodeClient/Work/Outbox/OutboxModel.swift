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

    /// What a list or a card never sends, only opens: what its own detail alone shows. A LifeOS
    /// mail may be a reply that quotes the mail it answers, which only its whole read carries; an
    /// Outlook mail's body is its html, which the list and the pushes leave out; a
    /// computer act's kept picture of the window is in its whole read alone (the desktop's
    /// `sendMany` leaves both for their own look).
    public nonisolated static func sendsFromDetailOnly(_ kind: OutboxItem.Kind) -> Bool {
        kind == .mailSend || kind == .officeMailSend || kind == .computerAct
    }

    /// A computer act's kept picture in a whole read: none was kept, kept with its bytes, or
    /// kept but the bytes did not come (a failure, never "none").
    public enum KeptPicture: Sendable, Hashable {
        case notKept
        case bytes(Data, width: Double?, height: Double?)
        case missing
    }

    public nonisolated static func keptPicture(_ payload: JSONValue?) -> KeptPicture {
        guard case .object(let o)? = payload, case .object(let picture)? = o["picture"] else { return .notKept }
        let size = { (key: String) -> Double? in if case .number(let n)? = picture[key] { n } else { nil } }
        guard case .string(let data)? = picture["data"], let bytes = Data(base64Encoded: data), !bytes.isEmpty else { return .missing }
        return .bytes(bytes, width: size("width"), height: size("height"))
    }

    /// Whether the detail may send: for what a list never sends, the whole read has come
    /// (with a computer act's kept picture in it); anything else as listed.
    public nonisolated static func detailReady(_ kind: OutboxItem.Kind, whole: OutboxItem?) -> Bool {
        guard sendsFromDetailOnly(kind) else { return true }
        guard let whole else { return false }
        return kind != .computerAct || keptPicture(whole.payload) != .missing
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

    /// "Send" → "Sent", "Reply" → "Replied", "Move or rename files" → "Moved or renamed files": the
    /// desktop's `pastOf`. A verb is the first word, or one that follows "or"/"and" right after another
    /// verb; the words after them stay. An older Outlook tentative answer's verb, "Maybe", is said whole.
    public nonisolated static func pastOf(_ verb: String, kind: OutboxItem.Kind? = nil) -> String {
        if verb == "Maybe" { return "Answered maybe" }
        // A computer act's verb is its control's own word ("Reset", "Bid"): one the table does not know reads as the press it was.
        if pressed(verb, kind: kind) { return "Pressed \(verb)" }
        return turned(verb, pastWord)
    }

    /// A computer act whose first word the past table does not know: said as a press ("Pressed Reset", "Pressing
    /// Reset"), never a guessed past ("Reseted"). The desktop's `pastOf(verb, kind)`.
    private nonisolated static func pressed(_ verb: String, kind: OutboxItem.Kind?) -> Bool {
        guard kind == .computerAct else { return false }
        let head = verb.split(separator: " ", omittingEmptySubsequences: false).first.map { $0.lowercased() } ?? ""
        return past[head] == nil
    }

    /// The desktop's PAST (work/outbox/model.ts), word for word.
    private nonisolated static let past = [
        "send": "sent", "post": "posted", "make": "made", "accept": "accepted", "submit": "submitted", "share": "shared", "book": "booked",
        "run": "ran", "publish": "published", "decline": "declined", "reply": "replied", "pay": "paid", "buy": "bought", "put": "put", "set": "set",
        "upload": "uploaded", "forward": "forwarded", "answer": "answered", "sell": "sold", "leave": "left", "withdraw": "withdrew", "give": "gave",
        "hold": "held", "take": "took", "get": "got", "keep": "kept", "tell": "told", "bring": "brought", "draw": "drew", "choose": "chose",
        "write": "wrote", "begin": "began", "find": "found", "spend": "spent", "build": "built", "meet": "met", "pick": "picked", "go": "went",
        "do": "did", "say": "said", "win": "won", "cut": "cut", "let": "let", "quit": "quit",
    ]
    /// Verbs stressed on a last syllable that doubles its consonant: "Transfer" → "Transferred" (the desktop's DOUBLES).
    private nonisolated static let doublesSet: Set<String> = ["transfer", "commit", "submit", "admit", "permit", "omit", "refer", "prefer", "occur", "regret", "control", "patrol", "compel", "expel", "rebut", "unpin", "unplug", "quit", "begin"]

    /// One syllable, one vowel, one closing consonant ("stop", "ship", "plan"), or a stressed last syllable
    /// in `doublesSet`: the final consonant doubles (the desktop's `doubles`).
    nonisolated static func doubles(_ w: String) -> Bool {
        doublesSet.contains(w) || w.range(of: "^[^aeiou]*[aeiou][b-df-hj-np-tvz]$", options: .regularExpression) != nil
    }

    /// The verb words of a label turned by `word`, each keeping its first letter's case.
    private nonisolated static func turned(_ verb: String, _ word: (String) -> String) -> String {
        let words = verb.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        var verbAt: Set<Int> = [0]
        if words.count > 2 { for i in 2..<words.count where (words[i - 1] == "or" || words[i - 1] == "and") && verbAt.contains(i - 2) { verbAt.insert(i) } }
        return words.enumerated().map { i, w in verbAt.contains(i) && !w.isEmpty ? cased(word(w.lowercased()), like: w) : w }.joined(separator: " ")
    }

    private nonisolated static func cased(_ turned: String, like word: String) -> String {
        word.first?.isUppercase == true ? turned.prefix(1).uppercased() + turned.dropFirst() : turned
    }

    private nonisolated static func pastWord(_ w: String) -> String {
        if let known = past[w] { return known }
        if w.hasSuffix("e") { return w + "d" }
        if w.count > 1, w.hasSuffix("y"), let before = w.dropLast().last, !"aeiou".contains(before) { return w.dropLast() + "ied" }
        if doubles(w), let last = w.last { return w + String(last) + "ed" }
        return w + "ed"
    }

    /// "Stop" → "Stopping", "Transfer" → "Transferring", "Make" → "Making": the past's doubling, applied to -ing.
    private nonisolated static func progressiveWord(_ w: String) -> String {
        if w.hasSuffix("e"), !w.hasSuffix("ee"), w.count > 2 { return w.dropLast() + "ing" }
        if doubles(w), let last = w.last { return w + String(last) + "ing" }
        return w + "ing"
    }

    /// "Sending to events booking": the undo capsule's line while a press waits its five seconds.
    /// A mail names its recipients from the payload ("Sending to Dana Lee"), as the host's
    /// summary does, without the subject the summary carries after them; any other act
    /// is its summary with the verb made progressive.
    public nonisolated static func pendingLine(_ item: OutboxItem) -> String {
        if let people = recipients(item), !people.isEmpty {
            return "\(progressive(item.verb, kind: item.kind)) to \(peopleWords(people))"
        }
        let summary = item.summary
        guard summary.hasPrefix(item.verb) else { return summary }
        let rest = summary.dropFirst(item.verb.count)
        return progressive(item.verb, kind: item.kind) + rest
    }

    /// A mail's To and Cc as a person reads them: the name where there is one, else the address.
    /// LifeOS's mail keeps them under `message`; Outlook's as plain addresses at the top.
    nonisolated static func recipients(_ item: OutboxItem) -> [String]? {
        guard case .object(let payload)? = item.payload else { return nil }
        switch item.kind {
        case .mailSend:
            guard case .object(let message)? = payload["message"] else { return nil }
            return ["to", "cc"].flatMap { key in (message[key].flatMap(addresses) ?? []).map { $0.name ?? $0.address } }
        case .officeMailSend:
            return ["to", "cc"].flatMap { key -> [String] in
                guard case .array(let list)? = payload[key] else { return [] }
                return list.compactMap { value -> String? in
                    guard case .string(let address) = value else { return nil }
                    return address
                }
            }
        default:
            return nil
        }
    }

    /// "Dana Lee", "Dana Lee and Sam", "Dana Lee, Sam and 2 more": the host's own list words.
    nonisolated static func peopleWords(_ people: [String]) -> String {
        people.count <= 2 ? people.joined(separator: " and ") : "\(people.prefix(2).joined(separator: ", ")) and \(people.count - 2) more"
    }

    /// "Send" → "Sending", "Answer maybe" → "Answering maybe", "Move or rename files" → "Moving or
    /// renaming files": the undo capsule's verb, turned as `pastOf` turns it.
    nonisolated static func progressive(_ verb: String, kind: OutboxItem.Kind? = nil) -> String {
        if verb == "Maybe" { return "Answering maybe" }
        if pressed(verb, kind: kind) { return "Pressing \(verb)" }
        return turned(verb, progressiveWord)
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
            /// An html with no text beside it (Outlook's mail): shown as words, never edited here.
            public var readOnly = false
            public var id: String { path.joined(separator: ".") }
        }

        public var fields: [Field]
        public var body: Body?
        /// What LifeOS puts under a reply: the answered mail, as words (`HtmlWords`), drawn muted
        /// under the body and never a field (it is not his to edit).
        public var quote: String? = nil
    }

    /// Keys that are the host's bookkeeping, never what goes.
    private nonisolated static let quiet: Set<String> = ["id", "status", "kind", "accountId", "html", "addonId", "specDigest", "toolDigest", "hints", "mark", "targets", "picture", "read", "proposed", "error", "words", "addon", "tool", "why", "host", "quote", "replyTo", "forward"]
    /// Keys whose text is the body: drawn as one plain-text block, not a field.
    private nonisolated static let bodyKeys = ["text", "body", "message", "content"]
    private nonisolated static let labels = ["to": "To", "cc": "Cc", "bcc": "Bcc", "from": "From", "subject": "Subject", "channel": "In", "title": "Title", "app": "App", "window": "Window", "label": "Act", "url": "URL", "chat": "In", "account": "From", "outlookAdds": "Also goes"]
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

    /// A field the host keeps whatever an edit says (Outlook's `keepOfficeMail`): the account a mail goes
    /// from, what Outlook adds under a reply, and a reply's or a forward's subject. Never offered in Edit,
    /// so a reply has nothing to edit and Edit hides.
    nonisolated static func kept(_ key: String, in object: [String: JSONValue]) -> Bool {
        if key == "account" || key == "outlookAdds" { return true }
        return key == "subject" && (object["replyTo"] != nil || object["forward"] != nil)
    }

    /// The names of a mail's files, its attachments then its forwarded parts; nil where the object has
    /// neither list (not a mail), so their keys read as any other.
    nonisolated static func fileNames(_ object: [String: JSONValue]) -> [String]? {
        let lists = ["attachments", "forwardParts"].compactMap { key -> [JSONValue]? in
            if case .array(let list)? = object[key] { list } else { nil }
        }
        guard !lists.isEmpty else { return nil }
        return lists.flatMap { list in list.compactMap { item -> String? in
            guard case .object(let o) = item, case .string(let name)? = o["name"] else { return nil }
            return name
        } }
    }

    /// A value exactly as JSON writes it: `null`, `""`, an object or a list whole.
    nonisolated static func json(_ value: JSONValue) -> String {
        (try? String(decoding: JSONEncoder.sorted.encode(value), as: UTF8.self)) ?? ""
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
        // Inside an add-on call's or a computer act's arguments every key is what goes, so none is quiet there:
        // no bookkeeping filter, a null or an empty value shown as it goes, an object or a list whole as JSON
        // (the desktop's payloadView, the hold re-review's findings 10 and 18).
        func walk(_ value: JSONValue, _ path: [String], _ depth: Int, quiet: Bool = true) {
            guard case .object(let object) = value else { return }
            // The html is what goes when there is one: the body reads from it (links with their targets,
            // images named), and an edit goes to the text beside it; with none beside it, it is read only
            // (the desktop's payloadView, the hold review's findings 4 and 11).
            if quiet, view.body == nil, case .string(let html)? = object["html"], !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let hasText: Bool = if case .string? = object["text"] { true } else { false }
                view.body = .init(path: path + [hasText ? "text" : "html"], text: HtmlWords.of(html), readOnly: !hasText)
            }
            // A mail's files are its own attachments and the parts it forwards from the mail it answers: one
            // row of their names, as the desktop's mail lists them (the hold review).
            let files = quiet ? fileNames(object) : nil
            for (key, v) in ordered(object) {
                if quiet, OutboxModel.quiet.contains(key) { continue }
                if files != nil, key == "attachments" || key == "forwardParts" { continue }
                let at = path + [key]
                if !quiet {
                    switch v {
                    case .null, .array, .object:
                        view.fields.append(Field(key: key, path: at, label: label(key), value: json(v), edit: nil))
                        continue
                    case .string(let s) where s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                        view.fields.append(Field(key: key, path: at, label: label(key), value: json(v), edit: .text))
                        continue
                    default:
                        break
                    }
                }
                switch v {
                case .null:
                    continue
                case .string(let s):
                    if quiet, view.body?.path == at { continue }
                    // A post's own words at the top (a Teams reply) are its body at any length, with no html beside them.
                    let topText = depth == 0 && key == "text" && object["html"] == nil
                    if view.body == nil, bodyKeys.contains(key), topText || s.contains("\n") || s.count > 80 {
                        view.body = .init(path: at, text: s)
                    } else if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: s, edit: quiet && kept(key, in: object) ? nil : .text))
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
                        walk(v, at, depth + 1, quiet: key == "message")
                    } else if case .string(let name)? = o["name"] {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: name, edit: nil))
                    } else {
                        view.fields.append(Field(key: key, path: at, label: label(key), value: text(v), edit: nil))
                    }
                }
            }
            if let files, !files.isEmpty {
                view.fields.append(Field(key: "files", path: path + ["attachments"], label: "Files", value: files.joined(separator: ", "), edit: nil))
            }
        }
        if let payload { walk(payload, [], 0) }
        if case .object(let o)? = payload, case .string(let quote)? = o["quote"], !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let words = HtmlWords.of(quote)
            view.quote = words.isEmpty ? nil : words
        }
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
        if let body = view.body, !body.readOnly { editable.append((body.path, "Message", .text)) }
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

    /// What Away's "Written on your files" lists from a host's results (the desktop's `writesOf`):
    /// writes made in the stretch, cut at the moment he came back, never a send (a send's Result
    /// carries `ref.held`, and the Held and Failed sections already speak for it).
    public nonisolated static func awayWrites(_ results: [WorkResult], until: Int) -> [WorkResult] {
        results.filter { result in
            guard result.createdAt <= until else { return false }
            if case .object(let ref)? = result.ref, let held = ref["held"], held != .null { return false }
            return true
        }
    }

    /// The line under Written when some hosts' writes did not come back: one host by name, else a count.
    public nonisolated static func unreadLine(_ names: [String]) -> String? {
        guard let first = names.first else { return nil }
        return names.count == 1 ? "\(first) did not answer" : "\(names.count) hosts did not answer"
    }

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
        // As JSON.stringify writes it on the desktop: an address keeps its slashes.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
