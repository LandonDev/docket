import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// M17: a file's first page before the whole file. Every check counts reads, renders or bytes, never time.

/// Counts what a test's reads asked, and holds a frame back until another has been asked, so the order the
/// frames land in is the test's, not the scheduler's.
private actor Asks {
    private(set) var offsets: [Int] = []
    private(set) var most = 0
    private var out = 0
    private var gates: [Int: CheckedContinuation<Void, Never>] = [:]
    private var opened: Set<Int> = []

    func begin(_ offset: Int) {
        offsets.append(offset)
        out += 1
        most = max(most, out)
    }

    func end() { out -= 1 }

    /// Waits until `open(offset)` is called (at once if it was already).
    func wait(_ offset: Int) async {
        if opened.contains(offset) { return }
        await withCheckedContinuation { gates[offset] = $0 }
    }

    func open(_ offset: Int) {
        opened.insert(offset)
        gates.removeValue(forKey: offset)?.resume()
    }
}

private func frame(_ rev: String, _ text: String, size: Int = 0) -> FileBytes {
    FileBytes(data: Data(text.utf8).base64EncodedString(), size: Double(size), rev: rev)
}

/// The text of a file of `size` bytes, one letter a byte, so a frame out of place shows.
private func body(_ size: Int) -> String { String((0..<size).map { Character(UnicodeScalar(UInt8(97 + $0 % 26))) }) }

private func slice(_ text: String, _ offset: Int, _ length: Int) -> String {
    let start = text.index(text.startIndex, offsetBy: offset)
    return String(text[start..<text.index(start, offsetBy: length)])
}

struct PinnedReadTests {
    @Test func `two frames are asked at once and put together in order`() async throws {
        let asks = Asks()
        let text = body(10)
        var landed: [Int] = []
        let data = try await ChunkedRead.pinned(size: 10, rev: "r1", frame: 3, read: { offset, length in
            await asks.begin(offset)
            // The first frame lands only once the second is on its way.
            if offset == 0 { await asks.wait(3) } else { await asks.open(offset) }
            await asks.end()
            return frame("r1", slice(text, offset, length))
        }, landed: { landed.append($0) })
        #expect(String(decoding: data, as: UTF8.self) == text)
        #expect(await asks.offsets.sorted() == [0, 3, 6, 9])
        #expect(await asks.most == 2)
        #expect(landed.last == 10)
    }

    @Test func `the frames never mix revisions`() async throws {
        let text = body(9)
        await #expect(throws: ChunkedRead.Failure.changed) {
            _ = try await ChunkedRead.pinned(size: 9, rev: "r1", frame: 3, read: { offset, length in
                frame(offset == 6 ? "r2" : "r1", slice(text, offset, length))
            })
        }
        // Not even when the frame of the other version is the first to land.
        let asks = Asks()
        await #expect(throws: ChunkedRead.Failure.changed) {
            _ = try await ChunkedRead.pinned(size: 6, rev: "r1", frame: 3, read: { offset, length in
                if offset == 0 { await asks.wait(3) } else { await asks.open(3) }
                return frame(offset == 3 ? "r2" : "r1", slice(text, offset, length))
            })
        }
        // A frame shorter than asked is a failure, never a hole in the file.
        await #expect(throws: ChunkedRead.Failure.short) {
            _ = try await ChunkedRead.pinned(size: 6, rev: "r1", frame: 3, read: { offset, _ in frame("r1", offset == 0 ? "ab" : "def") })
        }
    }

    @Test func `a file of one frame is one read`() async throws {
        let asks = Asks()
        let data = try await ChunkedRead.pinned(size: 3, rev: "r1", read: { offset, length in
            await asks.begin(offset)
            return frame("r1", slice("abc", offset, length))
        })
        #expect(data == Data("abc".utf8))
        #expect(await asks.offsets == [0])
    }
}

struct FirstPictureRuleTests {
    @Test func `a first page is only of the rev the view named`() {
        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        #expect(FirstPicture.of(PdfFirstPage(png: png, rev: "r1", width: 800), rev: "r1")?.kind == .png)
        #expect(FirstPicture.of(PdfFirstPage(png: png, rev: "r2", width: 800), rev: "r1") == nil)
        #expect(FirstPicture.of(PdfFirstPage(png: "not base64!", rev: "r1", width: 800), rev: "r1") == nil)
        #expect(FirstPicture.width(points: 680, scale: 3) == FirstPicture.widthMax)
        #expect(FirstPicture.width(points: 390, scale: 2) == 780)
        #expect(FirstPicture.width(points: 0, scale: 2) == 64)
    }

    private func deck(_ slides: [DeckPhoneView.Slide]) -> DeckPhoneView {
        DeckPhoneView(itemId: "d1", name: "Deck", rev: "v1", slides: slides, changes: [], renders: .init(file: .init(rev: "render1", size: 100, pages: 2), proposed: nil))
    }

    private func slide(_ id: Int, page: Int, pic: DeckPhoneView.Slide.Pic?, from: DeckPhoneView.Slide.From = .file) -> DeckPhoneView.Slide {
        DeckPhoneView.Slide(key: "s\(id)", id: id, pic: pic, number: page, title: "", hidden: false, from: from, page: page, change: nil, tint: nil)
    }

    @Test func `a deck's first picture is its render's first page, small enough for one ask`() {
        let view = deck([slide(7, page: 2, pic: .init(rev: "p7", size: 10)), slide(3, page: 1, pic: .init(rev: "p3", size: 10))])
        #expect(FirstPicture.firstSlide(of: view, proposed: false)?.id == 3)
        #expect(FirstPicture.firstSlide(of: view, proposed: true) == nil)
        #expect(FirstPicture.firstSlide(of: deck([slide(3, page: 1, pic: nil)]), proposed: false) == nil)
        #expect(FirstPicture.firstSlide(of: deck([slide(3, page: 1, pic: .init(rev: "p3", size: Double(FirstPicture.bytesMax + 1)))]), proposed: false) == nil)
        // Kept by the render's rev, once the slide's own picture is the one the view named, and whole.
        #expect(FirstPicture.of(frame("p3", "pdf", size: 3), pic: "p3", render: "render1")?.rev == "render1")
        #expect(FirstPicture.of(frame("p9", "pdf", size: 3), pic: "p3", render: "render1") == nil)
        #expect(FirstPicture.of(frame("p3", "pd", size: 3), pic: "p3", render: "render1") == nil)
    }
}

@MainActor
struct ReaderOpensTests {
    private let picture = FirstPicture(kind: .png, data: Data("png".utf8), rev: "r1")

    /// What one test's opens cost: the first pictures asked (each a render on the host) and the whole reads.
    @MainActor private final class Costs {
        var firsts = 0
        var rests = 0
        var shown: [FirstPicture] = []
    }

    @Test func `two views of one file at one rev hold one seat`() async throws {
        let opens = ReaderOpens(cache: ReaderCache())
        let costs = Costs()
        let asks = Asks()
        // The rest is in only once both views were handed the picture, so the second joined while the first read.
        let shown: @MainActor (FirstPicture) -> Void = { costs.shown.append($0); if costs.shown.count == 2 { Task { await asks.open(1) } } }
        let one = Task { @MainActor in
            try await opens.open("f", rev: "r1", show: shown, first: { costs.firsts += 1; return self.picture }) {
                costs.rests += 1
                await asks.wait(1)
                return Data("whole".utf8)
            }
        }
        let two = Task { @MainActor in
            try await opens.open("f", rev: "r1", show: shown, first: { costs.firsts += 1; return self.picture }) {
                costs.rests += 1
                await asks.wait(1)
                return Data("again".utf8)
            }
        }
        // Whichever view came first read for both.
        let first = try await one.value
        #expect(try await two.value == first)
        #expect(costs.rests == 1)
        #expect(costs.firsts == 1)
        #expect(costs.shown == [picture, picture])
        #expect(opens.reading == 0)
    }

    @Test func `a first picture costs one read and is shown while the rest reads`() async throws {
        let cache = ReaderCache()
        let opens = ReaderOpens(cache: cache)
        let costs = Costs()
        let asks = Asks()
        let data = try await opens.open("f", rev: "r1", show: { costs.shown.append($0); Task { await asks.open(1) } }, first: { costs.firsts += 1; return self.picture }) {
            // The rest is not in before the picture is shown.
            await asks.wait(1)
            #expect(costs.shown == [self.picture])
            costs.rests += 1
            return Data("whole".utf8)
        }
        #expect(data == Data("whole".utf8))
        #expect(costs.firsts == 1)
        #expect(costs.rests == 1)
    }

    @Test func `a second open at the same rev draws nothing again`() async throws {
        // A file larger than the cache: its bytes are read again, its first picture is not drawn again.
        let cache = ReaderCache(byteCap: 16)
        let opens = ReaderOpens(cache: cache)
        let costs = Costs()
        let big = Data(repeating: 1, count: 64)
        let asks = Asks()
        for n in 0..<2 {
            _ = try await opens.open("f", rev: "r1", show: { costs.shown.append($0); Task { await asks.open(n) } }, first: { costs.firsts += 1; return self.picture }) {
                await asks.wait(n)
                cache.keep(big, for: "f", rev: "r1")
                return big
            }
        }
        #expect(costs.firsts == 1)
        #expect(costs.shown == [picture, picture])
        // A file the cache keeps: the view paints it from memory, and neither a picture nor a frame is asked.
        let small = ReaderCache()
        small.keep(Data("whole".utf8), for: "g", rev: "r1")
        #expect(small.data("g", rev: "r1") == Data("whole".utf8))
        // Another rev is another file: its own first picture.
        _ = try await opens.open("f", rev: "r2", show: { costs.shown.append($0) }, first: { costs.firsts += 1; return FirstPicture(kind: .png, data: Data("p2".utf8), rev: "r2") }) { big }
        #expect(costs.firsts == 2)
    }

    @Test func `a first picture of another rev is never shown`() async throws {
        let cache = ReaderCache()
        let opens = ReaderOpens(cache: cache)
        let costs = Costs()
        let asks = Asks()
        _ = try await opens.open("f", rev: "r2", show: { costs.shown.append($0) }, first: { costs.firsts += 1; Task { await asks.open(1) }; return self.picture }) {
            await asks.wait(1)
            return Data("whole".utf8)
        }
        #expect(costs.firsts == 1)
        #expect(costs.shown.isEmpty)
        #expect(cache.picture("f", rev: "r1") == nil)
        #expect(cache.picture("f", rev: "r2") == nil)
    }

    @Test func `a host with no first picture leaves the open to the rest`() async throws {
        let opens = ReaderOpens(cache: ReaderCache())
        let costs = Costs()
        let asks = Asks()
        let data = try await opens.open("f", rev: "r1", show: { costs.shown.append($0) }, first: { costs.firsts += 1; Task { await asks.open(1) }; return nil }) {
            await asks.wait(1)
            return Data("whole".utf8)
        }
        #expect(data == Data("whole".utf8))
        #expect(costs.firsts == 1)
        #expect(costs.shown.isEmpty)
        #expect(opens.reading == 0)
    }
}

@MainActor
struct ReaderCacheCapTests {
    @Test func `the cache never holds more than its byte cap`() {
        let cache = ReaderCache(byteCap: 100)
        let sizes = [40, 30, 50, 10, 90, 20, 60, 100, 5]
        for (n, size) in sizes.enumerated() {
            cache.keep(Data(repeating: 0, count: size), for: "f\(n)", rev: "r")
            if n % 2 == 0 { cache.keep(picture: FirstPicture(kind: .png, data: Data(repeating: 1, count: 15), rev: "r"), for: "p\(n)") }
            #expect(cache.bytes <= 100)
            #expect(cache.count <= ReaderCache.cap)
        }
        // The one read last is kept, and the oldest went to make room.
        #expect(cache.data("f8", rev: "r") != nil)
        #expect(cache.data("f0", rev: "r") == nil)
    }

    @Test func `a file larger than the cap is not kept`() {
        let cache = ReaderCache(byteCap: 100)
        cache.keep(Data(repeating: 0, count: 50), for: "a", rev: "r")
        cache.keep(Data(repeating: 0, count: 101), for: "b", rev: "r")
        #expect(cache.data("b", rev: "r") == nil)
        #expect(cache.data("a", rev: "r") != nil)
        #expect(cache.bytes == 50)
        #expect(ReaderCache.byteCap == 64 * 1024 * 1024)
    }

    @Test func `first pictures go before renders, and a kept render drops its own picture`() {
        let cache = ReaderCache(byteCap: 100)
        let picture = FirstPicture(kind: .png, data: Data(repeating: 1, count: 30), rev: "r")
        cache.keep(picture: picture, for: "a")
        cache.keep(Data(repeating: 0, count: 60), for: "b", rev: "r")
        #expect(cache.picture("a", rev: "r") == picture)
        #expect(cache.picture("a", rev: "other") == nil)
        cache.keep(Data(repeating: 0, count: 30), for: "c", rev: "r")
        // 120 bytes asked: the picture went, both renders stayed.
        #expect(cache.picture("a", rev: "r") == nil)
        #expect(cache.data("b", rev: "r") != nil)
        #expect(cache.bytes == 90)
        cache.keep(picture: FirstPicture(kind: .png, data: Data(repeating: 1, count: 5), rev: "r"), for: "c")
        cache.keep(Data(repeating: 0, count: 30), for: "c", rev: "r")
        #expect(cache.picture("c", rev: "r") == nil)
        cache.drop()
        #expect(cache.bytes == 0)
    }
}
