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
        #expect(SharePhase.after([item("a", .queued), item("b", .refused, words: "b is larger than The box takes (200 MB).")], host: "The box") == .refused("b is larger than The box takes (200 MB)."))
        #expect(SharePhase.after([item("a", .refused)], host: "The box") == .refused("The box did not take a."))
    }

    @Test func `the bar is the share of every file together`() {
        #expect(SharePhase.share(done: 0, of: 2, current: 0.5) == 0.25)
        #expect(SharePhase.share(done: 1, of: 2, current: 1) == 1)
        #expect(SharePhase.share(done: 0, of: 0, current: 1) == 0)
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
