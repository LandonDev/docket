import Testing
@testable import TempCodeClient

/// A Work thread's item as its hero (milestone 47, ThreadFrame.swift).
struct WorkItemSegmentTests {
    @Test func aChatWithAnOpenItemIsItemAndChat() {
        #expect(ThreadSegment.segments(for: .chat, hasItems: true) == [.item, .chat])
        #expect(ThreadSegment.segments(for: .chat, hasItems: false) == [.chat])
        #expect(ThreadSegment.item.title == "Item")
    }

    @Test func aThreadWithAHeroOfItsOwnKeepsIt() {
        #expect(ThreadSegment.segments(for: .implementation, hasItems: true) == [.board, .chat])
        #expect(ThreadSegment.segments(for: .planning, hasItems: true) == [.plan, .chat])
        #expect(ThreadSegment.segments(for: .subagent, hasItems: true) == [.chat])
    }
}
