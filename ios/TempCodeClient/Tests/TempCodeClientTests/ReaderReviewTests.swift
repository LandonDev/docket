import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A client on fake sockets, its socket opened with a hello and Work's open
/// answered, for a document's comments and a review (Work/Reader/WorkComments.swift,
/// WorkReview.swift, PF2).
@MainActor
private final class ReaderRig {
    let clock = ManualClock(now: 1_000_000, random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let client: EnvironmentClient
    var work: WorkHost { client.work }
    /// Request ids a test has already taken, so `next` finds the following call of a method.
    private var taken: Set<String> = []

    init() throws {
        try keys.set("tc_K1.secret", for: "env_test")
        UserDefaults.standard.removeObject(forKey: "work.on.env_test")
        let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    func open() async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: ["read", "operate"])
        _ = await until { await self.client.socket.isOpen }
        var answered: Set<String> = []
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline, answered.count < 6 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list", "project.list": fake.answer(id: sent.id, result: "[]")
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g0")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [], cursor: nil)))
                case "work.get": fake.answer(id: sent.id, result: #"{"enabled":false}"#)
                case "away.get": fake.answer(id: sent.id, result: #"{"state":{"enabled":false,"at":1,"by":"phone"},"decided":{"since":0,"threads":[]}}"#)
                default: continue
                }
                answered.insert(sent.id)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return fake
    }

    func until(_ predicate: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    /// The next call of `method` not yet taken, with its params as sent.
    func next(_ fake: FakeWebSocket, _ method: String) async -> (id: String, params: JSONValue)? {
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while ContinuousClock.now < deadline {
            if let found = fake.sentRequests.first(where: { $0.method == method && !taken.contains($0.id) }) {
                taken.insert(found.id)
                return (found.id, found.params)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }
}

/// What a host answers a method its schema does not list (the fake escapes it for the frame's JSON).
private let unknownMethod = #"bad request: [{"code":"invalid_union","note":"No matching discriminator","discriminator":"method","path":["method"]}]"#

private let doc = CanvasSource.lifeos(LifeosSource(table: .docs, id: "d1"))
private let docJSON = JSONValue.object(["at": .string("lifeos"), "table": .string("docs"), "id": .string("d1")])

private func body(_ text: String) -> String {
    #"[{\"content\":[{\"styles\":{},\"text\":\"\#(text)\",\"type\":\"text\"}],\"type\":\"paragraph\"}]"#
}

private func row(_ id: String, at: Int, resolved: Bool = false, deleted: Bool = false, quote: String? = nil, comments: String) -> String {
    let quoted = quote.map { #""quote":"\#($0)","# } ?? ""
    return #"{"thread":{"publicId":"\#(id)",\#(quoted)"resolved":\#(resolved),"resolvedAt":null,"resolvedByMemberId":null,"createdAt":\#(at),"updatedAt":\#(at),"deletedAt":\#(deleted ? "5" : "null")},"comments":[\#(comments)]}"#
}

private func comment(_ id: String, by: String, at: Int, text: String, deleted: Bool = false) -> String {
    #"{"publicId":"\#(id)","body":"\#(body(text))","authorMemberId":"\#(by)","reactions":[],"createdAt":\#(at),"updatedAt":\#(at),"deletedAt":\#(deleted ? "9" : "null")}"#
}

private let threads = #"{"rows":["#
    + [
        row("t-resolved", at: 10, resolved: true, comments: comment("c1", by: "owner", at: 10, text: "Done")),
        row("t-new", at: 30, comments: comment("c2", by: "agent:h1:s1", at: 30, text: "Shorter?")),
        row("t-old", at: 20, quote: "the budget", comments: [comment("c3", by: "external:Sam", at: 20, text: "Is this right?"), comment("c4", by: "lifeos:u9", at: 25, text: "Yes"), comment("c5", by: "owner", at: 26, text: "gone", deleted: true)].joined(separator: ",")),
        row("t-deleted", at: 5, deleted: true, comments: comment("c6", by: "owner", at: 5, text: "x"))
    ].joined(separator: ",")
    + #"],"names":{"owner":"Landon","agent:h1:s1":"Budget thread","external:Sam":"Sam"}}"#

private let branches = #"{"branches":["#
    + #"{"id":"b1","baseVersionId":"v1","authors":["agent:h1:s1"],"label":"Tighter intro","at":100,"editedAt":110,"diff":{"stats":{"same":3,"added":1,"removed":0,"changed":1,"moved":0},"rows":["#
    + #"{"kind":"changed","id":"k1","left":{"text":"Old words"},"right":{"text":"New words"}},"#
    + #"{"kind":"added","id":"k2","right":{"text":"A new line"}}],"lines":[]}},"#
    + #"{"id":"b2","baseVersionId":"v1","authors":["agent:h1:s2"],"label":"","at":200,"editedAt":200,"diff":{"stats":{"same":4,"added":0,"removed":1,"changed":0,"moved":0},"rows":["#
    + #"{"kind":"removed","id":"k3","left":{"text":"Cut this"}}],"lines":[]}}"#
    + #"],"names":{"agent:h1:s1":"Budget thread"}}"#

/// `branches` after the host took k1: b1 is rewritten, so its `editedAt` moves (history/privateBranches.ts).
private let branchesAfterK1 = branches
    .replacingOccurrences(of: #"{"kind":"changed","id":"k1","left":{"text":"Old words"},"right":{"text":"New words"}},"#, with: "")
    .replacingOccurrences(of: #""editedAt":110"#, with: #""editedAt":111"#)

/// Only b2's block added since, as the host lists it after Accept All took the rest.
private let branchesOnlyK4 = #"{"branches":[{"id":"b2","authors":["agent:h1:s2"],"label":"","at":200,"editedAt":201,"diff":{"rows":[{"kind":"added","id":"k4","right":{"text":"Added since"}}]}}],"names":{}}"#

/// `branches` after the agent added a block to b2.
private let branchesGrown = branches.replacingOccurrences(of: #"{"kind":"removed","id":"k3","left":{"text":"Cut this"}}"#, with: #"{"kind":"removed","id":"k3","left":{"text":"Cut this"}},{"kind":"added","id":"k4","right":{"text":"Added since"}}"#)

private func suggestion(_ id: String, set: String, row: Int, col: Int, base: String, proposed: String, state: String = "pending", reason: String? = nil) -> String {
    let why = reason.map { #","reason":"\#($0)""# } ?? ""
    return #"{"id":"\#(id)","changeSet":"\#(set)","by":"agent:h1:s1","sheet":"sheet1","row":\#(row),"col":\#(col),"base":\#(base),"proposed":\#(proposed),"state":"\#(state)"\#(why)}"#
}

private func sheet(_ suggestions: [String]) -> String {
    #"{"itemId":"i1","sessionId":"s1","name":"Budget","store":"lifeos","rev":7,"shared":false,"mode":"suggests","suggestions":[\#(suggestions.joined(separator: ","))],"charts":[]}"#
}

private let s1 = suggestion("g1", set: "cs1", row: 3, col: 2, base: #"{"v":100}"#, proposed: #"{"v":120}"#, reason: "Q3 grew")
private let s2 = suggestion("g2", set: "cs1", row: 4, col: 2, base: "null", proposed: #"{"f":"=SUM(C1:C4)"}"#, reason: "Q3 grew")
private let s3 = suggestion("g3", set: "cs2", row: 0, col: 26, base: #"{"v":"Draft"}"#, proposed: #"{"v":true}"#, state: "conflict")

@Suite(.serialized) @MainActor struct ReaderReviewTests {
    @Test func `comments read open threads first, each oldest first, with the host's names`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let comments = WorkComments(work: rig.work, source: doc)
        let load = Task { await comments.load() }
        let read = try #require(await rig.next(fake, "work.docs.threads"))
        #expect(read.params == .object(["source": docJSON]))
        fake.answer(id: read.id, result: threads)
        await load.value
        #expect(comments.loaded)
        #expect(comments.failure == nil)
        #expect(comments.open.map(\.id) == ["t-old", "t-new"])
        #expect(comments.resolved.map(\.id) == ["t-resolved"])
        let first = try #require(comments.open.first)
        #expect(first.quote == "the budget")
        // A deleted comment is left out; a principal with no name reads as itself.
        #expect(first.comments == [Comment(id: "c3", author: "Sam", at: 20, body: "Is this right?"), Comment(id: "c4", author: "lifeos:u9", at: 25, body: "Yes")])
        #expect(comments.open.last?.comments.first?.author == "Budget thread")
    }

    @Test func `a post, a reply and a resolve each send their change, then read again`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let comments = WorkComments(work: rig.work, source: doc)

        let post = Task { try await comments.post(body: "Looks good", quote: "the budget") }
        let create = try #require(await rig.next(fake, "work.docs.thread"))
        #expect(create.params == .object(["source": docJSON, "change": .object(["op": .string("create"), "body": .string(CommentBody.blocks("Looks good")), "quote": .string("the budget")])]))
        fake.answer(id: create.id, result: #"{"ok":true}"#)
        let reread = try #require(await rig.next(fake, "work.docs.threads"))
        fake.answer(id: reread.id, result: threads)
        try await post.value
        #expect(comments.open.count == 2)

        let reply = Task { try await comments.reply(to: "t-old", body: "Thanks") }
        let sent = try #require(await rig.next(fake, "work.docs.thread"))
        #expect(sent.params == .object(["source": docJSON, "change": .object(["op": .string("reply"), "threadId": .string("t-old"), "body": .string(CommentBody.blocks("Thanks"))])]))
        fake.answer(id: sent.id, result: #"{"ok":true}"#)
        fake.answer(id: try #require(await rig.next(fake, "work.docs.threads")).id, result: threads)
        try await reply.value

        let resolve = Task { try await comments.resolve("t-old", true) }
        let resolved = try #require(await rig.next(fake, "work.docs.thread"))
        #expect(resolved.params == .object(["source": docJSON, "change": .object(["op": .string("resolve"), "threadId": .string("t-old"), "resolved": .bool(true)])]))
        fake.answer(id: resolved.id, result: #"{"ok":true}"#)
        fake.answer(id: try #require(await rig.next(fake, "work.docs.threads")).id, result: threads)
        try await resolve.value
    }

    @Test func `a failed post throws the host's words and leaves the threads as they were`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let comments = WorkComments(work: rig.work, source: doc)
        let load = Task { await comments.load() }
        fake.answer(id: try #require(await rig.next(fake, "work.docs.threads")).id, result: threads)
        await load.value
        let before = comments.open

        let post = Task { try await comments.post(body: "Hello", quote: nil) }
        let create = try #require(await rig.next(fake, "work.docs.thread"))
        // No quote: the field is left out.
        #expect(create.params == .object(["source": docJSON, "change": .object(["op": .string("create"), "body": .string(CommentBody.blocks("Hello"))])]))
        fake.refuse(id: create.id, error: "LifeOS is not signed in on this host")
        await #expect(throws: ActionError.refused(message: "LifeOS is not signed in on this host", forbidden: false)) { try await post.value }
        #expect(comments.open == before)
        #expect(comments.failure == nil)
    }

    @Test func `a work.docs push moves rev for its document, a file's named by the host's open`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let comments = WorkComments(work: rig.work, source: doc)
        #expect(comments.rev == 0)
        fake.deliver(#"{"push":"work.docs","doc":"d1","threads":true}"#)
        #expect(await rig.until { comments.rev == 1 })
        fake.deliver(#"{"push":"work.docs","doc":"d2","threads":true}"#)
        #expect(await rig.until { rig.work.docsRev["d2"] == 1 })
        #expect(comments.rev == 1)

        // A .tcdoc's name in the service is the host's: the first load asks `work.docs.open` for it.
        let file = CanvasSource.file(FileSource(host: "env_test", path: "/w/Plan.tcdoc"))
        let review = WorkReview(work: rig.work, subject: .document(file))
        let load = Task { await review.load() }
        let open = try #require(await rig.next(fake, "work.docs.open"))
        fake.answer(id: open.id, result: #"{"doc":"file:abc","source":{"at":"file","host":"env_test","path":"/w/Plan.tcdoc"},"title":"Plan","role":"edit","shared":false,"mode":"suggests","written":null,"me":"owner","names":{}}"#)
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: #"{"branches":[],"names":{}}"#)
        await load.value
        #expect(review.loaded)
        #expect(review.words == "0 changes")
        fake.deliver(#"{"push":"work.docs","doc":"file:abc","branches":true}"#)
        #expect(await rig.until { review.rev == 1 })
    }

    @Test func `a document's review: a row per block, one decided, then the rest per branch with a refusal kept`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .document(doc))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.history.branches"))
        #expect(read.params == .object(["source": docJSON]))
        fake.answer(id: read.id, result: branches)
        await load.value
        #expect(review.rows.map(\.id) == ["b1/k1", "b1/k2", "b2/k3"])
        #expect(review.rows.map(\.kind) == [.block(old: "Old words", new: "New words"), .block(old: "", new: "A new line"), .block(old: "Cut this", new: "")])
        #expect(review.rows.map(\.reason) == ["Tighter intro", "Tighter intro", nil])
        #expect(review.rows.allSatisfy { $0.group == nil })
        #expect(review.words == "3 changes")
        // Each row carries its branch as he read it: a decision sends it back (`editedAt`).
        #expect(review.rows.map(\.revision) == [110, 110, 200])
        #expect(ReviewBatch.of(review.rows).map(\.editedAt) == [110, 200])

        let one = Task { await review.decide(review.rows[0], accept: true) }
        let decide = try #require(await rig.next(fake, "work.history.decide"))
        #expect(decide.params == .object(["source": docJSON, "branchId": .string("b1"), "which": .array([.string("k1")]), "accept": .bool(true), "editedAt": .number(110)]))
        fake.answer(id: decide.id, result: #"{"left":1}"#)
        // Taking k1 rewrote b1 (its `editedAt` moved, as the host does): the branches are read again before he goes on.
        let again = try #require(await rig.next(fake, "work.history.branches"))
        fake.answer(id: again.id, result: branchesAfterK1)
        #expect(await one.value)
        #expect(review.rows.map(\.id) == ["b1/k2", "b2/k3"])
        #expect(review.rows.map(\.revision) == [111, 200])

        let all = Task { await review.decideAll(accept: false) }
        let first = try #require(await rig.next(fake, "work.history.decide"))
        // Every row he sees, by its own id: never the host's "all", which would take a block added since; with the
        // branch as the host now has it.
        #expect(first.params == .object(["source": docJSON, "branchId": .string("b1"), "which": .array([.string("k2")]), "accept": .bool(false), "editedAt": .number(111)]))
        fake.answer(id: first.id, result: #"{"left":0}"#)
        let second = try #require(await rig.next(fake, "work.history.decide"))
        #expect(second.params == .object(["source": docJSON, "branchId": .string("b2"), "which": .array([.string("k3")]), "accept": .bool(false), "editedAt": .number(200)]))
        fake.refuse(id: second.id, error: "LifeOS is not signed in on this host")
        // b1 was taken: read again, and the refusal stays on b2's row.
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branchesAfterK1.replacingOccurrences(of: #"{"kind":"added","id":"k2","right":{"text":"A new line"}}"#, with: ""))
        #expect(await all.value == false)
        #expect(review.rows.map(\.id) == ["b2/k3"])
        #expect(review.rows.first?.refusal == "LifeOS is not signed in on this host")
        #expect(review.words == "1 change")
    }

    @Test func `Accept All sends the rows on screen when he pressed, though a push reads a branch again between two calls`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .document(doc))
        let load = Task { await review.load() }
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branches)
        await load.value

        let all = Task { await review.decideAll(accept: true) }
        let first = try #require(await rig.next(fake, "work.history.decide"))
        #expect(first.params == .object(["source": docJSON, "branchId": .string("b1"), "which": .array([.string("k1"), .string("k2")]), "accept": .bool(true), "editedAt": .number(110)]))
        // While the first call waits, a push reads the branches again: the agent added k4 to b2.
        let reload = Task { await review.load() }
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branchesGrown)
        await reload.value
        #expect(review.rows.map(\.id) == ["b1/k1", "b1/k2", "b2/k3", "b2/k4"])
        fake.answer(id: first.id, result: #"{"left":0}"#)
        let second = try #require(await rig.next(fake, "work.history.decide"))
        #expect(second.params == .object(["source": docJSON, "branchId": .string("b2"), "which": .array([.string("k3")]), "accept": .bool(true), "editedAt": .number(200)]))
        fake.answer(id: second.id, result: #"{"left":1}"#)
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branchesOnlyK4)
        #expect(await all.value)
        #expect(review.rows.map(\.id) == ["b2/k4"], "the block added since waits for him")
    }

    @Test func `while one decision runs, another sends nothing`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .document(doc))
        let load = Task { await review.load() }
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branches)
        await load.value

        let one = Task { await review.decide(review.rows[0], accept: false) }
        let sent = try #require(await rig.next(fake, "work.history.decide"))
        #expect(review.deciding)
        let calls = fake.sentRequests.count
        #expect(await review.decide(review.rows[1], accept: false) == false)
        #expect(await review.decideAll(accept: true) == false)
        #expect(fake.sentRequests.count == calls)
        #expect(review.deciding, "the second press does not end the first's")
        #expect(review.rows.allSatisfy { $0.refusal == nil })
        fake.answer(id: sent.id, result: #"{"left":1}"#)
        fake.answer(id: try #require(await rig.next(fake, "work.history.branches")).id, result: branchesAfterK1)
        #expect(await one.value)
        #expect(!review.deciding)
        #expect(review.rows.map(\.id) == ["b1/k2", "b2/k3"])
    }

    @Test func `a sheet's review: a row per open cell, its refusal kept on the row, then all`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .sheet(itemId: "i1"))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.sheets.open"))
        #expect(read.params == .object(["itemId": .string("i1")]))
        fake.answer(id: read.id, result: sheet([s1, s2, s3]))
        await load.value
        #expect(review.rows.map(\.id) == ["g1", "g2", "g3"])
        #expect(review.rows.map(\.kind) == [.cell(address: "C4", old: "100", new: "120"), .cell(address: "C5", old: "", new: "=SUM(C1:C4)"), .cell(address: "AA1", old: "Draft", new: "TRUE")])
        #expect(review.rows.map(\.group) == ["cs1", "cs1", "cs2"])
        #expect(review.rows.map(\.reason) == ["Q3 grew", "Q3 grew", nil])
        // A cell the host found changed since says so before any press, and only Reject takes it.
        #expect(review.rows.map(\.accepts) == [true, true, false])
        #expect(review.rows[2].refusal == WorkReview.conflictWords)

        // A cell the host found changed since is never sent for Accept: the row stays with its words.
        let sentBefore = fake.sentRequests.count
        #expect(await review.decide(review.rows[2], accept: true) == false)
        #expect(fake.sentRequests.count == sentBefore)
        #expect(review.rows.count == 3)
        #expect(review.rows[2].refusal == "That cell changed since the agent saw it: reject it, or edit the cell yourself.")
        #expect(review.acceptsAny)

        // A decision the host takes drops its row; a refusal on another row stays.
        let one = Task { await review.decide(review.rows[0], accept: false) }
        let second = try #require(await rig.next(fake, "work.sheets.review"))
        #expect(second.params == .object(["itemId": .string("i1"), "which": .object(["ids": .array([.string("g1")])]), "verdict": .string("reject")]))
        fake.answer(id: second.id, result: sheet([s2, s3]))
        #expect(await one.value)
        #expect(review.rows.map(\.id) == ["g2", "g3"])
        #expect(review.rows[1].refusal != nil)

        let all = Task { await review.decideAll(accept: true) }
        let third = try #require(await rig.next(fake, "work.sheets.review"))
        // The cells on his screen that Accept can take, by id: the conflicted one is not sent. A change set the
        // agent added since stays open, and shows next.
        #expect(third.params == .object(["itemId": .string("i1"), "which": .object(["ids": .array([.string("g2")])]), "verdict": .string("accept")]))
        fake.answer(id: third.id, result: sheet([s3, suggestion("g9", set: "cs3", row: 7, col: 0, base: "null", proposed: #"{"v":"Added since"}"#, state: "pending")]))
        #expect(await all.value)
        #expect(review.rows.map(\.id) == ["g3", "g9"])

        fake.deliver(#"{"push":"work.sheets","sessionId":"s1","itemId":"i1","rev":8}"#)
        #expect(await rig.until { review.rev == 1 })
    }

    @Test func `Accept All on a sheet that the host refuses part of reads the sheet again: the words stay only on rows still open`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .sheet(itemId: "i1"))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.sheets.open"))
        fake.answer(id: read.id, result: sheet([s1, s2]))
        await load.value
        let all = Task { await review.decideAll(accept: true) }
        let press = try #require(await rig.next(fake, "work.sheets.review"))
        #expect(press.params == .object(["itemId": .string("i1"), "which": .object(["ids": .array([.string("g1"), .string("g2")])]), "verdict": .string("accept")]))
        // The host wrote g1, found g2 changed, and refused.
        fake.refuse(id: press.id, error: "That cell changed since the agent saw it: reject it, or edit the cell yourself.")
        let again = try #require(await rig.next(fake, "work.sheets.open"))
        fake.answer(id: again.id, result: sheet([suggestion("g2", set: "cs1", row: 4, col: 2, base: "null", proposed: #"{"f":"=SUM(C1:C4)"}"#, state: "conflict")]))
        #expect(await all.value == false)
        #expect(review.rows.map(\.id) == ["g2"])
        #expect(review.rows[0].refusal == "That cell changed since the agent saw it: reject it, or edit the cell yourself.")
        #expect(!review.rows[0].accepts)
        // With only a conflicted row left, Accept All is not offered, and a press sends nothing.
        #expect(!review.acceptsAny)
        let sent = fake.sentRequests.count
        #expect(await review.decideAll(accept: true) == false)
        #expect(fake.sentRequests.count == sent)
    }

    @Test func `a sheet with only a proposed format and rule has rows for them, decided by their own ids`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .sheet(itemId: "i1"))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.sheets.open"))
        let changes = #"[{"id":"c1","changeSet":"cs9","by":"agent:h1:s1","kind":"format","sheet":"sheet1","range":{"startRow":1,"endRow":8,"startColumn":1,"endColumn":1},"words":"Bold, yellow fill on B2:B9","state":"pending","reason":"Mark the totals"},{"id":"c2","changeSet":"cs9","by":"agent:h1:s1","kind":"rule","sheet":"sheet1","range":null,"words":"Red text where C2:C9 is below 0","state":"orphaned"}]"#
        fake.answer(id: read.id, result: sheet([]).replacingOccurrences(of: #""charts":[]"#, with: #""charts":[],"changes":\#(changes)"#))
        await load.value
        #expect(review.count == 2)
        #expect(review.rows.map(\.kind) == [.block(old: "", new: "Bold, yellow fill on B2:B9"), .block(old: "", new: "Red text where C2:C9 is below 0")])
        #expect(review.rows.map(\.accepts) == [true, false])
        #expect(review.rows[1].refusal == WorkReview.orphanedChangeWords)
        let all = Task { await review.decideAll(accept: true) }
        let press = try #require(await rig.next(fake, "work.sheets.review"))
        #expect(press.params == .object(["itemId": .string("i1"), "which": .object(["ids": .array([.string("c1")])]), "verdict": .string("accept")]))
        fake.answer(id: press.id, result: sheet([]))
        #expect(await all.value)
        #expect(review.rows.isEmpty)
    }

    @Test func `a host from before review on the phone has no rows and is asked once a socket`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .sheet(itemId: "i1"))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.sheets.open"))
        fake.refuse(id: read.id, error: unknownMethod)
        await load.value
        #expect(!review.loaded)
        #expect(review.failure == nil)
        #expect(!rig.work.can.has("work.sheets.open"))
        let sent = fake.sentRequests.count
        await review.load()
        #expect(fake.sentRequests.count == sent)
    }

    @Test func `a slower, older read never overwrites a newer one`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .sheet(itemId: "i1"))
        let older = Task { await review.load() }
        let first = try #require(await rig.next(fake, "work.sheets.open"))
        let newer = Task { await review.load() }
        let second = try #require(await rig.next(fake, "work.sheets.open"))
        fake.answer(id: second.id, result: sheet([s1, s2]))
        await newer.value
        fake.answer(id: first.id, result: sheet([s1]))
        await older.value
        #expect(review.rows.map(\.id) == ["g1", "g2"])
    }

    @Test func `a document's Page Preview is its Word file drawn on the host, read at the rev the host named`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let memo = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i7","sessionId":"s1","workspaceId":"w1","kind":"document","title":"Travel memo","source":{"at":"lifeos","table":"docs","id":"d1"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        let source = try #require(rig.work.canvas.preview(for: memo))
        let rev = String(repeating: "a", count: 32)
        let read = Task { try await source.data() }
        let draw = try #require(await rig.next(fake, "work.formats.preview"))
        #expect(draw.params == .object(["source": docJSON, "itemId": .string("i7"), "format": .string("docx")]))
        fake.answer(id: draw.id, result: #"{"rev":"\#(rev)","size":6,"pages":2,"drawnBy":"libreoffice","name":"Travel memo.docx","warnings":[]}"#)
        let frame = try #require(await rig.next(fake, "work.formats.previewRead"))
        #expect(frame.params == .object(["source": docJSON, "itemId": .string("i7"), "rev": .string(rev), "offset": .number(0), "length": .number(6)]))
        fake.answer(id: frame.id, result: #"{"data":"\#(Data("abcdef".utf8).base64EncodedString())"}"#)
        #expect(String(decoding: try await read.value, as: UTF8.self) == "abcdef")
        // A sheet has no pages here yet, and a host from before Preview loses the row for the session.
        let budget = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i8","sessionId":"s1","workspaceId":"w1","kind":"sheet","title":"Budget","source":{"at":"lifeos","table":"sheets","id":"k1"},"state":"open","position":1,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        #expect(rig.work.canvas.preview(for: budget) == nil)
        let again = Task { try? await source.data() }
        let refused = try #require(await rig.next(fake, "work.formats.preview"))
        fake.refuse(id: refused.id, error: unknownMethod)
        _ = await again.value
        #expect(rig.work.canvas.preview(for: memo) == nil)
    }

    @Test func `a file moved on the host is read and written at its new path, never the old one`() throws {
        let item = { (path: String) in
            try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i9","sessionId":"s1","workspaceId":"w1","kind":"document","title":"Trip","source":{"at":"file","host":"env_box","path":"\#(path)"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        }
        let opened = try item("/w/Trip.tcdoc")
        let moved = try item("/w/Trip 2.tcdoc")
        // Until the host has pushed a list, the page's own item stands.
        #expect(ReaderFile.current(opened, in: nil) == opened)
        // The push carries the new path: the reader takes it, and it is a different reader from the one at the old path.
        #expect(ReaderFile.current(opened, in: [moved]) == moved)
        #expect(ReaderFile.Identity(opened) != ReaderFile.Identity(moved))
        // A list that no longer holds the item (he closed it, its tab went) fails closed: the page acts on nothing.
        #expect(ReaderFile.live(opened, in: []) == nil)
        #expect(ReaderFile.live(opened, in: nil) == opened)
        #expect(ReaderFile.live(opened, in: [moved]) == moved)
        let closed = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i9","sessionId":"s1","workspaceId":"w1","kind":"document","title":"Trip","source":{"at":"file","host":"env_box","path":"/w/Trip.tcdoc"},"state":"closed","position":0,"rev":2,"createdAt":1,"updatedAt":2}"#.utf8))
        #expect(ReaderFile.live(opened, in: [closed]) == nil)
        // The page closes on a list that held the item and then does not; a list not heard yet closes nothing.
        #expect(ReaderFile.presence(opened, in: nil) == .unheard)
        #expect(ReaderFile.presence(opened, in: [moved]) == .listed)
        #expect(ReaderFile.presence(opened, in: [closed]) == .gone)
        #expect(ReaderFile.presence(opened, in: []) == .gone)
        // Ask's chip for picked words names the live item's path, never the one the page opened with.
        guard case .canvasSource(let chipSource) = ChipWords.selection(in: ReaderFile.current(opened, in: [moved]), quote: "Page 6").ref else { Issue.record("no source"); return }
        #expect(chipSource == moved.source)
        #expect(ChipWords.message([ChipWords.selection(in: ReaderFile.current(opened, in: [moved]), quote: "Page 6")], text: "what changed?").contains("Trip 2.tcdoc"))

        guard case .document(let source)? = ReaderFile.parts(ReaderFile.current(opened, in: [moved])).review else { Issue.record("no review"); return }
        #expect(source == moved.source)
        // A Word file is no source of the docs pillar's: no comments or review are asked for it.
        let letter = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i10","sessionId":"s1","workspaceId":"w1","kind":"document","title":"Letter","source":{"at":"file","host":"env_box","path":"/w/Letter.docx"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        #expect(ReaderFile.parts(letter).review == nil)
        #expect(ReaderFile.parts(letter).comments == nil)
    }

    @Test func `a list held from before is read again, and an item it lacked is listed`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let item = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i9","sessionId":"pane1","workspaceId":"w1","kind":"document","title":"Budget","source":{"at":"file","host":"env_box","path":"/w/Budget.tcdoc"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        // A push from before the phone was away, without the item the desktop opened since.
        fake.deliver(#"{"push":"work.canvas","sessionId":"pane1","items":[]}"#)
        #expect(await rig.until { rig.work.canvas.items["pane1"] != nil })
        #expect(ReaderFile.presence(item, in: rig.work.canvas.items["pane1"]) == .gone)
        // The page reads its list once as it shows.
        let load = Task { await rig.work.canvas.load("pane1") }
        let list = try #require(await rig.next(fake, "work.canvas.list"))
        #expect(list.params == .object(["sessionId": .string("pane1")]))
        fake.answer(id: list.id, result: #"{"items":[{"id":"i9","sessionId":"pane1","workspaceId":"w1","kind":"document","title":"Budget","source":{"at":"file","host":"env_box","path":"/w/Budget.tcdoc"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}]}"#)
        await load.value
        #expect(ReaderFile.presence(item, in: rig.work.canvas.items["pane1"]) == .listed)
        #expect(ReaderFile.live(item, in: rig.work.canvas.items["pane1"]) == item)
    }

    @Test func `Page Preview of a moved file draws the new path, never the old one`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let item = { (path: String) in
            try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i9","sessionId":"s1","workspaceId":"w1","kind":"document","title":"Trip","source":{"at":"file","host":"env_box","path":"\#(path)"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        }
        let shown = ReaderFile.current(try item("/w/Trip.tcdoc"), in: [try item("/w/Trip 2.tcdoc")])
        let source = try #require(rig.work.canvas.preview(for: shown))
        let read = Task { try? await source.data() }
        let draw = try #require(await rig.next(fake, "work.formats.preview"))
        #expect(draw.params == .object(["source": .object(["at": .string("file"), "host": .string("env_box"), "path": .string("/w/Trip 2.tcdoc")]), "itemId": .string("i9"), "format": .string("docx")]))
        fake.refuse(id: draw.id, error: "no LibreOffice here")
        _ = await read.value
    }

    @Test func `a block an agent rewrote since he read it is refused, and the row keeps the host's words`() async throws {
        let rig = try ReaderRig()
        let fake = await rig.open()
        let review = WorkReview(work: rig.work, subject: .document(doc))
        let load = Task { await review.load() }
        let read = try #require(await rig.next(fake, "work.history.branches"))
        fake.answer(id: read.id, result: branches)
        await load.value
        let press = Task { await review.decide(review.rows[0], accept: true) }
        let decide = try #require(await rig.next(fake, "work.history.decide"))
        #expect(decide.params == .object(["source": docJSON, "branchId": .string("b1"), "which": .array([.string("k1")]), "accept": .bool(true), "editedAt": .number(110)]))
        fake.refuse(id: decide.id, error: "The suggestion changed since it was shown: look at it again before deciding.")
        #expect(await press.value == false)
        #expect(review.rows[0].refusal == "The suggestion changed since it was shown: look at it again before deciding.")
    }

    @Test func `a cell's address reads as Excel writes it`() {
        #expect(CellAddress.column(0) == "A")
        #expect(CellAddress.column(25) == "Z")
        #expect(CellAddress.column(26) == "AA")
        #expect(CellAddress.column(701) == "ZZ")
        #expect(CellAddress.column(702) == "AAA")
        #expect(CellAddress.of(sheet: "Budget", row: 3, col: 2) == "Budget!C4")
        #expect(CellAddress.of(sheet: "Q1 Budget", row: 0, col: 0) == "'Q1 Budget'!A1")
        #expect(CellAddress.of(sheet: "Bob's", row: 9, col: 27) == "'Bob''s'!AB10")
        #expect(CellAddress.of(sheet: "2024", row: 0, col: 1) == "'2024'!B1")
        #expect(CellAddress.of(sheet: nil, row: 3, col: 2) == "C4")
    }

    @Test func `a cell reads as he would type it, and a comment body as words`() {
        #expect(WorkReview.cellWords(SheetCellPhone(v: .number(12))) == "12")
        #expect(WorkReview.cellWords(SheetCellPhone(v: .number(1.5))) == "1.5")
        #expect(WorkReview.cellWords(SheetCellPhone(v: .bool(false))) == "FALSE")
        #expect(WorkReview.cellWords(SheetCellPhone(v: .number(3), f: "SUM(A1:A2)")) == "=SUM(A1:A2)")
        #expect(WorkReview.cellWords(nil) == "")
        #expect(CommentBody.blocks("One") == #"[{"content":[{"styles":{},"text":"One","type":"text"}],"type":"paragraph"}]"#)
        #expect(CommentBody.plain(CommentBody.blocks("One\n\nTwo")) == "One\n\nTwo")
        #expect(CommentBody.plain(#"[{"type":"paragraph","content":[{"type":"text","text":"See "},{"type":"link","href":"https://x","content":[{"type":"text","text":"this"}]}]}]"#) == "See this")
        #expect(CommentBody.plain("plain words") == "plain words")
    }
}

struct ReviewGroupTests {
    @Test func `Accept All's calls: a batch per branch, in order, each with its blocks and its rows`() {
        let rows = [
            ReviewRow(id: "b1/x", kind: .block(old: "a", new: "b"), group: nil, reason: nil, refusal: nil, branch: "b1", target: "x"),
            ReviewRow(id: "b2/y", kind: .block(old: "c", new: "d"), group: nil, reason: nil, refusal: nil, branch: "b2", target: "y"),
            ReviewRow(id: "b1/z", kind: .block(old: "", new: "e"), group: nil, reason: nil, refusal: nil, branch: "b1", target: "z"),
            ReviewRow(id: "g1", kind: .cell(address: "A1", old: "", new: "1"))
        ]
        #expect(ReviewBatch.of(rows) == [
            ReviewBatch(branch: "b1", targets: ["x", "z"], ids: ["b1/x", "b1/z"]),
            ReviewBatch(branch: "b2", targets: ["y"], ids: ["b2/y"])
        ])
        #expect(ReviewBatch.of([]).isEmpty)
    }

    @Test func `the changes that came together sit under one heading, in the host's order`() {
        let rows = [
            ReviewRow(id: "a", kind: .cell(address: "C4", old: "120", new: "180"), group: "set1", reason: "Bus quote came in higher"),
            ReviewRow(id: "b", kind: .cell(address: "C5", old: "40", new: "60"), group: "set1", reason: "Bus quote came in higher"),
            ReviewRow(id: "c", kind: .cell(address: "D2", old: "", new: "Paid"), group: "set2", reason: nil)
        ]
        let groups = ReviewGroup.of(rows)
        #expect(groups.map(\.rows.count) == [2, 1])
        #expect(groups.map(\.heading) == ["Bus quote came in higher", nil])
    }

    @Test func `a document's branch heads its blocks with its label, never with a restore's time`() {
        let rows = [
            ReviewRow(id: "b1/x", kind: .block(old: "Leave at 8.", new: "Leave at 7:30."), reason: "Tightened the schedule"),
            ReviewRow(id: "b1/y", kind: .block(old: "", new: "Bring badges."), reason: "Tightened the schedule"),
            ReviewRow(id: "b2/z", kind: .block(old: "Old", new: "New"), reason: "Restore 1763900000000")
        ]
        let groups = ReviewGroup.of(rows)
        #expect(groups.count == 2)
        #expect(groups[0].heading == "Tightened the schedule")
        #expect(groups[1].heading == nil)
        // The host's own name for a branch with no reason is not one.
        #expect(ReviewGroup.of([ReviewRow(id: "b3/q", kind: .block(old: "a", new: "b"), reason: "Suggestions")]).first?.heading == nil)
    }
}

struct DraftTargetTests {
    @Test func `an empty field follows a tap; words in it keep their thread`() {
        #expect(DraftTarget.moved(nil, to: "t1", draft: "") == "t1")
        #expect(DraftTarget.moved("t1", to: "t2", draft: "  \n") == "t2", "blank space is no draft")
        #expect(DraftTarget.moved("t1", to: "t2", draft: "Agreed") == "t1")
        #expect(DraftTarget.moved(nil, to: "t2", draft: "A new point") == nil, "a new comment's words stay a new comment")
    }

    @Test func `the thread he replies to resolved: an empty field turns to a new comment, words stay a reply`() {
        #expect(DraftTarget.moved("t1", to: nil, draft: "") == nil)
        #expect(DraftTarget.moved("t1", to: nil, draft: "One more thing") == "t1")
    }
}
