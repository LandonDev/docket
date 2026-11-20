import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A deck under review shows only the render its changes propose.
struct DeckRenderTests {
    @Test func `while changes wait only their proposed render shows, never the file under review`() {
        #expect(DeckRender.pick(changesWaiting: true, hasProposed: true, hasFile: true) == .proposed)
        #expect(DeckRender.pick(changesWaiting: true, hasProposed: false, hasFile: true) == nil)
        #expect(DeckRender.missingWords(changesWaiting: true) == "The proposed changes have not been drawn yet.")
    }

    @Test func `with nothing waiting the file's render shows when there is one`() {
        #expect(DeckRender.pick(changesWaiting: false, hasProposed: true, hasFile: true) == .file)
        #expect(DeckRender.pick(changesWaiting: false, hasProposed: false, hasFile: false) == nil)
        #expect(DeckRender.missingWords(changesWaiting: false) == "The deck has not been drawn yet.")
    }
}

/// A deck's render is read as the view named it: a frame of another render fails the read.
struct ChunkedReadRevTests {
    private func frame(_ rev: String, _ text: String) -> FileBytes {
        FileBytes(data: Data(text.utf8).base64EncodedString(), size: 6, rev: rev)
    }

    @Test func `a read that meets another render than the one the view advertised fails`() async throws {
        let whole = try await ChunkedRead.all(size: 6, frame: 3, expecting: "r1") { offset, _ in frame("r1", offset == 0 ? "abc" : "def") }
        #expect(String(decoding: whole, as: UTF8.self) == "abcdef")
        await #expect(throws: ChunkedRead.Failure.changed) {
            _ = try await ChunkedRead.all(size: 6, frame: 3, expecting: "r1") { offset, _ in frame("r2", offset == 0 ? "abc" : "def") }
        }
        // With none advertised, the frames need only agree with each other.
        let free = try await ChunkedRead.all(size: 6, frame: 3) { offset, _ in frame("r2", offset == 0 ? "abc" : "def") }
        #expect(free.count == 6)
    }
}
