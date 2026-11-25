import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The reader's M3b rules: a PDF's highlights and fields (`PdfBox`, `PdfLayerName`, `PdfFields`), a meeting's
/// recording and tasks (`MeetingRecording`, `MeetingActions`), history's Restore (`HistoryRestore`), Ask landing on
/// Chat (`AskLanding`), an open file's title (`ReaderVerbs.title(of:)`) and its two halves on the Duo (`ReaderHalves`).
struct ReaderLayerTests {
    // MARK: a PDF's boxes

    private let letter = CGRect(x: 0, y: 0, width: 612, height: 792)

    @Test func `a box as shares of the page, top left, lands in the page's own space, bottom left`() throws {
        let rect = try #require(PdfBox.rect([0.1, 0.25, 0.5, 0.3], page: letter))
        #expect(abs(rect.minX - 61.2) < 0.001)
        #expect(abs(rect.width - 244.8) < 0.001)
        // 25% down from the top is 75% up from the bottom: the box's top edge.
        #expect(abs(rect.maxY - 594) < 0.001)
        #expect(abs(rect.height - 39.6) < 0.001)
    }

    @Test func `a page whose crop box does not start at zero keeps its offset`() throws {
        let cropped = CGRect(x: 18, y: 36, width: 576, height: 720)
        let rect = try #require(PdfBox.rect([0, 0, 1, 1], page: cropped))
        #expect(rect == cropped)
    }

    @Test func `a box and its shares go there and back`() throws {
        let box = [0.125, 0.5, 0.375, 0.625]
        let rect = try #require(PdfBox.rect(box, page: letter))
        let back = try #require(PdfBox.share(rect, page: letter))
        for (a, b) in zip(box, back) { #expect(abs(a - b) < 0.000_001) }
    }

    @Test func `a box with no area, the wrong length, or off the page is none`() {
        #expect(PdfBox.rect([0.5, 0.5, 0.5, 0.6], page: letter) == nil)
        #expect(PdfBox.rect([0.1, 0.2, 0.3], page: letter) == nil)
        #expect(PdfBox.share(CGRect(x: 700, y: 0, width: 20, height: 20), page: letter) == nil)
        #expect(PdfBox.share(.zero, page: .zero) == nil)
    }

    @Test func `a selection's lines become one box each, held to the page and capped at the host's 200`() {
        let lines = (0..<250).map { CGRect(x: -10, y: Double($0), width: 100, height: 1) }
        let quads = PdfBox.quads(lines: lines, page: letter)
        #expect(quads.count == 200)
        // The line ran past the page's left edge: it starts at the edge.
        #expect(quads.first?.first == 0)
    }

    // MARK: names and picks

    @Test func `the reader's annotations are named for their highlight or field, and a tap finds them again`() {
        #expect(PdfLayerName.pick(name: PdfLayerName.mark("m1")) == .mark("m1"))
        #expect(PdfLayerName.pick(name: PdfLayerName.field("Name of entity")) == .field("Name of entity"))
        #expect(PdfLayerName.ours(PdfLayerName.mark("m1")))
        #expect(!PdfLayerName.ours("Someone else's note"))
        #expect(!PdfLayerName.ours(nil))
        // A widget of the file is a field only when the host's view names it.
        #expect(PdfLayerName.pick(name: nil, widget: "f1", fields: ["f1"]) == .field("f1"))
        #expect(PdfLayerName.pick(name: nil, widget: "f2", fields: ["f1"]) == nil)
        #expect(PdfLayerName.pick(name: "tc-mark:") == nil)
    }

    // MARK: fields

    private func field(_ key: String, type: String = "text", page: Int = 1, top: Double = 0.1, value: PdfFieldPhone.Value? = nil, proposed: PdfFieldPhone.Proposed? = nil, state: PdfFieldPhone.State = .empty, from: [PdfFieldPhone.Provenance] = []) -> PdfFieldPhone {
        PdfFieldPhone(key: key, label: key.capitalized, type: type, page: page, bbox: [0.1, top, 0.5, top + 0.02], value: value, proposed: proposed, state: state, provenance: from)
    }

    @Test func `a field shows the agent's value while it waits, else the value the copy will carry`() {
        #expect(PdfFields.shown(field("a", value: .string("Old"), proposed: .string("New"), state: .proposed)) == "New")
        #expect(PdfFields.shown(field("a", value: .string("Typed"), state: .accepted)) == "Typed")
        #expect(PdfFields.shown(field("a")) == nil)
        #expect(PdfFields.shown(field("c", type: "checkbox", value: .bool(true), state: .accepted)) == PdfFields.checked)
        #expect(PdfFields.shown(field("c", type: "checkbox", value: .bool(false), state: .accepted)) == nil)
    }

    @Test func `the values that wait come in reading order: page, then top, then left`() {
        let fields = [
            field("p2", page: 2, top: 0.1, proposed: .string("x"), state: .proposed),
            field("low", top: 0.6, proposed: .string("x"), state: .proposed),
            field("high", top: 0.2, proposed: .string("x"), state: .proposed),
            field("done", top: 0.1, value: .string("x"), state: .accepted)
        ]
        #expect(PdfFields.waiting(fields).map(\.key) == ["high", "low", "p2"])
        #expect(PdfFields.waitingWords(1) == "1 value to check")
        #expect(PdfFields.waitingWords(3) == "3 values to check")
    }

    @Test func `where a value came from is one line, its words quoted when there are some`() {
        #expect(PdfFields.source(field("a", from: [.init(label: "Purdue profile", quote: " Landon Hale ")])) == "From Purdue profile: “Landon Hale”")
        #expect(PdfFields.source(field("a", from: [.init(label: "Typed")])) == "From Typed")
        #expect(PdfFields.source(field("a")) == nil)
    }

    @Test func `he types a field's value, never a signature or the day he signed`() {
        #expect(PdfFields.fills(field("t")))
        #expect(PdfFields.fills(field("c", type: "checkbox")))
        #expect(PdfFields.fills(field("ch", type: "choice")))
        #expect(PdfFields.fills(field("d", type: "date")))
        #expect(!PdfFields.fills(field("d", type: "date", state: .needsOwner)))
        #expect(!PdfFields.fills(field("s", type: "signature")))
        #expect(!PdfFields.fills(field("x", type: "stamp")))
    }

    @Test func `his words go to the host as the field's value: a checkbox on or off, an empty field null`() {
        #expect(PdfFields.value("  Hale  ", for: field("t")) == .string("Hale"))
        #expect(PdfFields.value("   ", for: field("t")) == nil)
        #expect(PdfFields.value(PdfFields.checked, for: field("c", type: "checkbox")) == .bool(true))
        #expect(PdfFields.value("", for: field("c", type: "checkbox")) == .bool(false))
        #expect(PdfFields.field(named: "t", in: [field("t")])?.key == "t")
        #expect(PdfFields.field(named: nil, in: [field("t")]) == nil)
    }

    // MARK: a meeting's recording

    @Test func `the phone plays what the system's player opens, and a WebM plays on the computer`() {
        #expect(MeetingRecording.type(of: "Standup.m4a") == "com.apple.m4a-audio")
        #expect(MeetingRecording.type(of: "Call.MOV") == "com.apple.quicktime-movie")
        #expect(MeetingRecording.type(of: "Call.mp4") == "public.mpeg-4")
        #expect(MeetingRecording.type(of: "Call.webm") == nil)
        #expect(MeetingRecording.type(of: "notes") == nil)
    }

    @Test func `a player's request is read in chunks, none past the end`() {
        let chunk = 4
        #expect(MeetingRecording.ranges(offset: 0, length: 10, size: 100, chunk: chunk) == [0..<4, 4..<8, 8..<10])
        #expect(MeetingRecording.ranges(offset: 96, length: 10, size: 100, chunk: chunk) == [96..<100])
        #expect(MeetingRecording.ranges(offset: 100, length: 10, size: 100, chunk: chunk).isEmpty)
        #expect(MeetingRecording.ranges(offset: 0, length: 0, size: 100, chunk: chunk).isEmpty)
        #expect(MeetingRecording.chunk == 2 * 1024 * 1024)
    }

    // MARK: a meeting's tasks

    private func meeting(_ actions: [MeetingPhone.Notes.Action]?) -> MeetingPhone {
        MeetingPhone(itemId: "m1", title: "Standup", status: "ready", durationSec: 600, speakers: [], segments: [], notes: actions.map { MeetingPhone.Notes(actions: $0) })
    }

    @Test func `the tasks that wait come first, a dropped one is not shown, and the bar counts the waiting`() {
        let m = meeting([
            .init(id: "a1", text: "Book the bus", state: .filed, at: 12),
            .init(id: "a2", text: "Send the roster", due: "2026-12-01", state: .proposed, at: 40),
            .init(id: "a3", text: "Drop me", state: .rejected, at: nil)
        ])
        #expect(MeetingActions.waiting(m).map(\.id) == ["a2"])
        #expect(MeetingActions.shown(m).map(\.id) == ["a2", "a1"])
        #expect(MeetingActions.addWords(1) == "Add 1 Task")
        #expect(MeetingActions.addWords(3) == "Add 3 Tasks")
        #expect(MeetingActions.waiting(meeting(nil)).isEmpty)
        #expect(MeetingActions.seek(.init(id: "x", text: "", state: .proposed, at: -2)) == 0)
        #expect(MeetingActions.seek(.init(id: "x", text: "", state: .proposed, at: nil)) == nil)
    }

    @Test func `what LifeOS would not file is said in its words, or counted`() {
        #expect(MeetingActions.failedWords([]) == nil)
        #expect(MeetingActions.failedWords([(id: "a", error: "LifeOS is not reachable.")]) == "LifeOS is not reachable.")
        #expect(MeetingActions.failedWords([(id: "a", error: "LifeOS is not reachable."), (id: "b", error: "x")]) == "2 tasks were not added. LifeOS is not reachable.")
    }

    // MARK: history's Restore

    @Test func `every version but the newest restores`() {
        let versions = ["v3", "v2", "v1"]
        #expect(!HistoryRestore.restores("v3", in: versions))
        #expect(HistoryRestore.restores("v1", in: versions))
        #expect(!HistoryRestore.restores("v9", in: versions))
    }

    @Test func `a restore on his own document is written with its Undo; on a shared one it waits as suggestions`() {
        let direct = HistoryRestore.outcome(.direct(.init(versionId: "v4", beforeVersionId: "v3b")))
        #expect(direct == .written(undo: "v3b"))
        #expect(HistoryRestore.words(direct) == "Restored")
        let branch = HistoryRestore.outcome(.branch(.init(branchId: "b1", versionId: "v4")))
        #expect(branch == .suggested)
        #expect(HistoryRestore.words(branch) == "Waiting in Review Changes")
        #expect(HistoryRestore.outcome(.unknown(.null)) == .unknown)
    }

    // MARK: Ask lands on Chat

    private func item(_ id: String, path: String) -> CanvasItem {
        CanvasItem(id: id, sessionId: "s1", workspaceId: "w1", kind: .pdf, title: "Rules", source: .file(.init(host: "h1", path: path)), state: .open, position: 0, rev: 1, createdAt: 0, updatedAt: 0)
    }

    @Test func `the host's announcement of the file Ask seated opens nothing; another file's does`() {
        let rules = item("i1", path: "/w/Tournament rules.pdf")
        let other = item("i2", path: "/w/Venue map.pdf")
        let file = rules.source
        #expect(AskLanding.swallows(opened: "i1", items: [rules, other], file: file))
        #expect(!AskLanding.swallows(opened: "i2", items: [rules, other], file: file))
        #expect(!AskLanding.swallows(opened: "gone", items: [rules], file: file))
    }

    // MARK: an open file's title

    @Test func `an open file is titled by its own name, our two formats without their extension`() {
        #expect(ReaderVerbs.title(of: item("i1", path: "/w/Nationals kickoff.pptx")) == "Nationals kickoff.pptx")
        #expect(ReaderVerbs.title(of: item("i1", path: "/w/Travel memo.tcdoc")) == "Travel memo")
        let lifeos = CanvasItem(id: "i3", sessionId: "s1", workspaceId: nil, kind: .document, title: "Budget notes", source: .lifeos(.init(table: .docs, id: "d1")), state: .open, position: 0, rev: 1, createdAt: 0, updatedAt: 0)
        #expect(ReaderVerbs.title(of: lifeos) == "Budget notes")
    }

    // MARK: a sheet's tab in Review Changes

    @Test func `a cell names its tab only where the changes reach two tabs, and only by the host's name`() {
        let tabs = ["s1": "Budget", "s2": "Q3 Plan"]
        #expect(ReviewTabs.name("s1", among: ["s1", "s1"], tabs: tabs) == nil)
        #expect(ReviewTabs.name("s2", among: ["s1", "s2"], tabs: tabs) == "Q3 Plan")
        #expect(ReviewTabs.name("s2", among: ["s1", "s2"], tabs: nil) == nil)
        #expect(ReviewTabs.name("s3", among: ["s1", "s3"], tabs: tabs) == nil)
    }

    // MARK: two halves on the Duo

    @Test func `upright like a book, the band stands between the thing and its notes`() {
        let size = CGSize(width: 951, height: 669)
        let band = CGRect(x: 470, y: 0, width: 11, height: 669)
        #expect(ReaderHalves.of(size: size, division: band) == .pages(thing: CGRect(x: 0, y: 0, width: 470, height: 669), with: CGRect(x: 481, y: 0, width: 470, height: 669)))
    }

    @Test func `on a table the thing stands above the band and its notes lie below`() {
        let size = CGSize(width: 669, height: 951)
        let band = CGRect(x: 0, y: 470, width: 669, height: 11)
        #expect(ReaderHalves.of(size: size, division: band) == .table(thing: CGRect(x: 0, y: 0, width: 669, height: 470), with: CGRect(x: 0, y: 481, width: 669, height: 470)))
    }

    @Test func `no band, or a page too narrow for notes, keeps the file's one column`() {
        #expect(ReaderHalves.of(size: CGSize(width: 393, height: 852), division: nil) == nil)
        // The band at a split's edge: the trailing page would be under 320 pt.
        #expect(ReaderHalves.of(size: CGSize(width: 700, height: 669), division: CGRect(x: 470, y: 0, width: 11, height: 669)) == nil)
        // A band that misses the container (the item's column beside a thread's chat).
        #expect(ReaderHalves.of(size: CGSize(width: 470, height: 669), division: CGRect(x: 470, y: 0, width: 11, height: 669)) == nil)
        #expect(ReaderHalves.of(size: .zero, division: CGRect(x: 0, y: 0, width: 1, height: 1)) == nil)
    }
}
