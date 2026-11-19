import Foundation
import Testing
@testable import TempCodeClient

/// Settings → Work's reads: a failure keeps its reason and never reads as an empty list.
struct WorkReadTests {
    @Test func `an answer is the value, a failure is its reason and no value`() async {
        let answered = await WorkRead<[Int]>.of { [] }
        #expect(answered == .loaded([]))
        #expect(answered.value == [])
        #expect(answered.failure == nil)

        let failed = await WorkRead<[Int]>.of { throw ActionError.refused(message: "LifeOS did not answer", forbidden: false) }
        #expect(failed == .failed("LifeOS did not answer"))
        #expect(failed.value == nil)
    }

    @Test func `a host that serves no documents has no guest links section, any other failure shows`() {
        #expect(GuestLinksRead.servedElsewhere("served elsewhere: env_box"))
        #expect(!GuestLinksRead.servedElsewhere("LifeOS did not answer"))
    }
}
