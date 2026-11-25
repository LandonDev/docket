import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Away by kind on the phone (docs/agents/away-from-computer.md): two switches over `away.set {code, work}`,
/// one for a host one release behind, each with its tally.
@Suite struct AwayKindsTests {
    private func state(_ json: String) throws -> AwayState {
        try JSONDecoder().decode(AwayState.self, from: Data(json.utf8))
    }

    private let byKind = #"{"enabled":false,"code":false,"work":true,"codeAt":1000,"workAt":5000,"at":5000,"by":"box"}"#
    private let older = #"{"enabled":true,"at":3000,"by":"box"}"#

    // MARK: - the two shapes

    @Test func `a host that knows kinds is read kind by kind; an older host's enabled stands for both`() throws {
        let kinds = try state(byKind)
        #expect(AwayKinds.byKind(kinds))
        #expect(!AwayKinds.on(kinds, .code))
        #expect(AwayKinds.on(kinds, .work))
        #expect(AwayKinds.any(kinds))
        let old = try state(older)
        #expect(!AwayKinds.byKind(old))
        #expect(AwayKinds.on(old, .code) && AwayKinds.on(old, .work))
        #expect(!AwayKinds.any(try state(#"{"enabled":false,"at":0,"by":""}"#)))
        // `enabled` false with Work alone on is still a stretch: an old reader's "both" is not the phone's.
        #expect(!kinds.enabled)
    }

    @Test func `the stretch began at the earliest flip among the kinds that are on`() throws {
        let both = try state(#"{"enabled":true,"code":true,"work":true,"codeAt":1000,"workAt":2000,"at":2000,"by":"box"}"#)
        #expect(AwayKinds.since(both) == 1000)
        #expect(AwayKinds.since(try state(byKind)) == 5000)
        #expect(AwayKinds.since(try state(older)) == 3000)
        #expect(AwayKinds.since(try state(#"{"enabled":false,"code":false,"work":false,"at":9,"by":"box"}"#)) == nil)
    }

    @Test func `away.set names the one kind to a host that knows kinds, and enabled to an older one`() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let words = { (params: Methods.AwaySet.Params) in String(decoding: try encoder.encode(params), as: UTF8.self) }
        #expect(try words(AwayKinds.params(.code, on: true, byKind: true)) == #"{"code":true}"#)
        #expect(try words(AwayKinds.params(.work, on: false, byKind: true)) == #"{"work":false}"#)
        #expect(try words(AwayKinds.params(.work, on: true, byKind: false)) == #"{"enabled":true}"#)
        #expect(try words(AwayKinds.params(nil, on: true, byKind: true)) == #"{"enabled":true}"#)
    }

    // MARK: - the menu

    @Test func `the menu has Away for Code and Away for Work, each with its own tally`() throws {
        let tally = AwayDecided(since: 1000, threads: [.init(sessionId: "w1", count: 3), .init(sessionId: "c1", count: 1), .init(sessionId: "gone", count: 2), .init(sessionId: "w2", count: 0)])
        let scopes: [String: SessionScope] = ["w1": .work, "w2": .work, "c1": .code]
        let switches = AwayKinds.switches(AwaySnapshot(state: try state(byKind), decided: tally)) { scopes[$0] }
        #expect(switches.map(\.title) == ["Away for Code", "Away for Work"])
        #expect(switches.map(\.on) == [false, true])
        // A thread the lists no longer hold counts as Code, as the host's own rule reads a row with no scope.
        #expect(switches.map(\.decided) == [3, 3])
        #expect(switches.map(\.tally) == ["3 decisions", "3 decisions"])
        #expect(switches.map(\.id) == ["code", "work"])
    }

    @Test func `an older host has one Away for both, with the whole tally`() throws {
        let tally = AwayDecided(since: 1000, threads: [.init(sessionId: "w1", count: 1)])
        let switches = AwayKinds.switches(AwaySnapshot(state: try state(older), decided: tally)) { _ in .work }
        #expect(switches.count == 1)
        #expect(switches[0].kind == nil)
        #expect(switches[0].title == "Away")
        #expect(switches[0].on)
        #expect(switches[0].tally == "1 decision")
    }

    @Test func `a kind with nothing decided shows no tally`() throws {
        let switches = AwayKinds.switches(AwaySnapshot(state: try state(byKind), decided: AwayDecided(since: 0, threads: []))) { _ in nil }
        #expect(switches.allSatisfy { $0.tally == nil })
    }
}
