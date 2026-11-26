import Testing
@testable import TempCodeClient

/// A place's list comes back only to a row it draws (`PlaceTopRules`): Today's section ids and folded rows were
/// handed to UIKit's scroll and ended the app (the S10a crash, f21 and f24).
struct PlaceTopRulesTests {
    @Test func aKeptRowComesBackOnlyWhileTheListDrawsIt() {
        let rows = ["fold:earlier:held", "row:a", "row:b", "fold:more:held"]
        #expect(PlaceTopRules.target(kept: "row:b", rows: rows) == "row:b")
        #expect(PlaceTopRules.target(kept: "fold:more:held", rows: rows) == "fold:more:held")
        // A section's own id, or a row now folded away: the list stays at its top.
        #expect(PlaceTopRules.target(kept: "section:held", rows: rows) == nil)
        #expect(PlaceTopRules.target(kept: "row:c", rows: rows) == nil)
        #expect(PlaceTopRules.target(kept: nil, rows: rows) == nil)
        #expect(PlaceTopRules.target(kept: "row:a", rows: []) == nil)
    }
}
