import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// M3c: the hosted editor's native frame (HostedFrame.swift), Share (ShareRules.swift) and the clicker on the
/// host's show wire (ClickerHost.swift).
@Suite struct EditorFrameTests {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    // MARK: - the frame's bridge

    @Test func `the ticket's address asks for no chrome in its fragment, once`() {
        #expect(HostedBridge.framed("https://box.example/w/open#t=abc") == "https://box.example/w/open#t=abc&chrome=none")
        #expect(HostedBridge.framed("https://box.example/w/open") == "https://box.example/w/open#chrome=none")
        #expect(HostedBridge.framed("https://box.example/w/open#t=abc&chrome=none") == "https://box.example/w/open#t=abc&chrome=none")
    }

    @Test func `the page's three messages are read, and anything else is dropped`() throws {
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"drawn","v":1,"offers":{"format":true,"find":true,"undo":true}}"#)) == .drawn(HostedOffers(format: true, find: true, undo: true)))
        let state = try json(#"{"kind":"state","editing":true,"style":"Heading 1","styles":["Body","Heading 1",""],"bold":true,"italic":false,"list":"bullet","undo":true,"redo":false}"#)
        #expect(HostedFrameMessage.parse(state) == .state(HostedEditState(editing: true, style: "Heading 1", styles: ["Body", "Heading 1"], bold: true, italic: false, list: .bullet, undo: true, redo: false)))
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"found","query":"bus","count":7,"at":2}"#)) == .found(HostedFound(query: "bus", count: 7, at: 2)))
        // Not in the set, a version it does not know, a value of the wrong kind, a pick past the count.
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"navigate","url":"https://elsewhere"}"#)) == nil)
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"drawn","v":2,"offers":{}}"#)) == nil)
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"state","editing":"yes","bold":true,"italic":false,"undo":true,"redo":false,"styles":[]}"#)) == nil)
        #expect(HostedFrameMessage.parse(try json(#"{"kind":"found","query":"bus","count":2,"at":3}"#)) == nil)
        #expect(HostedFrameMessage.parse(try json(#""drawn""#)) == nil)
        // A list the frame does not know reads as none.
        if case .state(let read)? = HostedFrameMessage.parse(try json(#"{"kind":"state","editing":false,"style":null,"styles":[],"bold":false,"italic":false,"list":"roman","undo":false,"redo":false}"#)) {
            #expect(read.list == nil)
            #expect(read.style == nil)
        } else {
            Issue.record("a state with an unknown list is still a state")
        }
    }

    @Test func `each command is one closed message to the page's receiver`() throws {
        #expect(HostedCommand.bold.body == (try json(#"{"kind":"format","what":"bold"}"#)))
        #expect(HostedCommand.style("Heading 2").body == (try json(#"{"kind":"format","what":"style","style":"Heading 2"}"#)))
        #expect(HostedCommand.list(.number).body == (try json(#"{"kind":"format","what":"list","list":"number"}"#)))
        #expect(HostedCommand.search("bus \"7\"").body == (try json(#"{"kind":"find","what":"search","query":"bus \"7\""}"#)))
        #expect(HostedCommand.previous.body == (try json(#"{"kind":"find","what":"previous"}"#)))
        #expect(HostedCommand.clearFind.body == (try json(#"{"kind":"find","what":"clear"}"#)))
        #expect(HostedCommand.redo.body == (try json(#"{"kind":"redo"}"#)))
        let script = HostedCommand.undo.script
        #expect(script.hasPrefix("window.tcFrame && window.tcFrame.receive({"))
        #expect(script.hasSuffix("})"))
        // Words he typed reach the page as a JSON string, never as script.
        let found = HostedCommand.search("'); alert(1); ('").script
        let arg = String(found.dropFirst("window.tcFrame && window.tcFrame.receive(".count).dropLast())
        #expect((try json(arg))["query"]?.stringValue == "'); alert(1); ('")
    }

    @MainActor @Test func `the frame asks only for what the page offered, and fades in once it has drawn`() throws {
        let frame = HostedFrame()
        var ran: [String] = []
        frame.evaluate = { ran.append($0) }
        frame.run(.bold)
        #expect(ran.isEmpty, "nothing goes before the page says what it offers")
        #expect(!frame.drawn)
        frame.receive(try json(#"{"kind":"drawn","v":1,"offers":{"format":true,"find":false,"undo":true}}"#))
        #expect(frame.drawn)
        frame.run(.bold)
        frame.run(.search("bus"))
        frame.run(.style("Title"))
        #expect(ran.count == 1, "no find where the page finds nothing, no style it did not name")
        frame.receive(try json(#"{"kind":"state","editing":true,"style":"Body","styles":["Body","Title"],"bold":false,"italic":false,"list":null,"undo":true,"redo":false}"#))
        frame.run(.style("Title"))
        #expect(ran.count == 2)
        #expect(frame.formatRow)
        #expect(frame.canUndo)
        #expect(!frame.canRedo)
        // A new page in the same view starts again.
        frame.reset()
        #expect(!frame.drawn && !frame.formatRow && !frame.canUndo)
        // A page from before the bridge shows once it has loaded.
        frame.loaded()
        #expect(frame.drawn)
    }

    @MainActor @Test func `a find answer is kept and heard`() throws {
        let frame = HostedFrame()
        var heard: HostedFound?
        frame.onFound = { heard = $0 }
        frame.receive(try json(#"{"kind":"found","query":"bus","count":3,"at":1}"#))
        #expect(frame.found == HostedFound(query: "bus", count: 3, at: 1))
        #expect(heard == frame.found)
    }

    // MARK: - Share

    private func item(_ kind: String, _ source: String) throws -> CanvasItem {
        let json = #"{"id":"i1","sessionId":"s1","workspaceId":"w1","kind":"\#(kind)","title":"Travel memo","source":\#(source),"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#
        return try JSONDecoder().decode(CanvasItem.self, from: Data(json.utf8))
    }

    private func link(_ id: String, role: String = "edit", created: Int, expires: Int, revoked: Int? = nil, opened: Int? = nil, open: Int = 0) -> GuestLinkRow {
        let json = """
        {"id":"\(id)","name":"Dana Lee","source":{"at":"lifeos","table":"docs","id":"d1"},"title":"Plan","role":"\(role)",
         "createdAt":\(created),"expiresAt":\(expires),"revokedAt":\(revoked.map(String.init) ?? "null"),"by":"owner","lastOpenedAt":\(opened.map(String.init) ?? "null"),"open":\(open)}
        """
        return try! JSONDecoder().decode(GuestLinkRow.self, from: Data(json.utf8))
    }

    @Test func `Share takes a LifeOS document or sheet and a TempCode one kept as a file`() throws {
        #expect(ShareSource.of(try item("document", #"{"at":"lifeos","table":"docs","id":"d1"}"#)) == .lifeos(.docs, id: "d1"))
        #expect(ShareSource.of(try item("sheet", #"{"at":"file","host":"box","path":"/w/Budget.tcsheet"}"#)) == .file(host: "box", path: "/w/Budget.tcsheet"))
        #expect(ShareSource.of(try item("document", #"{"at":"lifeos","table":"outbox","id":"o1"}"#)) == nil)
        #expect(ShareSource.of(try item("pdf", #"{"at":"file","host":"box","path":"/w/Plan.tcdoc"}"#)) == nil)
        // One press on its way per item: a ref of its own.
        #expect(ShareSource.lifeos(.docs, id: "d1").ref == "guest:docs:d1")
        #expect(ShareSource.file(host: "box", path: "/w/A.tcdoc").ref == "guest:file:box:/w/A.tcdoc")
    }

    @Test func `More offers Undo, Redo and Find for the hosted page, and Share for a file kept as a TempCode document`() throws {
        let document = try item("document", #"{"at":"lifeos","table":"docs","id":"d1"}"#)
        #expect(ReaderVerbs.of(document, ReaderFacts(comments: true, finds: true, undo: true)) == [.undo, .find, .comments])
        #expect(ReaderVerbs.of(document, ReaderFacts(undo: true, redo: true)) == [.undo, .redo])
        #expect(ReaderVerbs.of(document, ReaderFacts()) == [])
        let memo = try item("document", #"{"at":"file","host":"box","path":"/w/Travel memo.tcdoc"}"#)
        #expect(ReaderVerbs.of(memo, ReaderFacts(mayGuestLink: true)) == [.guestLink])
        #expect(ReaderVerbs.of(try item("document", #"{"at":"file","host":"box","path":"/w/Letter.docx"}"#), ReaderFacts(mayGuestLink: true)) == [])
        #expect(ReaderVerb.guestLink.title == "Share…")
        let deck = try item("slides", #"{"at":"file","host":"box","path":"/w/Nationals kickoff.pptx"}"#)
        #expect(ReaderVerbs.of(deck, ReaderFacts(showing: true)) == [.clicker, .find, .print])
        #expect(ReaderVerbs.of(deck, ReaderFacts()) == [.find, .print])
        #expect(ReaderVerbs.of(document, ReaderFacts(showing: true)) == [])
    }

    @Test func `the roles and refusals are the host's own`() throws {
        struct Rules: Decodable {
            struct Row: Decodable {
                struct Source: Decodable { let at: String; let table: String?; let path: String? }
                let source: Source
                let table: String?
                let roles: [String]
            }
            let refusals: [String]
            let sources: [Row]
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/share/rules.json")
        let rules = try JSONDecoder().decode(Rules.self, from: Data(contentsOf: url))
        #expect(ShareRules.refusals == rules.refusals)
        for row in rules.sources {
            let source: ShareSource = row.source.at == "lifeos" ? .lifeos(ShareSource.Table(rawValue: row.source.table!)!, id: "x") : .file(host: "box", path: row.source.path!)
            #expect(source.table?.rawValue == row.table)
            if row.table != nil { #expect(source.roles.map(\.rawValue) == row.roles) }
        }
        // A refusal is found inside whatever came before it.
        #expect(ShareRules.refusal(in: "bad request: This file lives in Teams. Share it from Teams.") == "This file lives in Teams. Share it from Teams.")
        #expect(ShareRules.refusal(in: "did not make the link") == nil)
        // The host's "workspace" is the phone's job.
        #expect(ShareRules.refusal(in: "Guests reach files on the box only. Keep this file in a workspace on the box to share it.") == "Guests reach files on the box only. Keep this file in a job on the box to share it.")
        #expect(ShareRules.elsewhere("served elsewhere: env_box") == "env_box")
        #expect(ShareRules.elsewhere("work.guests.forItem: served elsewhere: env_mac (try there)") == "env_mac")
        #expect(ShareRules.elsewhere("refused") == nil)
    }

    @Test func `the item's live links, newest first, each in one line`() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "en_US")
        let nov20 = 1_795_132_800_000 // Fri Nov 20 2026, 00:00 UTC
        let dayMs = 86_400_000
        let now = Date(timeIntervalSince1970: Double(nov20 + 3 * dayMs) / 1000)
        let made = link("a", created: nov20, expires: nov20 + 30 * dayMs, opened: nov20 + 2 * dayMs + 15 * 3_600_000 + 10 * 60_000)
        let newer = link("b", role: "view", created: nov20 + dayMs, expires: nov20 + 7 * dayMs, open: 1)
        let ended = link("c", created: nov20, expires: nov20 + dayMs)
        let revoked = link("d", created: nov20, expires: nov20 + 30 * dayMs, revoked: nov20 + dayMs)
        #expect(ShareRules.live([made, ended, newer, revoked], now: now).map(\.id) == ["b", "a"])
        #expect(ShareRules.facts(made, roles: 3, calendar: utc, locale: locale) == "Edit · made Nov 20 · opened Nov 22, 3:10 PM · until Dec 20")
        #expect(ShareRules.facts(newer, roles: 1, calendar: utc, locale: locale) == "made Nov 21 · in it now · until Nov 27")
        #expect(ShareRules.facts(ended, roles: 2, calendar: utc, locale: locale).contains("not opened yet"))
    }

    @Test func `a repeat of Create link's key is the link with no address`() {
        let row = link("a", created: 1, expires: 2)
        #expect(ShareRules.made(.init(link: row, url: "https://s/g/a#k=1")) == .address("https://s/g/a#k=1", link: row))
        #expect(ShareRules.made(.init(link: row, again: true)) == .again(row))
        #expect(ShareRules.newAttempt().count >= 8)
        #expect(ShareRules.newAttempt() != ShareRules.newAttempt())
    }

    @Test func `a lost Create link reads back by its key`() throws {
        func attempt(_ text: String) throws -> GuestAttempt { try JSONDecoder().decode(GuestAttempt.self, from: Data(text.utf8)) }
        #expect(PressTruth.guest(try attempt(#"{"state":"made","linkId":"a"}"#)) == .done)
        #expect(PressTruth.guest(try attempt(#"{"state":"none"}"#)) == .waiting(rev: nil))
        #expect(PressTruth.guest(try attempt(#"{"state":"making"}"#)) == nil)
        #expect(PressTruth.guest(try attempt(#"{"state":"refused","words":"LifeOS did not mark it"}"#)) == .failed("LifeOS did not mark it"))
        #expect(PressTruth.guest(try attempt(#"{"state":"unknown","words":"restarted"}"#)) == .mayHaveGone)
    }

    // MARK: - the clicker

    private func live(_ showId: String = "show-0001", item: String = "deck1", rev: Int, slide: Int = 4, ended: Bool = false) throws -> ShowLive {
        let text = """
        {"showId":"\(showId)","itemId":"\(item)","title":"Nationals kickoff","rev":\(rev),"slide":\(slide),"count":12,"step":0,"steps":0,
         "next":{"kind":"slide","number":5,"title":"Check-in"},"notes":"Check-in runs at the CoRec.","timer":{"elapsed":60000,"paused":false,"target":null},
         "blank":false,"ended":\(ended)}
        """
        return try JSONDecoder().decode(ShowLive.self, from: Data(text.utf8))
    }

    @Test func `a running show reads as the clicker's show, and an ended one as none`() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let show = try #require(ClickerShow(try live(rev: 9), now: now))
        #expect(show.itemId == "deck1")
        #expect(show.name == "Nationals kickoff")
        #expect(show.position == "4 / 12")
        #expect(show.slideNotes == "Check-in runs at the CoRec.")
        // The timer's start, the time he has talked back from now (a date keeps its seconds from 2001: within a millisecond).
        #expect(abs((show.startedAt ?? 0) - (1_000_000 - 60_000)) < 1)
        #expect(show.rev == 9)
        #expect(ClickerShow(try live(rev: 9, ended: true), now: now) == nil)
    }

    @Test func `each press goes as the host's word`() {
        #expect(ClickerPress.next.act == .next)
        #expect(ClickerPress.previous.act == .prev)
        #expect(ClickerPress.blank.act == .blank)
        #expect(ClickerPress.end.act == .end)
    }

    @Test func `the row picks the newest show that runs, of the deck when one is named`() throws {
        let a = try live("show-a", item: "deck1", rev: 3)
        let b = try live("show-b", item: "deck2", rev: 8)
        let over = try live("show-c", item: "deck1", rev: 20, ended: true)
        #expect(ShowRows.running([a, b, over])?.showId == "show-b")
        #expect(ShowRows.running([a, b, over], itemId: "deck1")?.showId == "show-a")
        #expect(ShowRows.running([over]) == nil)
        #expect(ShowRows.title(computer: "MacBook") == "Showing on MacBook")
        #expect(ShowRows.detail(a) == "Nationals kickoff · 4 of 12")
    }
}
