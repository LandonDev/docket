import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's reader (PF1): the place he stopped, the renders kept in memory, what a host cannot do yet
/// and a deck's pages.
@MainActor
struct ReaderPlacesTests {
    private func places() -> (ReaderPlaces, UserDefaults, String) {
        let suite = "reader-places-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (ReaderPlaces(defaults: defaults), defaults, suite)
    }

    @Test func `a place is kept by host and file and read again after a launch`() {
        let (places, defaults, _) = places()
        places.keep(ReaderPlace(page: 6, rev: "r1"), host: "box", file: "file:box:/a.pdf")
        #expect(places.place(host: "box", file: "file:box:/a.pdf") == ReaderPlace(page: 6, rev: "r1"))
        #expect(places.place(host: "mac", file: "file:box:/a.pdf") == nil)
        #expect(ReaderPlaces(defaults: defaults).place(host: "box", file: "file:box:/a.pdf")?.page == 6)
    }

    @Test func `the last 200 files keep their place and the oldest falls off`() {
        let (places, _, _) = places()
        for index in 0..<(ReaderPlaces.cap + 5) { places.keep(ReaderPlace(page: index + 1), host: "box", file: "f\(index)") }
        #expect(places.count == ReaderPlaces.cap)
        #expect(places.place(host: "box", file: "f0") == nil)
        #expect(places.place(host: "box", file: "f5")?.page == 6)
        // A file read again is the newest: it outlives the files kept before it.
        places.keep(ReaderPlace(page: 9), host: "box", file: "f5")
        places.keep(ReaderPlace(page: 1), host: "box", file: "new")
        #expect(places.place(host: "box", file: "f5")?.page == 9)
        #expect(places.place(host: "box", file: "f6") == nil)
    }

    @Test func `a new render keeps the page while it still exists`() {
        let (places, _, _) = places()
        places.keep(ReaderPlace(page: 6, rev: "r1"), host: "box", file: "a")
        #expect(places.page(host: "box", file: "a", pages: 14) == 6)
        #expect(places.page(host: "box", file: "a", pages: 6) == 6)
        #expect(places.page(host: "box", file: "a", pages: 5) == nil)
        #expect(places.page(host: "box", file: "never", pages: 5) == nil)
    }

    @Test func `a deck follows its slide's key when the page moved`() {
        let (places, _, _) = places()
        places.keep(ReaderPlace(page: 3, slide: "258", rev: "r1"), host: "box", file: "deck")
        #expect(places.page(host: "box", file: "deck", pages: 9) { $0 == "258" ? 5 : nil } == 5)
        // The slide is gone from the new render: the page, while it exists.
        #expect(places.page(host: "box", file: "deck", pages: 9) { _ in nil } == 3)
    }

    @Test func `a file's key is where it lives, not the item that shows it`() throws {
        func item(_ id: String, _ source: String) throws -> CanvasItem {
            let json = #"{"id":"\#(id)","sessionId":"s1","workspaceId":"w1","kind":"pdf","title":"Rules","source":\#(source),"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#
            return try JSONDecoder().decode(CanvasItem.self, from: Data(json.utf8))
        }
        let file = #"{"at":"file","host":"box","path":"/w/rules.pdf"}"#
        #expect(ReaderPlaces.fileKey(try item("i1", file)) == ReaderPlaces.fileKey(try item("i2", file)))
        #expect(ReaderPlaces.fileKey(try item("i1", #"{"at":"lifeos","table":"docs","id":"d1"}"#)) == "lifeos:docs:d1")
        #expect(ReaderPlaces.fileKey(try item("i7", #"{"at":"thread"}"#)) == "item:i7")
    }
}

@MainActor
struct ReaderCacheTests {
    @Test func `a render is kept by its rev and never shown for another`() {
        let cache = ReaderCache()
        cache.keep(Data("one".utf8), for: "a", rev: "r1")
        #expect(cache.data("a", rev: "r1") == Data("one".utf8))
        #expect(cache.data("a", rev: "r2") == nil)
        cache.keep(Data("two".utf8), for: "a", rev: "r2")
        #expect(cache.count == 1)
        #expect(cache.data("a", rev: "r1") == nil)
        // The first frame of a second open: what was last kept, with the rev it was kept at.
        #expect(cache.latest("a")?.rev == "r2")
        cache.keep(Data("three".utf8), for: "a", rev: "r3", note: "slides")
        #expect(cache.latest("a")?.note as? String == "slides")
        #expect(cache.latest("b") == nil)
    }

    @Test func `three renders at most, the one read last kept longest`() {
        let cache = ReaderCache()
        for name in ["a", "b", "c"] { cache.keep(Data(name.utf8), for: name, rev: "r") }
        _ = cache.data("a", rev: "r")
        cache.keep(Data("d".utf8), for: "d", rev: "r")
        #expect(cache.count == ReaderCache.cap)
        #expect(cache.data("a", rev: "r") != nil)
        #expect(cache.data("b", rev: "r") == nil)
    }

    @Test func `a memory warning drops every render, and nothing is on disk`() {
        let cache = ReaderCache()
        cache.keep(Data("one".utf8), for: "a", rev: "r1")
        cache.drop()
        #expect(cache.count == 0)
        #expect(!ReaderCache.keepsOnDisk)
    }
}

@MainActor
struct HostCanTests {
    private let unknown = TransportError.server(method: "work.slides.show", message: #"bad request: [{"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":"method","path":["method"],"message":"Invalid input"}]"#)

    @Test func `a method an older host refuses as unknown is remembered and not asked again`() async throws {
        let can = HostCan()
        var asked = 0
        let first: Int? = try await can.ask("work.slides.show") { asked += 1; throw unknown }
        let second: Int? = try await can.ask("work.slides.show") { asked += 1; return 1 }
        #expect(first == nil && second == nil)
        #expect(asked == 1)
        #expect(!can.has("work.slides.show"))
        #expect(can.has("work.slides.open"))
    }

    @Test func `a new socket asks again`() async throws {
        let can = HostCan()
        _ = try await can.ask("work.formats.preview") { () -> Int in throw unknown }
        can.connected()
        #expect(try await can.ask("work.formats.preview") { 4 } == 4)
    }

    @Test func `any other refusal is thrown as it came and remembered as nothing`() async {
        let can = HostCan()
        let badParam = TransportError.server(method: "work.pdf.open", message: #"bad request: [{"expected":"string","code":"invalid_type","path":["params","itemId"],"message":"Invalid input: expected string, received undefined"}]"#)
        await #expect(throws: TransportError.self) { _ = try await can.ask("work.pdf.open") { () -> Int in throw badParam } }
        await #expect(throws: TransportError.self) { _ = try await can.ask("work.pdf.open") { () -> Int in throw TransportError.server(method: "work.pdf.open", message: "forbidden: work.pdf.open needs read") } }
        #expect(can.has("work.pdf.open"))
        #expect(!HostCan.saysUnknown(TransportError.notConnected))
    }
}

struct DeckPagerTests {
    private func deck(_ slides: String) throws -> DeckPhoneView {
        let json = #"{"itemId":"i1","name":"Kickoff","rev":"f1","slides":[\#(slides)],"changes":[],"renders":{"file":{"rev":"r1","size":10,"pages":4},"proposed":null}}"#
        return try JSONDecoder().decode(DeckPhoneView.self, from: Data(json.utf8))
    }

    private func slide(_ key: String, page: Int, from: String = "file", hidden: Bool = false, notes: String? = nil) -> String {
        let notesField = notes.map { #","notes":"\#($0)""# } ?? ""
        return #"{"key":"\#(key)","number":\#(page),"title":"Slide \#(key)","hidden":\#(hidden),"from":"\#(from)","page":\#(page),"change":null,"tint":null\#(notesField)}"#
    }

    @Test func `a hidden slide keeps its page, so a slide's key finds the page after it`() throws {
        let pager = DeckPager(try deck([slide("256", page: 1), slide("257", page: 2, hidden: true), slide("258", page: 3, notes: "Thank the hosts"), slide("259", page: 4)].joined(separator: ",")), render: .file, count: 4)
        #expect(pager.pages.map(\.page) == [1, 2, 3, 4])
        #expect(pager.page(for: "258") == 3)
        #expect(pager.slide(at: 2)?.hidden == true)
        #expect(pager.notes(at: 3) == "Thank the hosts")
        #expect(pager.notes(at: 1) == "")
        #expect(pager.hasNotes)
        #expect(pager.stamp(at: 3) == "3 of 4")
    }

    @Test func `the proposed render pages only its own slides, never the place a slide leaves`() throws {
        let slides = [slide("256", page: 1, from: "proposed"), slide("300", page: 2, from: "proposed"), slide("ghost:257", page: 2, from: "file")].joined(separator: ",")
        let pager = DeckPager(try deck(slides), render: .proposed, count: 2)
        #expect(pager.pages.map(\.key) == ["256", "300"])
        #expect(pager.page(for: "ghost:257") == nil)
    }

    @Test func `the slide keeps its shape over its notes, and the notes give way when the room is short`() {
        // A phone upright: a 16:9 slide at 390 wide, the notes under it.
        let upright = DeckPager.layout(width: 390, height: 700, aspect: 16.0 / 9, filmstrip: 72, hasNotes: true)
        #expect(upright.notes)
        #expect(abs((upright.slide ?? 0) - 390 / (16.0 / 9)) < 0.01)
        // On its side there is no room for two lines: the slide takes it all.
        #expect(DeckPager.layout(width: 844, height: 300, aspect: 16.0 / 9, filmstrip: 72, hasNotes: true) == .init(slide: nil, notes: false))
        // A tall slide never takes more than its share.
        #expect(DeckPager.layout(width: 600, height: 800, aspect: 0.75, filmstrip: 72, hasNotes: true).slide == 800 * DeckPager.slideShare)
        #expect(DeckPager.layout(width: 390, height: 700, aspect: 16.0 / 9, filmstrip: 72, hasNotes: false) == .init(slide: nil, notes: false))
    }

    @Test func `a host that sends no notes shows none, and a row past the render is no page`() throws {
        let pager = DeckPager(try deck([slide("256", page: 1), slide("257", page: 9)].joined(separator: ",")), render: .file, count: 1)
        #expect(pager.pages.count == 1)
        #expect(!pager.hasNotes)
        #expect(pager.stamp(at: 7) == "1 of 1")
    }

    @Test func `a deck whose slides have no notes keeps the notes' room, as a deck with one note does`() throws {
        // The host sends the field, empty: each slide says "No notes", the same as an empty slide beside a full one.
        let pager = DeckPager(try deck([slide("256", page: 1, notes: ""), slide("257", page: 2, notes: "")].joined(separator: ",")), render: .file, count: 2)
        #expect(pager.hasNotes)
        #expect(pager.notes(at: 1) == "")
    }
}

struct ReaderVerbsTests {
    @Test func `the bar names a file without our own two extensions, and keeps every other`() {
        #expect(ReaderVerbs.title("Travel memo.tcdoc") == "Travel memo")
        #expect(ReaderVerbs.title("Budget.TCSHEET") == "Budget")
        #expect(ReaderVerbs.title("Tournament rules.pdf") == "Tournament rules.pdf")
        #expect(ReaderVerbs.title("Plan.docx") == "Plan.docx")
        #expect(ReaderVerbs.title("Run of show") == "Run of show")
    }

    private func item(_ kind: String, _ source: String) throws -> CanvasItem {
        let json = #"{"id":"i1","sessionId":"s1","workspaceId":"w1","kind":"\#(kind)","title":"Rules","source":\#(source),"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#
        return try JSONDecoder().decode(CanvasItem.self, from: Data(json.utf8))
    }

    private let file = #"{"at":"file","host":"box","path":"/w/a"}"#

    @Test func `Ask with nothing picked names the whole file`() throws {
        let chip = ChipWords.item(try item("pdf", file))
        #expect(chip.kind == .item)
        #expect(chip.label == "Rules")
        #expect(chip.quote == nil)
    }

    @Test func `a row is there only when it can act`() throws {
        let pdf = try item("pdf", file)
        // A PDF and a deck show the pages that print already: Print, and no Page Preview of the same pages.
        #expect(ReaderVerbs.of(pdf, ReaderFacts()) == [.find, .print])
        #expect(ReaderVerbs.of(pdf, ReaderFacts(canOperate: true, inThread: true, previews: true)) == [.find, .print, .close])
        #expect(ReaderVerbs.of(try item("slides", file), ReaderFacts(previews: true)) == [.find, .print])
        let document = try item("document", #"{"at":"lifeos","table":"docs","id":"d1"}"#)
        #expect(ReaderVerbs.of(document, ReaderFacts(canOperate: true, canApprove: true, inThread: true, waiting: 3, previews: true, comments: true, shares: true)) == [.comments, .review, .preview, .share, .guestLink, .close])
        // A key that cannot approve makes no guest link, and nothing waiting shows no review.
        #expect(ReaderVerbs.of(document, ReaderFacts(canOperate: true, inThread: true, comments: true)) == [.comments, .close])
        // A key that may only read closes nothing: the host would refuse it.
        #expect(ReaderVerbs.of(document, ReaderFacts(inThread: true, comments: true)) == [.comments])
        #expect(ReaderVerbs.of(try item("media", file), ReaderFacts()) == [])
    }

    @Test func `a page, a slide and a picture hide the bars on a tap, an editor never`() throws {
        #expect(ReaderVerbs.immerses(try item("pdf", file)))
        #expect(ReaderVerbs.immerses(try item("slides", file)))
        #expect(ReaderVerbs.immerses(try item("media", file)))
        #expect(!ReaderVerbs.immerses(try item("document", #"{"at":"lifeos","table":"docs","id":"d1"}"#)))
        #expect(!ReaderVerbs.immerses(try item("meeting", #"{"at":"thread"}"#)))
    }

    @Test func `paper keeps the reading measure and the hosted editor the whole width`() throws {
        #expect(ReaderVerbs.keepsMeasure(try item("pdf", file)))
        #expect(!ReaderVerbs.keepsMeasure(try item("sheet", #"{"at":"lifeos","table":"sheets","id":"k1"}"#)))
    }
}

struct ReadShareTests {
    @Test func `the bar follows the bytes read and never passes the whole`() {
        #expect(ChunkedRead.share(read: 0, of: 8) == 0)
        #expect(ChunkedRead.share(read: 2, of: 8) == 0.25)
        #expect(ChunkedRead.share(read: 12, of: 8) == 1)
        #expect(ChunkedRead.share(read: 0, of: 0) == 1)
    }
}

@MainActor
struct HostedTicketsTests {
    private final class Clock { var at = Date(timeIntervalSince1970: 1_000) }

    @Test func `a ticket asked while the page is pushed is the one the web view takes, once`() async throws {
        let tickets = HostedTickets()
        var early = 0
        tickets.warm("doc") { early += 1; return "early" }
        // The push built the view a second time: still one request.
        tickets.warm("doc") { early += 1; return "early again" }
        #expect(try await tickets.take("doc") { "late" } == "early")
        #expect(early == 1)
        // A ticket opens once: the next open asks again.
        #expect(try await tickets.take("doc") { "late" } == "late")
    }

    @Test func `a ticket near its end is asked again, and each file has its own`() async throws {
        let clock = Clock()
        let tickets = HostedTickets(now: { clock.at })
        tickets.warm("doc") { "early" }
        #expect(try await tickets.take("sheet") { "the sheet's" } == "the sheet's")
        clock.at += HostedTickets.fresh + 1
        #expect(try await tickets.take("doc") { "late" } == "late")
    }

    @Test func `a request that failed is not kept`() async throws {
        struct Down: Error {}
        let tickets = HostedTickets()
        tickets.warm("doc") { throw Down() }
        await #expect(throws: Down.self) { _ = try await tickets.take("doc") { "late" } }
        #expect(try await tickets.take("doc") { "late" } == "late")
    }
}

@MainActor
struct PagePreviewSourceTests {
    private func frame(_ rev: String, _ text: String) -> FileBytes {
        FileBytes(data: Data(text.utf8).base64EncodedString(), size: 6, rev: rev)
    }

    @Test func `the pages are read at the one rev the host named, frame by frame`() async throws {
        var asked: [String] = []
        var shares: [Double] = []
        var said: PrintPages?
        let source = PagePreviewSource(
            open: { PrintPages(rev: "r1", size: 6, pages: 5) },
            read: { rev, offset, length in
                asked.append("\(rev):\(offset):\(length)")
                return self.frame("r1", offset == 0 ? "abcd" : "ef")
            }
        )
        let data = try await source.data(opened: { said = $0 }, progress: { shares.append($0) })
        #expect(String(decoding: data, as: UTF8.self) == "abcdef")
        #expect(asked == ["r1:0:6", "r1:4:2"])
        #expect(said == PrintPages(rev: "r1", size: 6, pages: 5))
        #expect(shares.last == 1)
    }

    @Test func `pages that moved on under the read are refused, never shown as what will print`() async {
        let source = PagePreviewSource(open: { PrintPages(rev: "r1", size: 6) }, read: { _, offset, _ in self.frame(offset == 0 ? "r1" : "r2", "abc") })
        await #expect(throws: PagePreviewSource.Moved.self) { _ = try await source.data() }
        #expect(PagePreviewSource.Moved().description == "The file changed while its pages were read.")
    }

    @Test func `the loading line says how many pages once the host has`() {
        #expect(PagePreviewSource.loadingWords(pages: 5) == "Drawing 5 pages")
        #expect(PagePreviewSource.loadingWords(pages: 1) == "Drawing 1 page")
        #expect(PagePreviewSource.loadingWords(pages: nil) == nil)
        #expect(PagePreviewSource.loadingWords(pages: 0) == nil)
    }
}
