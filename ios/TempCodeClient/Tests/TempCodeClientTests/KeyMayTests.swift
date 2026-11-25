import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// KeyMay against Fixtures/keymay.json, which scripts/ios-keymay-fixture.test.ts
/// writes from the host's own rules (capabilities.ts, the person checks, the relay).
@Suite struct KeyMayTests {
    struct Fixture: Decodable {
        struct Key: Decodable {
            var caps: [String]
            var revoked: Bool?
        }

        struct Row: Decodable {
            var method: String
            var word: String?
            var relay: String
            var allowed: [String: Bool]
            var relayed: Bool
            var relayedLocked: Bool
        }

        var keys: [String: Key]
        var rows: [Row]
    }

    static let fixture: Fixture = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/keymay.json")
        return try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }()

    static func key(_ name: String, lane: KeyMay.Lane = .direct) -> KeyMay {
        let key = fixture.keys[name]!
        return KeyMay(caps: key.caps.map(Capability.init(rawValue:)), revoked: key.revoked == true, lane: lane)
    }

    @Test func `every method in the table has a row and every row a method`() {
        let rows = Set(Self.fixture.rows.map(\.method))
        #expect(rows == Set(KeyMethod.allCases.map(\.rawValue)))
    }

    @Test func `the person word and the relay are the host's`() throws {
        for row in Self.fixture.rows {
            let rule = try #require(KeyMethod(rawValue: row.method)).rule
            #expect(rule.word?.rawValue == row.word, "\(row.method)")
            #expect(rule.relay.rawValue == row.relay, "\(row.method)")
        }
    }

    @Test func `every kind of key may press exactly what the host allows`() throws {
        for row in Self.fixture.rows {
            let method = try #require(KeyMethod(rawValue: row.method))
            for (name, allowed) in row.allowed {
                #expect(Self.key(name)(method) == allowed, "\(name) \(row.method)")
            }
            #expect(Self.key("operateApproveAdmin", lane: .relayed)(method) == row.relayed, "relayed \(row.method)")
            #expect(Self.key("operateApproveAdmin", lane: .relayedLocked)(method) == row.relayedLocked, "locked \(row.method)")
        }
    }

    @Test func `approve never stands in for operate and admin never for the word approve`() {
        let approve = KeyMay(caps: [.read, .approve])
        #expect(approve(.outboxSend))
        #expect(!approve(.routinesPause))
        #expect(!approve(.guestsRevoke))
        let admin = KeyMay(caps: [.read, .admin])
        #expect(admin(.routinesPause))
        #expect(admin(.outboxGrant))
        #expect(!admin(.outboxSend))
        #expect(!admin(.outboxEdit))
        #expect(!admin(.outboxDiscard))
        #expect(!admin(.outboxUndo))
    }

    @Test func `a read key and a revoked key press nothing`() {
        let read = KeyMay(caps: [.read])
        let revoked = KeyMay(caps: [.read, .operate, .approve, .admin], revoked: true)
        let presses = KeyMethod.allCases.filter { $0.rule.need != .read }
        #expect(presses.allSatisfy { !read($0) })
        #expect(KeyMethod.allCases.allSatisfy { !revoked($0) })
    }

    @Test func `an admin-only key sees no Review and no Put Back; a locked Mac's lane shows no Open on Mac`() {
        let admin = KeyMay(caps: [.read, .admin])
        for method in [KeyMethod.reviewWeek, .reviewList, .reviewSettle, .reviewUndo, .reviewSeen, .filesRestore] { #expect(!admin(method)) }
        #expect(admin(.filesTrash))
        #expect(KeyMay(caps: [.read, .approve])(.reviewSettle))
        #expect(KeyMay(caps: [.read, .operate])(.filesRestore))
        // The live lane follows what the box last said of the Mac's screen.
        let full: [Capability] = [.read, .operate, .approve, .admin]
        #expect(KeyMay(caps: full, lane: .of(relayed: true, locked: false))(.reveal))
        #expect(!KeyMay(caps: full, lane: .of(relayed: true, locked: true))(.reveal))
        #expect(KeyMay.Lane.of(relayed: false, locked: true) == .direct)
    }
}
