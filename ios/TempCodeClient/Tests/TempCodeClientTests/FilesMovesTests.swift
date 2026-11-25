import Foundation
import Testing
@testable import TempCodeClient
import TempCodeContract

/// Files for every job (M3a): Move, Copy, the delete's question, the copy's progress, a far computer, Go to and
/// saved searches, thumbnails, the search across jobs and the kept pages.

private func spot(_ id: String, kind: String = "folder", name: String = "Dummy Esports", host: String = "box", env: String = "env_box", shared: Bool = false,
                  can: [String] = ["make", "upload", "rename", "move", "copy", "edit", "trash", "restore", "purge"], state: String = "ok",
                  group: String? = nil, bin: Bool = true, root: String? = nil, key: String? = nil) -> FilePlace {
    let canList = can.map { "\"\($0)\"" }.joined(separator: ",")
    let esc = { (text: String) in text.replacingOccurrences(of: "\\", with: "\\\\") }
    let name = esc(name), root = root.map(esc)
    let rootJSON = root.map { #"{"at":"file","host":"\#(host)","path":"\#($0)"}"# } ?? #"{"at":"place","id":"\#(id)"}"#
    let extra = (group.map { #","group":"\#($0)""# } ?? "") + (bin ? "" : #","bin":false"#) + (key.map { #","key":"\#($0)""# } ?? "")
    let json = #"{"id":"\#(id)","kind":"\#(kind)","name":"\#(name)","host":"\#(host)","env":"\#(env)","shared":\#(shared),"can":[\#(canList)],"state":{"state":"\#(state)"},"root":\#(rootJSON)\#(extra)}"#
    return try! JSONDecoder().decode(FilePlace.self, from: Data(json.utf8))
}

private func row(_ name: String, size: Double = 1000, changed: Double = 1_700_000_000_000, kind: FileEntry.Kind = .pdf) -> FileEntry {
    FileEntry(key: "file:box:/w/\(name)", ref: .file(.init(host: "box", path: "/w/\(name)")), folder: nil, name: name, kind: kind, size: size, changed: changed)
}

private func job(_ id: String, _ name: String) -> FilesRoot.Job {
    FilesRoot.Job(id: id, environmentId: "env_box", workspaceId: "w-\(id)", name: name, sector: "purdue")
}

struct FilesMoveRulesTests {
    let mine = spot("folder")
    let team = spot("lib1", kind: "teams", name: "Esports Staff", shared: true, group: "Esports")

    @Test func `a copy into a shared place asks first, and a delete there asks for everyone`() {
        #expect(FilesRules.question(mine, .copy, entry: row("A.pdf"), to: team) == "Copy to Esports Staff? Everyone in that team can open it.")
        #expect(FilesRules.question(mine, .move, entry: row("A.pdf"), to: team) == "Move to Esports Staff? Everyone in that team can open it.")
        #expect(FilesRules.question(team, .trash, entry: row("A.pdf")) == "Delete for everyone?")
        #expect(FilesRules.question(mine, .trash, entry: row("A.pdf")) == nil)
        #expect(FilesRules.question(mine, .move, entry: row("A.pdf"), to: spot("folder")) == nil)
    }

    @Test func `across places the grammar's refusals hold word for word`() {
        let drive = spot("d1", kind: "drive", name: "Drive")
        let far = spot("pc", name: "Purdue PC", host: "Purdue PC", env: "env_pc")
        #expect(FilesRules.refusal(team, .copy, entry: row("A.pdf"), to: mine)?.text == "Teams files stay in Teams.")
        #expect(FilesRules.refusal(mine, .copy, entry: row("A.pdf"), to: drive)?.text == "A Google file lives in Google Drive. Export a copy instead.")
        #expect(FilesRules.refusal(spot("l", kind: "lifeos", name: "LifeOS"), .move, entry: row("A"), to: mine)?.text == "A LifeOS document lives in LifeOS. Export a copy instead.")
        #expect(FilesRules.refusal(far, .copy, entry: row("Big.mov", size: 60 * 1024 * 1024), to: mine)?.text == "This file is over 48 MB, too big to copy from Purdue PC.")
        #expect(FilesRules.refusal(spot("o", can: ["trash"]), .move, entry: row("A.pdf"), to: spot("p", can: []))?.text == "Nothing can be copied in Dummy Esports from here.")
        #expect(FilesRules.refusal(spot("o", can: ["copy"]), .move, entry: row("A.pdf"), to: mine)?.text == "Nothing can be moved in Dummy Esports from here.")
        #expect(FilesRules.refusal(spot("m", kind: "mail", name: "From mail"), .copy, entry: row("A.pdf"), to: mine) == nil)
        #expect(FilesRules.refusal(mine, .copy, entry: row("A.pdf"), to: spot("x", host: "MacBook", state: "unreachable"))?.text == "MacBook is out of reach.")
        #expect(FilesRules.refusal(mine, .move, entry: row("A.pdf"), to: mine) == nil)
    }

    @Test func `a move into a shared place is offered only to a key that may approve`() {
        #expect(FilesRules.offers(mine, .copy, entry: row("A.pdf"), to: team, caps: .init(operate: true, approve: true)))
        #expect(!FilesRules.offers(mine, .copy, entry: row("A.pdf"), to: team, caps: .init(operate: true, approve: false)))
        #expect(FilesRules.offers(mine, .move, entry: row("A.pdf"), to: spot("other"), caps: .init(operate: true, approve: false)))
    }

    @Test func `a delete's words: a drive with no bin first, then who can open it`() {
        let mapped = spot("r", kind: "onedrive", name: "Roster", shared: true, bin: false, root: "R:\\Esports")
        #expect(FilesRules.deleteAsk(mapped, names: ["Roster.xlsx"]) == ("Delete Roster.xlsx for good?", "Deleted from R: at once; it cannot be put back."))
        #expect(FilesRules.deleteAsk(team, names: ["A.pdf"]) == ("Delete A.pdf for everyone?", "Everyone in Esports can open it."))
        #expect(FilesRules.deleteAsk(team, names: ["A.pdf", "B.pdf"]) == ("Delete 2 items for everyone?", "Everyone in Esports can open them."))
        #expect(FilesRules.deleteAsks(mapped, entry: nil))
        #expect(!FilesRules.deleteAsks(mine, entry: row("A.pdf")))
    }

    @Test func `the drive with no bin reads as the shared rule does`() {
        #expect(FilesRules.noBinDrive("R:\\x") == "R:")
        #expect(FilesRules.noBinDrive("\\\\srv\\share\\a") == "\\\\srv\\share")
        #expect(FilesRules.noBinDrive("C:\\x") == nil)
        #expect(FilesRules.noBinDrive("//?/x") == nil)
        #expect(FilesRules.noBinDrive("/Users/l") == nil)
    }

    /// The same tags `openingTag` in src/shared/work/files.ts makes (bun, 2026-11-24).
    @Test func `the opening tag is the host's`() {
        #expect(FilesRules.openingTag("file:mac:/Users/l/Budget.xlsx") == "13v89bl1tyt0n")
        #expect(FilesRules.openingTag("trash:é1") == "1w0us9315wglnx")
    }

    @Test func `the grid is offered where the host draws pictures`() {
        #expect(FilesRules.hasThumb(row("A.pdf")))
        #expect(!FilesRules.hasThumb(row("A.mp3", kind: .audio)))
        #expect(FilesRules.gridOffered([row("A.pdf")], far: false, place: mine))
        #expect(!FilesRules.gridOffered([row("A.pdf")], far: true, place: mine))
        #expect(!FilesRules.gridOffered([row("A.zip", kind: .archive)], far: false, place: mine))
    }
}

struct FilesRootTests {
    @Test func `the filter shows one job, and a pick no longer listed shows every job`() {
        let jobs = [job("a", "Purdue"), job("b", "Hypixel")]
        #expect(FilesRoot.shown(jobs, pick: nil).map(\.id) == ["a", "b"])
        #expect(FilesRoot.shown(jobs, pick: "b").map(\.id) == ["b"])
        #expect(FilesRoot.shown(jobs, pick: "gone").map(\.id) == ["a", "b"])
    }

    @Test func `a job's band holds its lenses, places, far computers, mail and trash; a place two computers hold shows once`() {
        let places = [spot("recent", kind: "recent", name: "Recent"), spot("folder"), spot("lib", kind: "onedrive", name: "Esports", key: "od:esports"),
                      spot("mail", kind: "mail", name: "From mail"), spot("trash", kind: "trash", name: "Trash")]
        let pc = FilesHost.FarDesktop(host: "pc", name: "Purdue PC", places: [spot("pc1", kind: "onedrive", name: "Esports", key: "od:esports"), spot("pc2", name: "J:\\Esports", host: "Purdue PC")])
        let band = FilesRoot.band(job("a", "Purdue"), places: places, far: [pc])
        #expect(band.lenses.map(\.id) == ["recent"])
        #expect(band.places.map(\.id) == ["folder", "lib"])
        #expect(band.far.first?.places.map(\.id) == ["pc2"])
        #expect(band.mail.map(\.id) == ["mail"])
        #expect(band.trash?.id == "trash")
    }

    @Test func `jobs are every Work workspace of a host, a sector or none`() {
        let spaces = [WorkspaceMeta(id: "w1", name: "Purdue", path: "/w", git: false, kind: .work, sector: "purdue", createdAt: 1),
                      WorkspaceMeta(id: "w2", name: "Side", path: "/s", git: false, kind: .work, sector: nil, createdAt: 1),
                      WorkspaceMeta(id: "c1", name: "Code", path: "/c", git: true, createdAt: 1)]
        #expect(FilesRoot.jobs(environmentId: "env_box", workspaces: spaces).map(\.workspaceId) == ["w1", "w2"])
        let twice = FilesRoot.jobs(environmentId: "env_box", workspaces: spaces) + FilesRoot.jobs(environmentId: "env_mac", workspaces: [spaces[0]])
        #expect(FilesRoot.unique(twice).count == 3)
        #expect(FilesRoot.unique(FilesRoot.jobs(environmentId: "env_box", workspaces: spaces) + FilesRoot.jobs(environmentId: "env_box", workspaces: spaces)).map(\.workspaceId) == ["w1", "w2"])
    }
}

struct FilesFoundTests {
    let a = job("a", "Purdue")
    let b = job("b", "Hypixel")

    @Test func `local rows show at once, a host's answer takes its job's place, newest first`() {
        var found = FilesFound(query: "budget", jobs: [a, b], local: ["a": [row("Budget.xlsx", changed: 1), row("Notes.txt")]])
        #expect(found.rows.map(\.entry.name) == ["Budget.xlsx"])
        found.land([row("Budget 2.xlsx", changed: 5), row("Budget.xlsx", changed: 1)], job: a, query: "budget")
        found.land([row("Budget plan.pdf", changed: 3)], job: b, query: "budget")
        #expect(found.rows.map(\.entry.name) == ["Budget 2.xlsx", "Budget plan.pdf", "Budget.xlsx"])
        #expect(found.waiting.isEmpty)
    }

    @Test func `an answer for older words is dropped, and a failed job is named once`() {
        var found = FilesFound(query: "bud", jobs: [a, b], local: [:])
        found.land([row("Old.pdf")], job: a, query: "bu")
        #expect(found.rows.isEmpty)
        found.fail(job: b, query: "bud")
        found.fail(job: b, query: "bud")
        #expect(found.note == "Hypixel was not searched.")
        found.land([], job: a, query: "bud")
        #expect(found.isEmpty)
    }
}

@MainActor struct FolderKeptTests {
    private let environment = PairedEnvironment(id: "env_box", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 7)

    @Test func `a folder's first page is kept once, and comes back with no file ref`() {
        let cache = FolderBookCache()
        let kept = FolderKept(cache: cache, environment: environment)
        let folder = FolderRef.place(.init(id: "folder"))
        let sub = FileEntry(key: "file:box:/w/Sub", ref: nil, folder: .file(.init(host: "box", path: "/w/Sub")), name: "Sub", kind: .folder)
        kept.keep("env_box", "w1", folder, [sub, row("A.pdf")])
        kept.keep("env_box", "w1", folder, [sub, row("A.pdf")])
        #expect(cache.writes == 1)
        let again = FolderKept(cache: cache, environment: environment).page("env_box", "w1", folder)
        #expect(again?.entries.map(\.name) == ["Sub", "A.pdf"])
        #expect(again?.entries.allSatisfy { $0.ref == nil } == true)
        #expect(again?.entries.first?.folder != nil)
        #expect(again?.page.names == ["Sub", "A.pdf"])
        #expect(kept.page("env_mac", "w1", folder) == nil)
        kept.drop(.workOff(host: "env_box"))
        #expect(FolderKept(cache: cache, environment: environment).page("env_box", "w1", folder) == nil)
    }
}

@MainActor struct FilesMovesHostTests {
    private let root = FolderRef.place(.init(id: "folder"))
    private let done = #"{"entries":[],"refused":[],"op":"op_1"}"#

    @Test func `a move sends his yes and lists both folders shown again`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        let to = FolderRef.file(.init(host: "box", path: "/w/Sub"))
        await wire.answer("work.files.list", #"{"entries":[]}"#)
        await host.list("w1", root)
        await wire.answer("work.files.move", done)
        await wire.answer("work.files.list", #"{"entries":[]}"#)
        try await host.move("w1", [row("A.pdf")], to: to, from: root, asked: true)
        let sent = await wire.params("work.files.move").first ?? ""
        #expect(sent.contains(#""asked":true"#))
        #expect(await wire.methods() == ["work.files.list", "work.files.move", "work.files.list"])
    }

    @Test func `a copy the host refuses throws its sentence`() async {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: false))
        await wire.answer("work.files.copy", #"{"entries":[],"refused":[{"name":"A.pdf","text":"Others can open that place: this key may not change it."}],"op":"op_1"}"#)
        await #expect(throws: ActionError.self) { try await host.copy("w1", [row("A.pdf")], to: root, from: root, asked: true) }
    }

    @Test func `a delete for everyone and for good carries both words`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        await wire.answer("work.files.trash", #"{"entries":[],"refused":[],"trashed":["t1"],"op":"op_1"}"#)
        #expect(try await host.trash("w1", [row("A.pdf")], in: root, asked: true, forGood: true) == ["t1"])
        let sent = await wire.params("work.files.trash").first ?? ""
        #expect(sent.contains(#""asked":true"#) && sent.contains(#""forGood":true"#))
    }

    @Test func `a copy's progress comes from the push by its row's tag, and goes when it opens`() async {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        let entry = row("Roster.xlsx")
        let tag = FilesRules.openingTag(entry.key)
        host.apply(.workFiles(WorkFilesPush(workspaceId: "w1", opening: .init(of: tag, done: 25, total: 100))))
        #expect(host.opening[tag] == 0.25)
        await wire.refuse("work.files.open", "Purdue PC is not reachable now.")
        _ = try? await host.open("w1", entry)
        #expect(host.opening[tag] == nil)
    }

    @Test func `a far computer is asked through the workspace's host, and its folders listed the same way`() async {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        await wire.answer("work.workspace.get", #"{"mayUseDesktop":["env_box","pc","mac"],"voice":false}"#)
        await wire.answer("work.files.across", #"{"host":"pc","name":"Purdue PC","places":[{"id":"pc1","kind":"folder","name":"J:\\Esports","host":"Purdue PC","env":"pc","shared":false,"can":[],"state":{"state":"ok"},"root":{"at":"file","host":"pc","path":"J:\\Esports"}}],"rev":1}"#)
        await wire.refuse("work.files.across", "MacBook is not reachable now.")
        await host.loadFar("w1")
        let far = host.far["w1"]?.value ?? []
        #expect(far.map(\.name) == ["Purdue PC", "mac"])
        #expect(far.last?.failed == "MacBook is not reachable now.")
        let folder = FolderRef.file(.init(host: "pc", path: "J:\\Esports"))
        await wire.answer("work.files.across", #"{"entries":[{"key":"file:pc:J:\\Esports\\Roster.xlsx","ref":{"at":"file","host":"pc","path":"J:\\Esports\\Roster.xlsx"},"folder":null,"name":"Roster.xlsx","kind":"sheet"}]}"#)
        await host.list("w1", folder, through: "pc")
        #expect(host.listing("w1", folder)?.value?.entries.map(\.name) == ["Roster.xlsx"])
        #expect(host.farHost("w1", folder) == "pc")
        let asked = await wire.params("work.files.across")
        #expect(asked.last?.contains(#""method":"work.files.list""#) == true)
        #expect(asked.last?.contains(#""workspaceId":"w1""#) == true)
    }

    @Test func `thumbnails are asked once for the rows that can have one`() async {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        let png = Data([1, 2, 3]).base64EncodedString()
        await wire.answer("work.files.thumbs", #"{"thumbs":["\#(png)",null]}"#)
        let rows = [row("A.pdf"), row("B.png", kind: .picture), row("C.mp3", kind: .audio)]
        await host.loadThumbs("w1", rows, size: FilesRules.thumbSize)
        await host.loadThumbs("w1", rows, size: FilesRules.thumbSize)
        #expect(host.thumbs[FilesHost.thumbKey(rows[0])] == Data([1, 2, 3]))
        #expect(host.thumbs[FilesHost.thumbKey(rows[1])] == nil)
        #expect(await wire.methods() == ["work.files.thumbs"])
    }

    @Test func `Go to and the saved searches read the host's answers`() async throws {
        let wire = StubFilesWire()
        let host = FilesHost(wire: wire, environmentId: "env_box", caps: .init(operate: true, approve: true))
        await wire.answer("work.files.names", #"{"entries":[{"key":"k","ref":null,"folder":null,"name":"Budget.xlsx","kind":"sheet"}]}"#)
        #expect(try await host.names("w1", "bud").map(\.name) == ["Budget.xlsx"])
        await wire.answer("work.files.searches", #"{"searches":[{"id":"s1","name":"PDFs this week","query":"","filter":{"kinds":["pdf"],"within":"week"}}]}"#)
        let saved = try await host.searches("w1")
        #expect(saved.map(\.name) == ["PDFs this week"])
        await wire.answer("work.files.search", #"{"entries":[]}"#)
        _ = try await host.search("w1", saved[0])
        let sent = await wire.params("work.files.search").first ?? ""
        #expect(sent.contains(#""within":"week""#) && sent.contains(#""kinds":["pdf"]"#))
    }
}
