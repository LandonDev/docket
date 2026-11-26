import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func status(_ transport: TransportState, attempts: Int = 0, halt: HaltReason? = nil, retryAt: Double? = nil) -> EnvironmentStatus {
    var status = EnvironmentStatus(transport: transport, attempts: attempts, halt: halt)
    status.nextRetryAt = retryAt
    return status
}

private let identityChanged = HaltReason.identityChanged(expected: "env_a", got: "env_b")
private let hostNewer = HaltReason.contractMismatch(app: 3, host: 4)
private let hostOlder = HaltReason.contractMismatch(app: 4, host: 3)

@Suite("ConnectionWord")
struct ConnectionWordTests {
    @Test(arguments: [
        (status(.open), "Connected"),
        (status(.connecting), "Connecting…"),
        (status(.connecting, attempts: 1), "Not answering"),
        (status(.reconnecting), "Reconnecting…"),
        (status(.offline), "Offline"),
        (status(.offline, halt: identityChanged), "Another computer"),
        (status(.offline, halt: hostNewer), "Needs an update"),
        (status(.unauthorized), "Refuses this key"),
        (status(.suspended), "Reconnecting…"),
    ])
    func `one word per transport state`(status: EnvironmentStatus, word: String) {
        #expect(ConnectionWord.text(for: status) == word)
    }
}

@Suite("ConnectionSentence")
struct ConnectionSentenceTests {
    /// 1,000 s after the epoch, in the status's milliseconds.
    private let now = Date(timeIntervalSince1970: 1000)

    @Test(arguments: [
        (status(.open), "Connected"),
        (status(.connecting), "Connecting to the box…"),
        (status(.connecting, attempts: 2, retryAt: 1_005_000), "the box did not answer; retrying in 5 s"),
        (status(.reconnecting, retryAt: 1_005_000), "the box dropped; retrying in 5 s"),
        (status(.reconnecting, retryAt: 999_000), "Reconnecting to the box…"),
        (status(.reconnecting), "Reconnecting to the box…"),
        (status(.suspended), "Reconnecting to the box…"),
        (status(.offline), "the box is offline"),
        (status(.offline, halt: identityChanged), "the box’s address answers as another computer"),
        (status(.offline, halt: hostNewer), "the box is newer than this app"),
        (status(.offline, halt: hostOlder), "the box is older than this app"),
        (status(.unauthorized), "the box no longer accepts this key"),
    ])
    func `the desktop's sentence per state`(status: EnvironmentStatus, text: String) {
        #expect(ConnectionSentence.text(name: "the box", status: status, now: now) == text)
    }

    @Test func `the host's own error never shows`() {
        var offline = status(.offline)
        offline.lastError = "ECONNREFUSED 10.0.0.2:8787"
        #expect(ConnectionSentence.text(name: "Studio Mac", status: offline, now: now) == "Studio Mac is offline")
    }

    @Test func `only a countdown ticks`() {
        #expect(ConnectionSentence.ticks(status(.reconnecting, retryAt: 1_005_000)))
        #expect(ConnectionSentence.ticks(status(.connecting, attempts: 1, retryAt: 1_005_000)))
        #expect(!ConnectionSentence.ticks(status(.reconnecting)))
        #expect(!ConnectionSentence.ticks(status(.offline)))
    }
}

@Suite("abbreviatedEnvironmentId")
struct AbbreviatedEnvironmentIdTests {
    @Test func `a 22-character body keeps its prefix, four head and four tail characters`() {
        #expect(abbreviatedEnvironmentId("env_AbCdEfGhIjKlMnOpQrStUv") == "env_AbCd…StUv")
    }

    @Test func `a short body stays whole`() {
        #expect(abbreviatedEnvironmentId("env_AbCdEfGhIj") == "env_AbCdEfGhIj")
        #expect(abbreviatedEnvironmentId("env_") == "env_")
        #expect(abbreviatedEnvironmentId("") == "")
    }

    @Test func `an id without the prefix is abbreviated without one`() {
        #expect(abbreviatedEnvironmentId("AbCdEfGhIjKlMnOpQrStUv") == "AbCd…StUv")
    }
}

@Suite("sentence")
struct SentenceTests {
    @Test func `capitalises and adds a full stop`() {
        #expect(sentence("that is not a pairing link") == "That is not a pairing link.")
    }

    @Test func `keeps a trailing question or exclamation mark`() {
        #expect(sentence("is the host up?") == "Is the host up?")
        #expect(sentence("refused!") == "Refused!")
        #expect(sentence("already a sentence.") == "Already a sentence.")
    }

    @Test func `trims whitespace and leaves empty alone`() {
        #expect(sentence("  no key for this host \n") == "No key for this host.")
        #expect(sentence("") == "")
        #expect(sentence("   ") == "")
    }
}

@Suite("HostFix")
struct HostFixTests {
    @Test(arguments: [
        (status(.unauthorized), HostFix.pairAgain),
        (status(.reconnecting), .retry),
        (status(.offline), .retry),
        (status(.offline, halt: identityChanged), .pairAgain),
        (status(.offline, halt: hostNewer), nil),
        (status(.connecting), nil),
        (status(.connecting, attempts: 1), .retry),
        (status(.open), nil),
        (status(.suspended), nil),
    ] as [(EnvironmentStatus, HostFix?)])
    func `the one action per state`(status: EnvironmentStatus, fix: HostFix?) {
        #expect(HostFix.fix(for: status) == fix)
    }

    @Test func `titles`() {
        #expect(HostFix.retry.title == "Retry Now")
        #expect(HostFix.pairAgain.title == "Sign In Again")
    }

    @Test func `the explanation names which side needs the update`() {
        #expect(HostFix.explanation(for: status(.offline, halt: hostNewer)) == "Update this app to talk to it.")
        #expect(HostFix.explanation(for: status(.offline, halt: hostOlder)) == "Update it to talk to this app.")
        #expect(HostFix.explanation(for: status(.open)) == nil)
        #expect(HostFix.explanation(for: status(.connecting)) == nil)
        #expect(HostFix.explanation(for: status(.connecting, attempts: 2)) == "The phone keeps trying on its own.")
        #expect(HostFix.explanation(for: status(.offline)) == "The phone tries again when the network returns.")
        #expect(HostFix.explanation(for: status(.offline, halt: identityChanged)) == "Sign in again to trust it.")
        #expect(HostFix.explanation(for: status(.unauthorized)) == "Make a sign-in link on it in Settings → Sharing, then sign in again.")
        #expect(HostFix.explanation(for: status(.suspended)) == nil)
    }

    @Test(arguments: [
        (status(.unauthorized), true),
        (status(.offline, halt: identityChanged), true),
        (status(.offline, halt: hostNewer), true),
        (status(.offline), false),
        (status(.reconnecting), false),
        (status(.connecting, attempts: 3), false),
        (status(.open), false),
        (status(.suspended), false),
    ])
    func `destructive only when the state waits on the person`(status: EnvironmentStatus, waits: Bool) {
        #expect(HostFix.waitsOnUser(status) == waits)
    }
}

@Suite("HostBuildLine")
struct HostBuildLineTests {
    @Test func `the version and seven characters of the commit`() {
        let build = BuildFacts(release: 273, version: "1.0.273", sha: "5edeb5d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7", platform: "darwin")
        #expect(HostBuildLine.text(build) == "1.0.273 (5edeb5d)")
    }

    @Test func `the version alone without a commit`() {
        #expect(HostBuildLine.text(BuildFacts(release: 273, version: "1.0.273", sha: nil, platform: "linux")) == "1.0.273")
        #expect(HostBuildLine.text(BuildFacts(release: 273, version: "1.0.273", sha: "", platform: "linux")) == "1.0.273")
    }
}

@Suite("HostPushWord")
struct HostPushWordTests {
    private func pushStatus(registered: Bool = true, relay: PushStatus.Relay) -> PushStatus {
        PushStatus(registered: registered, relay: relay, error: nil, events: [], updatedAt: nil)
    }

    @Test func `the switch and the host's failure come first`() {
        #expect(HostPushWord.text(enabled: false, failure: nil, status: pushStatus(relay: .ok)) == "Off")
        #expect(HostPushWord.text(enabled: true, failure: "This key can read but not act", status: pushStatus(relay: .ok)) == "Failed")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: nil) == "Not registered")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(registered: false, relay: .ok)) == "Not registered")
    }

    @Test func `the relay's word once registered`() {
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .ok)) == "On")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .none)) == "No relay")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .failed)) == "Failed")
        #expect(HostPushWord.text(enabled: true, failure: nil, status: pushStatus(relay: .unknown("later"))) == "Registered")
    }
}

@Suite("KeyRights")
struct KeyRightsTests {
    @Test(arguments: [
        ([Capability.read], KeyRights.look),
        ([.read, .operate], .run),
        ([.read, .operate, .approve], .approve),
        ([.read, .operate, .approve, .admin], .manage),
        // The highest the key holds decides, whatever else rides with it.
        ([.admin, .give], .manage),
        ([.device, .operate, .pending], .run),
        ([], .look),
    ] as [([Capability], KeyRights)])
    func `a key holds one level`(caps: [Capability], level: KeyRights) {
        #expect(KeyRights.of(caps) == level)
    }

    @Test func `the desktop's It may words`() {
        #expect(KeyRights.allCases.map { $0.title(computer: "the box") } == ["Look only", "Run threads", "Run threads and approve", "Manage the box"])
        #expect(KeyRights.look.detail(computer: "the box") == "Read threads and files")
        #expect(KeyRights.run.detail(computer: "the box") == "Start, steer and stop threads")
        #expect(KeyRights.approve.detail(computer: "the box") == "Also answer when a thread asks before a risky step")
        #expect(KeyRights.manage.detail(computer: "the box") == "Everything above, and add devices and change every setting on the box")
    }
}

@Suite("Capability words")
struct CapabilityWordsTests {
    @Test func `give and device show only on a key that holds them`() {
        #expect(Capability.extras(holding: [.read, .operate, .approve, .admin]) == [])
        #expect(Capability.extras(holding: [.device, .operate, .approve, .pending]) == [.device])
        #expect(Capability.extras(holding: [.admin, .give]) == [.give])
        #expect(Capability.give.title == "Set up other computers")
        #expect(Capability.device.title == "Set up from another computer")
    }

    @Test func `an unknown capability keeps its raw name`() {
        #expect(Capability.unknown("x").title == "X")
        #expect(Capability.unknown("x").detail == "Not known to this app")
    }
}
