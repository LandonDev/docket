import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The group keychain in memory, counting writes.
final class FakeShareKeychain: ShareKeychain, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: String] = [:]
    private(set) var writes = 0

    func ids() throws -> [String] { lock.withLock { keys.keys.sorted() } }
    func key(for id: String) throws -> String? { lock.withLock { keys[id] } }
    func set(_ key: String, for id: String) throws { lock.withLock { keys[id] = key; writes += 1 } }
    func remove(for id: String) throws { _ = lock.withLock { keys.removeValue(forKey: id) } }
}

@Suite struct ShareKeysTests {
    private func environment(_ id: String, _ caps: [Capability], via: String? = nil) -> PairedEnvironment {
        PairedEnvironment(id: id, name: id, origin: URL(string: "https://\(id).example")!, caps: caps, keyId: "k-\(id)", keyName: "phone", addedAt: 0, via: via)
    }

    private let appKeys = ["box": "tc_box.secret", "reader": "tc_reader.secret", "boss": "tc_boss.secret"]

    @Test func `only a key that may operate is copied, a relayed host with its carrier's key`() throws {
        let store = FakeShareKeychain()
        let keys = ShareKeys(store: store)
        keys.sync([
            environment("box", [.read, .operate]),
            environment("reader", [.read]),
            environment("boss", [.admin]),
            environment("mac", [.read, .operate], via: "box")
        ]) { appKeys[$0] }
        #expect(try store.ids() == ["boss", "box", "mac"])
        #expect(keys.key(for: "box") == "tc_box.secret")
        #expect(keys.key(for: "mac") == "tc_box.secret")
        #expect(keys.key(for: "reader") == nil)
        #expect(try (keys as any KeyStore).key(for: "boss") == "tc_boss.secret", "the extension's socket reads it as a key store")
    }

    @Test func `a host that is gone or lost operate loses its copy; an unchanged copy is not written again`() throws {
        let store = FakeShareKeychain()
        let keys = ShareKeys(store: store)
        keys.sync([environment("box", [.operate]), environment("reader", [.operate]), environment("boss", [.operate])]) { appKeys[$0] }
        #expect(store.writes == 3)
        keys.sync([environment("box", [.operate]), environment("reader", [.read])]) { appKeys[$0] }
        #expect(try store.ids() == ["box"])
        #expect(store.writes == 3)
        keys.sync([environment("box", [.operate])]) { _ in nil }
        #expect(try store.ids().isEmpty, "no key in the app: nothing to copy")
    }
}
