import Foundation
import TempCodeContract

/// The rows of the kinds the generic reader would leak ids, revisions and
/// raw values for (a form's publish, a Google share, a Frame.io post): what
/// he approves, in his words, the same as the desktop's `kindRows`
/// (work/acts/kindRows.ts). None of these kinds is editable, so a body here is
/// read only. A Teams post stays with the generic reader, which reads it the
/// same way ("In", the post as the body) and keeps both editable.
public extension OutboxModel {
    nonisolated static func kindView(kind: OutboxItem.Kind, payload: JSONValue?) -> PayloadView? {
        guard case .object(let o)? = payload else { return nil }
        var rows: [(String, String)] = []
        var body: String?
        switch kind {
        case .formPublish:
            if let title = word(o["title"]) { rows.append(("Form", title)) }
            if case .number(let n)? = o["questions"] { rows.append(("Questions", String(Int(n)))) }
            body = word(o["content"])
        case .shareGoogle:
            // The file is in the title already ("Share Budget.xlsx with …"): the person, the access, the
            // mail, and the account it is shared from (two shares alike but for it differ there alone).
            if let email = word(o["email"]) { rows.append(("Person", email)) }
            if let role = word(o["role"]) { rows.append(("Access", access[role] ?? role)) }
            if let account = word(o["account"]) { rows.append(("Account", account)) }
            if case .bool(true)? = o["notify"] { rows.append(("Notice", "Tells them by mail")) }
        case .frameioPost:
            if word(o["what"]) == "version" {
                if let onto = word(o["ontoName"]) { rows.append(("On top of", onto)) }
                if let name = word(o["name"]) { rows.append(("File", name)) }
                if case .number(let size)? = o["size"] { rows.append(("Size", megabytes(size))) }
                if let from = word(o["from"]) { rows.append(("From", from)) }
            } else {
                if let file = word(o["fileName"]) { rows.append(("File", file)) }
                // Everything the post carries: how long it spans and each mark, in words, and what Frame.io
                // draws otherwise, so two comments alike in words differ on screen where they differ there.
                if let at = word(o["clock"]) {
                    let span: Double? = if case .number(let n)? = o["durationFrames"] { n } else { nil }
                    rows.append(("At", span.map { $0 > 1 ? "\(at), for \(Int($0)) frames" : at } ?? at))
                }
                let marks = marksWords(pin: o["pin"], shapes: o["shapes"])
                if let words = marks.words { rows.append(("Marks", words)) }
                if let changes = marks.changes { rows.append(("Goes as", changes)) }
                body = word(o["text"])
            }
        case .computerAct:
            // The app, the window, the address and what the press lands on; the title (the heading), the
            // label (Send's word) and the call's raw targets are not his to read twice.
            let app: String? = if case .object(let a)? = o["app"] { word(a["name"]) } else { word(o["app"]) }
            if let app { rows.append(("App", app)) }
            if let window = word(o["window"]) { rows.append(("Window", window)) }
            if case .object(let args)? = o["args"], let url = word(args["url"]) { rows.append(("URL", url)) }
            if case .object(let read)? = o["read"], let on = word(read["on"]) { rows.append(("On", on)) }
        default:
            return nil
        }
        var view = PayloadView(fields: rows.map { Field(key: $0.0.lowercased(), path: [$0.0], label: $0.0, value: $0.1, edit: nil) })
        if let body { view.body = .init(path: ["body"], text: body, readOnly: true) }
        return view
    }

    /// What a row's second line says from the summary: the words after its first ": " ("Share
    /// Budget.xlsx with dana@purdue.edu (can edit): …"), the act itself before them. The desktop's
    /// `splitSummary`.
    nonisolated static func splitSummary(_ summary: String) -> (act: String, about: String?) {
        guard let at = summary.range(of: ": "), at.lowerBound > summary.startIndex else { return (summary, nil) }
        return (String(summary[..<at.lowerBound]), String(summary[at.upperBound...]))
    }

    /// An Outbox row's two lines. The title is the act, the summary before its ": "; the line is the
    /// failure's reason, a calendar act's When, a mail's subject, and for every other kind the
    /// summary's words after the ": " (the desktop's row), never the first text of its payload (an
    /// account, an id).
    nonisolated static func rowWords(_ item: OutboxItem) -> (title: String, line: String?) {
        let (act, about) = splitSummary(item.summary)
        if item.state == .failed { return (act, checkFirst(item) ?? item.error ?? "Didn’t send") }
        if let when = calendarWhen(kind: item.kind, payload: item.payload) { return (act, when) }
        switch item.kind {
        case .mailSend, .officeMailSend:
            let view = payloadView(item.payload)
            let subject = view.fields.first { $0.key == "subject" }?.value
            return (act, subject ?? about ?? view.body.flatMap { $0.text.split(separator: "\n").first.map(String.init) })
        default:
            return (act, about)
        }
    }

    private nonisolated static let shapeWords: [String: (one: String, many: String)] = [
        "rect": ("a box", "boxes"), "ellipse": ("an oval", "ovals"), "line": ("a line", "lines"), "arrow": ("an arrow", "arrows"), "pen": ("a drawn line", "drawn lines"),
    ]
    /// What Frame.io cannot draw as drawn, said as the host's post makes it (frameio/map.ts `annotationOf`).
    private nonisolated static let lossy = ["ellipse": "an oval as its box", "pen": "a drawn line as straight lines"]

    /// A comment's marks in words ("A pin, 2 boxes and an oval") and what Frame.io draws otherwise
    /// ("An oval as its box"): the desktop's `marksWords`.
    nonisolated static func marksWords(pin: JSONValue?, shapes: JSONValue?) -> (words: String?, changes: String?) {
        var order: [String] = []
        var counts: [String: Int] = [:]
        if case .array(let list)? = shapes {
            for shape in list {
                guard case .object(let o) = shape, case .string(let tool)? = o["tool"] else { continue }
                if counts[tool] == nil { order.append(tool) }
                counts[tool, default: 0] += 1
            }
        }
        var parts: [String] = []
        if case .object? = pin { parts.append("a pin") }
        for tool in order {
            let n = counts[tool] ?? 0
            parts.append(n == 1 ? (shapeWords[tool]?.one ?? "a \(tool)") : "\(n) \(shapeWords[tool]?.many ?? "\(tool)s")")
        }
        let words: String? = parts.isEmpty ? nil : parts.count == 1 ? parts[0] : "\(parts.dropLast().joined(separator: ", ")) and \(parts[parts.count - 1])"
        let changes = order.compactMap { lossy[$0] }.joined(separator: "; ")
        let cap = { (t: String) in t.prefix(1).uppercased() + t.dropFirst() }
        return (words.map(cap), changes.isEmpty ? nil : cap(changes))
    }

    private nonisolated static let access = ["reader": "Can view", "commenter": "Can comment", "writer": "Can edit"]

    private nonisolated static func word(_ value: JSONValue?) -> String? {
        guard case .string(let s)? = value else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// "700 MB", "1.5 MB": whole from 100 MB, one place below (the desktop's `megabytes`, in MiB).
    nonisolated static func megabytes(_ bytes: Double) -> String {
        let mb = bytes / (1024 * 1024)
        return String(format: bytes >= 100 * 1024 * 1024 ? "%.0f MB" : "%.1f MB", mb)
    }
}
