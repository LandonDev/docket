import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Today's store (Work/Today/TodayReads.swift): the disk's rows on the first page, the fresh page as a diff that
/// keeps unchanged rows, reads only when a push or a link asks, a failed read that keeps what shows, and the drops.
@MainActor
struct TodayStoreTests {
    static let cal = TodayModelTests.cal
    static let now = TodayModelTests.at(24, 9, 41)
    static let key = WorkCache.Key(host: "box", account: "k1", keyGeneration: 1, scope: .today)
    static let day = TodayWords.localDay(now, cal)

    /// Answers each read from what it holds and counts them.
    final class FakeReads: TodayHostReads {
        var chats: [TodaySources.Chat] = []
        var chatsFail = false
        var made: [String] = []
        func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat] {
            made.append("chats:\(workspaceId)")
            if chatsFail { throw TestError.refused }
            return chats
        }
        func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed {
            made.append("owed")
            return try TodayRecode.as(TodaySources.Owed.self, ["rows": [JSONValue]()])
        }
        func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form] { [] }
        func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting] {
            made.append("prep")
            return []
        }
        func todayReview() async throws -> TodaySources.ReviewReady? { nil }
        func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange {
            made.append("clashes")
            return TodaySources.ClashRange(clashes: [], leaves: [])
        }
        func todayDigest() async { made.append("digest") }
    }

    enum TestError: Error { case refused }

    static func item(_ id: String, at: Int) -> OutboxItem {
        OutboxItem(ref: .host(.init(id: id)), kind: .mailSend, workspaceId: "ws-purdue", sessionId: "s1", sector: "purdue", summary: "Send to events booking: Ballroom for April 10", verb: "Send", account: nil, state: .held, payload: nil, createdAt: at, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: at)
    }

    static let purdue = WorkspaceMeta(id: "ws-purdue", name: "Purdue Esports", path: "/w/purdue", git: false, kind: .work, sector: "purdue", createdAt: 1)

    static func host(open: Bool = true, workOn: Bool = true, held: [OutboxItem] = [], loaded: Bool = true, revs: TodayHostInput.Revs = .init(), generation: Int = 1) -> TodayHostInput {
        var key = Self.key
        key.keyGeneration = generation
        return TodayHostInput(environmentId: "box", name: "Box", workOn: workOn, open: open, workspaces: [purdue], held: held, heldLoaded: loaded, tells: [], revs: revs, key: key)
    }

    /// The row the held item makes, as it was kept on the disk.
    static func keptRow(_ item: OutboxItem) -> TodayRow {
        WorkCache.today(TodaySources.heldRows([.init(environmentId: "box", item: item)], now: now, names: [TodayPlace(environmentId: "box", workspaceId: "ws-purdue"): "Purdue Esports"], calendar: cal))[0]
    }

    func store(_ cache: TodayBookCache, reads: FakeReads = FakeReads()) -> TodayStore {
        let store = TodayStore(cache: cache, calendar: Self.cal, now: Self.now)
        store.readsOf = { _ in reads }
        return store
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    @Test func `the first page is the disk's rows, before any read answers`() {
        let held = Self.item("h1", at: Int(Self.now) - 60_000)
        var book = WorkCacheBook()
        book.put(.todayRows([Self.keptRow(held)], day: Self.day), at: Self.key)
        let store = store(TodayBookCache(book: book))
        store.update(hosts: [Self.host(loaded: false)])
        #expect(TodayStore.rows(store.page).map(\.key) == ["held:box:host:h1"])
        #expect(store.cached)
        // A cached row opens its thing; its verbs wait for the fresh one.
        #expect(!store.isFresh(TodayStore.rows(store.page)[0]))
        // Held rows alone give the Work list no line: the Outbox's row counts them.
        #expect(store.line == nil)
    }

    @Test func `the fresh page keeps each unchanged row as the value it was, and writes what changed`() async {
        let held = Self.item("h1", at: Int(Self.now) - 60_000)
        var book = WorkCacheBook()
        book.put(.todayRows([Self.keptRow(held)], day: Self.day), at: Self.key)
        let cache = TodayBookCache(book: book)
        let store = store(cache)
        store.update(hosts: [Self.host(loaded: false)])
        let first = TodayStore.rows(store.page)
        store.update(hosts: [Self.host(held: [held, Self.item("h2", at: Int(Self.now))])])
        let fresh = TodayStore.rows(store.page)
        #expect(fresh.map(\.key) == ["held:box:host:h1", "held:box:host:h2"])
        #expect(store.keptKeys.contains("held:box:host:h1"))
        #expect(!store.keptKeys.contains("held:box:host:h2"))
        #expect(fresh[0] == first[0])
        #expect(!store.cached)
        #expect(store.isFresh(fresh[1]))
        await settle()
        guard case .todayOn(_, let written)? = cache.book.get(Self.key) else { Issue.record("nothing written"); return }
        #expect(written.map(\.key).contains("held:box:host:h2"))
        #expect(written.allSatisfy { $0.acts.isEmpty })
    }

    @Test func `a host's lists are read once, then again only when its push moves the counter`() async {
        let reads = FakeReads()
        let store = store(TodayBookCache(), reads: reads)
        store.update(hosts: [Self.host()])
        await settle()
        let first = reads.made.count
        #expect(reads.made.contains("chats:ws-purdue"))
        #expect(reads.made.contains("prep"))
        #expect(reads.made.contains("clashes"))
        // The same inputs again: nothing is read.
        store.update(hosts: [Self.host()])
        await settle()
        #expect(reads.made.count == first)
        // A messages push for the job: that read alone.
        var revs = TodayHostInput.Revs()
        revs.messages["ws-purdue"] = 1
        store.update(hosts: [Self.host(revs: revs)])
        await settle()
        #expect(Array(reads.made.dropFirst(first)) == ["chats:ws-purdue"])
    }

    @Test func `an offline host is not read, and its link coming back reads it`() async {
        let reads = FakeReads()
        let store = store(TodayBookCache(), reads: reads)
        store.update(hosts: [Self.host(open: false)])
        await settle()
        #expect(!reads.made.contains("chats:ws-purdue"))
        store.update(hosts: [Self.host(open: true)])
        await settle()
        #expect(reads.made.contains("chats:ws-purdue"))
    }

    @Test func `a read that fails keeps the rows it had and says the host with Retry`() async {
        let reads = FakeReads()
        reads.chats = [TodaySources.Chat(chatId: "c1", chat: "Staff", who: "Dana", text: "Can you look?", at: Self.now - 60_000)]
        let store = store(TodayBookCache(), reads: reads)
        store.update(hosts: [Self.host()])
        await settle()
        #expect(TodayStore.rows(store.page).contains { $0.section == "messages" })
        reads.chatsFail = true
        var revs = TodayHostInput.Revs()
        revs.messages["ws-purdue"] = 1
        store.update(hosts: [Self.host(revs: revs)])
        await settle()
        #expect(TodayStore.rows(store.page).contains { $0.section == "messages" })
    }

    @Test func `the kept rows go when Work goes off, the host leaves or its key is paired again`() {
        var book = WorkCacheBook()
        book.put(.todayRows([TodayModelTests.row("held:box:host:h1")], day: Self.day), at: Self.key)
        let cache = TodayBookCache(book: book)
        let store = store(cache)
        store.update(hosts: [Self.host(loaded: false)])
        store.update(hosts: [Self.host(workOn: false)])
        #expect(cache.book.get(Self.key) == nil)

        cache.keepToday([Self.key: [TodayModelTests.row("held:box:host:h1")]], day: Self.day)
        store.update(hosts: [Self.host()])
        store.update(hosts: [Self.host(generation: 2)])
        #expect(cache.book.get(Self.key) == nil)

        cache.keepToday([Self.key: [TodayModelTests.row("held:box:host:h1")]], day: Self.day)
        store.update(hosts: [])
        #expect(cache.book.keys(host: "box").isEmpty)
    }

    @Test func `a ticked row leaves at once and Undo brings it back`() {
        let store = store(TodayBookCache())
        let held = Self.item("h1", at: Int(Self.now) - 60_000)
        store.update(hosts: [Self.host(held: [held])])
        #expect(TodayStore.rows(store.page).count == 1)
        store.hide("held:box:host:h1")
        #expect(TodayStore.rows(store.page).isEmpty)
        store.unhide("held:box:host:h1")
        #expect(TodayStore.rows(store.page).count == 1)
    }

    @Test func `a fold opened stays open and shows every row`() {
        let store = store(TodayBookCache())
        let items = (1...7).map { Self.item("h\($0)", at: Int(Self.now) - $0 * 60_000) }
        store.update(hosts: [Self.host(held: items)])
        #expect(TodayStore.rows(store.page).count == 5)
        store.unfold(TodayModel.foldKey(.more, "held"))
        #expect(TodayStore.rows(store.page).count == 7)
    }

    @Test func `the stable page keeps a row's value only while its facts are the same`() {
        var a = TodayModelTests.row("held:1", title: "One")
        a.acts = [TodayAct("Tomorrow", .tomorrow(sector: "purdue", taskId: "t"))]
        var b = a
        b.at = 5
        let section = TodayModel.fold(TodayModel.MergedSection(def: TodaySources.held, rows: [a]))
        let prev = TodayModel.Page.day(blocks: [.section(section)], offline: [], keys: [a.key])
        var moved = section
        moved.rows = [b]
        let (out, kept) = TodayStore.stable(.day(blocks: [.section(moved)], offline: [], keys: [b.key]), previous: prev)
        #expect(kept.isEmpty)
        #expect(TodayStore.rows(out) == [b])
        let (same, keptSame) = TodayStore.stable(prev, previous: prev)
        #expect(keptSame == [a.key])
        #expect(TodayStore.rows(same) == [a])
    }

    // MARK: - fix round 2

    /// Each host answers its own chats; `held` holds a host's reads until `release` lets them answer.
    final class HostReads: TodayHostReads {
        var chats: [TodaySources.Chat]
        var held = false
        var prepFails = false
        var relisted = 0
        func todayRelist() async { relisted += 1 }
        private var waiting: [CheckedContinuation<Void, Never>] = []
        init(chats: [TodaySources.Chat] = []) { self.chats = chats }
        func release() {
            held = false
            for one in waiting { one.resume() }
            waiting = []
        }
        func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat] {
            let answer = chats
            if held { await withCheckedContinuation { waiting.append($0) } }
            return answer
        }
        func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed { try TodayRecode.as(TodaySources.Owed.self, ["rows": [JSONValue]()]) }
        func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form] { [] }
        func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting] {
            if prepFails { throw TestError.refused }
            return []
        }
        func todayReview() async throws -> TodaySources.ReviewReady? { nil }
        func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange { .init(clashes: [], leaves: []) }
        func todayDigest() async {}
    }

    static func on(_ env: String, generation: Int = 1, open: Bool = true, loaded: Bool = true, tells: [TellRow]? = [], requests: [OutboxRequest] = [], held: [OutboxItem] = [], threads: [String: String] = [:], revoked: Bool = false) -> TodayHostInput {
        let workspace = WorkspaceMeta(id: "ws-\(env)", name: "Purdue (\(env))", path: "/w/\(env)", git: false, kind: .work, sector: "purdue", createdAt: 1)
        let key = WorkCache.Key(host: env, account: "k-\(env)", keyGeneration: generation, scope: .today)
        return TodayHostInput(environmentId: env, name: env, workOn: true, open: open, workspaces: [workspace], held: held, requests: requests, threads: threads, heldLoaded: loaded, tells: tells, key: key, revoked: revoked)
    }

    /// LifeOS answered every list, empty.
    static var emptyLife: TodayLifeInput {
        var life = TodayLifeInput(host: "box", reach: .ok)
        life.events = []
        life.tasks = []
        life.waits = []
        return life
    }

    func store(_ cache: TodayBookCache, by reads: [String: HostReads]) -> TodayStore {
        let store = TodayStore(cache: cache, calendar: Self.cal, now: Self.now)
        store.readsOf = { reads[$0] }
        return store
    }

    static func sections(_ page: TodayModel.Page?) -> [TodayModel.ShownSection] {
        guard case .day(let blocks, _, _)? = page else { return [] }
        return blocks.compactMap { if case .section(let s) = $0 { s } else { nil } }
    }

    @Test func `a Work host that has not linked this launch settles Held and Also and is named at the foot`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads(), "mac": HostReads()])
        store.update(hosts: [Self.on("box"), Self.on("mac", open: false, loaded: false, tells: nil)])
        store.update(life: Self.emptyLife)
        await settle()
        guard case .day(_, let offline, _)? = store.page else { Issue.record("no day"); return }
        #expect(offline == ["mac"])
        // No section is still out: Held said what it has and gave the Mac to the foot.
        #expect(Self.sections(store.page).allSatisfy { !$0.pending })
        // With the Mac back and listed, nothing is left: All clear.
        store.update(hosts: [Self.on("box"), Self.on("mac")])
        await settle()
        #expect(store.page == .clear(line: nil))
    }

    @Test func `a prep read that fails adds no line and keeps nothing from settling`() async {
        let reads = HostReads()
        reads.prepFails = true
        let store = store(TodayBookCache(), by: ["box": reads])
        store.update(hosts: [Self.on("box")])
        store.update(life: Self.emptyLife)
        await settle()
        #expect(store.page == .clear(line: nil))
    }

    @Test func `a revoked key's rows and answers go from memory and disk, and its late reply is refused`() async {
        let chat = { (env: String, at: Double) in TodaySources.Chat(chatId: "c-\(env)", chat: "Staff", who: "Dana", text: env, at: at) }
        let box = HostReads(chats: [chat("box", Self.now - 120_000)])
        let mac = HostReads(chats: [chat("mac", Self.now - 60_000)])
        let cache = TodayBookCache()
        let store = store(cache, by: ["box": box, "mac": mac])
        store.update(hosts: [Self.on("box"), Self.on("mac")])
        await settle()
        #expect(Set(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail)) == ["box", "mac"])
        #expect(!cache.book.keys(host: "mac").isEmpty)
        // The Mac's next read is held out, then its key is refused before it answers.
        mac.held = true
        var revs = TodayHostInput.Revs()
        revs.messages["ws-mac"] = 1
        var macMoved = Self.on("mac")
        macMoved.revs = revs
        store.update(hosts: [Self.on("box"), macMoved])
        await settle()
        var revoked = macMoved
        revoked.revoked = true
        store.update(hosts: [Self.on("box"), revoked])
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["box"])
        #expect(cache.book.keys(host: "mac").isEmpty)
        // The late answer lands nowhere, and nothing of the Mac is written again.
        mac.release()
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["box"])
        store.update(hosts: [Self.on("box", loaded: true), revoked])
        await settle()
        #expect(cache.book.keys(host: "mac").isEmpty)
        #expect(!store.jobs.contains { $0.environmentId == "mac" })
    }

    @Test func `a chat marked read stays read when a host that is behind answers an older copy`() async {
        let older = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "older", at: Self.now - 120_000)
        let newer = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "newer", at: Self.now - 60_000)
        let mac = HostReads(chats: [older])
        let store = store(TodayBookCache(), by: ["box": HostReads(chats: [newer]), "mac": mac])
        store.update(hosts: [Self.on("box"), Self.on("mac")])
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["newer"])
        store.hide(TodaySources.chatKey("c", at: newer.at))
        store.markedRead(chatId: "c", at: newer.at)
        // The box clears the chat first; the Mac still answers the older copy.
        let boxCleared = HostReads()
        store.readsOf = { ["box": boxCleared, "mac": mac][$0] }
        var revs = TodayHostInput.Revs()
        revs.messages["ws-box"] = 1
        var box = Self.on("box")
        box.revs = revs
        store.update(hosts: [box, Self.on("mac")])
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.isEmpty)
    }

    @Test func `an open request is one Held row, and the items it lists are not listed again`() {
        let listed = Self.item("h1", at: Int(Self.now) - 300_000)
        let other = Self.item("h2", at: Int(Self.now) - 200_000)
        let request = OutboxRequest(id: "r1", n: 1, sessionId: "s1", workspaceId: "ws-box", sector: "purdue", quote: "send it", head: "Send 1 mail", state: .open, createdAt: Int(Self.now) - 100_000, expiresAt: Int(Self.now) + 3_600_000, answeredBy: nil, answeredAt: nil,
                                    rows: [OutboxRequestRow(ref: listed.ref, do: .send, item: listed, changed: false, open: true)])
        let store = store(TodayBookCache(), by: [:])
        store.update(hosts: [Self.on("box", requests: [request], held: [listed, other], threads: ["s1": "Budget thread"])])
        let held = TodayStore.rows(store.page).filter { $0.section == "held" }
        // Oldest first: the item h2 was held before the thread asked.
        #expect(held.map(\.key) == ["held:box:host:h2", "held:request:box:r1"])
        let asked = held.first { $0.key == "held:request:box:r1" }
        #expect(asked?.detail == "Asked in Budget thread")
        #expect(asked?.open == .request(environmentId: "box", requestId: "r1"))
    }

    @Test func `a LifeOS failure's Retry asks LifeKit again through the app`() async {
        let store = store(TodayBookCache(), by: [:])
        var asked: [TodayRetry] = []
        store.retryLife = { asked.append($0) }
        await store.retry(.lifeos(what: "tasks"))
        await store.retry(.lost(environmentId: "mac", sector: "ref", down: true))
        #expect(asked == [.lifeos(what: "tasks"), .lost(environmentId: "mac", sector: "ref", down: true)])
    }

    @Test func `the feed's tick builds only when the minute moved`() {
        let store = store(TodayBookCache(), by: [:])
        store.update(hosts: [Self.on("box")])
        let built = store.page
        store.tick(now: Self.now + 10_000, ifMoved: true)
        #expect(store.now == Self.now)
        store.tick(now: Self.now + 61_000, ifMoved: true)
        #expect(store.now == Self.now + 61_000)
        #expect(built != nil)
    }

    // MARK: - each job's read, as the desktop's snapshot()

    static let jobA = TodayWorkspace(environmentId: "box", workspaceId: "a", sector: "purdue", name: "A", open: true)
    static let jobB = TodayWorkspace(environmentId: "mac", workspaceId: "b", sector: "ref", name: "B", open: true)

    @Test func `a value read again on a push is not loading`() {
        var reads = JobReads<Int>()
        reads.values[Self.jobA.place] = 1
        reads.out.insert(Self.jobA.place)
        let answer = reads.answer([Self.jobA]) { _ in [] }
        #expect(!answer.loading && !answer.stale)
    }

    @Test func `an offline job is away even with a value`() {
        var reads = JobReads<Int>()
        var offline = Self.jobA
        offline.open = false
        reads.values[offline.place] = 1
        #expect(reads.answer([offline]) { _ in [] }.away)
    }

    @Test func `one job answered and another still out is loading and not stale`() {
        var reads = JobReads<Int>()
        reads.values[Self.jobA.place] = 0
        reads.out.insert(Self.jobB.place)
        let answer = reads.answer([Self.jobA, Self.jobB]) { _ in [] }
        #expect(answer.loading && !answer.stale && answer.rows == [])
        // A failed read asked again is out, and stale while it has a value.
        reads = JobReads<Int>()
        reads.values[Self.jobB.place] = 2
        reads.failed[Self.jobB.place] = "no"
        reads.out.insert(Self.jobB.place)
        let again = reads.answer([Self.jobB]) { _ in [] }
        #expect(again.loading && again.stale && again.failed.isEmpty)
        reads.out.remove(Self.jobB.place)
        #expect(reads.answer([Self.jobB]) { _ in [] }.failed.map(\.environmentId) == ["mac"])
    }

    // MARK: - fix round 3

    @Test func `an asleep host's kept rows stay on the page and on disk while the others answer`() async {
        let macChat = TodayRow(key: "chat:c-mac:1", section: "messages", sector: "purdue", title: "Dana")
        var kept = macChat
        kept.open = .chat(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), chatId: "c-mac")
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([kept], day: Self.day), at: macKey)
        let cache = TodayBookCache(book: book)
        let store = store(cache, by: ["box": HostReads()])
        store.update(hosts: [Self.on("box"), Self.on("mac", open: false, loaded: false, tells: nil)])
        store.update(life: Self.emptyLife)
        await settle()
        let shown = TodayStore.rows(store.page).filter { $0.section == "messages" }
        #expect(shown.map(\.key) == ["chat:c-mac:1"])
        // From the disk: it opens to read and is pressed only once fresh.
        #expect(shown.first.map(store.isFresh) == false)
        guard case .day(_, let offline, _)? = store.page else { Issue.record("no day"); return }
        #expect(offline == ["mac"])
        // Nothing of the asleep host was written over.
        #expect(cache.book.today([macKey], day: Self.day).map(\.key) == ["chat:c-mac:1"])
    }

    @Test func `a refused host is named at the foot, and the page is never All Clear over it`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads(), "mac": HostReads()])
        store.update(hosts: [Self.on("box"), Self.on("mac", revoked: true)])
        store.update(life: Self.emptyLife)
        await settle()
        guard case .day(let blocks, let offline, _)? = store.page else { Issue.record("clear over a refused host"); return }
        // Its own words at the foot, never "offline".
        #expect(offline.isEmpty)
        #expect(blocks.last == .refused(["mac"]))
    }

    @Test func `a refused host that held every job leaves its line, never No Jobs Yet`() {
        let store = store(TodayBookCache(), by: [:])
        store.update(hosts: [Self.on("mac", revoked: true)])
        #expect(store.page == .day(blocks: [.refused(["mac"])], offline: [], keys: []))
    }

    @Test func `a read past its deadline fails with the desktop's words, keeps its rows, and drops its late answer`() async throws {
        let chat = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "kept", at: Self.now - 60_000)
        let box = HostReads(chats: [chat])
        let store = store(TodayBookCache(), by: ["box": box])
        store.deadline = .milliseconds(30)
        store.update(hosts: [Self.on("box")])
        await settle()
        box.held = true
        box.chats = [TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "late", at: Self.now - 30_000)]
        var revs = TodayHostInput.Revs()
        revs.messages["ws-box"] = 1
        var moved = Self.on("box")
        moved.revs = revs
        store.update(hosts: [moved])
        try await Task.sleep(for: .milliseconds(120))
        await settle()
        let messages = Self.sections(store.page).first { $0.id == "messages" }
        #expect(messages?.failed.map(\.error) == [TodayStore.timedOut])
        #expect(messages?.rows.map(\.detail) == ["kept"])
        box.release()
        await settle()
        #expect(Self.sections(store.page).first { $0.id == "messages" }?.rows.map(\.detail) == ["kept"])
    }

    @Test func `one tell told by two hosts is one row: the one told already, else the newest`() {
        func tell(_ host: String, title: String, at: Double, told: Double? = nil) throws -> TellRow {
            var json: [String: JSONValue] = ["id": .string("t-\(host)"), "host": .string(host), "kind": .string("ending.signin"), "group": .string("ending"), "title": .string(title), "key": .string("teams-end"), "at": .number(at), "how": .string("digest"), "day": .string(Self.day)]
            if let told { json["toldAt"] = .number(told) }
            return try TodayRecode.as(TellRow.self, JSONValue.object(json))
        }
        guard let older = try? tell("box", title: "Old words", at: Self.now - 120_000), let newer = try? tell("mac", title: "New words", at: Self.now - 60_000) else {
            Issue.record("no tells"); return
        }
        let store = store(TodayBookCache(), by: [:])
        store.update(hosts: [Self.on("box", tells: [older]), Self.on("mac", tells: [newer])])
        #expect(TodayStore.rows(store.page).filter { $0.section == "also" }.map(\.title) == ["New words"])
    }

    @Test func `a host's kept rows of a source go only once its own part of that source answers`() async {
        var chat = TodayRow(key: "chat:c-mac:1", section: "messages", sector: "purdue", title: "Dana")
        chat.open = .chat(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), chatId: "c-mac")
        var held = TodayRow(key: "held:mac:host:h9", section: "held", sector: nil, title: "Send the notes")
        held.open = .held(environmentId: "mac", ref: .host(.init(id: "h9")))
        held.at = Self.now - 3_600_000
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([chat, held], day: Self.day), at: macKey)
        let cache = TodayBookCache(book: book)
        let mac = HostReads()
        mac.held = true
        let store = store(cache, by: ["box": HostReads(), "mac": mac])
        // The Mac links and lists its Outbox (empty), but its Messages read is still out.
        store.update(hosts: [Self.on("box"), Self.on("mac")])
        await settle()
        let keys = Set(TodayStore.rows(store.page).map(\.key))
        #expect(!keys.contains("held:mac:host:h9"))
        #expect(keys.contains("chat:c-mac:1"))
        // Held answered (empty): its kept row is not written back; Messages has not, so its kept row is carried.
        #expect(cache.book.today([macKey], day: Self.day).map(\.key).sorted() == ["chat:c-mac:1"])
        mac.release()
        await settle()
        #expect(!TodayStore.rows(store.page).contains { $0.key == "chat:c-mac:1" })
    }


    @Test func `an older answer that lands after a newer ask is dropped`() async {
        let old = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "old", at: Self.now - 120_000)
        let new = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "new", at: Self.now - 60_000)
        let box = HostReads(chats: [old])
        let store = store(TodayBookCache(), by: ["box": box])
        store.update(hosts: [Self.on("box")])
        await settle()
        // The next ask is held out; then a newer one answers first.
        box.held = true
        var revs = TodayHostInput.Revs()
        revs.messages["ws-box"] = 1
        var moved = Self.on("box")
        moved.revs = revs
        store.update(hosts: [moved])
        await settle()
        box.held = false
        box.chats = [new]
        revs.messages["ws-box"] = 2
        moved.revs = revs
        store.update(hosts: [moved])
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["new"])
        box.release()
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["new"])
    }

    @Test func `Retry on a host's line lists its Outbox and digest again`() async {
        let box = HostReads()
        let store = store(TodayBookCache(), by: ["box": box])
        store.update(hosts: [Self.on("box")])
        await store.retry(.host("box"))
        #expect(box.relisted == 1)
    }

    // MARK: - fix round 5

    @Test func `a kept row its host let go never comes back when a later read fails`() async {
        var gone = TodayRow(key: "held:box:host:old", section: "held", sector: nil, title: "Gone overnight")
        gone.open = .held(environmentId: "box", ref: .host(.init(id: "old")))
        gone.at = Self.now - 3_600_000
        let key = WorkCache.Key(host: "box", account: "k-box", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([gone], day: Self.day), at: key)
        let store = store(TodayBookCache(book: book), by: ["box": HostReads()])
        // The box lists its Outbox without the old item.
        store.update(hosts: [Self.on("box")])
        await settle()
        #expect(!TodayStore.rows(store.page).contains { $0.key == "held:box:host:old" })
        // Then a list read fails while the link stays: what the answer gave stands, the old row does not return.
        var failing = Self.on("box")
        failing.heldError = "It did not answer in time"
        store.update(hosts: [failing])
        #expect(!TodayStore.rows(store.page).contains { $0.key == "held:box:host:old" })
    }

    @Test func `a review read that failed counts as none, so the page settles`() async {
        final class SlowReview: TodayHostReads {
            func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat] { [] }
            func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed { try TodayRecode.as(TodaySources.Owed.self, ["rows": [JSONValue]()]) }
            func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form] { [] }
            func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting] { [] }
            func todayReview() async throws -> TodaySources.ReviewReady? {
                try await Task.sleep(for: .seconds(5))
                return nil
            }
            func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange { .init(clashes: [], leaves: []) }
            func todayDigest() async {}
        }
        let store = TodayStore(cache: TodayBookCache(), calendar: Self.cal, now: Self.now)
        let reads = SlowReview()
        store.readsOf = { _ in reads }
        store.deadline = .milliseconds(30)
        store.update(hosts: [Self.on("box")])
        store.update(life: Self.emptyLife)
        try? await Task.sleep(for: .milliseconds(150))
        await settle()
        #expect(store.page == .clear(line: nil))
    }

    @Test func `a kept copy of a chat a fresh row gives is not a second row`() async {
        var kept = TodayRow(key: "chat:c:100", section: "messages", sector: "purdue", title: "Dana")
        kept.open = .chat(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), chatId: "c")
        kept.at = -100
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([kept], day: Self.day), at: macKey)
        let fresh = TodaySources.Chat(chatId: "c", chat: "Staff", who: "Dana", text: "newer", at: Self.now - 60_000)
        let store = store(TodayBookCache(book: book), by: ["box": HostReads(chats: [fresh])])
        store.update(hosts: [Self.on("box"), Self.on("mac", open: false, loaded: false, tells: nil)])
        await settle()
        #expect(TodayStore.rows(store.page).filter { $0.section == "messages" }.map(\.detail) == ["newer"])
    }

    // MARK: - fix round 7

    @Test func `a cold launch before the catalog lands keeps an asleep host's kept chats`() async {
        var kept = TodayRow(key: "chat:c-mac:1", section: "messages", sector: "purdue", title: "Dana")
        kept.open = .chat(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), chatId: "c-mac")
        kept.at = -1
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([kept], day: Self.day), at: macKey)
        let store = store(TodayBookCache(book: book), by: ["box": HostReads()])
        // The first update has no workspaces yet: the hosts' catalogs are still loading.
        var bare = Self.on("mac", open: false, loaded: false, tells: nil)
        bare.workspaces = []
        var box = Self.on("box")
        box.workspaces = []
        store.update(hosts: [box, bare])
        await settle()
        // Then the catalog lands, the Mac still asleep: its chat is laid on the page from the disk.
        store.update(hosts: [Self.on("box"), Self.on("mac", open: false, loaded: false, tells: nil)])
        await settle()
        #expect(TodayStore.rows(store.page).contains { $0.key == "chat:c-mac:1" })
    }

    @Test func `a host's kept row goes once its own job answered, whatever its other job does`() async {
        final class TwoJobs: TodayHostReads {
            func todayChats(_ workspaceId: String) async throws -> [TodaySources.Chat] {
                if workspaceId == "ws-unify" { throw TestError.refused }
                return []
            }
            func todayOwed(_ workspaceId: String) async throws -> TodaySources.Owed { try TodayRecode.as(TodaySources.Owed.self, ["rows": [JSONValue]()]) }
            func todayForms(_ workspaceId: String) async throws -> [TodaySources.Form] { [] }
            func todayPrep(from: Double, to: Double) async throws -> [TodaySources.PrepMeeting] { [] }
            func todayReview() async throws -> TodaySources.ReviewReady? { nil }
            func todayClashes(from: Double, to: Double) async throws -> TodaySources.ClashRange { .init(clashes: [], leaves: []) }
            func todayDigest() async {}
        }
        var kept = TodayRow(key: "chat:x:1", section: "messages", sector: "purdue", title: "Read on the desktop")
        kept.open = .chat(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), chatId: "x")
        kept.at = -1
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([kept], day: Self.day), at: macKey)
        let store = TodayStore(cache: TodayBookCache(book: book), calendar: Self.cal, now: Self.now)
        let reads = TwoJobs()
        store.readsOf = { _ in reads }
        var mac = Self.on("mac")
        mac.workspaces.append(WorkspaceMeta(id: "ws-unify", name: "Unify", path: "/w/unify", git: false, kind: .work, sector: "unify", createdAt: 1))
        store.update(hosts: [mac])
        await settle()
        #expect(!TodayStore.rows(store.page).contains { $0.key == "chat:x:1" })
    }

    @Test func `a LifeOS sign-out takes what that session gave from memory`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads()])
        store.update(hosts: [Self.on("box")])
        var life = Self.emptyLife
        life.events = [TodaySources.Event(id: "e1", title: "Budget sync", sector: "purdue", startsAt: Self.now + 3_600_000)]
        store.update(life: life)
        await settle()
        #expect(TodayStore.rows(store.page).contains { $0.key == "event:e1" })
        // Signed out, then LifeOS reads again from nothing: the old meeting is not kept and shown.
        store.update(life: TodayLifeInput(host: "box", reach: .down(.signedOut)))
        var again = TodayLifeInput(host: "box", reach: .ok)
        again.eventsRead = TodaySources.LifeosRead(pending: true)
        store.update(life: again)
        #expect(!TodayStore.rows(store.page).contains { $0.key == "event:e1" })
    }

    // MARK: - fix round 8

    @Test func `a host's LifeOS sign-out, heard with Today closed, takes what its session gave at once`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads()])
        store.update(hosts: [Self.on("box")])
        var life = Self.emptyLife
        life.events = [TodaySources.Event(id: "e1", title: "Budget sync", sector: "purdue", startsAt: Self.now + 3_600_000)]
        store.update(life: life)
        await settle()
        #expect(TodayStore.rows(store.page).contains { $0.key == "event:e1" })
        // No new input comes (Today is off screen): the sign-out alone ends the rows.
        store.lifeosSignedOut(host: "box")
        #expect(!TodayStore.rows(store.page).contains { $0.key == "event:e1" })
        guard case .day(let blocks, _, _)? = store.page else { Issue.record("no day"); return }
        #expect(blocks.contains(.lifeos(.signedOut)))
    }

    @Test func `a narrowed session's sign-out takes its own sectors alone`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads()])
        var mac = Self.on("mac")
        mac.workspaces = [WorkspaceMeta(id: "ws-ref", name: "Refereeing", path: "/w/ref", git: false, kind: .work, sector: "ref", createdAt: 1)]
        store.update(hosts: [Self.on("box"), mac])
        var life = Self.emptyLife
        life.events = [
            TodaySources.Event(id: "e1", title: "Budget sync", sector: "purdue", startsAt: Self.now + 3_600_000),
            TodaySources.Event(id: "e2", title: "Varsity game", sector: "ref", startsAt: Self.now + 7_200_000),
        ]
        life.narrowed = ["mac": ["ref"]]
        store.update(life: life)
        await settle()
        store.lifeosSignedOut(host: "mac")
        let keys = Set(TodayStore.rows(store.page).map(\.key))
        #expect(keys.contains("event:e1") && !keys.contains("event:e2"))
    }

    // MARK: - fix round 9

    @Test func `LifeOS rows carry the host whose session read them`() async {
        let store = store(TodayBookCache(), by: ["box": HostReads()])
        var mac = Self.on("mac")
        mac.workspaces = [WorkspaceMeta(id: "ws-ref", name: "Refereeing", path: "/w/ref", git: false, kind: .work, sector: "ref", createdAt: 1)]
        store.update(hosts: [Self.on("box"), mac])
        var life = Self.emptyLife
        life.events = [
            TodaySources.Event(id: "e1", title: "Budget sync", sector: "purdue", startsAt: Self.now + 3_600_000),
            TodaySources.Event(id: "e2", title: "Varsity game", sector: "ref", startsAt: Self.now + 7_200_000),
        ]
        life.narrowed = ["mac": ["ref"]]
        store.update(life: life)
        let rows = TodayStore.rows(store.page)
        #expect(rows.first { $0.key == "event:e1" }?.suppliedBy == "box")
        #expect(rows.first { $0.key == "event:e2" }?.suppliedBy == "mac")
    }

    @Test func `a sign-out with no LifeOS input yet takes the session's kept rows from another host's key`() {
        // Kept under the Mac's key (its job), read by the box's whole session; Today has had no LifeOS input yet.
        var wait = TodayRow(key: "mail:w1", section: "waiting", sector: "purdue", title: "Dana Lee")
        wait.open = .mail(TodayPlace(environmentId: "mac", workspaceId: "ws-mac"), threadId: "w1")
        wait.suppliedBy = "box"
        let macKey = WorkCache.Key(host: "mac", account: "k-mac", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([wait], day: Self.day), at: macKey)
        let store = store(TodayBookCache(book: book), by: [:])
        // The box on its first connect (open, not yet linked): LifeOS is on its way, so the kept row shows.
        var box = Self.on("box", loaded: false, tells: nil)
        box.linked = false
        store.update(hosts: [box, Self.on("mac", open: false, loaded: false, tells: nil)])
        #expect(TodayStore.rows(store.page).contains { $0.key == "mail:w1" })
        store.lifeosSignedOut(host: "box")
        #expect(!TodayStore.rows(store.page).contains { $0.key == "mail:w1" })
    }
}
