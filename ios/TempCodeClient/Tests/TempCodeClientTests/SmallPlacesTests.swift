import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct SmallPlacesTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func play(_ takes: String, proposed: Bool = false) throws -> PlayPhoneRow {
        try decode(PlayPhoneRow.self, #"{"id":"p","workspaceId":"w","name":"Recap","instructions":"x","takes":[\#(takes)],"proposed":\#(proposed),"host":"box"}"#)
    }

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    // MARK: plays

    @Test func `a play runs here only when it takes text, a date or nothing, and never a proposal`() throws {
        #expect(PlayRun.runsHere(try play("")))
        #expect(PlayRun.runsHere(try play(#""text","date""#)))
        #expect(!PlayRun.runsHere(try play(#""mail""#)))
        #expect(!PlayRun.runsHere(try play(#""text""#, proposed: true)))
    }

    @Test func `a start waits for each thing it takes and hands over only those`() throws {
        let both = try play(#""text","date""#)
        let day = Date(timeIntervalSince1970: 1_795_564_800) // 2026-11-25 UTC
        #expect(PlayRun.inputs(both, text: "  ", date: day, calendar: utc) == nil)
        #expect(PlayRun.inputs(both, text: "Spring LAN", date: nil, calendar: utc) == nil)
        #expect(PlayRun.inputs(both, text: " Spring LAN ", date: day, calendar: utc) == .init(text: "Spring LAN", date: "2026-11-25"))
        #expect(PlayRun.inputs(try play(""), text: "ignored", date: day, calendar: utc) == .init())
        #expect(PlayRun.inputs(try play(#""mail""#), text: "x", date: day, calendar: utc) == nil)
    }

    @Test func `the takes line says what a play takes, as the desktop does`() {
        #expect(PlayRun.takesLine([]) == nil)
        #expect(PlayRun.takesLine([.mail]) == "Takes a mail")
        #expect(PlayRun.takesLine([.event, .date, .text]) == "Takes an event, a date and a line of text")
    }

    // MARK: runs

    private func run(_ state: String, summary: String = "", folded: Int = 0) throws -> RoutineRunPhone {
        try decode(RoutineRunPhone.self, #"{"id":"r","routineId":"x","sessionId":"s","firedAt":1795464000000,"cause":"Run now","folded":\#(folded),"state":"\#(state)","summary":"\#(summary)"}"#)
    }

    @Test func `a run's words and mark follow the desktop's`() throws {
        #expect(RoutineRuns.words(try run("running")) == "Running")
        #expect(RoutineRuns.mark(try run("starting")) == .working)
        #expect(RoutineRuns.words(try run("failed", summary: "Failed: LifeOS did not answer")) == "LifeOS did not answer")
        #expect(RoutineRuns.words(try run("failed")) == "Did not finish")
        #expect(RoutineRuns.mark(try run("failed")) == .failed)
        #expect(RoutineRuns.words(try run("held", summary: "Held 3", folded: 2)) == "Held 3, covers 3")
        #expect(RoutineRuns.words(try run("quiet")) == "Done")
        #expect(RoutineRuns.mark(try run("asked")) == .waiting)
    }

    @Test func `runs that fail to read again keep the last runs under the failure`() throws {
        let kept = [try run("quiet")]
        let failed = RoutineRuns.fold(failed: "The box did not answer", kept: kept)
        #expect(failed == .init(failed: "The box did not answer", runs: kept, noneYet: false, reading: false))
        #expect(RoutineRuns.fold(failed: nil, kept: kept) == .init(failed: nil, runs: kept, noneYet: false, reading: false))
        #expect(RoutineRuns.fold(failed: nil, kept: []).noneYet)
        // A failure over a read that found none: the failure alone, never "None yet" under it.
        #expect(!RoutineRuns.fold(failed: "The box did not answer", kept: []).noneYet)
        #expect(RoutineRuns.fold(failed: nil, kept: nil).reading)
        #expect(!RoutineRuns.fold(failed: "The box did not answer", kept: nil).reading)
    }

    @Test func `Run Now is offered on a routine that has not ended and is not running`() throws {
        let row = { (running: Bool, ended: Bool) in
            try self.decode(RoutinePhoneRow.self, #"{"id":"r","workspaceId":"w","kind":"routine","name":"n","words":"w","ends":{"kind":"never"},"enabled":true,"proposed":false,"nextAt":null,"lastAt":null,"running":\#(running),"ended":\#(ended),"waiting":null}"#)
        }
        #expect(RoutineRuns.runsNow(try row(false, false)))
        #expect(!RoutineRuns.runsNow(try row(true, false)))
        #expect(!RoutineRuns.runsNow(try row(false, true)))
    }

    // MARK: templates

    @Test func `a template's fields go trimmed, only its own, and an empty one stays as written`() throws {
        let template = try decode(TemplatePhone.self, #"{"id":"job:Invoice.docx","name":"Invoice","kind":"document","form":"docx","where":"job","fields":["Client","PO"]}"#)
        #expect(TemplateFill.fields(["Client": " Purdue ", "PO": "  ", "Other": "x"], of: template) == ["Client": "Purdue"])
        #expect(TemplateFill.day(Date(timeIntervalSince1970: 1_795_564_800), calendar: utc) == "2026-11-25")
        let made = try decode(Methods.WorkTemplatesMake.Output.self, #"{"kind":"document","title":"Invoice","unfilled":["PO"]}"#)
        #expect(TemplateFill.madeWords(made) == "Made Invoice. PO is left to fill")
        #expect(TemplateFill.glyph(.sheet) == "tablecells")
    }

    // MARK: forms

    @Test func `Close is offered on an open form and Reopen on a closed one only for a key that may reopen`() throws {
        let ours = { (state: String) in try self.decode(FormListPhoneRow.self, #"{"id":"i","title":"RSVP","state":"\#(state)","updatedAt":1}"#) }
        #expect(FormsList.presses(try ours("open"), mayClose: true, mayReopen: false) == [.close])
        #expect(FormsList.presses(try ours("closed"), mayClose: true, mayReopen: false) == [])
        #expect(FormsList.presses(try ours("closed"), mayClose: true, mayReopen: true) == [.reopen])
        #expect(FormsList.presses(try ours("draft"), mayClose: true, mayReopen: true) == [])
        #expect(FormsList.stamp(try ours("open")) == "Open")
        let ms = try decode(MsFormPhoneRow.self, #"{"formId":"f","tenant":"t","title":"Survey","state":"collecting","count":3,"link":null,"unseen":2}"#)
        #expect(FormsList.presses(ms, mayClose: false, mayReopen: true) == [])
        #expect(FormsList.presses(ms, mayClose: true, mayReopen: false) == [.close])
        #expect(FormsList.stamp(ms) == "3 responses, 2 new")
        #expect(FormsList.answersHere(ms))
        // A host before the unseen count says the stamp it said before.
        let older = try decode(MsFormPhoneRow.self, #"{"formId":"f","tenant":"t","title":"Survey","state":"closed","count":1,"link":null}"#)
        #expect(FormsList.stamp(older) == "Closed, 1 response")
        #expect(FormsList.presses(older, mayClose: true, mayReopen: true) == [.reopen])
    }

    @Test func `KeyMay draws Reopen only for a key with operate and approve, as the host's check asks`() {
        let operate = KeyMay(caps: [.read, .operate])
        let both = KeyMay(caps: [.read, .operate, .approve])
        let admin = KeyMay(caps: [.read, .admin])
        #expect(operate(.formsClose) && operate(.msformsClose))
        #expect(!operate(.formsReopen) && !operate(.msformsReopen))
        #expect(both(.formsReopen) && both(.msformsReopen))
        // admin passes the door but is not the word approve
        #expect(!admin(.formsReopen))
    }

    @Test func `the answers line says when they were read and when the last read fell short`() throws {
        let answers = { (stale: Bool) in try self.decode(MsFormResponsesPhone.self, #"{"rev":1,"columns":[],"rows":[],"count":0,"cut":false,"at":1795464000000,"stale":\#(stale),"none":false}"#) }
        let now = Date(timeIntervalSince1970: 1_795_465_000)
        #expect(FormsList.readLine(try answers(false), now: now, calendar: utc)?.hasPrefix("Read at ") == true)
        #expect(FormsList.readLine(try answers(true), now: now, calendar: utc)?.hasSuffix("The newest answers did not load.") == true)
    }

    // MARK: connections

    private func report(_ host: String, _ rows: String) throws -> HealthReportPhone {
        try decode(HealthReportPhone.self, #"{"host":"\#(host)","at":1,"rows":[\#(rows)]}"#)
    }

    @Test func `rows group in the desktop's order, a shared row shows once and a title two hosts give names its host`() throws {
        let shared = #"{"id":"lifeos.source:mail","group":"LifeOS","title":"Purdue mail","state":"working","shared":true}"#
        let mac = try report("mac", [#"{"id":"office.excel","group":"Office","title":"Excel","state":"broken","line":"Not installed"}"#, shared].joined(separator: ","))
        let box = try report("box", [#"{"id":"office.excel","group":"Office","title":"Excel","state":"working"}"#, shared, #"{"id":"winvm.eval","group":"Windows VM","title":"Windows","state":"needs-you"}"#].joined(separator: ","))
        let sections = Connections.sections([.init(id: "mac", name: "Mac", report: mac), .init(id: "box", name: "the box", report: box)])
        #expect(sections.map(\.group) == ["LifeOS", "Office", "Windows VM"])
        #expect(sections[0].rows.count == 1)
        #expect(sections[1].rows.map(\.title) == ["Excel on Mac", "Excel on the box"])
        #expect(sections[2].rows.map(\.title) == ["Windows"])
        #expect(Connections.reveals(sections[1].rows[0]) && !Connections.reveals(sections[1].rows[1]))
        #expect(sections.map(\.headed) == [true, true, true])
    }

    @Test func `a group whose one row bears its name draws no band`() throws {
        let mac = try report("mac", [#"{"id":"lifeos","group":"LifeOS","title":"LifeOS","state":"needs-you","line":"Not signed in to LifeOS"}"#, #"{"id":"tools.ffmpeg","group":"Tools","title":"ffmpeg","state":"working"}"#].joined(separator: ","))
        let sections = Connections.sections([.init(id: "mac", name: "Mac", report: mac)])
        #expect(sections.map(\.group) == ["LifeOS", "Tools"])
        #expect(sections.map(\.headed) == [false, true])
    }

    @Test func `the foot shows Connections while a row does not work or an end is near`() throws {
        let fine = try report("box", #"{"id":"a","group":"Tools","title":"ffmpeg","state":"working"}"#)
        let now = Date(timeIntervalSince1970: 1_795_564_800)
        let far = LapsePhone(id: "eval", title: "Windows evaluation", until: (now.timeIntervalSince1970 + 30 * 86_400) * 1000)
        let near = LapsePhone(id: "eval", title: "Windows evaluation", until: (now.timeIntervalSince1970 + 3 * 86_400) * 1000)
        #expect(!Connections.needsHim([.init(id: "box", name: "box", report: fine, lapses: [far])], now: now))
        #expect(Connections.needsHim([.init(id: "box", name: "box", report: fine, lapses: [near])], now: now))
        let broken = try report("box", #"{"id":"a","group":"Tools","title":"ffmpeg","state":"needs-you"}"#)
        #expect(Connections.needsHim([.init(id: "box", name: "box", report: broken)], now: now))
        #expect(!Connections.needsHim([.init(id: "box", name: "box", report: nil)], now: now))
        // A failed health or ending-soon check keeps the row, its Try Again inside; a host away alone does not.
        #expect(Connections.needsHim([], missed: [.failed("The box did not answer.")], now: now))
        #expect(Connections.needsHim([.init(id: "box", name: "box", report: fine)], missed: [.lapses], now: now))
        #expect(!Connections.needsHim([.init(id: "box", name: "box", report: fine)], missed: [.away], now: now))
        #expect(Connections.ending([.init(id: "box", name: "box", report: fine, lapses: [far, near])], now: now).map(\.lapse.until) == [near.until])
        // Two hosts that name the same end keep a row each, apart by key.
        let both = Connections.ending([.init(id: "box", name: "box", report: fine, lapses: [near]), .init(id: "mac", name: "Mac", report: fine, lapses: [near])], now: now)
        #expect(Set(both.map(\.key)).count == 2)
    }

    @Test func `an end reads today, tomorrow, a day, or ended`() {
        let now = Date(timeIntervalSince1970: 1_795_564_800) // 2026-11-25 00:00 UTC
        #expect(Connections.lapseLine(until: (now.timeIntervalSince1970 + 3_600) * 1000, now: now, calendar: utc).hasPrefix("Ends today, "))
        #expect(Connections.lapseLine(until: (now.timeIntervalSince1970 + 86_400 + 60) * 1000, now: now, calendar: utc).hasPrefix("Ends tomorrow, "))
        #expect(Connections.lapseLine(until: (now.timeIntervalSince1970 - 60) * 1000, now: now, calendar: utc).hasPrefix("Ended "))
        #expect(Connections.word(.needsYou) == "Needs you")
    }

    // MARK: the VM

    private func vm(_ state: String, cannot: String? = nil, held: Bool? = nil, step: String? = nil) throws -> WinvmStatePhone {
        let cannotJSON = cannot.map { "\"\($0)\"" } ?? "null"
        let stepJSON = step.map { "\"\($0)\"" } ?? "null"
        let heldJSON = held.map { ",\"heldAsleep\":\($0)" } ?? ""
        return try decode(WinvmStatePhone.self, #"{"state":"\#(state)","step":\#(stepJSON),"error":null,"cannot":\#(cannotJSON),"since":1\#(heldJSON)}"#)
    }

    @Test func `the VM shows where it is kept, offers Wake asleep and Sleep awake, nothing between`() throws {
        #expect(!WinvmWords.shows(nil))
        #expect(!WinvmWords.shows(try vm("none")))
        #expect(!WinvmWords.shows(try vm("asleep", cannot: "Not the box")))
        #expect(WinvmWords.shows(try vm("asleep")))
        #expect(WinvmWords.press(try vm("asleep")) == .wake)
        #expect(WinvmWords.press(try vm("awake")) == .sleep)
        #expect(WinvmWords.press(try vm("waking")) == nil)
        #expect(WinvmWords.moving(try vm("going-to-sleep")))
        #expect(WinvmWords.line(try vm("waking", step: "Waking the Windows VM")) == "Waking the Windows VM")
        #expect(WinvmWords.line(try vm("asleep", held: true)) == "Asleep until you wake it")
    }

    @Test func `the VM's push replaces the host's state`() throws {
        let push = try decode(ServerPush.self, #"{"push":"work.winvm","state":{"state":"awake","step":null,"error":null,"cannot":null,"since":5}}"#)
        guard case .workWinvm(let value) = push else { Issue.record("not the VM's push"); return }
        #expect(value.state.state == .awake)
        let plays = try decode(ServerPush.self, #"{"push":"work.routines.plays","workspaceId":"w1"}"#)
        guard case .workRoutinesPlays(let changed) = plays else { Issue.record("not the plays' push"); return }
        #expect(changed.workspaceId == "w1")
    }

    // MARK: dashboards and LifeOS documents

    @Test func `a block opens its LifeOS sheet or its form's answers, never a file on a host`() throws {
        let block = try decode(DashBlockPhone.self, #"{"id":"b","kind":"figures","figures":[{"id":"f0","label":"Seats","value":"12","from":{"counts":"entrants"}},{"id":"f1","label":"Owed","value":"$40","from":{"counts":"Amount","sheetTitle":"Ledger","sheet":{"at":"lifeos","table":"sheets","id":"sh1"}}}]}"#)
        #expect(DashSource.of(block) == .lifeosSheet(id: "sh1", title: "Ledger"))
        let chart = try decode(DashBlockPhone.self, #"{"id":"c","kind":"chart","title":"Sign-ups","bars":[],"from":{"counts":"Day","sheet":{"at":"msform","host":"box","workspaceId":"w","formId":"f","tenant":"t"}}}"#)
        #expect(DashSource.of(chart) == .msform(workspaceId: "w", formId: "f"))
        let table = try decode(DashBlockPhone.self, #"{"id":"t","kind":"table","title":"Budget","head":[],"rows":[],"numeric":[],"from":{"counts":"x","sheet":{"at":"file","host":"box","path":"/w/Budget.tcsheet"}}}"#)
        #expect(DashSource.of(table) == nil)
        // A host before the block named its sheet opens nothing.
        let older = try decode(DashBlockPhone.self, #"{"id":"t","kind":"table","title":"Budget","head":[],"rows":[],"numeric":[]}"#)
        #expect(DashSource.of(older) == nil)
    }

    @Test func `a project's LifeOS document or sheet opens in the hosted editor as an item's does`() {
        let doc = LifeDocItem.item(.document, id: "d1", title: "Run of show", workspaceId: "w")
        #expect(ItemBody.of(doc) == .hosted(.object(.init(at: "lifeos", table: .docs, id: "d1"))))
        let sheet = LifeDocItem.item(.sheet, id: "s1", title: "Budget", workspaceId: "w")
        #expect(ItemBody.of(sheet) == .hosted(.object(.init(at: "lifeos", table: .sheets, id: "s1"))))
        #expect(doc.id != sheet.id)
    }

    /// A Work host whose checks did not come back is named, never read as "Nothing to Check": away, its read failed
    /// with the time of the rows kept for it, its ends did not come, or several by name.
    @Test func connectionsNameEveryHostTheyMissed() {
        #expect(Connections.missedLine([]) == nil)
        #expect(Connections.missedLine([(name: "The box", why: .away, keptAt: nil)]) == "Not connected to the box.")
        #expect(Connections.missedLine([(name: "The box", why: .failed("It did not answer in time"), keptAt: "2:10 PM")])
                == "The box did not answer: It did not answer in time. Showing what it said at 2:10 PM.")
        #expect(Connections.missedLine([(name: "Mac", why: .lapses, keptAt: nil)]) == "Mac did not say what ends soon.")
        // A failure Work has no words for (the host's raw text) says only that the host did not answer.
        #expect(Connections.missedLine([(name: "Mac", why: .failed(""), keptAt: nil)]) == "Mac did not answer.")
        #expect(Connections.missedLine([(name: "Mac", why: .away, keptAt: nil), (name: "The box", why: .lapses, keptAt: nil)]) == "Mac and The box were not checked.")
    }

    @Test func `a recent check stands only while the linked computers are the ones it asked`() {
        let at = Date(timeIntervalSince1970: 1_000_000)
        let soon = at.addingTimeInterval(60)
        #expect(Connections.reuses(readAt: at, now: soon, stands: 300, linked: ["box", "mac"], asked: ["box", "mac"]))
        #expect(!Connections.reuses(readAt: nil, now: soon, stands: 300, linked: ["box"], asked: ["box"]))
        #expect(!Connections.reuses(readAt: at, now: at.addingTimeInterval(301), stands: 300, linked: ["box"], asked: ["box"]))
        // One linked since said nothing in it; one gone since must be named away.
        #expect(!Connections.reuses(readAt: at, now: soon, stands: 300, linked: ["box", "mac"], asked: ["box"]))
        #expect(!Connections.reuses(readAt: at, now: soon, stands: 300, linked: ["box"], asked: ["box", "mac"]))
    }
}
