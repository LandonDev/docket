import Foundation
#if canImport(Security)
import Security
#endif

/// A key store that can also say which ids it holds, so a copy of a host that is gone can be found.
public protocol ShareKeychain: KeyStore {
    func ids() throws -> [String]
}

/// The extension's copy of each host key that may operate, in the keychain access group the app and the
/// share extension both hold (`group.dev.landon.tempcode`). The app keeps it in step with its pairings
/// (`sync`); the extension only reads it. A relayed host's socket asks for its carrier's key, which is
/// here whenever the relayed host's is: the same key, the same capabilities.
public struct ShareKeys: KeyStore {
    private let store: any ShareKeychain

    public init(store: any ShareKeychain) {
        self.store = store
    }

    /// Copies the key of every environment whose key may operate, and removes the copy of one that is
    /// gone or no longer may. `key` reads the app's own key by the id it is kept under (`keyOwner`).
    public func sync(_ environments: [PairedEnvironment], key: (String) -> String?) {
        var wanted: [String: String] = [:]
        for environment in environments where environment.allows(.operate) {
            if let found = key(environment.keyOwner) { wanted[environment.id] = found }
        }
        for id in (try? store.ids()) ?? [] where wanted[id] == nil {
            try? store.remove(for: id)
        }
        for (id, value) in wanted where (try? store.key(for: id)) != value {
            try? store.set(value, for: id)
        }
    }

    public func key(for hostId: String) -> String? {
        try? store.key(for: hostId)
    }

    public func set(_ key: String, for hostId: String) throws {
        try store.set(key, for: hostId)
    }

    public func remove(for hostId: String) throws {
        try store.remove(for: hostId)
    }
}

#if canImport(Security)
extension ShareKeys {
    /// The copies in the app group's keychain group: what the app writes and the extension reads.
    public static var group: ShareKeys { ShareKeys(store: GroupKeychain()) }
}

/// Generic-password items in the app group's keychain access group, one per host id, readable after the
/// first unlock and never backed up to another device.
public struct GroupKeychain: ShareKeychain {
    public static let accessGroup = "group.dev.landon.tempcode"
    public let service: String

    public init(service: String = "dev.landon.tempcode.share-key") {
        self.service = service
    }

    private var base: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccessGroup: Self.accessGroup]
    }

    private func query(_ id: String) -> [CFString: Any] {
        var query = base
        query[kSecAttrAccount] = id
        return query
    }

    public func ids() throws -> [String] {
        var query = base
        query[kSecReturnAttributes] = true
        query[kSecMatchLimit] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            let rows = out as? [[String: Any]] ?? []
            return rows.compactMap { $0[kSecAttrAccount as String] as? String }
        case errSecItemNotFound:
            return []
        default:
            throw KeyStoreError.keychain(status)
        }
    }

    public func key(for id: String) throws -> String? {
        var query = query(id)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        case errSecItemNotFound:
            return nil
        default:
            throw KeyStoreError.keychain(status)
        }
    }

    public func set(_ key: String, for id: String) throws {
        let data = Data(key.utf8)
        let status = SecItemUpdate(query(id) as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeyStoreError.keychain(status) }
        var item = query(id)
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeyStoreError.keychain(added) }
    }

    public func remove(for id: String) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeyStoreError.keychain(status) }
    }
}
#endif
