import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A stand-in connection: each method answers from its queue of JSON (or refuses), and every request is kept.
private actor AskWire: FilesWire {
    struct Refused: Error {}

    private var answers: [String: [String?]] = [:]
    private(set) var sent: [(method: String, params: String)] = []

    func answer(_ method: String, _ json: String) { answers[method, default: []].append(json) }
    func refuse(_ method: String, _ words: String) { answers[method, default: []].append(nil) }
    func methods() -> [String] { sent.map(\.method) }
    func params(_ method: String) -> [String] { sent.filter { $0.method == method }.map(\.params) }

    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        sent.append((M.name, String(decoding: try encoder.encode(params), as: UTF8.self)))
        guard var queue = answers[M.name], !queue.isEmpty else { throw Refused() }
        let next = queue.removeFirst()
        answers[M.name] = queue
        guard let next else { throw Refused() }
        return try JSONDecoder().decode(M.Output.self, from: Data(next.utf8))
    }
}

/// Ask on a file with no thread beside it (Work/Reader/FileAsk.swift, PF5), on a stand-in wire.
@MainActor struct FileAskTests {
    private let item = CanvasItem(id: "i1", sessionId: "files:w1", workspaceId: "w1", kind: .pdf, title: "Bracket.pdf", source: .file(.init(host: "box", path: "/w/Bracket.pdf")), state: .open, position: 0, rev: 1, createdAt: 1, updatedAt: 1)
    private var chip: ContextChip { ChipWords.item(item) }

    private func meta(_ id: String, archived: Bool = false, updatedAt: Int = 1) -> SessionMeta {
        SessionMeta(id: id, parentId: nil, projectId: nil, workspaceId: "w1", threadType: .chat, planPath: nil, provider: .claude, model: "claude-opus-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/w", status: .idle, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, createdAt: 1, updatedAt: updatedAt)
    }

    private func thread(_ id: String) -> Methods.WorkFilesThreads.Output.Thread {
        .init(sessionId: id, itemId: "i-\(id)", source: item.source)
    }

    @Test func `the thread that holds the file is the newest the phone knows that is not archived`() {
        let known = ["a": meta("a", updatedAt: 5), "b": meta("b", updatedAt: 9), "c": meta("c", archived: true, updatedAt: 20)]
        #expect(FileAsk.holder([thread("a"), thread("b"), thread("c"), thread("unlisted")]) { known[$0] } == "b")
        #expect(FileAsk.holder([thread("c"), thread("unlisted")]) { known[$0] } == nil)
        #expect(FileAsk.holder([]) { known[$0] } == nil)
    }

    @Test func `his words go to the thread that holds the file`() async throws {
        let wire = AskWire()
        await wire.answer("work.files.threads", #"{"threads":[{"sessionId":"a","itemId":"i9","source":{"at":"file","host":"box","path":"/w/Bracket.pdf"}}]}"#)
        await wire.answer("session.send", "null")
        let known = ["a": meta("a")]
        let went = try await FileAsk.send(wire: wire, workspaceId: "w1", item: item, chip: chip, text: "Who plays first?") { known[$0] }
        #expect(went == "a")
        #expect(await wire.methods() == ["work.files.threads", "session.send"])
        #expect(await wire.params("session.send").first?.contains("Who plays first?") == true)
    }

    @Test func `with no thread holding it, one is started, the file is opened in it, then the words go`() async throws {
        let wire = AskWire()
        await wire.answer("work.files.threads", #"{"threads":[]}"#)
        await wire.answer("session.create", String(decoding: try JSONEncoder().encode(meta("new")), as: UTF8.self))
        await wire.answer("work.canvas.open", String(decoding: try JSONEncoder().encode(item), as: UTF8.self))
        await wire.answer("session.send", "null")
        let went = try await FileAsk.send(wire: wire, workspaceId: "w1", item: item, chip: chip, text: "Who plays first?") { _ in nil }
        #expect(went == "new")
        #expect(await wire.methods() == ["work.files.threads", "session.create", "work.canvas.open", "session.send"])
        let made = try #require(await wire.params("session.create").first)
        #expect(made.contains(#""workspaceId":"w1""#) && made.contains(#""scope":"work""#) && made.contains(#""about""#))
        let opened = try #require(await wire.params("work.canvas.open").first)
        #expect(opened.contains(#""sessionId":"new""#) && opened.contains(#""kind":"pdf""#) && opened.contains("Bracket.pdf"))
    }

    @Test func `an open the host refuses does not stop the words, and a host that names no holder starts a thread`() async throws {
        let wire = AskWire()
        await wire.refuse("work.files.threads", "bad request")
        await wire.answer("session.create", String(decoding: try JSONEncoder().encode(meta("new")), as: UTF8.self))
        await wire.refuse("work.canvas.open", "That file is out of reach.")
        await wire.answer("session.send", "null")
        let went = try await FileAsk.send(wire: wire, workspaceId: "w1", item: item, chip: chip, text: "Hello") { _ in nil }
        #expect(went == "new")
        #expect(await wire.methods().last == "session.send")
    }
}
