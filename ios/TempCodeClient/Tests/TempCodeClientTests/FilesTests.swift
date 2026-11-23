import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

// The Files place on the phone (the files pillar's F9): the rules a menu reads, Open the original's temp
// file, and the store against a stand-in connection.

private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func place(_ id: String, kind: String = "folder", name: String = "Dummy Esports", host: String = "box", shared: Bool = false, can: [String] = ["make", "upload", "rename", "move", "copy", "edit", "trash", "restore", "purge"], state: String = "ok", key: String? = nil, vm: Bool = false) -> String {
    let keyField = key.map { #","key":"\#($0)""# } ?? ""
    let canList = can.map { "\"\($0)\"" }.joined(separator: ",")
    return #"{"id":"\#(id)","kind":"\#(kind)","name":"\#(name)","host":"\#(host)","env":"env_box","shared":\#(shared),"can":[\#(canList)],"state":{"state":"\#(state)"},"root":{"at":"place","id":"\#(id)"}\#(keyField),"vm":\#(vm)}"#
}

private func entry(_ name: String, kind: String = "pdf", size: Int = 1000, folder: Bool = false, extra: String = "") -> String {
    let path = "/w/Dummy Esports/\(name)"
    let ref = folder ? "null" : #"{"at":"file","host":"box","path":"\#(path)"}"#
    let dir = folder ? #"{"at":"file","host":"box","path":"\#(path)"}"# : "null"
    return #"{"key":"file:box:\#(path)","ref":\#(ref),"folder":\#(dir),"name":"\#(name)","kind":"\#(folder ? "folder" : kind)","size":\#(size),"changed":1700000000000\#(extra)}"#
}

private let full = FilesRules.Caps(operate: true, approve: true)

struct FilesRulesTests {
    @Test func `the Files screen lists Recent and Starred, then the places once each, then From mail`() throws {
        let all: [FilePlace] = try decode("[\(place("trash", kind: "trash", name: "Trash")),\(place("starred", kind: "starred", name: "Starred")),\(place("recent", kind: "recent", name: "Recent")),\(place("folder")),\(place("mac~1", kind: "teams", name: "General", host: "MacBook", state: "asleep", key: "staffgeneral")),\(place("box~2", kind: "teams", name: "General", host: "box", key: "staffgeneral")),\(place("mail", kind: "mail", name: "From mail"))]")
        let sections = FilesRules.sections(all)
        #expect(sections.lenses.map(\.id) == ["recent", "starred"])
        // One place two computers hold is one row: the copy that answers.
        #expect(sections.places.map(\.id) == ["folder", "box~2"])
        #expect(sections.mail.map(\.id) == ["mail"])
        #expect(FilesRules.workspaceFolder(all)?.id == "folder")
        // A remote key told of no lens draws none.
        #expect(FilesRules.sections(try decode("[\(place("folder"))]")).lenses.isEmpty)
    }

    @Test func `a place's refusals are the grammar's sentences`() throws {
        let folder: FilePlace = try decode(place("folder"))
        let library: FilePlace = try decode(place("lib", kind: "teams", name: "General", shared: true, can: ["make", "rename", "move", "copy", "edit"]))
        let mail: FilePlace = try decode(place("mail", kind: "mail", name: "From mail", can: []))
        let recent: FilePlace = try decode(place("recent", kind: "recent", name: "Recent", can: []))
        let down: FilePlace = try decode(place("mac", kind: "teams", name: "General", host: "MacBook", state: "unreachable"))
        let vm: FilePlace = try decode(place("vm", kind: "teams", name: "General", can: [], vm: true))
        let writing: FileEntry = try decode(entry("Budget.pdf", extra: #","state":{"is":"writing"}"#))
        #expect(FilesRules.refusal(folder, .trash) == nil)
        #expect(FilesRules.refusal(mail, .rename) == .init("A mail's file is read only. Keep it first.", press: .keep))
        #expect(FilesRules.refusal(recent, .rename)?.text == "Recent only shows files. Change one where it lives.")
        #expect(FilesRules.refusal(down, .rename) == .init("MacBook is out of reach.", press: .retry))
        #expect(FilesRules.refusal(folder, .rename, entry: writing)?.text == "A thread is writing in this file. Try when it is done.")
        #expect(FilesRules.refusal(library, .trash) == .init("Delete it in Teams.", press: .openWeb))
        #expect(FilesRules.refusal(library, .upload)?.text == "Nothing can be uploaded in General from here.")
        #expect(FilesRules.refusal(vm, .rename)?.text == "Files in the Windows VM cannot be changed from here yet. Open it there.")
    }

    @Test func `a menu offers a change only to a key that may ask for it`() throws {
        let folder: FilePlace = try decode(place("folder"))
        let library: FilePlace = try decode(place("lib", kind: "teams", name: "General", shared: true, can: ["make", "rename"]))
        #expect(FilesRules.offers(folder, .make, caps: full))
        #expect(!FilesRules.offers(folder, .make, caps: .readOnly))
        // Where others can open the place, the host's door asks a remote key for approve.
        #expect(!FilesRules.offers(library, .rename, caps: .init(operate: true, approve: false)))
        #expect(FilesRules.offers(library, .rename, caps: full))
        #expect(!FilesRules.offers(library, .trash, caps: full))
    }

    @Test func `a row says one fact`() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_700_000_000 + 3600)
        #expect(FilesRules.fact(try decode(entry("A.pdf", extra: #","state":{"is":"present","who":"Esports Staff"}"#)), inLens: false, now: now, calendar: calendar) == "Esports Staff is in it")
        #expect(FilesRules.fact(try decode(entry("A.pdf", extra: #","state":{"is":"suggestions","count":3}"#)), inLens: false, now: now, calendar: calendar) == "3 suggestions")
        #expect(FilesRules.fact(try decode(entry("A.pdf", extra: #","where":{"place":"folder","name":"Dummy Esports","trail":[]}"#)), inLens: true, now: now, calendar: calendar) == "Dummy Esports")
        #expect(FilesRules.fact(try decode(entry("A.pdf")), inLens: false, now: now, calendar: calendar).replacingOccurrences(of: "\u{202F}", with: " ") == "10:13 PM")
        #expect(FilesRules.changedWords(1_700_000_000_000, now: now.addingTimeInterval(86_400), calendar: calendar) == "Yesterday")
        #expect(FilesRules.changedWords(1_700_000_000_000, now: now.addingTimeInterval(86_400 * 20), calendar: calendar) == "Nov 14")
        #expect(FilesRules.changedWords(1_700_000_000_000, now: now.addingTimeInterval(86_400 * 400), calendar: calendar) == "Nov 14, 2023")
    }

    @Test func `a file opens by its kind, its place and the key`() throws {
        let folder: FilePlace = try decode(place("folder"))
        let library: FilePlace = try decode(place("lib", kind: "teams", name: "General", host: "MacBook", shared: true))
        let pdf: FileEntry = try decode(entry("Bracket.pdf"))
        #expect(FilesRules.opening(pdf, place: folder, caps: full) == .item)
        // A read-only key seats nothing: it reads the file in Quick Look where it may.
        #expect(FilesRules.opening(pdf, place: folder, caps: .readOnly) == .quickLook(.allowed))
        #expect(FilesRules.opening(try decode(entry("Notes.txt", kind: "text")), place: folder, caps: full) == .quickLook(.allowed))
        // A document or sheet kept as a file is seated for the hosted editor; a key that may not seat it reads it.
        #expect(FilesRules.opening(try decode(entry("Budget.xlsx", kind: "sheet")), place: folder, caps: full) == .item)
        #expect(FilesRules.opening(try decode(entry("Memo.tcdoc", kind: "document")), place: folder, caps: full) == .item)
        #expect(FilesRules.opening(try decode(entry("Memo.tcdoc", kind: "document")), place: folder, caps: .readOnly) == .quickLook(.readOnly))
        #expect(FilesRules.opening(try decode(entry("Roster.xlsx", kind: "sheet")), place: library, caps: full) == .quickLook(.facts(host: "MacBook")))
        #expect(FilesRules.opening(try decode(entry("Cut.mov", kind: "audio", size: 60 * 1024 * 1024)), place: folder, caps: full) == .quickLook(.tooBig))
        let lifeos: FileEntry = try decode(#"{"key":"lifeos:docs:d1","ref":{"at":"lifeos","table":"docs","id":"d1"},"folder":null,"name":"Run of show","kind":"document"}"#)
        #expect(FilesRules.opening(lifeos, place: folder, caps: full) == .item)
    }

    @Test func `the search field filters by every word, case and accents ignored`() throws {
        let rows: [FileEntry] = try decode("[\(entry("Spring Café budget.xlsx", kind: "sheet")),\(entry("Bracket.pdf")),\(entry("Budget 2.pdf"))]")
        #expect(FilesRules.filter(rows, query: "cafe BUDGET").map(\.name) == ["Spring Café budget.xlsx"])
        #expect(FilesRules.filter(rows, query: "budget").count == 2)
        #expect(FilesRules.filter(rows, query: "  ").count == 3)
    }

    @Test func `names and keys follow the grammar`() {
        #expect(FilesRules.nameProblem("Budget/2026") == "A name cannot hold /")
        #expect(FilesRules.nameProblem("  ") == "A name needs at least one letter.")
        #expect(FilesRules.nameProblem("Notes.") == "A name cannot start with a space or end with a space or a dot.")
        #expect(FilesRules.nameProblem("CON.txt") == "Windows keeps that name for itself.")
        #expect(FilesRules.nameProblem("Spring LAN plan") == nil)
        #expect(FilesRules.untitled(.folder) == "Untitled folder")
        #expect(FilesRules.key(.file(.init(host: "box", path: "/w/A"))) == "file:box:/w/A")
        #expect(FilesRules.key(.place(.init(id: "recent"))) == "place:recent")
        #expect(FilesRules.op().count >= 8)
    }
}

struct OriginalFilesTests {
    private func frame(_ bytes: Data, _ offset: Int, _ length: Int, version: String = "v1") -> FileRead {
        let end = min(bytes.count, offset + length)
        return FileRead(data: bytes.subdata(in: offset ..< end).base64EncodedString(), size: Double(bytes.count), version: version, changed: 1, end: end == bytes.count)
    }

    @Test func `an original is read in frames of one version into its temp file`() async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let bytes = Data((0 ..< 10).map(UInt8.init))
        let file = try OriginalFiles.place(for: "Notes.txt", base: base)
        var asked: [(Int, String?)] = []
        try await OriginalFiles.read(size: 10, to: file, frame: 4) { offset, length, version in
            asked.append((offset, version))
            return frame(bytes, offset, length)
        }
        #expect(try Data(contentsOf: file) == bytes)
        #expect(file.lastPathComponent == "Notes.txt")
        #expect(asked.map(\.0) == [0, 4, 8])
        // The first frame names the version; every later read asks for it.
        #expect(asked.map(\.1) == [nil, "v1", "v1"])
        OriginalFiles.remove(file)
        #expect(!FileManager.default.fileExists(atPath: file.deletingLastPathComponent().path))
    }

    @Test func `a file that changes midway, or is too big, leaves nothing behind`() async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let bytes = Data((0 ..< 10).map(UInt8.init))
        let file = try OriginalFiles.place(for: "Notes.txt", base: base)
        var n = 0
        await #expect(throws: OriginalFiles.Failure.changed) {
            try await OriginalFiles.read(size: 10, to: file, frame: 4) { offset, length, _ in
                n += 1
                return frame(bytes, offset, length, version: "v\(n)")
            }
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path).isEmpty)
        await #expect(throws: OriginalFiles.Failure.tooBig) {
            try await OriginalFiles.read(size: FilesRules.originalMax + 1, to: file) { _, _, _ in frame(bytes, 0, 4) }
        }
    }

    @Test func `the next launch sweeps what a past one left`() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let file = try OriginalFiles.place(for: "Left.pdf", base: base)
        try Data([1]).write(to: file)
        OriginalFiles.sweep(base: base)
        #expect(!FileManager.default.fileExists(atPath: OriginalFiles.root(base).path))
    }
}

/// A stand-in connection: each method answers from its queue of JSON (or an error), in order, and every
/// request is kept with its params as JSON.
actor StubFilesWire: FilesWire {
    struct Refused: Error, CustomStringConvertible {
        let description: String
    }

    private var answers: [String: [Result<String, Refused>]] = [:]
    private(set) var sent: [(method: String, params: String)] = []

    func answer(_ method: String, _ json: String) { answers[method, default: []].append(.success(json)) }
    func refuse(_ method: String, _ words: String) { answers[method, default: []].append(.failure(Refused(description: words))) }
    func methods() -> [String] { sent.map(\.method) }
    func params(_ method: String) -> [String] { sent.filter { $0.method == method }.map(\.params) }

    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        sent.append((M.name, String(decoding: try encoder.encode(params), as: UTF8.self)))
        guard var queue = answers[M.name], !queue.isEmpty else { throw Refused(description: "no answer for \(M.name)") }
        let next = queue.removeFirst()
        answers[M.name] = queue
        switch next {
        case .success(let json): return try JSONDecoder().decode(M.Output.self, from: Data(json.utf8))
        case .failure(let error): throw error
        }
    }
}

@MainActor struct FilesHostTests {
    private let root = FolderRef.place(.init(id: "folder"))

    @Test func `places and a folder read a page at a time, and a stale page lists again from the top`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        await wire.answer("work.files.places", #"{"host":"box","places":[\#(place("folder"))],"rev":1,"sources":[]}"#)
        await host.loadPlaces("w1")
        #expect(host.places["w1"]?.value?.map(\.id) == ["folder"])
        await wire.answer("work.files.list", #"{"entries":[\#(entry("A.pdf"))],"next":"c1","trail":[{"name":"Dummy Esports","at":{"at":"place","id":"folder"}}]}"#)
        await host.list("w1", root)
        #expect(host.listing("w1", root)?.value?.entries.map(\.name) == ["A.pdf"])
        #expect(host.listing("w1", root)?.value?.trail == ["Dummy Esports"])
        await wire.answer("work.files.list", #"{"entries":[\#(entry("B.pdf"))]}"#)
        await host.more("w1", root)
        #expect(host.listing("w1", root)?.value?.entries.map(\.name) == ["A.pdf", "B.pdf"])
        #expect(host.listing("w1", root)?.value?.next == nil)
        // Changed between pages: the host answers stale, the list is read again.
        await wire.answer("work.files.list", #"{"entries":[],"stale":true}"#)
        await wire.answer("work.files.list", #"{"entries":[\#(entry("C.pdf"))]}"#)
        await host.list("w1", root)
        #expect(host.listing("w1", root)?.value?.entries.map(\.name) == ["C.pdf"])
        #expect(host.known("w1").map(\.name) == ["C.pdf"])
    }

    @Test func `a place that fails says why, and a shown list stays through a failed refresh`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        await wire.refuse("work.files.list", "MacBook is out of reach.")
        await host.list("w1", root)
        #expect(host.listing("w1", root)?.failure == "MacBook is out of reach.")
        await wire.answer("work.files.list", #"{"entries":[\#(entry("A.pdf"))]}"#)
        await host.list("w1", root)
        await wire.refuse("work.files.list", "MacBook is out of reach.")
        await host.list("w1", root)
        #expect(host.listing("w1", root)?.value?.entries.count == 1)
    }

    @Test func `a change sends its id, and a refusal is the host's sentence as it is`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        await wire.answer("work.files.list", #"{"entries":[\#(entry("A.pdf")),\#(entry("Old", folder: true))]}"#)
        await host.list("w1", root)
        let shown = try #require(host.listing("w1", root)?.value?.entries)
        await wire.answer("work.files.trash", #"{"entries":[],"refused":[],"trashed":["t1"],"op":"op_x"}"#)
        let ids = try await host.trash("w1", [shown[0]], in: root)
        #expect(ids == ["t1"])
        #expect(host.listing("w1", root)?.value?.entries.map(\.name) == ["Old"])
        let trash = try #require(await wire.params("work.files.trash").first)
        #expect(trash.contains(#""refs":[{"at":"file","host":"box","path":"\/w\/Dummy Esports\/A.pdf"}]"#))
        #expect(trash.contains(#""op":"op_"#))
        await wire.answer("work.files.rename", #"{"entries":[],"refused":[{"name":"Old","text":"Nothing can be renamed in General from here."}],"op":"op_y"}"#)
        await #expect(throws: ActionError.refused(message: "Nothing can be renamed in General from here.", forbidden: false)) {
            try await host.rename("w1", shown[1], to: "New", in: root)
        }
        // A folder is named as a folder.
        #expect(try #require(await wire.params("work.files.rename").first).contains(#""ref":{"at":"file""#))
        await wire.answer("work.files.star", #"{"starred":true}"#)
        try await host.star("w1", shown[1], on: true)
        #expect(host.listing("w1", root)?.value?.entries.first?.starred == true)
        await wire.answer("work.files.make", #"{"entries":[\#(entry("Plans", folder: true))],"refused":[],"op":"op_z"}"#)
        await wire.answer("work.files.list", #"{"entries":[\#(entry("Old", folder: true)),\#(entry("Plans", folder: true))]}"#)
        let made = try await host.make("w1", in: root, kind: .folder, name: "Plans")
        #expect(made?.name == "Plans")
        #expect(host.listing("w1", root)?.value?.entries.map(\.name) == ["Old", "Plans"])
        #expect(try #require(await wire.params("work.files.make").first).contains(#""kind":"folder""#))
    }

    @Test func `an upload sends its chunks in order and commits; a failure aborts it and keeps the row`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        let bytes = Data(repeating: 7, count: AttachmentUpload.maxChunkBytes + 10)
        let source = UploadSource(name: "Photo.png", size: bytes.count, sha256: String(repeating: "a", count: 64)) { offset, length in bytes.subdata(in: offset ..< offset + length) }
        await wire.answer("work.files.upload", #"{"uploadId":"u1"}"#)
        await wire.answer("attachment.chunk", #"{"received":1}"#)
        await wire.answer("attachment.chunk", #"{"received":2}"#)
        await wire.answer("attachment.commit", #"{"path":"/w/Photo.png","name":"Photo.png","kind":"file","size":\#(bytes.count)}"#)
        await wire.answer("work.files.list", #"{"entries":[\#(entry("Photo.png", kind: "picture"))]}"#)
        try await host.upload("w1", into: root, source)
        #expect(await wire.methods() == ["work.files.upload", "attachment.chunk", "attachment.chunk", "attachment.commit", "work.files.list"])
        #expect(host.uploads[FilesHost.slot("w1", root)]?.isEmpty == true)
        #expect(try #require(await wire.params("work.files.upload").first).contains(#""at":{"at":"place","id":"folder"}"#))

        await wire.answer("work.files.upload", #"{"uploadId":"u2"}"#)
        await wire.refuse("attachment.chunk", "unknown upload")
        await wire.answer("attachment.abort", "null")
        await #expect(throws: (any Error).self) { try await host.upload("w1", into: root, source) }
        #expect(host.uploads[FilesHost.slot("w1", root)]?.first?.failed == "unknown upload")
        for _ in 0 ..< 100 where !(await wire.methods()).contains("attachment.abort") { try await Task.sleep(for: .milliseconds(5)) }
        #expect(await wire.methods().contains("attachment.abort"))
    }

    @Test func `open seats the file, or finds the thread that already shows it`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        let pdf: FileEntry = try decode(entry("Bracket.pdf"))
        let item = #"{"id":"i1","sessionId":"filespane_w1","workspaceId":"w1","kind":"pdf","title":"Bracket.pdf","source":{"at":"file","host":"box","path":"/w/Dummy Esports/Bracket.pdf"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#
        await wire.answer("work.files.open", #"{"rev":2,"tabs":[],"tabId":"t1","item":\#(item)}"#)
        #expect(try await host.open("w1", pdf).id == "i1")
        await wire.answer("work.files.open", #"{"rev":2,"tabs":[],"held":{"sessionId":"s9","itemId":"i1"}}"#)
        await wire.answer("work.canvas.list", #"{"items":[\#(item)]}"#)
        #expect(try await host.open("w1", pdf).id == "i1")
        #expect(try #require(await wire.params("work.canvas.list").first) == #"{"sessionId":"s9"}"#)
    }

    @Test func `the original is read by version into a temp file`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        let text: FileEntry = try decode(entry("Notes.txt", kind: "text", size: 2))
        await wire.answer("work.files.read", #"{"data":"aGk=","size":2,"version":"v1","changed":1,"end":true}"#)
        let file = try await host.original("w1", text, base: base)
        #expect(try String(contentsOf: file, encoding: .utf8) == "hi")
        #expect(try #require(await wire.params("work.files.read").first).contains(#""offset":0"#))
        // A shared library's bytes are refused to the phone: the host's sentence, and no file left.
        await wire.refuse("work.files.read", "Only his own window reads a library's bytes.")
        await #expect(throws: (any Error).self) { _ = try await host.original("w1", text, base: base) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: OriginalFiles.root(base).path).count == 1)
    }

    @Test func `a push reads again the folder it names, and only that one`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: full)
        let budgets = FolderRef.file(.init(host: "box", path: "/w/Dummy Esports/Budgets"))
        await wire.answer("work.files.list", #"{"entries":[]}"#)
        await host.list("w1", budgets)
        await wire.answer("work.files.list", #"{"entries":[\#(entry("New.pdf"))]}"#)
        host.apply(try decode(#"{"push":"work.files","workspaceId":"w1","at":"file:box:/w/Other"}"#, as: ServerPush.self))
        host.apply(try decode(#"{"push":"work.files","workspaceId":"w1","at":"file:box:/w/Dummy Esports/Budgets"}"#, as: ServerPush.self))
        for _ in 0 ..< 100 where host.listing("w1", budgets)?.value?.entries.isEmpty == true { try await Task.sleep(for: .milliseconds(5)) }
        #expect(host.listing("w1", budgets)?.value?.entries.map(\.name) == ["New.pdf"])
        #expect(await wire.params("work.files.list").count == 2)
    }
}
