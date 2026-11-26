import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// One host, one colour: Home's and the Hosts list's dot and the thread's
/// read the same tone (docs/IOS-DESIGN.md "The host tone").
@Suite struct HostToneTests {
    @Test func `the link's own tone, the desktop's five`() {
        #expect(HostTone(EnvironmentStatus(transport: .open, fresh: true)) == .fresh)
        #expect(HostTone(EnvironmentStatus(transport: .open)) == .stale)
        #expect(HostTone(EnvironmentStatus(transport: .connecting)) == .busy)
        #expect(HostTone(EnvironmentStatus(transport: .reconnecting)) == .busy)
        #expect(HostTone(EnvironmentStatus(transport: .suspended)) == .busy)
        #expect(HostTone(EnvironmentStatus(transport: .offline)) == .away)
        #expect(HostTone(EnvironmentStatus(transport: .unauthorized)) == .refused)
    }

    @Test func `a relayed host's state wins only over an open lane`() {
        let open = EnvironmentStatus(transport: .open, fresh: true)
        #expect(HostTone(open, relay: .locked) == .locked)
        #expect(HostTone(open, relay: .asleep) == .asleep)
        #expect(HostTone(open, relay: .unreachable) == .unreachable)
        #expect(HostTone(open, relay: .available) == .fresh)
        #expect(HostTone(EnvironmentStatus(transport: .open), relay: nil) == .stale)
        // Offline is away whatever the relay last said: no red for a host that is only gone.
        #expect(HostTone(EnvironmentStatus(transport: .offline), relay: .unreachable) == .away)
        #expect(HostTone(EnvironmentStatus(transport: .reconnecting), relay: .locked) == .busy)
    }
}
