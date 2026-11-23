import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's pure parts of milestone 47 (Work/Items, Work/Life): what each
/// item draws, the chips' words, the frame arithmetic, reading a file in
/// frames, the Routines bands, the guest link's bounds and the LifeOS token.
struct WorkItemsTests {
    private func item(_ kind: String, source: String) throws -> CanvasItem {
        let json = #"{"id":"i1","sessionId":"s1","workspaceId":"w1","kind":"\#(kind)","title":"Nationals travel budget","source":\#(source),"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#
        return try JSONDecoder().decode(CanvasItem.self, from: Data(json.utf8))
    }

    @Test func aLifeosDocumentOrSheetOpensInTheHostedEditor() throws {
        #expect(ItemBody.of(try item("document", source: #"{"at":"lifeos","table":"docs","id":"d1"}"#)) == .hosted(.init(at: "lifeos", table: .docs, id: "d1")))
        let sheet = ItemBody.of(try item("sheet", source: #"{"at":"lifeos","table":"sheets","id":"k9"}"#))
        #expect(sheet == .hosted(.init(at: "lifeos", table: .sheets, id: "k9")))
        #expect(sheet.guestSource == .init(at: "lifeos", table: .sheets, id: "k9"))
    }

    @Test func aFileDocumentSaysWhereItOpens() throws {
        guard case .unavailable(let words) = ItemBody.of(try item("document", source: #"{"at":"file","host":"mac","path":"/x.tcdoc"}"#)) else {
            Issue.record("a file document is not hosted")
            return
        }
        #expect(words.contains("computer"))
    }

    @Test func eachNativeKindHasItsBody() throws {
        let file = #"{"at":"file","host":"box","path":"/a"}"#
        #expect(ItemBody.of(try item("pdf", source: file)) == .pdf)
        #expect(ItemBody.of(try item("slides", source: file)) == .slides)
        #expect(ItemBody.of(try item("media", source: file)) == .media)
        #expect(ItemBody.of(try item("meeting", source: #"{"at":"thread"}"#)) == .meeting)
        #expect(ItemBody.of(try item("browser", source: #"{"at":"browser","host":"mac","sessionId":"s1"}"#)) == .browser)
        #expect(ItemBody.of(try item("form", source: #"{"at":"thread"}"#)) == .form)
        #expect(ItemBody.of(try item("dashboard", source: #"{"at":"thread"}"#)) == .dashboard)
        #expect(ItemBody.of(try item("mail", source: #"{"at":"lifeos","table":"outbox","id":"o7"}"#)) == .mail(draftId: "o7"))
        if case .history = ItemBody.of(try item("history", source: #"{"at":"lifeos","table":"docs","id":"d1"}"#)) {} else { Issue.record("history") }
        // A thread's canvas seats no `file` item yet (F5): the Files place opens one in Quick Look.
        #expect(ItemBody.of(try item("file", source: file)) == .unavailable("This file opens in Files."))
    }

    @Test func theSegmentLabelIsCut() {
        #expect(ItemLabel.short("Nationals travel budget") == "Nationals travel…")
        #expect(ItemLabel.short("Run of show") == "Run of show")
        #expect(ItemLabel.short("  ") == "Item")
    }

    @Test func chipLinesReadAsTheDesktopWritesThem() throws {
        let task = ChipWords.lifeos(.task, table: .tasks, id: "k1", label: "Book the ballroom")
        #expect(ChipWords.line(task) == "About this task: Book the ballroom (LifeOS tasks k1)")
        #expect(ChipWords.message([task], text: "Draft the mail") == "About this task: Book the ballroom (LifeOS tasks k1)\n\nDraft the mail")
        #expect(ChipWords.message([task], text: "/plan it") == "/plan it\n\nAbout this task: Book the ballroom (LifeOS tasks k1)")
        #expect(ChipWords.message([task], text: "") == "About this task: Book the ballroom (LifeOS tasks k1)")
        let pick = ChipWords.selection(in: try item("document", source: #"{"at":"lifeos","table":"docs","id":"d1"}"#), quote: "Doors at 9\nPlay at 10")
        #expect(ChipWords.line(pick) == "About this selection: Nationals travel budget (LifeOS docs d1)\n> Doors at 9\n> Play at 10")
    }

    @Test func framesFollowTheTable() {
        let cfr = FrameTable.cfr(.init(start: 0, rate: .init(num: 30000, den: 1001), count: 300))
        #expect(cfr.frameAt(0) == 0)
        #expect(cfr.frameAt(cfr.frameStart(42)) == 42)
        #expect(cfr.frameAt(cfr.frameCentre(42)) == 42)
        #expect(cfr.frameAt(1_000) == 299)
        #expect(abs(cfr.fps - 29.97) < 0.01)
        let vfr = FrameTable.vfr(.init(times: [0, 0.04, 0.1, 0.13], end: 0.2))
        #expect(vfr.frameAt(0.09) == 1)
        #expect(vfr.frameAt(0.0995) == 2) // a millisecond of slack, as the desktop
        #expect(vfr.frameAt(0.1) == 2)
        #expect(vfr.frameCount == 4)
        #expect(mediaClock(41.9) == "0:41")
        #expect(mediaClock(3725) == "1:02:05")
    }

    @Test func thePhonePlaysTheProxyOnceItIsCutAndShowsPicturesFromTiles() {
        let table = FrameTable.cfr(.init(start: 0, rate: .init(num: 25, den: 1), count: 250))
        let cutting = MediaPlay.hls(.init(init: "i", segments: [.init(start: 0, duration: 4)], ended: false, mime: "video/mp4", table: table, why: "phone"))
        #expect(MediaPick.of([cutting], ready: false, canRead: true) == .preparing)
        let cut = MediaPlay.hls(.init(init: "i", segments: [.init(start: 0, duration: 4), .init(start: 4, duration: 4)], ended: true, mime: "video/mp4", table: table, why: "phone"))
        let original = MediaPlay.original(.init(url: "tempcode-app://file/0123456789abcdef0123456789abcdef/clip.mp4?v=1", mime: "video/mp4", table: table))
        #expect(MediaPick.of([original, cut], ready: true, canRead: true) == .segments(init: "i", count: 2, table: table))
        // Short or small: no HLS, no tiles. A key that may read files takes the proxy, else the original, by token.
        let proxy = MediaPlay.proxy(.init(url: "tempcode-app://file/fedcba9876543210fedcba9876543210/proxy.mp4?v=2&host=box", table: table, why: "phone"))
        #expect(MediaPick.of([original, proxy], ready: true, canRead: true) == .file(token: "fedcba9876543210fedcba9876543210", table: table))
        #expect(MediaPick.of([original], ready: true, canRead: true) == .file(token: "0123456789abcdef0123456789abcdef", table: table))
        #expect(MediaPick.of([original], ready: true, canRead: false) == MediaPick.none)
        #expect(MediaPick.of([], ready: false, canRead: false) == .preparing)
        let picture = MediaPlay.image(.init(url: "tempcode-app://file/00112233445566778899aabbccddeeff/p.png?v=3", width: 2400, height: 1600))
        #expect(MediaPick.of([picture], ready: true, canRead: true) == .image(token: "00112233445566778899aabbccddeeff"))
        #expect(MediaPick.asks(canRead: true) == ["h264", "hevc", "hls", "tiles"])
        #expect(MediaPick.asks(canRead: false) == ["hls", "tiles"])
        #expect(MediaPick.token(of: "https://example.com/x") == nil)
        let grid = TileGrid(width: 6000, height: 4000, tile: 254, levels: 14, minLevel: 9, maxSide: 2048)
        #expect(grid.level == 11)
        #expect(grid.width == 1500 && grid.height == 1000)
        #expect(grid.columns == 6 && grid.rows == 4)
    }

    @Test func aFileIsReadInFramesOfOneVersion() async throws {
        let bytes = Data((0..<10).map(UInt8.init))
        var asked: [Int] = []
        let read = try await ChunkedRead.all(size: 10, frame: 4) { offset, length in
            asked.append(offset)
            return FileBytes(data: bytes.subdata(in: offset..<(offset + length)).base64EncodedString(), size: 10, rev: "r1")
        }
        #expect(read == bytes)
        #expect(asked == [0, 4, 8])
        await #expect(throws: ChunkedRead.Failure.changed) {
            var n = 0
            _ = try await ChunkedRead.all(size: 10, frame: 4) { offset, length in
                n += 1
                return FileBytes(data: bytes.subdata(in: offset..<(offset + length)).base64EncodedString(), size: 10, rev: "r\(n)")
            }
        }
    }

    @Test func aMediaFileIsReadInRangesUntilItsSize() async throws {
        let bytes = Data((0..<5).map(UInt8.init))
        var asked: [Int] = []
        var read = Data()
        try await ChunkedRead.media(frame: 2, read: { offset, length in
            asked.append(offset)
            let end = min(5, offset + length)
            return MediaRange(dataBase64: bytes.subdata(in: offset..<end).base64EncodedString(), mime: "video/mp4", size: 5, mtimeMs: 1)
        }, write: { read.append($0) })
        #expect(read == bytes)
        #expect(asked == [0, 2, 4])
        await #expect(throws: ChunkedRead.Failure.short) { try await ChunkedRead.media(read: { _, _ in nil }, write: { _ in }) }
    }

    @Test func aMediaCopyIsWholeOrAbsent() async throws {
        let file = MediaFiles.file(item: "test-\(UUID().uuidString)", version: "v1")
        try await MediaFiles.write(to: file) { try $0.write(contentsOf: Data([1, 2, 3])) }
        #expect(try Data(contentsOf: file) == Data([1, 2, 3]))
        await #expect(throws: ChunkedRead.Failure.short) {
            try await MediaFiles.write(to: file) { handle in
                try handle.write(contentsOf: Data([9]))
                throw ChunkedRead.Failure.short
            }
        }
        // The failed second read left the whole first copy, and no part file.
        #expect(try Data(contentsOf: file) == Data([1, 2, 3]))
        #expect(!FileManager.default.fileExists(atPath: file.appendingPathExtension("part").path()))
        try? FileManager.default.removeItem(at: file)
    }

    private func routine(_ id: String, kind: String, nextAt: Int?, ended: Bool = false, proposed: Bool = false, ends: String = #"{"kind":"never"}"#) throws -> RoutinePhoneRow {
        let next = nextAt.map(String.init) ?? "null"
        let json = #"{"id":"\#(id)","workspaceId":"w1","kind":"\#(kind)","name":"\#(id)","words":"Every weekday at 8","ends":\#(ends),"enabled":true,"proposed":\#(proposed),"nextAt":\#(next),"lastAt":null,"running":false,"ended":\#(ended),"waiting":null}"#
        return try JSONDecoder().decode(RoutinePhoneRow.self, from: Data(json.utf8))
    }

    @Test func routinesBandBySoonestWithEndedLastAndNoProposals() throws {
        let rows = [
            try routine("late", kind: "routine", nextAt: 9_000),
            try routine("soon", kind: "routine", nextAt: 1_000),
            try routine("done", kind: "routine", nextAt: nil, ended: true),
            try routine("asked", kind: "routine", nextAt: 500, proposed: true),
            try routine("scrims", kind: "watch", nextAt: nil, ends: #"{"kind":"day","at":1795996800000}"#)
        ]
        let bands = RoutineBands.bands(rows)
        #expect(bands.routines.map(\.id) == ["soon", "late", "done"])
        #expect(bands.watches.map(\.id) == ["scrims"])
        #expect(RoutineBands.stamp(bands.routines[2]) == "Ended")
        #expect(RoutineBands.stamp(bands.watches[0]).hasPrefix("Until "))
    }

    @Test func aGuestLinkEndsBetweenAnHourAndAYear() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var draft = GuestLinkDraft(now: now)
        #expect(draft.ends == now.addingTimeInterval(30 * 24 * 3600))
        #expect(!draft.canCreate(now: now))
        draft.name = "  Dana Lee "
        #expect(draft.canCreate(now: now))
        #expect(draft.trimmedName == "Dana Lee")
        draft.ends = now.addingTimeInterval(30 * 60)
        #expect(!draft.canCreate(now: now))
        draft.ends = now.addingTimeInterval(400 * 24 * 3600)
        #expect(!draft.canCreate(now: now))
        #expect(GuestLinkDraft.Role.edit.wire == .edit)
    }

    @Test func aLifeosTokenIsKeptUntilFiveMinutesBeforeItEnds() throws {
        let token = try LifeToken.from(.init(ok: true, jwt: "j", expiresAt: 3_600_000, url: "https://life.example.convex.cloud", state: nil))
        #expect(token.deployment.host == "life.example.convex.cloud")
        #expect(token.usable(now: 0))
        #expect(!token.usable(now: 3_600_000 - LifeToken.margin))
        #expect(throws: LifeToken.Refusal.host("signedOut")) { try LifeToken.from(.init(ok: false, state: "signedOut")) }
        #expect(throws: LifeToken.Refusal.malformed) { try LifeToken.from(.init(ok: true, jwt: "j")) }
    }
}

/// A pressed Send goes only while the draft says what the composer pressed on (milestone 47).
struct HeldSendCheckTests {
    @Test func theSameSubjectAndRecipientsGo() {
        #expect(HeldSendCheck.matches(pressedSubject: "Arena hold", pressedTo: ["Karen@purdue.edu", "dana@x.com"], subject: " Arena hold", to: ["karen@purdue.edu"], cc: ["dana@x.com"], bcc: []))
    }

    @Test func aChangedSubjectOrRecipientIsRefused() {
        #expect(!HeldSendCheck.matches(pressedSubject: "Arena hold", pressedTo: ["karen@purdue.edu"], subject: "Arena hold confirmed", to: ["karen@purdue.edu"], cc: [], bcc: []))
        #expect(!HeldSendCheck.matches(pressedSubject: "Arena hold", pressedTo: ["karen@purdue.edu"], subject: "Arena hold", to: ["karen@purdue.edu"], cc: [], bcc: ["someone@else.com"]))
    }
}

struct MediaNoteByTests {
    @Test(arguments: [("owner", "You"), ("agent:s_12", "Agent"), ("guest:Dana Lee", "Dana Lee"), ("guest:", "guest:"), ("someone", "someone")])
    func aCommentNamesWhoLeftIt(by: String, name: String) {
        #expect(MediaNoteBy.name(by) == name)
    }
}

struct ChartBarsTests {
    @Test func `a negative value runs the other way from a zero line`() {
        let values = [-50.0, 150, 0]
        #expect(ChartBars.zero(values) == 0.25)
        #expect(ChartBars.bar(-50, in: values) == .init(start: 0, length: 0.25))
        #expect(ChartBars.bar(150, in: values) == .init(start: 0.25, length: 0.75))
        #expect(ChartBars.bar(0, in: values).length == 0)
    }

    @Test func `with nothing negative zero is the start, with nothing at all no bar draws`() {
        #expect(ChartBars.zero([2, 4]) == 0)
        #expect(ChartBars.bar(2, in: [2, 4]) == .init(start: 0, length: 0.5))
        #expect(ChartBars.zero([-3, -1]) == 1)
        #expect(ChartBars.bar(0, in: [0, 0]) == .init(start: 0, length: 0))
    }
}
