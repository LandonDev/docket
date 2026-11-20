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
            // The form's name is the heading's (`kindHeading`), said once.
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
                // Each mark where it lands and how big, so two posts that differ only there never read the same.
                rows += markRows(pin: o["pin"], shapes: o["shapes"], height: o["height"])
                if let changes = marksWords(pin: o["pin"], shapes: o["shapes"]).changes { rows.append(("Goes as", changes)) }
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
            // Every step in order, what it types in full: a batch's tail never hides behind its cut title.
            if case .object(let args)? = o["args"] { rows += stepRows(args: args, targets: o["targets"]) }
        default:
            return nil
        }
        // Each row its own id (its label and place): a batch's steps and a comment's marks share labels, and a
        // list keyed by the label alone draws one of them in each of their places.
        var view = PayloadView(fields: rows.enumerated().map { i, row in Field(key: row.0.lowercased(), path: [row.0, String(i)], label: row.0, value: row.1, edit: nil) })
        if let body { view.body = .init(path: ["body"], text: body, readOnly: true) }
        return view
    }

    /// The detail's heading for a kind whose rows carry the rest, so each fact is said once there (the
    /// list keeps the whole summary): a form's publish names the form, a Google share the file (Person and
    /// Access are rows), a Teams post nothing but the act (the chat is the In row, the post the body). Nil
    /// for any other kind. `sent` gives the past. The desktop's `kindHeading`, word for word.
    nonisolated static func kindHeading(kind: OutboxItem.Kind, payload: JSONValue?, sent: Bool) -> String? {
        let o: [String: JSONValue] = if case .object(let o)? = payload { o } else { [:] }
        switch kind {
        case .formPublish:
            return word(o["title"]).map { "\(sent ? "Published" : "Publish") \($0)" }
        case .shareGoogle:
            return word(o["name"]).map { "\(sent ? "Shared" : "Share") \($0)" }
        case .teamsPost:
            if case .string? = o["html"] { return nil }
            return sent ? "Posted in Teams" : "Post in Teams"
        default:
            return nil
        }
    }

    /// A Google share's row (the desktop's `rowWords`): its summary ("Share Budget Q3 final.xlsx with dana@… (can
    /// edit)") has no colon, so a long file name would cut the person off. Its title is who and how ("Share with
    /// dana@purdue.edu (can edit)") and the file its second line; the detail keeps its own heading.
    nonisolated static func shareWords(_ item: OutboxItem) -> (act: String, about: String?)? {
        guard item.kind == .shareGoogle, case .object(let o)? = item.payload,
              case .string(let email)? = o["email"], case .string(let name)? = o["name"] else { return nil }
        // The role is the summary's last parenthesis, as the desktop reads it.
        let role = item.summary.range(of: #"\(([^)]*)\)\s*$"#, options: .regularExpression).map { found in
            String(String(item.summary[found]).trimmingCharacters(in: .whitespaces).dropFirst().dropLast())
        }
        return ("\(item.verb) with \(email)\(role.map { " (\($0))" } ?? "")", name)
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
        let (act, about) = shareWords(item) ?? splitSummary(item.summary)
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

    // MARK: - a computer act's steps (the desktop's `stepRows`)

    /// A string as it goes, in quotes: JSON's escapes for quotes, backslashes and the C0 controls (as
    /// `JSON.stringify` writes them), then an escape for every other character that cannot be seen or looks like a
    /// space, by its Unicode class: any format character (Cf: soft hyphen, zero-width and invisible operators, bidi
    /// marks, tags), control (Cc), line or paragraph separator (Zl, Zp), and any space (Zs) but U+0020. Written as
    /// `\uXXXX`, or `\u{XXXXX}` past the first plane, one per code point, so " " and "\u00a0" never read alike. The
    /// desktop's `exactQuote`.
    nonisolated static func exactQuote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case " ": out += " "
            default:
                if scalar.value < 0x20 || unseen(scalar) {
                    out += scalar.value > 0xFFFF ? "\\u{" + String(scalar.value, radix: 16) + "}" : "\\u" + String(format: "%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    /// Cf, Cc, Zl, Zp and Zs: what cannot be seen or looks like a space.
    private nonisolated static func unseen(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .format, .control, .lineSeparator, .paragraphSeparator, .spaceSeparator: true
        default: false
        }
    }

    private nonisolated static let clicks = ["left_click": "Clicks", "right_click": "Right-clicks", "middle_click": "Middle-clicks", "double_click": "Double-clicks", "triple_click": "Triple-clicks"]

    /// An element as the host bound it: its own role and name, `button "Send"`. The host writes the chain as JSON
    /// tuples (`[["button","Send"],["group","Compose"]]`); an act held before that has `button:Send < group:Compose`.
    nonisolated static func sigWords(_ sig: JSONValue?) -> String? {
        guard case .string(let sig)? = sig, !sig.isEmpty else { return nil }
        let role: String, name: String
        if sig.hasPrefix("[") {
            guard let data = sig.data(using: .utf8), let chain = try? JSONDecoder().decode([[String]].self, from: data),
                  let own = chain.first, let first = own.first else { return nil }
            role = first
            name = own.count > 1 ? own[1] : ""
        } else {
            let own = sig.components(separatedBy: " < ")[0]
            guard let colon = own.firstIndex(of: ":") else { return own }
            role = String(own[..<colon])
            name = String(own[own.index(after: colon)...])
        }
        return name.isEmpty ? role : "\(role) \(json(.string(name)))"
    }

    /// Every step of the call in order, as he approves it: what each types or pastes in full (never
    /// cut), what each clicks by the element the host bound, the keys it presses. A batch is a list of
    /// these; a single act is one. Steps that send nothing (a screenshot, a zoom) are left out.
    nonisolated static func stepRows(args: [String: JSONValue], targets: JSONValue?) -> [(String, String)] {
        let steps: [[String: JSONValue]]
        if case .array(let list)? = args["actions"] {
            steps = list.compactMap { if case .object(let o) = $0 { o } else { nil } }
        } else if case .string? = args["action"] {
            steps = [args]
        } else {
            steps = []
        }
        let bound: [[String: JSONValue]] = if case .array(let list)? = targets { list.compactMap { if case .object(let o) = $0 { o } else { nil } } } else { [] }
        var rows: [(String, String)] = []
        // Where the focus is as the steps run: the element the host bound as focused when the call was held, then
        // whatever a step puts it on (a click, a set value, a typed text into a named element); a Tab or a step on no
        // named element leaves it unknown, said plainly.
        var focus: String? = sigWords(bound.first { $0["param"] == .string("focus") }?["sig"])
        for (i, a) in steps.enumerated() {
            func target(_ param: String) -> [String: JSONValue]? {
                bound.first { $0["step"] == .number(Double(i)) && $0["param"] == .string(param) }
            }
            func whereAt(_ param: String, _ point: JSONValue?, _ element: JSONValue?) -> String {
                let t = target(param) ?? (param == "element" ? target("point") : nil)
                if let name = sigWords(t?["sig"]) { return name }
                if case .array(let xy)? = point, xy.count == 2 { return "the point \(number(xy[0])),\(number(xy[1]))" }
                if case .number? = element { return "element \(number(element!))" }
                return "where the cursor is"
            }
            let on = { whereAt("element", a["coordinate"], a["element"]) }
            let text: String? = if case .string(let t)? = a["text"] { t } else { nil }
            // A typed text, a paste or a key goes to its own element when it names one (bound by the host), else to the focus.
            let own = sigWords((target("element") ?? target("point"))?["sig"])
            let elementWords: String? = if case .number? = a["element"] { "element \(number(a["element"]!))" } else { nil }
            let into = own ?? elementWords ?? focus ?? "the focus"
            let count: (JSONValue?) -> Double? = { if case .number(let n)? = $0, n.isFinite, n != 0 { n } else { nil } }
            guard case .string(let action)? = a["action"] else { continue }
            switch action {
            case "type": if let text { rows.append(("Types", "into \(into): \(text)")) }
            case "paste": if let text { rows.append(("Pastes", "into \(into): \(text)")) }
            case "set_value":
                let value: String = if case .string(let v)? = a["value"] { v } else { text ?? "" }
                rows.append(("Sets", "\(on()) to \(json(.string(value)))"))
            case "key":
                if let text { rows.append(("Presses", text + (count(a["repeat"]).map { $0 > 1 ? ", \(number(.number($0))) times" : "" } ?? "") + ", in \(into)")) }
            case "hold_key":
                if let text { rows.append(("Holds", text + (count(a["duration"]).map { " for \(number(.number($0))) s" } ?? "") + ", in \(into)")) }
            case "left_click_drag":
                rows.append(("Drags", "from \(whereAt("start_element", a["start_coordinate"], a["start_element"])) to \(on())"))
            case "scroll":
                let direction = word(a["scroll_direction"]) ?? "down"
                rows.append(("Scrolls", "\(direction)\(count(a["scroll_amount"]).map { " \(number(.number($0)))" } ?? "") at \(on())"))
            case "perform":
                rows.append(("Performs", "\(word(a["name"]) ?? "an action") on \(on())"))
            case "select_text":
                // What it finds (its first match, narrowed by the words right around it, or a span of characters), in
                // which field, and whether it selects that or only puts the caret beside it: "select Pay" and "caret
                // after Pay" then paste the same text to different ends (the desktop's words).
                let range: String? = if case .array(let ends)? = a["range"], ends.count == 2 { "characters \(number(ends[0])) to \(number(ends[1]))" } else { nil }
                // Every prefix and suffix given is shown as it is, spaces alone included: the matcher compares them unit
                // for unit, so " Pay" and the first "Pay" can be different occurrences.
                let around = [("right after", a["prefix"]), ("right before", a["suffix"])].compactMap { words, value -> String? in
                    guard case .string(let given)? = value, !given.isEmpty else { return nil }
                    return "\(words) \(exactQuote(given))"
                }.joined(separator: " and ")
                let match = range ?? "the first \(exactQuote(text ?? ""))\(around.isEmpty ? "" : " \(around)")"
                let place = word(a["place"])
                if place == "before" || place == "after" {
                    rows.append(("Puts the caret", "\(place!) \(match) in \(into)"))
                } else {
                    rows.append(("Selects", "\(match) in \(into)"))
                }
            case "save_as":
                rows.append(("Saves as", word(a["path"]) ?? word(a["named"]) ?? "a file"))
            case "mouse_move":
                rows.append(("Moves to", on()))
            case "left_mouse_down", "left_mouse_up":
                rows.append((action == "left_mouse_down" ? "Presses the mouse" : "Lets go of the mouse", on()))
            default:
                if let click = clicks[action] {
                    rows.append((click, on()))
                } else if !["screenshot", "zoom", "cursor_position", "wait"].contains(action) {
                    let label = action.replacingOccurrences(of: "_", with: " ")
                    rows.append((label.prefix(1).uppercased() + label.dropFirst(), text ?? on()))
                }
            }
            // Where this step leaves the focus, for the steps after it.
            let named = own ?? elementWords
            if clicks[action] != nil || ["set_value", "select_text", "left_mouse_down"].contains(action) {
                focus = named
            } else if ["type", "paste", "key", "hold_key"].contains(action), let named {
                focus = named
            }
            if action == "key" || action == "hold_key", let text, text.range(of: #"\btab\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
                focus = nil
            }
        }
        return rows
    }

    /// A number as the desktop prints it: 3, 1.5.
    private nonisolated static func number(_ value: JSONValue) -> String {
        guard case .number(let n) = value else { return json(value) }
        return n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
    }

    // MARK: - a Frame.io comment's marks (the desktop's `markRows`)

    /// A share of the frame as a percentage, exact (the value that goes, float noise trimmed): 31%, 15.5%,
    /// 12.3456%. The desktop's `+(n * 100).toPrecision(10)`.
    private nonisolated static func pct(_ value: JSONValue?) -> String {
        guard case .number(let n)? = value else { return "?" }
        return "\(percentFormat.string(from: NSNumber(value: n * 100)) ?? String(n * 100))%"
    }

    private nonisolated static let percentFormat: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.usesSignificantDigits = true
        f.maximumSignificantDigits = 10
        return f
    }()

    /// A mark's line as Frame.io draws it: its share of the frame's height in pixels, at least 1 (frameio/map.ts `pixels`).
    private nonisolated static func thickness(_ width: JSONValue?, _ height: Double) -> String {
        guard case .number(let w)? = width else { return "" }
        return ", \(max(1, Int((w * height).rounded()))) px thick"
    }

    private nonisolated static func at2(_ x: JSONValue?, _ y: JSONValue?) -> String { "\(pct(x)) across, \(pct(y)) down" }

    /// A mark's colour as a word: the hue's name, or white, grey or black.
    nonisolated static func colourWord(_ hex: JSONValue?) -> String {
        guard case .string(let hex)? = hex, hex.count == 7, hex.hasPrefix("#"), let rgb = Int(hex.dropFirst(), radix: 16) else { return "" }
        let r = Double((rgb >> 16) & 0xff) / 255, g = Double((rgb >> 8) & 0xff) / 255, b = Double(rgb & 0xff) / 255
        let high = max(r, g, b), low = min(r, g, b)
        let light = (high + low) / 2
        let sat = high == low ? 0 : (high - low) / (1 - abs(2 * light - 1))
        if sat < 0.2 { return light > 0.85 ? "white" : light < 0.15 ? "black" : "grey" }
        let d = high - low
        let hue = (high == r ? ((g - b) / d).truncatingRemainder(dividingBy: 6) : high == g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
        let h = (hue + 360).truncatingRemainder(dividingBy: 360)
        return h < 15 || h >= 345 ? "red" : h < 45 ? "orange" : h < 70 ? "yellow" : h < 160 ? "green" : h < 200 ? "teal" : h < 255 ? "blue" : h < 290 ? "purple" : "pink"
    }

    /// One row per mark: the pin, then each shape's kind, where it is, how big and its colour.
    nonisolated static func markRows(pin: JSONValue?, shapes: JSONValue?, height: JSONValue? = nil) -> [(String, String)] {
        let frame: Double = if case .number(let h)? = height, h > 0 { h } else { 1080 }
        var rows: [(String, String)] = []
        if case .object(let p)? = pin { rows.append(("Pin", "at \(at2(p["x"], p["y"]))")) }
        guard case .array(let list)? = shapes else { return rows }
        for raw in list {
            guard case .object(let s) = raw else { continue }
            let colour = colourWord(s["color"])
            let tail = (colour.isEmpty ? "" : ", \(colour)") + thickness(s["width"], frame)
            let doubled: (JSONValue?) -> JSONValue? = { if case .number(let n)? = $0 { .number(n * 2) } else { nil } }
            var words: String?
            switch word(s["tool"]) {
            case "rect": words = "A box at \(at2(s["x"], s["y"])), \(pct(s["w"])) wide and \(pct(s["h"])) high\(tail)"
            case "ellipse": words = "An oval centred \(at2(s["cx"], s["cy"])), \(pct(doubled(s["rx"]))) wide and \(pct(doubled(s["ry"]))) high\(tail)"
            case "line": words = "A line from \(at2(s["x1"], s["y1"])) to \(at2(s["x2"], s["y2"]))\(tail)"
            case "arrow": words = "An arrow from \(at2(s["x1"], s["y1"])) to \(at2(s["x2"], s["y2"]))\(tail)"
            case "pen":
                // Every point, in order: Frame.io gets a straight line between each pair (frameio/map.ts), so the whole path is what goes.
                let points: [String] = if case .array(let list)? = s["points"] {
                    list.map { point in
                        guard case .array(let xy) = point else { return at2(nil, nil) }
                        return at2(xy.count > 0 ? xy[0] : nil, xy.count > 1 ? xy[1] : nil)
                    }
                } else { [] }
                if points.count == 1 {
                    words = "A single point at \(points[0]), which Frame.io does not draw\(tail)"
                } else if points.count > 1 {
                    words = "A drawn line through \(points.joined(separator: "; "))\(tail)"
                }
            default: break
            }
            if let words { rows.append(("Mark", words)) }
        }
        return rows
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
