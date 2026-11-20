import Testing
import TempCodeContract
@testable import TempCodeClient

/// The cases of `computerTiles` in src/renderer/src/lib/computers.test.ts that hold on a phone, which draws every
/// session through `video.open` and so has no "this desktop may not draw it".
@Suite struct ComputerTilesTests {
    private func row(_ threadId: String, lastCallAt: Int = 1, apps: [ComputerSessionRow.App]? = nil, running: String? = nil, macName: String? = nil, driver: String? = nil) -> ComputerSessionRow {
        ComputerSessionRow(
            threadId: threadId, since: 1, lastCallAt: lastCallAt,
            apps: apps ?? [.init(name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled")],
            running: running.map { .init(tool: "computer_click", words: $0, startedAt: 5, held: nil) },
            tier: nil, macPeer: macName == nil ? nil : "env_studio", macName: macName, driver: driver
        )
    }
    private let chromium: [ComputerSessionRow.App] = [.init(name: "Chromium", bundleId: "org.chromium.Chromium", window: "Concur")]
    private let titles = ["mac\nt1": "Fix the invoice", "box\nb1": "File the expense report", "box\nb2": "Book the room"]
    private func titleOf(_ host: String, _ thread: String) -> String? { titles["\(host)\n\(thread)"] }
    private func nameOf(_ host: String) -> String { host == "mac" ? "Studio Mac" : "The box" }

    @Test func `one tile for each live session on every host, the one that acted last first, joined to its thread's title`() {
        let tiles = ComputerTiles.tiles(
            byHost: ["mac": [row("t1", lastCallAt: 5, running: "Clicking Save in TextEdit")], "box": [row("b1", lastCallAt: 9, apps: chromium), row("b2", lastCallAt: 2, apps: chromium)]],
            titleOf: titleOf, nameOf: nameOf
        )
        #expect(tiles.map(\.id) == ["box\nb1", "mac\nt1", "box\nb2"])
        #expect(tiles.map(\.title) == ["File the expense report", "Fix the invoice", "Book the room"])
        #expect(tiles.map(\.place) == ["The box", "Studio Mac", "The box"])
        #expect(tiles.map(\.doing) == [nil, "Clicking Save in TextEdit", nil])
    }

    @Test func `a page he drives is a tile that says so, with nothing running`() {
        let tile = ComputerTiles.tiles(byHost: ["box": [row("b1", apps: chromium, running: "stale", driver: "owner")]], titleOf: titleOf, nameOf: nameOf)[0]
        #expect(tile.driving && tile.doing == nil)
    }

    @Test func `a box thread driving a Mac says the Mac`() {
        let tile = ComputerTiles.tiles(byHost: ["box": [row("b1", macName: "Studio")]], titleOf: titleOf, nameOf: nameOf)[0]
        #expect(tile.place == "Studio")
    }

    @Test func `a session a box thread drives on a Mac is one tile, the box's, when the phone reaches both`() {
        let box = "env_" + String(repeating: "b", count: 22)
        let both = ComputerTiles.tiles(
            byHost: [box: [row("b1", macName: "Studio")], "mac": [row("\(box):b1")]],
            titleOf: { _, _ in "File the expense report" }, nameOf: nameOf
        )
        #expect(both.map(\.id) == ["\(box)\nb1"])
        #expect(both[0].place == "Studio")
        // the Mac alone: its row is the only one there is
        let alone = ComputerTiles.tiles(byHost: ["mac": [row("\(box):b1")]], titleOf: { _, _ in nil }, nameOf: nameOf)
        #expect(alone.map(\.title) == ["Untitled"])
    }

    @Test func `falls back to the window's name for a thread the phone does not hold, and is empty when nothing is driven`() {
        #expect(ComputerTiles.tiles(byHost: ["mac": [row("gone")]], titleOf: titleOf, nameOf: nameOf)[0].title == "Untitled")
        #expect(ComputerTiles.tiles(byHost: ["mac": [row("gone", apps: [.init(name: "Notes", bundleId: nil, window: nil)])]], titleOf: titleOf, nameOf: nameOf)[0].title == "Notes")
        #expect(ComputerTiles.tiles(byHost: ["mac": [], "box": []], titleOf: titleOf, nameOf: nameOf).isEmpty)
    }
}
