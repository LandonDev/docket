import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The council's round 3 on the phone (surface 12).
@Suite struct CommandCaseTests {
    @Test func `a command's own text is never recased`() {
        let call = PhraseFixture.call("Bash", .object(["command": .string("TEMP_CODE_GATEWAY_TRACE=1 bun run dev"), "description": .string("TEMP_CODE_GATEWAY_TRACE=1 bun run dev")]))
        #expect(ToolPhrase.runClauses(call, live: false) == ["TEMP_CODE_GATEWAY_TRACE=1 bun run dev"])
        let ios = PhraseFixture.call("Bash", .object(["command": .string("xcodebuild"), "description": .string("iOS build for the simulator")]))
        #expect(ToolPhrase.runClauses(ios, live: false) == ["iOS build for the simulator"])
    }

    @Test func `a known verb still takes its tense and a capital`() {
        let call = PhraseFixture.call("Bash", .object(["command": .string("npm test"), "description": .string("Run the tests")]))
        #expect(ToolPhrase.runClauses(call, live: false) == ["Ran the tests"])
        #expect(ToolPhrase.runClauses(call, live: true) == ["Running the tests"])
    }
}

/// Home's host card names the computer once: the line under its name is the desktop's `linkFact`.
@Suite struct ConnectionFactTests {
    @Test func `the words leave the name out`() {
        #expect(ConnectionFact.text(for: EnvironmentStatus(transport: .reconnecting, nextRetryAt: 5, attempts: 2)) == "Reconnecting…")
        #expect(ConnectionFact.text(for: EnvironmentStatus(transport: .connecting, nextRetryAt: 5, attempts: 2)) == "Connecting…")
        #expect(ConnectionFact.text(for: EnvironmentStatus(transport: .offline)) == "Offline")
        #expect(ConnectionFact.text(for: EnvironmentStatus(transport: .offline, halt: .identityChanged(expected: "a", got: "b"))) == "Not the host this computer paired with")
        #expect(ConnectionFact.text(for: EnvironmentStatus(transport: .unauthorized)) == "No longer accepts this key")
    }
}

/// Same-named workspaces across computers keep the computer's name; folders only break a tie on one computer.
@Suite struct WorkspaceNameHintSpanTests {
    private func ws(_ id: String, host: String, path: String) -> HomeWorkspace {
        HomeWorkspace(id: "\(host):\(id)", name: "cosmic-web", repo: nil, members: [.init(environmentId: host, workspace: WorkspaceMeta(id: id, name: "cosmic-web", path: path, git: true, createdAt: 1))])
    }

    @Test func `two copies on one computer and a third elsewhere all read apart`() {
        let hints = HomeSections.nameHints([
            ws("a", host: "mac", path: "/u/work/cosmic-web"),
            ws("b", host: "mac", path: "/u/old/cosmic-web"),
            ws("c", host: "box", path: "/u/work/cosmic-web")
        ]) { $0 == "mac" ? "Mac" : "box" }
        #expect(hints == ["mac:a": "work on Mac", "mac:b": "old on Mac", "box:c": "box"])
        #expect(Set(hints.values).count == 3)
    }
}
