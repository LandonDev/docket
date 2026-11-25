import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A Work thread's `@`, chips and item order (All of Work on the iPhone M4a; Work/Mentions/Mentions.swift).
@MainActor
struct MentionsTests {
    private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private var task: ContextChip { ChipWords.lifeos(.task, table: .tasks, id: "k1", label: "Book the ballroom") }
    private var held: ContextChip { ContextChip(kind: .held, label: "Reply to Dana", ref: .object3(.init(at: "work", pillar: .outbox, id: "h1")), excerpt: "Thanks, the 10th works.\nSee you then.") }

    // MARK: the token

    @Test func theTokenIsTheLastWordWhenItOpensWithAnAt() {
        #expect(MentionTrigger.query(in: "@") == "")
        #expect(MentionTrigger.query(in: "look at @bud") == "bud")
        #expect(MentionTrigger.query(in: "line\n@ball") == "ball")
        #expect(MentionTrigger.query(in: "mail a@b.com") == nil)
        #expect(MentionTrigger.query(in: "@a@b") == nil)
        #expect(MentionTrigger.query(in: "@bud ") == nil)
        #expect(MentionTrigger.query(in: "") == nil)
        #expect(MentionTrigger.query(in: "@" + String(repeating: "x", count: 300))?.count == MentionTrigger.most)
    }

    @Test func aPickTakesTheTokenOutAndKeepsTheRest() {
        #expect(MentionTrigger.removing(from: "look at @bud") == "look at ")
        #expect(MentionTrigger.removing(from: "@bud") == "")
        #expect(MentionTrigger.removing(from: "no token") == "no token")
    }

    @Test func theDraftAssignsItsMentionOnlyWhenTheWordsChange() {
        let draft = ComposerDraft()
        draft.type("hi")
        #expect(draft.mention == nil)
        draft.type("hi @")
        #expect(draft.mention == "")
        draft.type("hi @bu")
        #expect(draft.mention == "bu")
        var edits = 0
        draft.onEdit = { edits += 1 }
        draft.takeMention()
        #expect(draft.text == "hi ")
        #expect(draft.mention == nil)
        // A pick is a named write, never his edit.
        #expect(edits == 0)
    }

    // MARK: the chip box

    @Test func theBoxHoldsEachThingOnceAndEightAtMost() {
        let box = ChipBox()
        #expect(box.add(task))
        #expect(!box.add(task))
        for i in 0..<10 { box.add(ChipWords.lifeos(.task, table: .tasks, id: "t\(i)", label: "T\(i)")) }
        #expect(box.chips.count == ChipBox.most)
        box.remove(at: 0)
        #expect(box.chips.count == ChipBox.most - 1)
        #expect(!box.chips.contains { ChipBox.same($0, task) })
    }

    @Test func aRefusedSendGivesItsChipsBackFirst() {
        let box = ChipBox()
        box.add(task)
        let sent = box.take()
        #expect(box.chips.isEmpty)
        box.add(held)
        box.restore(sent)
        #expect(box.chips.map(\.label) == ["Book the ballroom", "Reply to Dana"])
    }

    @Test func eachThreadHasItsOwnBox() {
        let store = ComposerChips()
        let a = store.box(environmentId: "box", sessionId: "s1")
        #expect(store.box(environmentId: "box", sessionId: "s1") === a)
        #expect(store.box(environmentId: "mac", sessionId: "s1") !== a)
    }

    // MARK: the line the model reads (the desktop's chips.test.ts)

    @Test func aChipIsTheDesktopsLine() throws {
        #expect(ChipWords.line(ChipWords.lifeos(.chat, table: .chats, id: "c1", label: "Dana Lee in Slack")) == "About this conversation: Dana Lee in Slack (LifeOS chats c1)")
        #expect(ChipWords.line(held) == "About this held act: Reply to Dana (Work outbox h1)\n> Thanks, the 10th works.\n> See you then.")
        #expect(ChipWords.line(ContextChip(kind: .item, label: "Budget", ref: .object2(.init(at: "item", id: "i1")))) == "About this item: Budget (canvas item i1)")
        #expect(ChipWords.line(ContextChip(kind: .project, label: "Spring LAN", ref: .object(.init(at: "lifeos", table: .projects, id: "p1")), excerpt: "  ")) == "About this project: Spring LAN (LifeOS projects p1)")
        // A task's notes as its quote, past an excerpt; a label that ran onto two lines is one.
        #expect(ChipWords.line(ContextChip(kind: .task, label: "Book the\nballroom", ref: task.ref, quote: "Ask for the east hall.\nBudget 2k")) == "About this task: Book the ballroom (LifeOS tasks k1)\n> Ask for the east hall.\n> Budget 2k")
    }

    @Test func aFileChipNamesItsSourceAndPlaceAndNothingFromInside() throws {
        let ref: CanvasSource = try decode(#"{"at":"file","host":"box","path":"/cloud/Esports Staff/General/Spring budget (final).xlsx"}"#)
        let file = ContextChip(kind: .file, label: "Spring budget (final).xlsx", ref: .canvasSource(ref), quote: "secret cell", excerpt: "Q1 total 4,200",
                               where: .init(place: "box~ab12/general", name: "General", path: "Spring budget (final).xlsx", shared: true))
        let line = ChipWords.line(file)
        #expect(!line.contains("secret") && !line.contains("Q1 total"))
        #expect(line.hasSuffix("\n> In General (place box~ab12/general) at Spring budget (final).xlsx. Others can open it."))
        let head = String(line.split(separator: "\n")[0])
        #expect(head.hasPrefix("About this file: Spring budget (final).xlsx ({"))
        // The source's brackets are escaped, so the line reads back as one chip.
        let back = SentChips.of(line + "\n\nWhat changed?")
        #expect(back.text == "What changed?")
        #expect(back.chips.count == 1)
        #expect(back.chips.first?.label == "Spring budget (final).xlsx")
        let json = try #require(back.chips.first?.ref.replacingOccurrences(of: "\\u0028", with: "(").replacingOccurrences(of: "\\u0029", with: ")"))
        #expect(try decode(json, as: CanvasSource.self) == ref)
    }

    // MARK: the sent bubble (the desktop's sentChipsOf.test.ts)

    @Test func theLeadingLinesAreChipsAndHisWordsFollow() {
        let text = "About this task: Book the ballroom (LifeOS tasks k1)\n> For April 10\nAbout this held act: Reply to Dana (Work outbox h1)\n\nSay what the insurance must cover."
        let got = SentChips.of(text)
        #expect(got.chips == [SentChips.Chip(noun: "task", label: "Book the ballroom", ref: "LifeOS tasks k1"), SentChips.Chip(noun: "held act", label: "Reply to Dana", ref: "Work outbox h1")])
        #expect(got.text == "Say what the insurance must cover.")
        #expect(got.chips[1].kind == .held)
    }

    @Test func chipsStandAloneAndFollowASlashCommand() {
        let alone = SentChips.of("About this item: Budget (canvas item i1)")
        #expect(alone.chips == [SentChips.Chip(noun: "item", label: "Budget", ref: "canvas item i1")])
        #expect(alone.text == "")
        let slash = SentChips.of("/summarize the morning\n\nAbout this mail: Re: (Ballroom) (LifeOS mailThreads m1)")
        #expect(slash.chips == [SentChips.Chip(noun: "mail", label: "Re: (Ballroom)", ref: "LifeOS mailThreads m1")])
        #expect(slash.text == "/summarize the morning")
        #expect(SentChips.of("/review the plan\n\nfirst part\n\nAbout this task: X (LifeOS tasks k1)").chips.count == 1)
    }

    @Test func aMessageThatOnlyLooksLikeOneIsLeftAlone() {
        for text in ["About this task: no reference here", "About this bug: login fails (see logs)\n\nIt started Monday.",
                     "About this task: X (LifeOS tasks k1)\nand words with no blank line", "Hello\n\nAbout this task: X (LifeOS tasks k1)"] {
            let got = SentChips.of(text)
            #expect(got.chips.isEmpty)
            #expect(got.text == text)
        }
    }

    @Test func whatTheComposerSendsReadsBackAsItsChips() {
        let message = ChipWords.message([task, held], text: "Draft the reply")
        let got = SentChips.of(message)
        #expect(got.chips.map(\.label) == ["Book the ballroom", "Reply to Dana"])
        #expect(got.text == "Draft the reply")
    }

    // MARK: the ask

    @Test func theFirstAskGoesAtOnceAndTheNextWaitsABeat() async {
        var asked: [String] = []
        var slept: [Duration] = []
        let ask = MentionAsk(fetch: { text in
            asked.append(text)
            return MentionAnswer(hits: [MentionHit(chip: ChipWords.lifeos(.task, table: .tasks, id: "k1", label: "Book the ballroom"))], failed: [])
        }, failWords: { _ in nil }, sleep: { _ in })
        #expect(ask.loading)
        await ask.ask("b")
        #expect(asked == ["b"])
        #expect(!ask.loading)
        #expect(ask.rows(for: "b").count == 1)
        let waits = MentionAsk(fetch: { _ in MentionAnswer(hits: [], failed: []) }, failWords: { _ in nil }, sleep: { slept.append($0) })
        await waits.ask("a")
        await waits.ask("ab")
        #expect(slept == [MentionAsk.wait])
    }

    @Test func theLastAnswerStaysCutToWhatStillMatches() async {
        let hits = [MentionHit(chip: ChipWords.lifeos(.task, table: .tasks, id: "k1", label: "Book the ballroom")),
                    MentionHit(chip: ChipWords.lifeos(.mail, table: .mailThreads, id: "m1", label: "Budget for April"))]
        let ask = MentionAsk(fetch: { _ in MentionAnswer(hits: hits, failed: []) }, failWords: { _ in nil }, sleep: { _ in })
        await ask.ask("b")
        #expect(ask.rows(for: "b").count == 2)
        #expect(ask.rows(for: "bud").map(\.chip.label) == ["Budget for April"])
    }

    @Test func aFailedAskSaysSoAndKindsLeftOutAreWorded() async {
        struct Down: Error {}
        let failing = MentionAsk(fetch: { _ in throw Down() }, failWords: { _ in nil }, sleep: { _ in })
        await failing.ask("x")
        #expect(failing.note == MentionAsk.searchFailed)
        #expect(failing.rows(for: "x").isEmpty)
        let partial = MentionAsk(fetch: { _ in MentionAnswer(hits: [], failed: [.task, .mail]) },
                                 failWords: { MentionWords.failed($0, lifeos: "signed-out", host: "The box") }, sleep: { _ in })
        await partial.ask("x")
        #expect(partial.note == "Not signed in to LifeOS on the box")
    }

    @Test func aCancelledAskLandsNothing() async {
        let ask = MentionAsk(fetch: { _ in MentionAnswer(hits: [MentionHit(chip: ChipWords.lifeos(.task, table: .tasks, id: "k1", label: "A"))], failed: []) },
                             failWords: { _ in nil }, sleep: { _ in })
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await ask.ask("a")
        }
        await task.value
        #expect(ask.loading)
    }

    @Test func theQuietLineFollowsTheDesktopsWords() {
        #expect(MentionWords.failed([], lifeos: nil, host: "The box") == nil)
        #expect(MentionWords.failed([.file], lifeos: "connected", host: "The box") == "Couldn't search everything")
        #expect(MentionWords.failed([.task], lifeos: "connecting", host: "The box") == "LifeOS is still connecting on the box")
        #expect(MentionWords.failed([.task], lifeos: "connected", host: "The box") == "LifeOS did not answer the box")
        #expect(MentionWords.failed([.event], lifeos: nil, host: nil) == "LifeOS did not answer")
    }

    @Test func aRowsTimeIsTodaysTimeThisYearsDayOrAnOlderDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let locale = Locale(identifier: "en_US")
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 25, hour: 15))!
        let ms = { (d: Date) in d.timeIntervalSince1970 * 1000 }
        #expect(MentionWords.when(ms(calendar.date(from: DateComponents(year: 2026, month: 11, day: 25, hour: 14))!), now: now, calendar: calendar, locale: locale).contains("2:00"))
        #expect(MentionWords.when(ms(calendar.date(from: DateComponents(year: 2026, month: 4, day: 10, hour: 9))!), now: now, calendar: calendar, locale: locale) == "Apr 10")
        #expect(MentionWords.when(ms(calendar.date(from: DateComponents(year: 2025, month: 4, day: 10, hour: 9))!), now: now, calendar: calendar, locale: locale) == "Apr 10, 2025")
        let hit = MentionHit(chip: task, detail: "Dana Lee", at: ms(calendar.date(from: DateComponents(year: 2026, month: 4, day: 10))!))
        #expect(MentionWords.detail(hit, now: now, calendar: calendar, locale: locale) == "Dana Lee · Apr 10")
        #expect(MentionWords.detail(MentionHit(chip: task), now: now) == nil)
    }

    @Test func theAnswerDecodesAsTheHostWritesIt() throws {
        let answer: MentionAnswer = try decode(#"{"hits":[{"chip":{"kind":"task","label":"Book the ballroom","ref":{"at":"lifeos","table":"tasks","id":"k1"},"excerpt":"For April 10"},"detail":"Due Friday","at":1775800000000}],"failed":["mail"]}"#)
        #expect(answer.hits.first?.chip.ref == task.ref)
        #expect(answer.failed == [.mail])
        #expect(MentionWords.id(answer.hits[0]) == "task:LifeOS tasks k1")
    }

    // MARK: a Files row as a chip (files.ts fileChipOf)

    @Test func aFilesRowIsAFileChipWithItsPlaceAndPath() throws {
        let entry: FileEntry = try decode(#"{"key":"k","ref":{"at":"file","host":"box","path":"/w/Esports/Budgets/Spring.xlsx"},"name":"Spring.xlsx","kind":"sheet"}"#)
        let root: FolderRef = try decode(#"{"at":"file","host":"box","path":"/w/Esports/"}"#)
        let chip = try #require(FileChips.of(entry, place: .init(id: "folder", name: "Dummy Esports", shared: true, root: root)))
        #expect(chip.kind == .file)
        #expect(chip.label == "Spring.xlsx")
        #expect(chip.where == .init(place: "folder", name: "Dummy Esports", path: "Budgets/Spring.xlsx", shared: true))
        // A lens's row says where it is itself; with no place known the chip names its source alone.
        let found: FileEntry = try decode(#"{"key":"k","ref":{"at":"file","host":"box","path":"/x/Spring.xlsx"},"name":"Spring.xlsx","kind":"sheet","where":{"place":"p2","name":"OneDrive","trail":["Staff","General"]}}"#)
        #expect(FileChips.of(found)?.where == .init(place: "p2", name: "OneDrive", path: "Staff/General/Spring.xlsx", shared: nil))
        #expect(FileChips.of(entry)?.where == nil)
        // Outside the place's top folder: the name alone.
        let away: FileEntry = try decode(#"{"key":"k","ref":{"at":"file","host":"box","path":"/elsewhere/Spring.xlsx"},"name":"Spring.xlsx","kind":"sheet"}"#)
        #expect(FileChips.of(away, place: .init(id: "folder", name: "Dummy Esports", shared: false, root: root))?.where?.path == "Spring.xlsx")
    }

    @Test func aFolderOrAThreadsOwnItemIsNoChip() throws {
        let folder: FileEntry = try decode(#"{"key":"k","folder":{"at":"file","host":"box","path":"/w/Esports/Budgets"},"name":"Budgets","kind":"folder"}"#)
        #expect(FileChips.of(folder) == nil)
        let own: FileEntry = try decode(#"{"key":"k","ref":{"at":"thread"},"name":"out.md","kind":"sheet"}"#)
        #expect(FileChips.of(own) == nil)
    }

    // MARK: item order

    @Test func anItemMovesUpOrDownInsideTheRow() {
        #expect(CanvasOrder.moved(["a", "b", "c"], "b", by: -1) == ["b", "a", "c"])
        #expect(CanvasOrder.moved(["a", "b", "c"], "b", by: 1) == ["a", "c", "b"])
        #expect(CanvasOrder.moved(["a", "b", "c"], "a", by: -1) == nil)
        #expect(CanvasOrder.moved(["a", "b", "c"], "c", by: 1) == nil)
        #expect(CanvasOrder.moved(["a", "b"], "z", by: 1) == nil)
    }

    // MARK: Add to Thread

    private func meta(_ id: String, workspaceId: String? = "w1", projectId: String? = nil, parentId: String? = nil, scope: SessionScope? = .work,
                      pinned: Bool = false, archived: Bool = false, updatedAt: Int = 1) -> SessionMeta {
        SessionMeta(id: id, parentId: parentId, projectId: projectId, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-opus-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/w", status: .idle, pinned: pinned, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, scope: scope, createdAt: 1, updatedAt: updatedAt)
    }

    @Test func addToThreadListsTheJobsOpenWorkThreadsPinnedThenNewest() {
        let sessions = [
            meta("old", updatedAt: 2), meta("new", updatedAt: 9), meta("pinned", pinned: true, updatedAt: 1),
            meta("archived", archived: true, updatedAt: 20), meta("agent", parentId: "new", updatedAt: 30),
            meta("code", scope: nil, updatedAt: 40), meta("other", workspaceId: "w2", updatedAt: 50),
            meta("project", workspaceId: nil, projectId: "p1", updatedAt: 5),
        ]
        #expect(AddToThread.threads(sessions, workspaceId: "w1", projectWorkspace: ["p1": "w1"]).map(\.id) == ["pinned", "new", "project", "old"])
    }

    @Test func aDraggedRowIsTheChipTheHostsOwnMentionWouldBe() throws {
        let person = RowChips.person(id: "p1", name: "Dana Lee")
        #expect(ChipWords.line(person) == "About this person: Dana Lee (LifeOS people p1)")
        let item = { (ref: HeldRef) in
            OutboxItem(ref: ref, kind: .mailSend, workspaceId: "w1", sessionId: "s1", sector: "purdue", summary: "Send to events booking", verb: "Send", account: nil, state: .held, payload: nil, createdAt: 1, decidedBy: nil, decidedAt: nil, n: 1, why: .rule, grantId: nil, error: nil, result: nil, routineRunId: nil, updatedAt: 1)
        }
        let held = try #require(RowChips.held(item(try decode(#"{"at":"host","id":"h1"}"#))))
        #expect(ChipWords.line(held) == "About this held act: Send to events booking (Work outbox h1)")
        // A LifeOS draft the Outbox lists is no chip: the host's `@` offers its own held acts alone.
        #expect(RowChips.held(item(try decode(#"{"at":"lifeos","table":"outbox","id":"o1"}"#))) == nil)
    }
}
