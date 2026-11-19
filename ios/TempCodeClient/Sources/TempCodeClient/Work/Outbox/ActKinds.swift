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
            // The file is in the title already ("Share Budget.xlsx with …"): the person, the access and the mail.
            if let email = word(o["email"]) { rows.append(("Person", email)) }
            if let role = word(o["role"]) { rows.append(("Access", access[role] ?? role)) }
            if case .bool(true)? = o["notify"] { rows.append(("Notice", "Tells them by mail")) }
        case .frameioPost:
            if word(o["what"]) == "version" {
                if let onto = word(o["ontoName"]) { rows.append(("On top of", onto)) }
                if let name = word(o["name"]) { rows.append(("File", name)) }
                if case .number(let size)? = o["size"] { rows.append(("Size", megabytes(size))) }
                if let from = word(o["from"]) { rows.append(("From", from)) }
            } else {
                if let file = word(o["fileName"]) { rows.append(("File", file)) }
                if let clock = word(o["clock"]) { rows.append(("At", clock)) }
                if case .array(let shapes)? = o["shapes"], !shapes.isEmpty { rows.append(("Marks", shapes.count == 1 ? "1 shape" : "\(shapes.count) shapes")) }
                body = word(o["text"])
            }
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
