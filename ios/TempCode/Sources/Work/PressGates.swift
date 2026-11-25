import LocalAuthentication
import SwiftUI
import TempCodeClient

/// Touch ID, Face ID or the passcode before an outward press (plan "The hold
/// on the phone"). The rule is the client package's `PressGate`; this is its
/// adapter: the setting (UserDefaults `PressGate.settingKey`, absent means on,
/// per phone), the system's check (`LAContext`, `.deviceOwnerAuthentication`),
/// and the moments a pass ends: the app leaving the foreground, the phone
/// locking, a key that changed on the press's host.
///
/// Every outward press awaits `allow` once per attempt, before its wait; a
/// false answer sends nothing, and the press site says `line` in its own bar.
/// The press is frozen before the system asks (its host, its key, the thing and
/// the revision); when the answer comes, the host's live client is looked up
/// again and a pass for another host or another key sends nothing
/// (`PressGate.holds`), and each press's wait checks the key once more at dispatch.
@MainActor @Observable
final class PressGates {
    static let shared = PressGates()

    /// "Require Touch ID to Send" (Settings → Work). Off only after a pass (`setOn`).
    private(set) var on: Bool
    /// What the phone can check its owner by, as last read.
    private(set) var device: PressGate.Device = .ready
    private(set) var sensor: PressGate.Sensor = .none

    @ObservationIgnored private var gate = PressGate()
    /// The key each host's last press went out under: another one ends the pass.
    @ObservationIgnored private var keys: [String: String] = [:]
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    /// The paired clients by environment id, as the root attached them: the live host and key after the check.
    @ObservationIgnored private var clients: (String) -> EnvironmentClient? = { _ in nil }

    private init() {
        on = UserDefaults.standard.object(forKey: PressGate.settingKey) as? Bool ?? true
        readDevice()
        let center = NotificationCenter.default
        let end: @Sendable (Notification) -> Void = { _ in Task { @MainActor in PressGates.shared.left() } }
        // The phone locking, and the app going to the background, end the pass.
        observers = [
            center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main, using: end),
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main, using: end),
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
                Task { @MainActor in PressGates.shared.resigned() }
            },
        ]
    }

    func attach(_ clients: @escaping (String) -> EnvironmentClient?) {
        self.clients = clients
    }

    /// A host's live client, nil when it left the phone.
    func client(_ host: String) -> EnvironmentClient? { clients(host) }

    /// The key a host's live client presses under now, nil when it left the phone.
    func liveKey(_ host: String) -> String? {
        clients(host).map { Self.key($0.environment, revoked: $0.work.keyRevoked) }
    }

    /// The key a press goes out under: the paired key's id and what it may do, so a replaced or narrowed key is another key.
    /// It ends with the foreground it was taken in (`|f<n>`): a press approved before the app left and came back is
    /// never sent on its return (`SendWait.keyWhy`), though key, link and screen look the same again.
    static func key(_ environment: PairedEnvironment, revoked: Bool) -> String {
        "\(environment.keyId)|\(environment.caps.map(\.rawValue).sorted().joined(separator: ","))\(revoked ? "|revoked" : "")|f\(shared.foreground)"
    }

    /// Counts the times the app went to the background or the phone locked: a press carries the count it was approved
    /// under, and a frame of it is released only in that same foreground.
    private(set) var foreground = 0

    /// The press for `action` on one thing of a host: the item's ref and the revision he saw.
    static func press(_ client: EnvironmentClient, _ action: KeyMethod, ref: String, rev: String) -> PressGate.Press {
        PressGate.Press(host: client.environment.id, key: key(client.environment, revoked: client.work.keyRevoked), action: action.rawValue, ref: ref, rev: rev)
    }

    /// True: the press may go. `reason` says the act in plain words ("Send to Dana Whitfield").
    func allow(_ press: PressGate.Press, reason: String) async -> Bool {
        // Host by host, a group's members too: another key on any of them ends the pass (`PressGate.keys(after:)`).
        let noted = PressGate.keys(after: press, known: keys)
        if noted.changed { gate.end() }
        keys = noted.keys
        readDevice()
        switch gate.begin(press, on: on, device: device, now: Self.now) {
        case .go:
            return true
        case .unavailable, .busy:
            return false
        case .ask(let asked):
            let passed = await Self.evaluate(reason)
            return gate.answered(passed, for: asked, now: Self.now, live: live(asked))
        }
    }

    /// The press as its host stands now: the same thing and revision, under the host's live key. A press on many
    /// hosts (`host` joined with commas) is held to each of them.
    private func live(_ press: PressGate.Press) -> PressGate.Press? {
        let hosts = press.host.split(separator: ",").map(String.init)
        let keys = hosts.map(liveKey)
        guard !keys.contains(where: { $0 == nil }) else { return nil }
        var now = press
        now.key = keys.compactMap { $0 }.joined(separator: ";")
        return now
    }

    /// One press's link, then its check. Nil: it may go. Else the words for the press site's own line: "Not
    /// connected to <host>" at once with no link (nothing asked, nothing sent), or `line`.
    func pass(_ client: EnvironmentClient, _ action: KeyMethod, ref: String, rev: String, reason: String) async -> String? {
        guard OutboxPresses.linked(client) else { return PendingPresses.notConnected(client.environment.name) }
        return await allow(Self.press(client, action, ref: ref, rev: rev), reason: reason) ? nil : line
    }

    /// The bar's words when `allow` said no.
    var line: String {
        on && device == .noPasscode ? PressGate.unavailableLine : PressGate.cancelledLine
    }

    /// The switch. Turning the check off needs a pass; a cancel or a failure leaves it on.
    func setOn(_ next: Bool) async {
        guard next != on else { return }
        if !next {
            guard await Self.evaluate("Turn off \(PressGate.settingTitle(sensor: sensor))") else { return }
        }
        on = next
        UserDefaults.standard.set(next, forKey: PressGate.settingKey)
    }

    // MARK: - the system

    private static var now: Double { Date().timeIntervalSince1970 }

    /// Reads whether a passcode is set and which sensor the phone has.
    func readDevice() {
        let context = LAContext()
        var error: NSError?
        device = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) ? .ready : .noPasscode
        sensor = switch context.biometryType {
        case .touchID: .touchID
        case .faceID: .faceID
        case .opticID: .opticID
        default: .none
        }
    }

    private static func evaluate(_ reason: String) async -> Bool {
        let context = LAContext()
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    /// Background or lock: the pass is over, and an answer still on its way counts for nothing.
    private func left() {
        gate.end()
        foreground &+= 1
    }

    /// The scene left `.active`. The system's own check makes the app inactive while it asks, so a resign
    /// during an ask is that sheet, not him leaving; any other ends the pass.
    private func resigned() {
        guard gate.asking == nil else { return }
        gate.end()
    }
}
