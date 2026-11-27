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
        knownHome(of: entry, in: place, places: places) ?? place
    }

    /// The place a row's file lives in, so whether others can open it is known: the place itself when it is one, a
    /// lens row's `where`, else the place whose top folder holds its path on its host (Recent and Starred rows carry
    /// neither sharing nor home, files/handle.ts `markEntry`). Nil when nothing says: a lens row then opens as facts.
    public static func knownHome(of entry: FileEntry, in place: FilePlace, places: [FilePlace]) -> FilePlace? {
        if isHome(place.kind) { return place }
        return homeId(of: entry, places: places).flatMap { id in places.first { $0.id == id } }
    }

    /// The id of the place a row's file lives in, for a row with no place of its own (a lens's, a search's): its
    /// `where`, else the place whose top folder holds its path. Nil when nothing says; the file then opens as facts.
    public static func homeId(of entry: FileEntry, places: [FilePlace]) -> String? {
        if let id = entry.where?.place, places.contains(where: { $0.id == id }) { return id }
        guard case .file(let file)? = entry.ref else { return nil }
        var best: (place: FilePlace, length: Int)?
        for candidate in places where isHome(candidate.kind) {
            guard case .file(let root) = candidate.root, root.host == file.host, holds(root.path, file.path) else { continue }
            if root.path.count > (best?.length ?? -1) { best = (candidate, root.path.count) }
        }
        return best?.place.id
    }

    /// His own mail's or LifeOS's: a thing no one else opens, wherever its row is listed.
    public static func isOwn(_ entry: FileEntry) -> Bool {
        switch entry.ref {
        case .mail?, .lifeos?: true
        default: false
        }
    }

    /// A folder's path holds a file's: the file's path runs on past the folder's at a separator.
    static func holds(_ folder: String, _ path: String) -> Bool {
        let trimmed = folder.hasSuffix("/") || folder.hasSuffix("\\") ? String(folder.dropLast()) : folder
        guard path.count > trimmed.count, path.hasPrefix(trimmed) else { return false }
        let next = path[path.index(path.startIndex, offsetBy: trimmed.count)]
        return next == "/" || next == "\\"
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
    /// grammar, its sentences word for word. `to` is where a move or copy puts it: another place is a copy across.
    public static func refusal(_ place: FilePlace, _ verb: FilePlace.Can, entry: FileEntry? = nil, to: FilePlace? = nil) -> Refusal? {
        let across = to.map { $0.id != place.id } ?? false
        if place.kind == .mail {
            // Keep is the one thing a mail's file does: a copy into the workspace's folder.
            if verb == .copy, across, to?.kind == .folder { return nil }
            return Refusal("A mail's file is read only. Keep it first.", press: .keep)
        }
        if !isHome(place.kind) { return Refusal("\(place.name) only shows files. Change one where it lives.") }
        for p in [place] + (across ? [to!] : []) where p.state.state == .unreachable {
            return Refusal("\(p.host.isEmpty ? p.name : p.host) is out of reach.", press: .retry)
        }
        if case .writing? = entry?.state, [.rename, .move, .trash].contains(verb) { return Refusal("A thread is writing in this file. Try when it is done.") }
        if across, let to, [.move, .copy].contains(verb) {
            if !isHome(to.kind) { return Refusal("\(to.name) only shows files. Pick a folder to put it in.") }
            // Out of a shared place: a lasting copy of what a team holds is refused, and a move out is never offered.
            if place.shared, place.kind != .drive { return Refusal("\(service(place)) files stay in \(service(place)).", press: .openHere) }
            if place.kind == .lifeos { return Refusal("A LifeOS document lives in LifeOS. Export a copy instead.", press: .export) }
            if to.kind == .lifeos { return Refusal("Only a LifeOS document lives in LifeOS. Make one there instead.") }
            if place.kind == .drive || to.kind == .drive, place.kind != to.kind { return Refusal("A Google file lives in Google Drive. Export a copy instead.", press: .export) }
            if place.env != to.env, (entry?.size ?? 0) > Double(copyAcrossMax) {
                return Refusal("This file is over \(copyAcrossMax / 1024 / 1024) MB, too big to copy from \(place.host.isEmpty ? place.name : place.host).")
            }
            if !to.can.contains(.copy) { return cannot(to, .copy) }
            // A move across places is a copy, a check, then the source to Trash: the source's place must take the delete.
            if verb == .move, !place.can.contains(.trash) { return cannot(place, .move) }
            return nil
        }
        if [.trash, .restore, .purge].contains(verb) {
            if place.shared || entry?.shared == true, !place.can.contains(verb) { return Refusal("Delete it in \(service(place)).", press: .openWeb) }
            if place.kind == .lifeos, !place.can.contains(verb) { return Refusal("LifeOS cannot put a document back yet. Delete it in LifeOS.") }
        }
        if !place.can.contains(verb) { return cannot(place, verb) }
        return nil
    }

    private static func cannot(_ place: FilePlace, _ verb: FilePlace.Can) -> Refusal {
        // A helper in the VM that changes nothing is the VM's own sentence; one that does says what it does not.
        if place.vm == true, place.can.isEmpty { return Refusal("Files in the Windows VM cannot be changed from here yet. Open it there.", press: .openHere) }
        return Refusal("Nothing can be \(words(verb)) in \(place.name) from here.")
    }

    /// The most one copy across computers carries (`COPY_ACROSS_MAX`).
    public static let copyAcrossMax = 48 * 1024 * 1024

    /// What a menu offers: the place does it, and this key may ask (`operate`; `approve` too where others can
    /// open the place or the folder it goes to, which the host's door asks of a remote key).
    public static func offers(_ place: FilePlace, _ verb: FilePlace.Can, entry: FileEntry? = nil, to: FilePlace? = nil, caps: Caps) -> Bool {
        guard caps.operate, refusal(place, verb, entry: entry, to: to) == nil else { return false }
        return !(place.shared || entry?.shared == true || to?.shared == true) || caps.approve
    }

    // MARK: - the one question a change others will see asks first

    /// What his press asks before a change others will see (`questionFor`), or nil: a copy or a move into a
    /// shared place, and a delete in one. The host refuses such a change without his yes (`asked`).
    public static func question(_ place: FilePlace, _ verb: FilePlace.Can, entry: FileEntry? = nil, to: FilePlace? = nil) -> String? {
        if let to, to.id != place.id, [.copy, .move].contains(verb), to.shared {
            return "\(verb == .copy ? "Copy" : "Move") to \(to.name)? \(audience(to))"
        }
        if verb == .trash, place.shared || entry?.shared == true { return "Delete for everyone?" }
        return nil
    }

    /// Who else can open what is in a place (`audienceOf`), by the team or folder's own name when `named`.
    public static func audience(_ place: FilePlace, named: Bool = false) -> String {
        switch place.kind {
        case .teams: named ? "Everyone in \(place.group ?? place.name) can open it." : "Everyone in that team can open it."
        case .onedrive: named ? "Whoever you shared \(place.name) with can open it." : "Whoever you shared that folder with can open it."
        case .drive: named ? "Whoever \(place.name) is shared with can open it." : "Whoever that folder is shared with can open it."
        default: "Others can open it."
        }
    }

    /// A delete's words where it asks (`deleteAsk`): a drive with no bin first, for what goes there is gone.
    public static func deleteAsk(_ place: FilePlace, names: [String]) -> (title: String, body: String) {
        let what = names.count == 1 ? names[0] : "\(names.count) items"
        if place.bin == false {
            var drive: String?
            if case .file(let root) = place.root { drive = noBinDrive(root.path) }
            return ("Delete \(what) for good?", "Deleted from \(drive ?? place.name) at once; \(names.count == 1 ? "it" : "they") cannot be put back.")
        }
        let body = audience(place, named: true)
        guard names.count != 1, body.hasSuffix(" it.") else { return ("Delete \(what) for everyone?", body) }
        return ("Delete \(what) for everyone?", String(body.dropLast(" it.".count)) + " them.")
    }

    /// The drive a path lies on when a delete there has no bin (`noBinDrive`): a Windows drive other than C:,
    /// or a `\\server\share`. Nil on a path a bin takes from.
    public static func noBinDrive(_ path: String) -> String? {
        let chars = Array(path)
        let slash: (Character) -> Bool = { $0 == "/" || $0 == "\\" }
        if chars.count > 2, slash(chars[0]), slash(chars[1]), !(["?", "."].contains(chars[2]) && chars.count > 3 && slash(chars[3])) {
            let parts = path.split(whereSeparator: slash)
            if parts.count >= 2 { return "\\\\\(parts[0])\\\(parts[1])" }
        }
        if chars.count >= 2, chars[1] == ":", chars[0].isASCII, chars[0].isLetter, chars[0].lowercased() != "c", chars.count == 2 || slash(chars[2]) {
            return "\(chars[0].uppercased()):"
        }
        return nil
    }

    /// Whether a delete asks first: a shared place, or a drive with no bin.
    public static func deleteAsks(_ place: FilePlace, entry: FileEntry?) -> Bool {
        question(place, .trash, entry: entry) != nil || place.bin == false
    }

    /// The tag a `work.files` push's `opening` names a row by (`openingTag`): the row he pressed makes the same
    /// one from its key, so only that row shows how far its copy has got.
    public static func openingTag(_ key: String) -> String {
        var a: UInt32 = 0x811c9dc5
        var b: UInt32 = 0x01000193
        for c in key.utf16 {
            a = (a ^ UInt32(c)) &* 0x01000193
            b = (b ^ UInt32(c)) &* 0x5bd1e995
        }
        return String(a, radix: 36) + String(b, radix: 36)
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

    /// A size in one spelling everywhere on the phone ("15 KB", "2.1 MB"): Files, Messages, Save to Docket, Capture.
    public static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// What follows a file's kind on its facts line: its size and when it changed, as prose ("52 bytes, 9:41 AM"),
    /// never joined with a dot (docs/IOS-DESIGN.md "Text hierarchy, not dotted joins"). The view draws the kind
    /// first in its own weight. Nil when there is neither.
    public static func factDetail(size: Double?, changed: Double?, now: Date = .now, calendar: Calendar = .current) -> String? {
        var parts: [String] = []
        if let size { parts.append(Self.size(Int64(size))) }
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
        case .notAllowed: return "This job may not use \(machine)"
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
        // A lens row (Recent, Starred) whose home is not known (`knownHome`): whether others can open it is not known
        // either, so it shows facts, unless it is his own mail's or LifeOS's, which no one else opens.
        if !isHome(place.kind), !isOwn(entry) { return .quickLook(original) }
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

    /// Quick Look's pages are of one version of the file (`FilePreview.version`, pinned by the first page): a page of
    /// another version means the file was saved between two reads, and the pager starts over at that version, so no
    /// two pages of different versions show together. A host that names no version starts nothing over.
    public static func startsOver(pinned: String?, answered: String?) -> Bool {
        guard let pinned, let answered else { return false }
        return pinned != answered
    }

    public static func original(_ entry: FileEntry, place: FilePlace) -> Original {
        if place.kind != .folder || place.shared || entry.shared == true { return .facts(host: place.host) }
        if let size = entry.size, Int(size) > originalMax { return .tooBig }
        return [.document, .sheet].contains(entry.kind) ? .readOnly : .allowed
    }

    // MARK: - Open in Word

    /// The Office app a shared library's Office file opens in from its facts (Open in Word), by the host's
    /// `work.office.live.address` answer.
    public enum OfficeApp: String, Equatable, Sendable {
        case word, excel, powerpoint

        public var title: String {
            switch self {
            case .word: "Open in Word"
            case .excel: "Open in Excel"
            case .powerpoint: "Open in PowerPoint"
            }
        }
    }

    /// The app a shared library's file opens in, by its name (the host's `LIVE_FORMS`): only these ask the host
    /// for an address; nil for any other file and for every file of his own.
    public static func officeApp(_ entry: FileEntry, place: FilePlace) -> OfficeApp? {
        guard case .facts = original(entry, place: place) else { return nil }
        switch entry.name.split(separator: ".").last.map({ $0.lowercased() }) {
        case "docx": return .word
        case "xlsx", "xlsm": return .excel
        case "pptx": return .powerpoint
        default: return nil
        }
    }

    /// Where Open in Word goes: the app by its Office URI scheme (`ms-word:ofe|u|<address>`, the `|` written
    /// `%7C`, as a URL must hold it), without the address's `?web=1`; and the address itself, which Safari opens
    /// as Word for the web where no Office app takes the first.
    public static func officeLinks(_ app: OfficeApp, address: String) -> (app: URL, web: URL)? {
        guard let web = URL(string: address), web.scheme == "https" else { return nil }
        var file = URLComponents(url: web, resolvingAgainstBaseURL: false)
        file?.query = nil
        guard let plain = file?.string, let url = URL(string: "ms-\(app.rawValue):ofe%7Cu%7C\(plain)") else { return nil }
        return (url, web)
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

// MARK: - thumbnails, the root across jobs, and search

public extension FilesRules {
    /// Whether the host may make a small picture of a row (`work.files.thumbs`): a file whose bytes it can read,
    /// of a kind it draws. A folder, a sound, an archive or a file kept in the cloud draws its glyph.
    static func hasThumb(_ entry: FileEntry) -> Bool {
        guard entry.ref != nil, entry.folder == nil else { return false }
        if case .cloud? = entry.state { return false }
        switch entry.kind {
        case .picture, .pdf, .deck, .document, .sheet, .video, .text: return true
        default: return false
        }
    }

    /// Whether a folder offers the grid: its host makes pictures (a far computer and the Windows VM answer plain
    /// tiles) and some row could have one.
    static func gridOffered(_ entries: [FileEntry], far: Bool, place: FilePlace?) -> Bool {
        !far && place?.vm != true && entries.contains(where: hasThumb)
    }

    /// The grid's tile edge asked of the host: twice the points of the smallest tile (`THUMB_SIZES`).
    static let thumbSize = 192
}

/// Files for every job at once (the Work tab's Files place): each job's places under its name, in the Work
/// list's order of jobs, narrowed to one by the filter. Pure: the screen hands in each host's jobs and what it
/// has read of them.
public enum FilesRoot {
    /// A Work workspace as the place lists it: its entry key (the filter's id), its host, its name and sector.
    public struct Job: Hashable, Sendable, Identifiable {
        public var id: String
        public var environmentId: String
        public var workspaceId: String
        public var name: String
        public var sector: String?

        public init(id: String, environmentId: String, workspaceId: String, name: String, sector: String?) {
            self.id = id
            self.environmentId = environmentId
            self.workspaceId = workspaceId
            self.name = name
            self.sector = sector
        }
    }

    /// One job's band: its lenses (Recent, Starred), its places, its computers reached through its host, From
    /// mail, and its Trash, each only when the host lists it.
    public struct Band: Equatable, Sendable, Identifiable {
        public var job: Job
        public var lenses: [FilePlace]
        public var places: [FilePlace]
        public var far: [FilesHost.FarDesktop]
        public var mail: [FilePlace]
        public var trash: FilePlace?
        public var id: String { job.id }
        public var isEmpty: Bool { lenses.isEmpty && places.isEmpty && far.isEmpty && mail.isEmpty && trash == nil }
    }

    /// The jobs shown: every job, or the one the filter picked (a pick no longer listed shows every job).
    public static func shown(_ jobs: [Job], pick: String?) -> [Job] {
        guard let pick, jobs.contains(where: { $0.id == pick }) else { return jobs }
        return jobs.filter { $0.id == pick }
    }

    /// A job's band from its host's places and its far computers. A far computer's place two computers hold is
    /// listed once, under the computer that answers.
    public static func band(_ job: Job, places: [FilePlace], far: [FilesHost.FarDesktop]) -> Band {
        let sections = FilesRules.sections(places)
        let keys = Set(sections.places.compactMap(\.key))
        let reached = far.map { desk in
            var desk = desk
            desk.places = desk.places.filter { FilesRules.isHome($0.kind) && !($0.key.map(keys.contains) ?? false) }
            return desk
        }
        return Band(job: job, lenses: sections.lenses, places: sections.places, far: reached, mail: sections.mail, trash: places.first { $0.kind == .trash })
    }
}

/// A search across every job shown, as he types: the rows the phone holds that match at once, then each job's
/// host's answer as it lands, merged by key, newest change first. An answer for words he has since changed is
/// dropped (the next keystroke cancels the asks still out); a job whose host failed is named once, and the rest
/// still show.
public struct FilesFound: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public var job: FilesRoot.Job
        public var entry: FileEntry
        public var id: String { "\(job.id)|\(entry.key)" }

        public init(job: FilesRoot.Job, entry: FileEntry) {
            self.job = job
            self.entry = entry
        }
    }

    public private(set) var query: String
    public private(set) var rows: [Row] = []
    /// The jobs whose host has answered this query.
    public private(set) var answered: Set<String> = []
    /// The jobs still asked.
    public private(set) var waiting: Set<String> = []
    /// The jobs whose search failed, by name.
    public private(set) var failed: [String] = []

    /// A new query over the jobs shown: the matching rows the phone already holds, while every host is asked.
    public init(query: String, jobs: [FilesRoot.Job], local: [String: [FileEntry]]) {
        self.query = query
        waiting = Set(jobs.map(\.id))
        rows = Self.sorted(jobs.flatMap { job in FilesRules.filter(local[job.id] ?? [], query: query).map { Row(job: job, entry: $0) } })
    }

    /// A host answered: its rows take the place of that job's local ones. An answer for another query is dropped.
    public mutating func land(_ entries: [FileEntry], job: FilesRoot.Job, query: String) {
        guard query == self.query, waiting.contains(job.id) else { return }
        waiting.remove(job.id)
        answered.insert(job.id)
        var seen = Set<String>()
        let theirs = entries.filter { seen.insert($0.key).inserted }.map { Row(job: job, entry: $0) }
        rows = Self.sorted(rows.filter { $0.job.id != job.id } + theirs)
    }

    /// A host's search failed: the local rows of that job stay, and the job is named.
    public mutating func fail(job: FilesRoot.Job, query: String) {
        guard query == self.query, waiting.contains(job.id) else { return }
        waiting.remove(job.id)
        failed.append(job.name)
    }

    /// Nothing more is coming and nothing matched.
    public var isEmpty: Bool { waiting.isEmpty && rows.isEmpty }

    /// The one quiet line under the results when a job's host could not search.
    public var note: String? { Self.notSearched(failed) }

    /// "Unify was not searched.", "Unify and Purdue Esports were not searched."; nil for none.
    public static func notSearched(_ names: [String]) -> String? {
        guard let last = names.last else { return nil }
        return names.count == 1 ? "\(last) was not searched." : "\(names.dropLast().joined(separator: ", ")) and \(last) were not searched."
    }

    static func sorted(_ rows: [Row]) -> [Row] {
        rows.sorted { ($0.entry.changed ?? 0, $1.entry.name) > ($1.entry.changed ?? 0, $0.entry.name) }
    }
}

public extension FilesRoot {
    /// A host's jobs as Files lists them: every Work workspace, keyed as the Work list keys a job (`ProjectPairs.key`).
    /// Each job once: a job two hosts hold (one link key) is listed under the first host that names it.
    static func unique(_ jobs: [Job]) -> [Job] {
        var seen = Set<String>()
        return jobs.filter { seen.insert($0.id).inserted }
    }

    static func jobs(environmentId: String, workspaces: [WorkspaceMeta]) -> [Job] {
        workspaces.filter { $0.kind == .work }.map { Job(id: ProjectPairs.key(environmentId, $0), environmentId: environmentId, workspaceId: $0.id, name: $0.name, sector: $0.sector) }
    }
}

/// Go To's answer (Work/Files/FilesGoTo.swift): each job's host ranks its own names, the jobs keep their order, and a
/// host that could not look is named beside the names the others found, never read as "No Names Match".
public enum FilesGoToRules {
    /// The rows in the jobs' order, each job's own in its host's order; the jobs whose host did not answer, by name.
    /// `answers` holds each asked job with its names, or nil where its host failed.
    public static func merge(_ answers: [(job: FilesRoot.Job, entries: [FileEntry]?)], order: [FilesRoot.Job]) -> (rows: [FilesFound.Row], failed: [String]) {
        let place = Dictionary(order.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ranked = answers.sorted { (place[$0.job.id] ?? 0) < (place[$1.job.id] ?? 0) }
        let rows = ranked.flatMap { answer in (answer.entries ?? []).map { FilesFound.Row(job: answer.job, entry: $0) } }
        return (rows, ranked.filter { $0.entries == nil }.map(\.job.name))
    }

    /// Counts Go To's lookups, typed and Try Again's alike, and the Files search's runs, typed, saved, Try Again's
    /// and a pull's: only the newest one started publishes its rows, its failures and its end, so an older one
    /// that answers late neither replaces them nor leaves a spinner with nothing out.
    public struct Lookups: Sendable {
        public private(set) var latest = 0

        public init() {}

        /// A new lookup's number; every lookup started before it stops publishing.
        public mutating func start() -> Int {
            latest += 1
            return latest
        }

        public func publishes(_ lookup: Int) -> Bool {
            lookup == latest
        }
    }

    /// The words a lookup asks for: the field's text, trimmed.
    public static func query(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespaces)
    }

    /// The answer on hand is for the field's text now: only then are its rows drawn, tapped, or taken by Search, so
    /// a name typed past them never opens the last words' first match.
    public static func current(answered: String?, text: String) -> Bool {
        answered == query(text)
    }

    /// The sheet's empty words once nothing is out: "Nothing Recent" or "No Names Match"; nil while rows show, while
    /// it asks, or where a host failed (its line says so instead).
    public static func empty(text: String, rows: Int, failed: [String], asking: Bool) -> String? {
        guard rows == 0, !asking, failed.isEmpty else { return nil }
        return text.isEmpty ? "Nothing Recent" : "No Names Match"
    }
}
