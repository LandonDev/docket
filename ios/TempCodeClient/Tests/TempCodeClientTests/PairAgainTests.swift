import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Pair Again on a host already paired (council 13, Sol 2): a new key is a new generation, so the cache drops what the
/// old key read, and the live client is rebuilt on it; the same key again, a rename or a hello's platform is not.
@Suite struct PairAgainTests {
    private static func paired(keyId: String = "K1", caps: [Capability] = [.read, .approve], addedAt: Double = 1_000) -> PairedEnvironment {
        PairedEnvironment(id: "env_mac", name: "Mac", origin: URL(string: "https://mac.example")!, caps: caps, keyId: keyId, keyName: "iphone", addedAt: addedAt)
    }

    @Test func `a key of another id or other caps starts a new generation; the same key keeps the old one`() {
        var old = Self.paired()
        old.customName = "Studio Mac"
        old.platform = "darwin"
        // Approve to read only, under a new key: the generation moves, so the Mac's kept rows of the old key go.
        let readOnly = Self.paired(keyId: "K2", caps: [.read], addedAt: 2_000).replacing(old)
        #expect(readOnly.addedAt == 2_000)
        #expect(readOnly.customName == "Studio Mac" && readOnly.platform == "darwin")
        // The same key id with other caps (the host changed what it may do): a new generation too.
        #expect(Self.paired(caps: [.read], addedAt: 2_000).replacing(old).addedAt == 2_000)
        // The same key pasted again: the old generation stands, and with it what the key read.
        #expect(Self.paired(addedAt: 2_000).replacing(old).addedAt == 1_000)
    }

    @Test func `the live client is rebuilt only for another key, never for a name or a platform`() {
        let live = Self.paired()
        #expect(!live.sameKey(as: Self.paired(keyId: "K2", caps: [.read], addedAt: 2_000)))
        #expect(!live.sameKey(as: Self.paired(caps: [.read])))
        var renamed = live
        renamed.name = "Mac mini"
        renamed.customName = "Studio"
        renamed.platform = "darwin"
        #expect(live.sameKey(as: renamed))
    }

    @Test func `a lane through a carrier takes the carrier's new generation, so Pair Again on the carrier reaches it`() {
        let mac = RelayedHost(id: "env_mac", via: "env_box", presence: presence(), learnedAt: 5_000)
        var box = PairedEnvironment(id: "env_box", name: "Box", origin: URL(string: "https://box.example")!, caps: [.read, .approve], keyId: "K1", keyName: "iphone", addedAt: 1_000)
        // Learned after the carrier was paired: the lane's generation is when it was learned, as before.
        let before = PairedEnvironment.relayed(mac, through: box)
        #expect(before.addedAt == 5_000)
        // Box paired again with a read key: the lane takes the new key, caps and generation, so it is rebuilt and what
        // the old key read through it goes, its rows under other hosts' keys among them.
        box = PairedEnvironment(id: "env_box", name: "Box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K2", keyName: "iphone", addedAt: 9_000).replacing(box)
        let after = PairedEnvironment.relayed(mac, through: box)
        #expect(after.addedAt == 9_000 && after.caps == [.read] && after.keyId == "K2")
        #expect(!after.sameKey(as: before) && !after.sameLane(as: before))
    }
}
