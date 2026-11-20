import Testing
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
