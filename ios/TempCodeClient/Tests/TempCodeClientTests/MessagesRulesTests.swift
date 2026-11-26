import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Messages' names and rules on the phone (Work/Messages/MessagesRules.swift), held to the desktop's answers in
/// Fixtures/messages/rules.json (scripts/ios-messages-fixture.test.ts writes it), and the phone's own list, composer
/// and draft rules.
@Suite struct MessagesRulesTests {
    private struct Fixture: Decodable {
        struct Source: Decodable { var source: ChatSource; var name: String; var app: String; var route: String; var replyWhere: String }
        struct Words: Decodable { var text: String; var max: Int; var out: String }
        struct Files: Decodable { var text: String; var names: [String]; var out: String }
        struct Stale: Decodable { var source: ChatSourceState; var out: Bool }
        struct Sync: Decodable { var sources: [ChatSourceState]; var out: String? }
        struct Row: Decodable { var row: ChatRow; var line: String; var fact: String; var wantsRead: Bool }
        struct File: Decodable { var name: String; var type: String?; var kind: String? }
        var now: Double
        var zone: String
        var ownReplyHeld: Bool
        var replyMax: Int
        var mayHaveGone: String
        var sources: [Source]
        var firstWords: [Words]
        var fileMarkers: [Files]
        var stale: [Stale]
        var syncLine: [Sync]
        var rows: [Row]
        var files: [File]
    }

    private static let fixture: Fixture = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/messages/rules.json")
        return try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }()

    @Test func `the names, routes and constants are the desktop's`() {
        let f = Self.fixture
        #expect(MessagesRules.ownReplyHeld == f.ownReplyHeld)
        #expect(MessagesRules.replyMax == f.replyMax)
        #expect(MessagesRules.mayHaveGone == f.mayHaveGone)
        #expect(f.sources.map(\.source) == [.slack, .discord, .imessage, .teams])
        for s in f.sources {
            #expect(MessagesRules.name(s.source) == s.name)
            #expect(MessagesRules.app(s.source) == s.app)
            #expect(MessagesRules.sendsThroughLifeos(s.source) == (s.route == "lifeos"), "\(s.source)")
            #expect(MessagesRules.replyWhere(s.source, chat: "Dana Lee") == s.replyWhere)
        }
    }

    @Test func `first words and folded file names come out as on the desktop`() {
        for w in Self.fixture.firstWords { #expect(MessagesRules.firstWords(w.text, max: w.max) == w.out, "\(w.text)") }
        for f in Self.fixture.fileMarkers { #expect(MessagesRules.fileMarkers(f.text, names: f.names) == f.out, "\(f.text)") }
    }

    @Test func `stale and the sync line judge each source as the desktop does`() {
        let f = Self.fixture
        let zone = TimeZone(identifier: f.zone)!
        for s in f.stale { #expect(MessagesRules.stale(s.source, now: f.now) == s.out, "\(s.source)") }
        for s in f.syncLine { #expect(MessagesRules.syncLine(s.sources, now: f.now, zone: zone) == s.out) }
    }

    @Test func `a row's line, its fact and whether opening it marks it read`() {
        for r in Self.fixture.rows {
            #expect(MessagesRules.rowLine(r.row) == r.line)
            #expect(MessagesRules.chatFact(r.row) == r.fact)
            #expect(MessagesRules.wantsRead(r.row) == r.wantsRead)
        }
    }

    @Test func `a chat's file opens in the kind the desktop opens it in`() {
        for f in Self.fixture.files { #expect(ChatFiles.canvasKind(name: f.name, contentType: f.type) == f.kind, "\(f.name) \(f.type ?? "")") }
    }

    // MARK: - the phone's own

    private func row(_ id: String, at: Double, unread: Bool = false, sector: String = "cosmic") -> ChatRow {
        ChatRow(id: id, source: .slack, name: id, sector: sector, lastAt: at, unread: unread)
    }

    @Test func `every job's conversations as one list: each once, unread first, then the newest`() {
        let rows = [row("a", at: 5), row("b", at: 9), row("c", at: 1, unread: true), row("d", at: 3, unread: true, sector: "purdue"), row("b", at: 9)]
        #expect(MessagesRules.ordered(rows).map(\.id) == ["d", "c", "b", "a"])
        // Two at the same time keep one order however they came.
        #expect(MessagesRules.ordered([row("y", at: 2), row("x", at: 2)]).map(\.id) == ["x", "y"])
    }

    @Test func `Send only where LifeOS sends and says yes; else Copy with its reason`() {
        #expect(ReplyWay.of(.slack, route: ChatRoute(can: true)) == .send)
        #expect(ReplyWay.of(.imessage, route: ChatRoute(can: true)) == .send)
        #expect(ReplyWay.of(.slack, route: ChatRoute(can: false, why: "Your Mac isn't running LifeOS")) == .copy(why: "Your Mac isn't running LifeOS"))
        #expect(ReplyWay.of(.discord, route: ChatRoute(can: true)) == .copy(why: "LifeOS can’t reply in Discord yet"))
        #expect(ReplyWay.of(.teams, route: ChatRoute(can: false, why: "No")) == .copy(why: "No"))
        // Before LifeOS says, no Send is drawn.
        #expect(ReplyWay.of(.slack, route: nil) == .copy(why: nil))
    }

    @Test func `his sent reply reads as LifeOS's row says`() {
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .queued)) == ReplyLine(words: "Sending", reason: nil, undo: true, retry: false))
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .sending))?.undo == false)
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .failed, error: " Slack said no ")) == ReplyLine(words: "Not sent.", reason: "Slack said no", undo: false, retry: true))
        // His Retry out or unread: the row says so and offers no second Retry.
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .failed), press: .checking) == ReplyLine(words: "Checking…", reason: nil, undo: false, retry: false))
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .failed), press: .sending)?.retry == false)
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .failed), press: nil)?.retry == true)
        #expect(PressTruth.retry(.failed) == .waiting(rev: nil))
        #expect(PressTruth.retry(.queued) == .done && PressTruth.retry(nil) == .done)
        // VoiceOver: the job first on All Jobs, as Today and Review say it.
        let chat = ChatRow(id: "c1", source: .slack, name: "Dana", sector: "purdue", lastAt: 0, lastText: "Sounds good")
        #expect(MessagesRules.rowLabel(chat, job: "Purdue").hasPrefix("Purdue, Dana, "))
        #expect(MessagesRules.rowLabel(chat, job: nil).hasPrefix("Dana, "))
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .failed, error: "  "))?.reason == nil)
        #expect(ReplyLine.of(ChatReplyState(outboxId: "o", status: .sent)) == nil)
        #expect(ReplyLine.of(nil) == nil)
    }

    private func held(_ id: String, chat: String, state: String = "held", at: Int = 1) -> OutboxItem {
        let json = #"{"ref":{"at":"host","id":"\#(id)"},"kind":"chat.reply","workspaceId":"w1","sessionId":"s1","sector":"cosmic","summary":"Reply in Slack to Dana Lee","verb":"Send","account":null,"state":"\#(state)","payload":{"chatId":"\#(chat)","source":"slack","chat":"Dana Lee","text":"Draft \#(id)"},"createdAt":\#(at),"decidedBy":null,"decidedAt":null,"n":1,"why":"rule","grantId":null,"error":null,"result":null,"routineRunId":null,"updatedAt":\#(at)}"#
        return try! JSONDecoder().decode(OutboxItem.self, from: Data(json.utf8))
    }

    @Test func `a thread's held reply wins over a copy-only draft; each is the conversation's own`() {
        let copy = ChatDraft(id: "md_1", chatId: "c1", sessionId: "s1", thread: "Reply to Dana", text: "Copy me", at: 5)
        let items = [held("h1", chat: "c1", at: 1), held("h2", chat: "c1", at: 3), held("h3", chat: "c2", at: 9), held("h4", chat: "c1", state: "sent", at: 10)]
        #expect(ChatThreadDraft.of(chatId: "c1", held: items, copies: [copy]) == .held(items[1]))
        #expect(ChatThreadDraft.of(chatId: "c1", held: items, copies: [copy])?.text == "Draft h2")
        #expect(ChatThreadDraft.of(chatId: "c1", held: [], copies: [copy]) == .copy(copy))
        #expect(ChatThreadDraft.of(chatId: "c3", held: items, copies: [copy]) == nil)
        #expect(ChatThreadDraft.chatId(items[2]) == "c2")
    }

    @Test func `a page of LifeOS's rows decodes, a new source and missing fields included`() throws {
        let json = #"{"page":[{"_id":"c1","source":"slack","account":"T1","channel":"D1","name":"Dana Lee","kind":"direct","sector":"cosmic","lastAt":5,"lastText":"Hi","lastWho":"Dana Lee","lastFromMe":false,"unread":true,"faces":[]},{"_id":"c2","source":"mastodon","name":"Fed","sector":"life","lastAt":1}],"isDone":true,"continueCursor":""}"#
        struct Page: Decodable { var page: [ChatRow] }
        let rows = try JSONDecoder().decode(Page.self, from: Data(json.utf8)).page
        #expect(rows.map(\.source) == [.slack, .other])
        #expect(rows[1].kind == .group && !rows[1].unread && rows[1].lastText.isEmpty)
        #expect(ReplyWay.of(rows[1].source, route: ChatRoute(can: true)) == .copy(why: "LifeOS can’t reply in Chat yet"))
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"_id":"m1","who":{"name":"Landon","me":true},"text":"On it.","sentAt":9,"files":[{"_id":"f1","name":"plan.pdf","status":"stored","url":"https://x"}],"reply":{"outboxId":"out_1","status":"queued"}}"#.utf8))
        #expect(message.who.me && message.files.first?.status == .stored && message.reply?.status == .queued)
    }

    @Test func `a lost Try Again settles from the read it asked for, even when the rows did not change`() {
        // The same failed row before and after: LifeOS never took it, Try Again is his again.
        let rows = [ChatReplyState(outboxId: "o1", status: .failed), ChatReplyState(outboxId: "o2", status: .queued)]
        let truths = RetryReadBack.truths(asked: ["o1", "o2", "o3"], rows: rows)
        #expect(truths["o1"] == .waiting(rev: nil))
        #expect(truths["o2"] == .done)
        // One the page no longer holds cannot be proven: May have gone, never "not sent".
        #expect(truths["o3"] == .mayHaveGone)
    }

    @Test func `a reply put back or refused in a conversation he left is said off it, named; on screen, only there`() {
        #expect(MessagesRules.offLine("Not sent: Docket left the screen", name: "Dana Lee", shown: false) == "Not sent to Dana Lee: Docket left the screen")
        #expect(MessagesRules.offLine("It may have gone. Check the conversation.", name: "Esports staff", shown: false) == "Esports staff: It may have gone. Check the conversation.")
        #expect(MessagesRules.offLine("Not sent: Slack's sign-in ended", name: "Dana Lee", shown: true) == nil)
    }

    @Test func `a reply read back late as not sent is said off its conversation, named or not`() {
        #expect(MessagesRules.lateLine(.done) == nil)
        #expect(MessagesRules.lateLine(.checking) == nil)
        #expect(MessagesRules.lateLine(.failed("Slack's sign-in ended")) == "Not sent: Slack's sign-in ended")
        #expect(MessagesRules.offLine(MessagesRules.lateLine(.stillWaiting)!, name: "Dana Lee", shown: false) == "Not sent to Dana Lee: the host never had it")
        // After a relaunch the name is gone: the reply is named instead.
        #expect(MessagesRules.offLine(MessagesRules.lateLine(.failed("refused"))!, name: "", shown: false) == "Reply not sent: refused")
        #expect(MessagesRules.offLine(MessagesRules.lateLine(.mayHaveGone)!, name: "", shown: false) == "A reply: It may have gone. Check the conversation before sending it again.")
        #expect(MessagesRules.offLine(MessagesRules.lateLine(.failed("refused"))!, name: "Dana Lee", shown: true) == nil)
    }
}
