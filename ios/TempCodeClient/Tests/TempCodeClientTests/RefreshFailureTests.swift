import Foundation
import Testing
@testable import TempCodeClient

/// A pull or Try Again over an item's kept rows ends with the read it started, never when it asked (council round 5,
/// sitting F): a meeting's, a form's, a dashboard's and a video's preparation check.
@MainActor @Suite struct RefreshFailureTests {
    @Test func `a reread waits for the read's answer and clears the failure`() async {
        let refresh = RefreshFailure()
        refresh.failed("Not connected")
        let seen = Seen()
        let pull = Task { await refresh.reread { seen.asked += 1 }; seen.done = true }
        try? await Task.sleep(for: .milliseconds(300))
        #expect(seen.asked == 1)
        #expect(!seen.done)
        refresh.answered()
        await pull.value
        #expect(seen.done)
        #expect(refresh.error == nil)
    }

    @Test func `a reread that fails ends with the failure kept`() async {
        let refresh = RefreshFailure()
        let pull = Task { await refresh.reread {} }
        try? await Task.sleep(for: .milliseconds(150))
        refresh.failed("The host did not answer")
        await pull.value
        #expect(refresh.error == "The host did not answer")
    }

    @Test func `a cancelled pull stops waiting`() async {
        let refresh = RefreshFailure()
        let pull = Task { await refresh.reread {} }
        pull.cancel()
        await pull.value
        #expect(refresh.error == nil)
    }
}

@MainActor private final class Seen {
    var asked = 0
    var done = false
}
