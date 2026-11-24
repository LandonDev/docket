import Foundation
import TempCodeContract

/// The Files place's rules as the phone reads them (src/shared/work/files.ts, docs/agents/work-files.md):
/// a folder's key, what the Files screen lists, what a place lets a hand do and the sentence when it does
/// not, a row's one fact, and how a file opens. Pure, so the package tests it; the host stays the judge of
/// every change, and these only keep a menu from offering what it will refuse.
public enum FilesRules {
    // MARK: - keys

    /// `refKey` of a folder, as the `work.files` push's `at` names it. A host's `:` (and the `%` that writes it)
    /// is written out, as `refKey` does, so the host ends where the key's own `:` stands.
    public static func key(_ folder: FolderRef) -> String {
        switch folder {
        case .file(let ref): "file:\(ref.host.replacingOccurrences(of: "%", with: "%25").replacingOccurrences(of: ":", with: "%3A")):\(ref.path)"
        case .drive(let ref): "google:\(ref.folderId)"
        case .project(let ref): "project:\(ref.id)"
        case .place(let ref): "place:\(ref.id)"
        case .unknown: "unknown"
        }
    }

    /// The place a lens's row lives in (`where.place`), else the place being listed.
    public static func home(of entry: FileEntry, in place: FilePlace, places: [FilePlace]) -> FilePlace {
        guard let id = entry.where?.place, let home = places.first(where: { $0.id == id }) else { return place }
        return home
    }

    // MARK: - the Files screen

    public static func isHome(_ kind: FilePlace.Kind) -> Bool {
        switch kind {
        case .folder, .lifeos, .onedrive, .teams, .drive: true
        default: false
        }
    }

    /// The Files screen's three bands, in the design's order: Recent and Starred, then the places, then From
    /// mail. Only what the host lists is drawn (a remote key is told only what it could name). A place two
    /// computers hold (`key`) is one row: the copy that answers, else the first listed.
    public struct Sections: Equatable, Sendable {
        public var lenses: [FilePlace]
        public var places: [FilePlace]
        public var mail: [FilePlace]

        public var isEmpty: Bool { lenses.isEmpty && places.isEmpty && mail.isEmpty }
    }

    public static func sections(_ all: [FilePlace]) -> Sections {
        let lenses = [FilePlace.Kind.recent, .starred].compactMap { kind in all.first { $0.kind == kind } }
        var seen: [String: Int] = [:]
        var places: [FilePlace] = []
        for place in all where isHome(place.kind) {
            guard let key = place.key, !key.isEmpty else {
                places.append(place)
                continue
            }
            if let at = seen[key] {
                if places[at].state.state != .ok, place.state.state == .ok { places[at] = place }
            } else {
                seen[key] = places.count
                places.append(place)
            }
        }
        return Sections(lenses: lenses, places: places, mail: all.filter { $0.kind == .mail })
    }

    /// The place New and Upload put things in from a lens or the Files screen: the workspace's folder.
    public static func workspaceFolder(_ all: [FilePlace]) -> FilePlace? {
        all.first { $0.kind == .folder }
    }

    // MARK: - what a place lets a hand do

    public struct Refusal: Equatable, Sendable {
        public enum Press: String, Sendable { case keep, openHere, openWeb, export, retry, openCopies }
        public let text: String
        public let press: Press?

        public init(_ text: String, press: Press? = nil) {
            self.text = text
            self.press = press
        }
    }

    /// Why `place` does not do `verb` on `entry` (or in it, for `make` and `upload`), or nil: `refusal` of the
    /// grammar for a change inside one place, with its sentences word for word.
    public static func refusal(_ place: FilePlace, _ verb: FilePlace.Can, entry: FileEntry? = nil) -> Refusal? {
        if place.kind == .mail { return Refusal("A mail's file is read only. Keep it first.", press: .keep) }
        if !isHome(place.kind) { return Refusal("\(place.name) only shows files. Change one where it lives.") }
        if place.state.state == .unreachable { return Refusal("\(place.host.isEmpty ? place.name : place.host) is out of reach.", press: .retry) }
        if case .writing? = entry?.state, [.rename, .move, .trash].contains(verb) { return Refusal("A thread is writing in this file. Try when it is done.") }
        if [.trash, .restore, .purge].contains(verb) {
            if place.shared || entry?.shared == true, !place.can.contains(verb) { return Refusal("Delete it in \(service(place)).", press: .openWeb) }
            if place.kind == .lifeos, !place.can.contains(verb) { return Refusal("LifeOS cannot put a document back yet. Delete it in LifeOS.") }
        }
        if !place.can.contains(verb) {
            if place.vm == true { return Refusal("Files in the Windows VM cannot be changed from here yet. Open it there.", press: .openHere) }
            return Refusal("Nothing can be \(words(verb)) in \(place.name) from here.")
        }
        return nil
    }

    /// What a menu offers: the place does it, and this key may ask (`operate`; `approve` too where others can
    /// open the place, which the host's door asks of a remote key).
    public static func offers(_ place: FilePlace, _ verb: FilePlace.Can, entry: FileEntry? = nil, caps: Caps) -> Bool {
        guard caps.operate, refusal(place, verb, entry: entry) == nil else { return false }
        return !(place.shared || entry?.shared == true) || caps.approve
    }

    /// What the paired key may do, read once from its capabilities.
    public struct Caps: Equatable, Sendable {
        public var operate: Bool
        public var approve: Bool

        public init(operate: Bool, approve: Bool) {
            self.operate = operate
            self.approve = approve
        }

        public static let readOnly = Caps(operate: false, approve: false)
    }

    private static func service(_ place: FilePlace) -> String {
        switch place.kind {
        case .teams: "Teams"
        case .onedrive: "OneDrive"
        case .drive: "Google Drive"
        default: "that place"
        }
    }

    private static func words(_ verb: FilePlace.Can) -> String {
        switch verb {
        case .make: "made"
        case .upload: "uploaded"
        case .rename: "renamed"
        case .move: "moved"
        case .copy: "copied"
        case .edit: "changed"
        case .trash: "deleted"
        case .restore: "put back"
        case .purge: "deleted for good"
        case .unknown(let raw): raw
        }
    }

    // MARK: - a row and a place in words

    /// A row's one fact: what is happening to it, else where it lives (in a lens), else when it changed.
    public static func fact(_ entry: FileEntry, inLens: Bool, now: Date = .now, calendar: Calendar = .current) -> String {
        switch entry.state {
        case .present(let who)?: return "\(who.who) is in it"
        case .writing?: return "A thread is writing"
        case .suggestions(let count)?: return count.count == 1 ? "1 suggestion" : "\(Int(count.count)) suggestions"
        case .cloud?: return "In the cloud"
        default: break
        }
        if inLens, let place = entry.where?.name, !place.isEmpty { return place }
        guard let changed = entry.changed, changed > 0 else { return "" }
        return changedWords(Int(changed), now: now, calendar: calendar)
    }

    /// What follows a file's kind on its facts line: its size and when it changed, as prose ("52 bytes, 9:41 AM"),
    /// never joined with a dot (docs/IOS-DESIGN.md "Text hierarchy, not dotted joins"). The view draws the kind
    /// first in its own weight. Nil when there is neither.
    public static func factDetail(size: Double?, changed: Double?, now: Date = .now, calendar: Calendar = .current) -> String? {
        var parts: [String] = []
        if let size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if let changed, changed > 0 { parts.append(changedWords(Int(changed), now: now, calendar: calendar)) }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The host's sentence without the code word a failed answer can lead with ("internal: …"), its first letter
    /// raised: a Files failure says what went wrong in words, never the wire's code.
    public static func sentence(_ message: String) -> String {
        for code in ["internal", "error", "unavailable", "timeout", "not found", "bad request", "invalid request", "invalid params"] where message.hasPrefix("\(code): ") {
            let rest = message.dropFirst(code.count + 2)
            return rest.prefix(1).uppercased() + rest.dropFirst()
        }
        return message
    }

    /// "9:41 AM" today, "Yesterday", "Nov 3" this year, "Nov 3, 2025" before.
    public static func changedWords(_ ms: Int, now: Date = .now, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        var style = Date.FormatStyle.dateTime
        style.timeZone = calendar.timeZone
        style.locale = calendar.locale ?? .current
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(style.hour().minute()) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) { return date.formatted(style.month(.abbreviated).day()) }
        return date.formatted(style.month(.abbreviated).day().year())
    }

    /// What stands between a place and him, in one line; nil while it answers.
    public static func stateWords(_ place: FilePlace) -> String? {
        let state = place.state
        let machine = place.host.isEmpty ? place.name : place.host
        switch state.state {
        case .ok: return nil
        case .reading: return "Reading…"
        case .asleep: return "\(machine) is asleep"
        case .signedOut: return "Signed out"
        case .noOnedrive: return "OneDrive is not set up"
        case .noLibraries: return "No libraries"
        case .notSetUp: return "Not set up"
        case .notAllowed: return "This workspace may not use \(machine)"
        case .unreachable: return "\(machine) is out of reach"
        case .error: return state.detail ?? "It answered a fault"
        case .unknown(let raw): return state.detail ?? raw
        }
    }

    /// A place's one fact on the Files screen: its state while it does not answer, else its team, else nothing.
    public static func placeFact(_ place: FilePlace) -> String {
        stateWords(place) ?? place.group ?? ""
    }

    /// A place that lists nothing until it answers: asleep keeps its list (`at`), the rest show their state.
    public static func isDown(_ place: FilePlace) -> Bool {
        switch place.state.state {
        case .ok, .reading, .asleep: false
        default: true
        }
    }

    // MARK: - opening a file

    /// The most Open the original reads to the phone.
    public static let originalMax = 50 * 1024 * 1024

    /// How a file opens on the phone (the design's section 6 "Open").
    public enum Opening: Equatable, Sendable {
        /// Seated as a Files pane item (`work.files.open`) and drawn by its kind on the reader page: a document or
        /// sheet in the hosted editor, a PDF, deck, picture or video in the native viewers.
        case item
        /// The preview pager and its facts; `original` says whether Open the original reads its bytes here.
        case quickLook(Original)
    }

    public enum Original: Equatable, Sendable {
        /// A file of the workspace's folder, 50 MB or less: read by version into a temp file.
        case allowed
        case tooBig
        /// A shared library's file: facts only on the phone, and where it lives ("On MacBook").
        case facts(host: String)
        /// A document or sheet kept as a file, 50 MB or less: read only here ("Edit on your computer"), for a key
        /// that may not seat it and where its host will not open it in the hosted editor.
        case readOnly
    }

    public static func opening(_ entry: FileEntry, place: FilePlace, caps: Caps) -> Opening {
        let original = original(entry, place: place)
        if case .lifeos? = entry.ref, [.document, .sheet].contains(entry.kind) { return caps.operate ? .item : .quickLook(original) }
        // A file others can open shows its facts alone, whatever its kind: no reader reads its bytes to the phone.
        if place.shared || entry.shared == true { return .quickLook(original) }
        // A document or sheet kept as a file in a place of his own is seated too: the hosted editor takes it
        // first, and where its host will not open it there the screen shows Quick Look in its place (`.readOnly`).
        if original == .readOnly, caps.operate { return .item }
        switch entry.kind {
        case .pdf, .deck, .picture, .video:
            // A key that may not seat an item (operate) still reads the file where it may.
            return caps.operate ? .item : .quickLook(original)
        default:
            return .quickLook(original)
        }
    }

    public static func original(_ entry: FileEntry, place: FilePlace) -> Original {
        if place.kind != .folder || place.shared || entry.shared == true { return .facts(host: place.host) }
        if let size = entry.size, Int(size) > originalMax { return .tooBig }
        return [.document, .sheet].contains(entry.kind) ? .readOnly : .allowed
    }

    // MARK: - search, New and the change ids

    /// The folder's own rows whose name holds every word typed, case and accents ignored: what the system
    /// search field shows until the host's search answers.
    public static func filter(_ entries: [FileEntry], query: String) -> [FileEntry] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return entries }
        return entries.filter { entry in words.allSatisfy { entry.name.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil } }
    }

    /// What New names a thing before he types (`UNTITLED`).
    public static func untitled(_ kind: Methods.WorkFilesMake.Params.Kind) -> String {
        switch kind {
        case .document: "Untitled document"
        case .sheet: "Untitled sheet"
        case .deck: "Untitled deck"
        case .text: "Untitled"
        case .folder: "Untitled folder"
        case .unknown(let raw): raw
        }
    }

    /// Why a name cannot be a file's or folder's, or nil (`nameProblem`).
    public static func nameProblem(_ name: String) -> String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "A name needs at least one letter." }
        if name.count > 200 { return "A name can be 200 characters at most." }
        if name == "." || name == ".." { return "That name is not allowed." }
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return "A name cannot hold a line break or a control character." }
        if let bad = name.first(where: { "\\/:*?\"<>|".contains($0) }) { return "A name cannot hold \(bad)" }
        if name.hasSuffix(".") || name.hasSuffix(" ") || name.hasPrefix(" ") { return "A name cannot start with a space or end with a space or a dot." }
        if name.range(of: #"^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$"#, options: [.regularExpression, .caseInsensitive]) != nil { return "Windows keeps that name for itself." }
        return nil
    }

    /// A change's id: the same id again answers what the first did, so a retry after a lost answer is safe.
    public static func op() -> String { "op_" + UUID().uuidString.lowercased() }
}
