import Foundation
import Testing
@testable import TempCodeClient

/// Today's failure lines in Work's words: the desktop's lib/workErrorWords.ts rules, with no host's raw text shown.
struct WorkErrorWordsTests {
    @Test func `known raw forms have their sentence, with the computer named`() {
        #expect(WorkErrorWords.say("lifeos is not connected", host: "Mac") == "Mac cannot use LifeOS now. See why under Settings, Connections.")
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
}
