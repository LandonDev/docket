import Foundation

/// The paired hosts' names by environment id, in the App Group's defaults
/// so the notification service extension can read them. The host does not
/// know how many hosts a phone pairs with, so the phone decides: with two or
/// more hosts the extension appends the notice's `tc.host` to the subtitle;
/// with one it leaves the subtitle alone. Compiled into the app (which
/// publishes) and the extension (which reads).
nonisolated enum HostDirectory {
    static let suite = "group.dev.landon.tempcode"
    static let key = "hosts"

    /// The app's whole list, replaced each time the paired hosts change.
    static func publish(_ hosts: [(id: String, name: String)]) {
        let names = Dictionary(hosts.map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        UserDefaults(suiteName: suite)?.set(names, forKey: key)
    }

    /// Environment id → name; empty when the app never published (one host, or no App Group).
    static func names() -> [String: String] {
        (UserDefaults(suiteName: suite)?.dictionary(forKey: key) as? [String: String]) ?? [:]
    }

    /// A notice's subtitle with its host: "temp-code on box", the host under
    /// the name the person gave it (the directory's, by the notice's
    /// `tc.environmentId`), else the name the host sent (`tc.host`). Nil
    /// leaves the subtitle as it came: one host paired, or no host named.
    static func subtitle(_ subtitle: String, tc: [AnyHashable: Any], hosts: [String: String]) -> String? {
        guard hosts.count >= 2 else { return nil }
        let named = (tc["environmentId"] as? String).flatMap { hosts[$0] }
        guard let host = named ?? (tc["host"] as? String), !host.isEmpty else { return nil }
        return subtitle.isEmpty ? host : "\(subtitle) on \(host)"
    }
}
