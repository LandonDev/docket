import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The share sheet's own rules (PF3): what it shows after a save, what it calls several files, the name a
/// file gets when it came with none, and the folder picker's levels.
struct ShareSheetRulesTests {
    private func item(_ name: String, _ state: ShareItem.State, words: String? = nil) -> ShareItem {
        ShareItem(id: name, hostId: "box", workspaceId: "w1", folder: .top(name: "Purdue"), name: name, size: 10, sha256: String(repeating: "a", count: 64), state: state, words: words, createdAt: 1)
    }

    @Test func `every file with the host is saved; one it refused says why; one that waits says the app will send it`() {
        #expect(SharePhase.after([item("a", .done), item("b", .done)], host: "The box") == .saved)
        #expect(SharePhase.after([item("a", .done), item("b", .queued)], host: "The box") == .waiting("The box can’t be reached. TempCode will save this when it can."))
        #expect(SharePhase.after([item("a", .queued), item("b", .refused, words: "The box takes files up to 200 MB.")], host: "The box") == .refused("The box takes files up to 200 MB."))
        #expect(SharePhase.after([item("a", .refused)], host: "The box") == .refused("The box did not take a."))
    }

    @Test func `files the phone could not queue are named first, then what became of the rest`() {
        #expect(SharePhase.after([item("a", .done)], host: "The box", notQueued: [], total: 1) == .saved)
        #expect(SharePhase.after([], host: "The box", notQueued: ["b"], total: 1) == .refused("Could not send b from this phone."))
        #expect(SharePhase.after([], host: "The box", notQueued: ["a", "b"], total: 2) == .refused("Could not send any of the 2 files from this phone."))
        #expect(SharePhase.after([item("a", .done)], host: "The box", notQueued: ["b"], total: 2) == .refused("Could not send b from this phone. a is saved."))
        #expect(SharePhase.after([item("a", .done), item("c", .done)], host: "The box", notQueued: ["b"], total: 3) == .refused("Could not send b from this phone. The other 2 are saved."))
        #expect(SharePhase.after([item("a", .queued), item("c", .queued)], host: "The box", notQueued: ["b", "d"], total: 4) == .refused("Could not send 2 of 4 files from this phone. The box can’t be reached. TempCode will save this when it can."))
    }

    @Test func `the bar is the share of every file's bytes together`() {
        // A small photo, then a video nine times its size: the photo fills a tenth of the bar.
        #expect(SharePhase.share(sizes: [100, 900], done: 0, current: 1) == 0.1)
        #expect(SharePhase.share(sizes: [100, 900], done: 1, current: 0.5) == 0.55)
        #expect(SharePhase.share(sizes: [100, 900], done: 1, current: 1) == 1)
        #expect(SharePhase.share(sizes: [0, 0], done: 0, current: 1) == 0.5, "files of no bytes count one each")
        #expect(SharePhase.share(sizes: [], done: 0, current: 1) == 0)
    }

    @Test func `what could not be read is named, or counted when it is more than one`() {
        #expect(ShareSummary.unread([], of: 3) == nil)
        #expect(ShareSummary.unread(["Photo.heic"], of: 3) == "Could not read Photo.heic.")
        #expect(ShareSummary.unread(["a.png", "b.png"], of: 3) == "Could not read 2 of 3 files.")
        #expect(ShareSummary.unread(["a.png", "b.png"], of: 2) == "Could not read any of the 2 files.")
        #expect(ShareSummary.hostGone == "That computer is no longer on this phone.")
    }

    @Test func `several files are counted in their own noun, and a mix is files`() {
        #expect(ShareSummary.title([.photo, .photo, .photo]) == "3 photos")
        #expect(ShareSummary.title([.video]) == "1 video")
        #expect(ShareSummary.title([.photo, .file]) == "2 files")
    }

    @Test func `a file keeps its name as one path component, and one that came with none is named by its time`() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let at = Date(timeIntervalSince1970: 1_763_900_000)
        #expect(ShareSummary.name("Receipt.pdf", kind: .file, at: at, calendar: calendar) == "Receipt.pdf")
        #expect(ShareSummary.name("a/b:c.png", kind: .photo, at: at, calendar: calendar) == "a b c.png")
        #expect(ShareSummary.name("  ", kind: .photo, at: at, calendar: calendar) == "Photo 2025-11-23 12.13.20.jpg")
        #expect(ShareSummary.name("..", kind: .video, at: at, calendar: calendar).hasPrefix("Video 2025-11-23"))
    }

    @Test func `a level lists its folders alone, page after page, and never a place that is not the workspace's own`() async throws {
        func listing(_ entries: String, next: String? = nil) throws -> FilesListing {
            let json = #"{"entries":[\#(entries)]\#(next.map { #","next":"\#($0)""# } ?? "")}"#
            return try JSONDecoder().decode(FilesListing.self, from: Data(json.utf8))
        }
        var asked: [Methods.WorkFilesList.Params] = []
        let folders = try await ShareFolders.inside(.top(name: "Purdue"), workspaceId: "w1") { params in
            asked.append(params)
            if params.cursor == nil {
                return try listing(#"{"key":"k1","name":"Receipts","kind":"folder","folder":{"at":"file","host":"box","path":"/w/Receipts"}},{"key":"k2","name":"Notes.txt","kind":"text","folder":null}"#, next: "c1")
            }
            return try listing(#"{"key":"k3","name":"Team drive","kind":"folder","folder":{"at":"drive","account":"a","folderId":"f"}},{"key":"k4","name":"Trips","kind":"folder","folder":{"at":"file","host":"box","path":"/w/Trips"}}"#)
        }
        #expect(folders.map(\.name) == ["Receipts", "Trips"])
        #expect(asked.count == 2)
        #expect(asked[0].foldersOnly == true)
        #expect(asked[0].at == .place(.init(id: "folder")))
        #expect(asked[1].cursor == "c1")
    }
}
