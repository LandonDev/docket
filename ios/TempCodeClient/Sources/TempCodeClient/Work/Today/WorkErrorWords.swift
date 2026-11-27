import Foundation

/// An error as Work says it to him: the desktop's src/renderer/src/lib/workErrorWords.ts, rule for rule. A host
/// answers a refusal in its own words, and some were never written for a person (a method's name, a path, an errno,
/// a schema's complaint): each known raw form has its sentence; plain words pass; anything else that still carries a
/// path, a method, an id or a code answers "", so the caller's own line shows in place of the raw text.
public enum WorkErrorWords {
    private typealias Say = @Sendable (_ host: String, _ Host: String, _ named: Bool, _ write: Bool, _ input: String) -> String

    @Sendable private static func lost(_ Host: String, _ write: Bool) -> String {
        write ? "\(Host) did not confirm the change. Check whether it went through before you try again." : "\(Host) did not answer. Try again once it is connected."
    }

    private static let table: [(String, Say)] = [
        (#"^forbidden: \S+ is outside app-managed roots"#, { _, H, _, _, _ in "\(H) does not let this window reach that file where it lies. Open it from Files on the computer that holds it." }),
        (#"^forbidden: \S+ is local-only"#, { h, _, _, _, _ in "This is done in a window on \(h) itself." }),
        (#"^forbidden: \S+ (needs \w+|is not for a given computer|waits for Allow)"#, { h, _, _, _, _ in "This computer's key may not do that on \(h). Do it from a computer that manages \(h)." }),
        (#"^bad request\b|^\[\s*\{\s*"(code|expected|origin|path)""#, { _, H, _, _, _ in "\(H) could not read this request. Open this view again and retry; if it still fails, update the app on both computers." }),
        (#"work is off on this host"#, { h, _, named, _, input in named ? "Work is off on \(h). Turn it on in Settings, Work." : input }),
        (#"^no answer in \d+ ?s\b|timed out after \d|\btimed out\b|^timeout\b"#, { _, H, _, write, _ in lost(H, write) }),
        (#"^not connected\.?$"#, { _, H, named, _, input in named ? "\(H) is not connected. Try again once it is back." : input }),
        (#"connection closed|socket closed|^closed\.?$"#, { h, _, _, write, _ in "The connection to \(h) dropped.\(write ? " Check whether the change went through." : " Try again once it is back.")" }),
        (#"did not start on this host|^not built\b|is not built yet|no handler for"#, { h, _, _, _, _ in "This part of Work is not running on \(h). Look under Settings, Connections; if the two computers run different versions, update both." }),
        (#"^(unknown|no such) workspace\b"#, { h, _, _, _, _ in "This job is no longer on \(h)." }),
        (#"^(there is )?no canvas item\b"#, { _, _, _, _, _ in "This tab is no longer open. Open the file again from Files." }),
        (#"^not a work workspace\b|^unknown thread\b"#, { _, _, _, _, _ in "The thread or job this belongs to is gone. Open it again from Work." }),
        (#"\bspawn \S+ ENOENT\b|\bis not installed on\b"#, { h, _, _, _, _ in "A program \(h) needs for this is missing there." }),
        (#"\bENOENT\b|^there is no file at |^no file at "#, { _, _, _, _, _ in "The file or folder was moved or removed. Refresh Files and open it from where it is now." }),
        (#"\b(EACCES|EPERM|EROFS)\b"#, { _, _, _, _, _ in "This computer could not change the file in that folder. Check that you may edit it there, or save a copy somewhere you may." }),
        (#"\bENOSPC\b"#, { h, _, _, _, _ in "The disk on \(h) is full." }),
        (#"\b(EBUSY|ETXTBSY)\b"#, { _, _, _, _, _ in "The file is in use. Close it where it is open and try again." }),
        (#"\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)\b"#, { _, H, _, write, _ in lost(H, write) }),
        (#"left no output$"#, { _, _, _, _, _ in "The conversion made no file. Open the original and export again." }),
        (#"not a name a preview is kept under|that item is not open|that preview is gone"#, { _, _, _, _, _ in "This preview is gone. Close it and open it again from the file's tab." }),
        (#"lifeos is not signed in|lifeos is signed out"#, { h, _, _, _, _ in "Not signed in to LifeOS on \(h). Sign in under Settings, Connections." }),
        (#"lifeos did not start|lifeos is not connected"#, { _, H, _, _, _ in "\(H) cannot use LifeOS now. See why under Settings, Connections." }),
        (#"\b(libreoffice|soffice|python-pptx|ffmpeg|ffprobe)\b[^.]*\bnot installed\b"#, { _, H, named, _, _ in "\(named ? "\(H) is missing the tools that draw and read this file." : "The computer that draws this file is missing the tools for it.") Install them under Settings, Connections, Conversion tools." }),
        (#"^no such guest link\b"#, { h, _, _, _, _ in "This link is not on \(h). Look for it on the computer that made it." }),
        (#"its bytes go to no caller"#, { _, _, _, _, _ in "Open this file from its library in Files. The copy is made on the computer that runs the Windows VM." }),
    ]

    /// Read-only once made: the regular expressions are never changed after this.
    nonisolated(unsafe) private static let rules: [(NSRegularExpression, Say)] = table.map { pattern, say in
        // Case-blind as the desktop's `/i`, but for the errno rules it writes without it, which match capitals alone.
        let blind = !["EACCES", "ENOSPC", "EBUSY", "ECONNREFUSED"].contains { pattern.contains($0) }
        return (try! NSRegularExpression(pattern: pattern, options: blind ? [.caseInsensitive] : []), say)
    }

    /// A wire method, a path, a host's id, an errno, a schema's JSON, a stack, a setting's name in capitals: a line never
    /// written for him.
    nonisolated(unsafe) private static let raw = try! NSRegularExpression(pattern: #"\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[Ww]ork\.[a-z][A-Za-z.]*|\b(session|workspace|remote|defaults)\.[a-z][A-Za-z]+\b|(^|[\s'"(])/[\w.@-]+/[\w.@/ -]+|[A-Za-z]:\\[\w\\. -]+|\benv_[\w-]{6,}|\bE[A-Z]{3,}\b(?=[:,]| )|^\s*[\[{]|\n\s+at \S+ \(|^forbidden:"#)

    /// The desktop's `refusalWords`: "refused:" off, the first letter capital.
    static func refusal(_ error: String) -> String {
        var words = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = words.range(of: #"^refused:\s*"#, options: [.regularExpression, .caseInsensitive]) { words.removeSubrange(range) }
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// A read that failed, in one line a screen can show: Work's words for it, else that `host` could not read it.
    /// Never the host's raw text.
    public static func readFailure(_ error: String, host: String) -> String {
        let words = say(error, host: host)
        return words.isEmpty ? "\(host.prefix(1).uppercased() + host.dropFirst()) could not read this." : words
    }

    /// The error in Work's words, `host` the computer asked ("the box", "Mac"); "" where it has none.
    public static func say(_ error: String, host: String? = nil, write: Bool = false) -> String {
        let words = refusal(error)
        guard !words.isEmpty else { return "" }
        let named = !(host ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        let h = named ? host!.trimmingCharacters(in: .whitespaces) : "that computer"
        let H = h.prefix(1).uppercased() + h.dropFirst()
        let all = NSRange(words.startIndex..., in: words)
        for (form, say) in rules where form.firstMatch(in: words, range: all) != nil {
            return say(h, H, named, write, words)
        }
        return raw.firstMatch(in: words, range: all) != nil ? "" : words
    }
}
