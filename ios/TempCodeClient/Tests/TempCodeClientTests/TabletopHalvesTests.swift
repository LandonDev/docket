import Foundation
import Testing
@testable import TempCodeClient

/// The Duo on a table (docs/IOS-DESIGN.md "Work in every pose"): the thing above the fold, its controls
/// below, nothing within the band. Numbers from the 669 × 951 window the plan names for the pose.
@Suite struct TabletopHalvesTests {
    private let window = CGRect(x: 0, y: 0, width: 669, height: 951)
    private let band = CGRect(x: 0, y: 469, width: 669, height: 13)

    @Test func `the thing stands above the band and the controls lie below it`() throws {
        let halves = try #require(TabletopHalves.of(window: window, division: band))
        #expect(halves.thing == CGRect(x: 0, y: 0, width: 669, height: 469))
        #expect(halves.controls == CGRect(x: 0, y: 482, width: 669, height: 469))
    }

    @Test func `nothing within the band: the halves end where it starts and start where it ends`() throws {
        let halves = try #require(TabletopHalves.of(window: window, division: band))
        #expect(halves.thing.maxY == band.minY)
        #expect(halves.controls.minY == band.maxY)
        #expect(!halves.thing.intersects(band.insetBy(dx: 0, dy: 1)))
        #expect(!halves.controls.intersects(band.insetBy(dx: 0, dy: 1)))
    }

    @Test func `a window that does not start at the origin keeps its own edges`() throws {
        let shifted = CGRect(x: 10, y: 20, width: 669, height: 951)
        let halves = try #require(TabletopHalves.of(window: shifted, division: CGRect(x: 10, y: 489, width: 669, height: 13)))
        #expect(halves.thing == CGRect(x: 10, y: 20, width: 669, height: 469))
        #expect(halves.controls == CGRect(x: 10, y: 502, width: 669, height: 469))
    }

    @Test func `no band, or a band standing upright, is no table`() {
        #expect(TabletopHalves.of(window: window, division: nil) == nil)
        // The book pose and the open Duo: the band runs top to bottom; columns, not halves.
        #expect(TabletopHalves.of(window: CGRect(x: 0, y: 0, width: 951, height: 669), division: CGRect(x: 469, y: 0, width: 13, height: 669)) == nil)
    }

    @Test func `a band that leaves either half too short is no table`() {
        #expect(TabletopHalves.of(window: window, division: CGRect(x: 0, y: 150, width: 669, height: 13)) == nil)
        #expect(TabletopHalves.of(window: window, division: CGRect(x: 0, y: 800, width: 669, height: 13)) == nil)
        // At the shortest half allowed, both sides still stand.
        #expect(TabletopHalves.of(window: window, division: CGRect(x: 0, y: 200, width: 669, height: 13)) != nil)
    }
}
