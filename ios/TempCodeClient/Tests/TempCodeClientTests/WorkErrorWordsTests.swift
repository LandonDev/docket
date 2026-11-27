import Foundation
import Testing
@testable import TempCodeClient

/// Today's failure lines in Work's words: the desktop's lib/workErrorWords.ts rules, with no host's raw text shown.
struct WorkErrorWordsTests {
    @Test func `known raw forms have their sentence, with the computer named`() {
        #expect(WorkErrorWords.say("lifeos is not connected", host: "Mac") == "Mac cannot use LifeOS now. See why under Settings, Connections.")
        // A host's "<program> is not installed on <its id>" names neither the program nor the id on screen.
        #expect(WorkErrorWords.say("libreoffice is not installed on env_nvQV9vsaJzZar12u_CmxGA", host: "Box") == "A program Box needs for this is missing there.")
        #expect(WorkErrorWords.say("no handler for work.money.owed", host: "Mac") == "This part of Work is not running on Mac. Look under Settings, Connections; if the two computers run different versions, update both.")
        #expect(WorkErrorWords.say("refused: lifeos is signed out", host: "Box") == "Not signed in to LifeOS on Box. Sign in under Settings, Connections.")
        #expect(WorkErrorWords.say("Not connected", host: "Box") == "Box is not connected. Try again once it is back.")
        #expect(WorkErrorWords.say("Not connected") == "Not connected")
        #expect(WorkErrorWords.say("ECONNRESET while reading", host: "Box") == "Box did not answer. Try again once it is connected.")
    }

    @Test func `a line never written for him is no words, and plain words pass`() {
        #expect(WorkErrorWords.say("failed to read /Users/landon/work/Ledger.tcsheet: bad header", host: "Mac") == "")
        #expect(WorkErrorWords.say("work.messages.unanswered threw", host: "Mac") == "")
        #expect(WorkErrorWords.say("The ledger is open elsewhere", host: "Mac") == "The ledger is open elsewhere")
        #expect(WorkErrorWords.say("   ") == "")
    }

    /// A read's failure line on a screen: Work's words, else that the host could not read it; a setting's name in
    /// capitals marks the host's raw text, as the desktop's RAW does.
    @Test func `a failed read is never the host's raw text`() {
        #expect(WorkErrorWords.say("internal: failed by the answer seam (TEMP_CODE_FAIL_ANSWERS)", host: "Mac") == "")
        #expect(WorkErrorWords.readFailure("internal: failed by the answer seam (TEMP_CODE_FAIL_ANSWERS)", host: "the box") == "The box could not read this.")
        #expect(WorkErrorWords.readFailure("Not connected", host: "Box") == "Box is not connected. Try again once it is back.")
        #expect(WorkErrorWords.readFailure("The ledger is open elsewhere", host: "Mac") == "The ledger is open elsewhere")
    }
}
