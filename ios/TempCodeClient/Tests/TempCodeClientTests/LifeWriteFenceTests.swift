import Testing
@testable import TempCodeClient

@Suite struct LifeWriteFenceTests {
    @Test(arguments: ["replies:send", "replies:retry", "compose:send", "compose:retry"])
    func `a write that sends as him is refused`(_ path: String) {
        #expect(throws: LifeWriteFence.Refusal(path: path)) { try LifeWriteFence.check(path) }
    }

    @Test(arguments: ["replies:undo", "tasks:update", "compose:save", "mail:archive"])
    func `every other write passes`(_ path: String) throws {
        try LifeWriteFence.check(path)
    }

    /// Waiting on's Dismiss and its Undo are LifeOS's own, undoable, and send nothing: they pass.
    @Test(arguments: ["mailWaits:dismiss", "mailWaits:putBack"])
    func `waiting on's dismiss and undo pass`(_ path: String) throws {
        try LifeWriteFence.check(path)
    }
}
