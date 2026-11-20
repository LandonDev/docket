import Foundation
import Testing
@testable import TempCodeClient

/// His touches and keys on the phone's full screen as a `drive` stream's records (docs/agents/live-video.md "Driving"),
/// and the records' bytes as src/shared/video/nsl1.ts `encodeInput` writes them.
@Suite struct VideoInputTests {
    private final class Sent {
        var records: [InputRecord] = []
        var pastes: [String] = []
    }

    private func driving() -> (PhoneDriving, Sent) {
        let sent = Sent()
        return (PhoneDriving(send: { sent.records.append($0) }, paste: { sent.pastes.append($0) }), sent)
    }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    @Test func `a record's bytes are nsl1.ts's, byte for byte`() {
        // each line is `encodeInput(event, 7)` from src/shared/video/nsl1.ts
        #expect(hex(NSL1.encodeInput(.button(true, 1, 0.5, 0.25, buttons: 1), generation: 7)) == "4e534c310103000000000007000000000000001004000001000000008000400000010000")
        #expect(hex(NSL1.encodeInput(.wheel(horizontal: false, delta: -240, 1, 0), generation: 7)) == "4e534c310103000000000007000000000000001006000000ffffff10ffff000000000000")
        #expect(hex(NSL1.encodeInput(.key(true, 4, modifiers: 2), generation: 7)) == "4e534c310103000000000007000000000000001001000004000000000000000000000002")
        #expect(hex(NSL1.encodeInput(.releaseAll, generation: 7)) == "4e534c310103000000000007000000000000001007000000000000000000000000000000")
    }

    @Test func `a tap is a left click where he tapped`() {
        let (input, sent) = driving()
        input.tap(0.25, 0.75)
        #expect(sent.records == [
            .move(0.25, 0.75),
            .button(true, 1, 0.25, 0.75, buttons: 1),
            .button(false, 1, 0.25, 0.75, buttons: 0),
        ])
    }

    @Test func `a long press is a right click`() {
        let (input, sent) = driving()
        input.longPress(0.5, 0.5)
        #expect(sent.records == [
            .move(0.5, 0.5),
            .button(true, 3, 0.5, 0.5, buttons: 4),
            .button(false, 3, 0.5, 0.5, buttons: 0),
        ])
    }

    @Test func `a drag moves with the left button down and lets it go where it ends, inside the picture`() {
        let (input, sent) = driving()
        input.dragBegan(0.1, 0.1)
        input.dragMoved(0.3, 0.2)
        input.dragMoved(1.4, -0.2)
        input.dragEnded(0.9, 0.5)
        #expect(sent.records == [
            .move(0.1, 0.1),
            .button(true, 1, 0.1, 0.1, buttons: 1),
            .move(0.3, 0.2, buttons: 1),
            .move(1, 0, buttons: 1),
            .move(0.9, 0.5, buttons: 1),
            .button(false, 1, 0.9, 0.5, buttons: 0),
        ])
    }

    @Test func `two fingers scroll in whole notches, fingers up scrolling the page down, and keep a part notch for the next move`() {
        let (input, sent) = driving()
        let notch = PhoneDriving.pointsPerNotch
        input.scroll(dx: 0, dy: -notch * 2.5, 0.5, 0.5)
        #expect(sent.records == [.wheel(horizontal: false, delta: 240, 0.5, 0.5)])
        // the half notch left over makes the next half a whole one
        input.scroll(dx: 0, dy: -notch / 2, 0.5, 0.5)
        #expect(sent.records.last == .wheel(horizontal: false, delta: 120, 0.5, 0.5))
        // a turn the other way starts from nothing
        sent.records = []
        input.scroll(dx: notch * 0.6, dy: notch * 0.6, 0.5, 0.5)
        #expect(sent.records.isEmpty)
        input.scroll(dx: notch * 0.6, dy: 0, 0.5, 0.5)
        #expect(sent.records == [.wheel(horizontal: true, delta: -120, 0.5, 0.5)])
        // a fling is held to ten notches
        input.scroll(dx: 0, dy: -notch * 40, 0.5, 0.5)
        #expect(sent.records.last == .wheel(horizontal: false, delta: 1_200, 0.5, 0.5))
    }

    @Test func `what a US keyboard has goes as its keys, Shift held for a capital or a shifted sign`() {
        let (input, sent) = driving()
        input.type("a")
        #expect(sent.records == [.key(true, 4), .key(false, 4)])
        sent.records = []
        input.type("A")
        #expect(sent.records == [.key(true, 225, modifiers: 2), .key(true, 4, modifiers: 2), .key(false, 4, modifiers: 2), .key(false, 225)])
        sent.records = []
        input.type("0!?\n ")
        #expect(sent.records.filter { $0.kind == .keyDown && $0.code != 225 }.map(\.code) == [39, 30, 56, 40, 44])
        #expect(sent.pastes.isEmpty)
    }

    @Test func `every character a US keyboard has is a key, and nothing else is`() {
        let typable = (0x20...0x7E).map { Character(UnicodeScalar($0)!) } + ["\n", "\t"]
        for c in typable { #expect(PhoneDriving.usKey(c) != nil, "\(c)") }
        for c: Character in ["é", "’", "€", "😀", "ß"] { #expect(PhoneDriving.usKey(c) == nil, "\(c)") }
    }

    @Test func `other characters go through the source's own typing, each run as one paste, in their place`() {
        let (input, sent) = driving()
        input.type("café ok")
        #expect(sent.pastes == ["é"])
        // c, a, f before the paste; space, o, k after it
        #expect(sent.records.filter { $0.kind == .keyDown }.map(\.code) == [6, 4, 9, 44, 18, 14])
        input.type("’’")
        #expect(sent.pastes == ["é", "’’"])
    }

    @Test func `delete is Backspace, and letting go sends release-all only when something is held`() {
        let (input, sent) = driving()
        input.deleteBackward()
        #expect(sent.records == [.key(true, 42), .key(false, 42)])
        sent.records = []
        input.release()
        #expect(sent.records.isEmpty)
        input.dragBegan(0.5, 0.5)
        input.release()
        #expect(sent.records.last == .releaseAll)
    }
}
