import Foundation

/// An html body as the words a person reads (the desktop's `htmlWords`,
/// work/outbox/model.ts): every link keeps its target beside its words and
/// every image, background included, its source, so nothing in the html hides
/// from the one who approves it. Plain text out. Used for a LifeOS reply's
/// `quote`, the answered mail that goes under his words.
public enum HtmlWords {
    public nonisolated static func of(_ html: String) -> String {
        // A background goes with the mail as surely as an <img>: named before the tags go,
        // read through character references and CSS escapes as the mail's reader will.
        let plain = cssUnescape(decode(html))
        var backgrounds: [String] = []
        for m in matches(#"\sbackground\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#, in: plain) { backgrounds.append(m.firstGroup.trimmingCharacters(in: .whitespaces)) }
        for m in matches(#"url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)"#, in: plain) { backgrounds.append(m.firstGroup.trimmingCharacters(in: .whitespaces)) }

        var out = replace(#"<(script|style|head|title)\b[\s\S]*?</\1\s*>"#, in: html) { _ in "" }
        out = replace(#"<!--[\s\S]*?-->"#, in: out) { _ in "" }
        out = replace(#"<img\b[^>]*>"#, in: out) { m in
            let src = decode(attr(m.whole, "src") ?? "").trimmingCharacters(in: .whitespaces)
            let alt = decode(attr(m.whole, "alt") ?? "").trimmingCharacters(in: .whitespaces)
            return "[image\(alt.isEmpty ? "" : " \(alt)")\(src.isEmpty ? "" : ": \(src)")]"
        }
        out = replace(#"<a\b[^>]*>([\s\S]*?)</a\s*>"#, in: out) { m in
            let open = m.whole.firstIndex(of: ">").map { String(m.whole[...$0]) } ?? m.whole
            let href = decode(attr(open, "href") ?? "").trimmingCharacters(in: .whitespaces)
            let words = decode(replace("<[^>]*>", in: m.groups[0] ?? "") { _ in "" }).trimmingCharacters(in: .whitespacesAndNewlines)
            if href.isEmpty || href == words || href == "mailto:\(words)" { return words.isEmpty ? href : words }
            return words.isEmpty ? href : "\(words) (\(href))"
        }
        out = replace(#"<br\s*/?>"#, in: out) { _ in "\n" }
        out = replace(#"<li\b[^>]*>"#, in: out) { _ in "\n- " }
        out = replace(#"</(p|h[1-6]|blockquote|pre|ul|ol|table)\s*>"#, in: out) { _ in "\n\n" }
        out = replace(#"</(div|tr)\s*>"#, in: out) { _ in "\n" }
        out = replace("<[^>]*>", in: out) { _ in "" }
        var text = decode(out)
            .components(separatedBy: "\n")
            .map { line in replace(#"[ \t]+$"#, in: line) { _ in "" } }
            .joined(separator: "\n")
        text = replace(#"\n{3,}"#, in: text) { _ in "\n\n" }.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen = Set<String>()
        for url in backgrounds where !url.isEmpty && seen.insert(url).inserted { text += "\n[background image: \(url)]" }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private nonisolated static let entities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "lpar": "(", "rpar": ")", "colon": ":", "sol": "/", "bsol": "\\",
        "semi": ";", "comma": ",", "period": ".", "lowbar": "_", "num": "#", "excl": "!", "quest": "?", "equals": "=", "plus": "+", "percnt": "%",
        "lsqb": "[", "rsqb": "]", "lcub": "{", "rcub": "}", "hyphen": "-", "dash": "-", "Tab": "\t", "NewLine": "\n",
    ]

    /// Character references; a numeric one needs no semicolon, as HTML reads it.
    nonisolated static func decode(_ s: String) -> String {
        replace("&(#x[0-9a-f]+;?|#[0-9]+;?|[a-z]+;)", in: s, caseInsensitive: true) { m in
            var e = m.groups[0] ?? ""
            if e.hasSuffix(";") { e.removeLast() }
            if e.hasPrefix("#") {
                let hex = e.dropFirst().first.map { $0 == "x" || $0 == "X" } ?? false
                let n = hex ? UInt32(e.dropFirst(2), radix: 16) : UInt32(e.dropFirst())
                guard let n, n > 0, n < 0x110000, let scalar = Unicode.Scalar(n) else { return m.whole }
                return String(Character(scalar))
            }
            return entities[e] ?? entities[e.lowercased()] ?? m.whole
        }
    }

    /// CSS's own escapes, `\72` and `\r`, read as the characters they stand for.
    nonisolated static func cssUnescape(_ s: String) -> String {
        replace(#"\\([0-9a-f]{1,6})\s?|\\([^\n0-9a-f])"#, in: s, caseInsensitive: true) { m in
            if let ch = m.groups[1] { return ch }
            guard let n = UInt32(m.groups[0] ?? "", radix: 16), n > 0, n < 0x110000, let scalar = Unicode.Scalar(n) else { return "" }
            return String(Character(scalar))
        }
    }

    private nonisolated static func attr(_ tag: String, _ name: String) -> String? {
        matches(#"\s\#(name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#, in: tag).first.map(\.firstGroup)
    }

    private struct Match {
        var whole: String
        var groups: [String?]
        var firstGroup: String { groups.lazy.compactMap { $0 }.first ?? "" }
    }

    private nonisolated static func regex(_ pattern: String, caseInsensitive: Bool = true) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private nonisolated static func match(_ r: NSTextCheckingResult, in s: String) -> Match {
        let ns = s as NSString
        let groups: [String?] = (1..<max(1, r.numberOfRanges)).map { i in
            let range = r.range(at: i)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
        return Match(whole: ns.substring(with: r.range), groups: groups)
    }

    private nonisolated static func matches(_ pattern: String, in s: String) -> [Match] {
        guard let r = regex(pattern) else { return [] }
        return r.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length)).map { match($0, in: s) }
    }

    private nonisolated static func replace(_ pattern: String, in s: String, caseInsensitive: Bool = true, _ with: (Match) -> String) -> String {
        guard let r = regex(pattern, caseInsensitive: caseInsensitive) else { return s }
        let ns = s as NSString
        var out = ""
        var at = 0
        for found in r.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: at, length: found.range.location - at))
            out += with(match(found, in: s))
            at = found.range.location + found.range.length
        }
        return out + ns.substring(from: at)
    }
}
