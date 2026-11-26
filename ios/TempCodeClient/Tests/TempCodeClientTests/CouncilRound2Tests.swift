import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The council's round 2 on the phone (surface 12): a read key's words, said once, in the desktop's words.
@Suite struct ReadKeyWordsTests {
    @Test func `the composer says where to send from, a card where to answer from`() {
        #expect(ActionBlock.readOnly.sendText(now: 0, host: "The box") == "Send from a computer that manages the box")
        #expect(ActionBlock.readOnly.answerText(now: 0, host: "Studio Mac") == "Answer from a computer that manages Studio Mac")
        #expect(ActionBlock.noApprove.answerText(now: 0, host: "box") == "Answer from a computer that manages box")
    }

    @Test func `other blocks keep their own line, and only the key's reach is a key limit`() {
        #expect(ActionBlock.unauthorized.sendText(now: 0, host: "box") == ActionBlock.unauthorized.text(now: 0))
        #expect(ActionBlock.readOnly.isKeyLimit && ActionBlock.noApprove.isKeyLimit && ActionBlock.noAdmin.isKeyLimit)
        #expect(!ActionBlock.reconnecting(retryAt: nil).isKeyLimit)
        #expect(!ActionBlock.unauthorized.isKeyLimit)
    }
}

/// One word for one state on Home: a relayed host's foot row says locked, asleep or unreachable; no card says it again.
@Suite struct RelayedHostCardTests {
    @Test func `a relayed host the relay already words gets no status card`() {
        let offline = EnvironmentStatus(transport: .offline)
        #expect(!HomeSections.troubled(offline, awayMs: 0, relay: .unreachable))
        #expect(!HomeSections.troubled(offline, awayMs: 0, relay: .asleep))
        #expect(HomeSections.troubled(offline, awayMs: 0, relay: .available))
        #expect(HomeSections.troubled(offline, awayMs: 0, relay: nil))
    }
}

/// Three "cosmic-web" rows on Home tell themselves apart (`HomeSections.nameHints`).
@Suite struct WorkspaceNameHintTests {
    private func ws(_ id: String, _ name: String, host: String, path: String) -> HomeWorkspace {
        let meta = WorkspaceMeta(id: id, name: name, path: path, git: true, createdAt: 1)
        return HomeWorkspace(id: "\(host):\(id)", name: name, repo: nil, members: [.init(environmentId: host, workspace: meta)])
    }

    @Test func `same names on separate computers take the computer's name`() {
        let hints = HomeSections.nameHints([ws("a", "cosmic-web", host: "mac", path: "/u/a/cosmic-web"), ws("b", "cosmic-web", host: "box", path: "/srv/cosmic-web"), ws("c", "docket", host: "mac", path: "/u/docket")]) { $0 == "mac" ? "Mac" : "box" }
        #expect(hints == ["mac:a": "Mac", "box:b": "box"])
    }

    @Test func `same names on one computer take the shortest parent folders that differ`() {
        let hints = HomeSections.nameHints([ws("a", "cosmic-web", host: "mac", path: "/u/work/cosmic-web"), ws("b", "cosmic-web", host: "mac", path: "/u/old/cosmic-web"), ws("c", "cosmic-web", host: "mac", path: "/x/old/cosmic-web")]) { _ in "Mac" }
        #expect(hints == ["mac:a": "u/work", "mac:b": "u/old", "mac:c": "x/old"])
    }
}

/// At the largest text sizes the focused dock keeps its controls above the keyboard.
@Suite struct LargeTextDockTests {
    @Test func `the segment bar folds with focus at accessibility sizes, in any height`() {
        #expect(!ThreadPose.segmentBarShown(mode: .pager, compactHeight: false, composerFocused: true, accessibilityText: true))
        #expect(ThreadPose.segmentBarShown(mode: .pager, compactHeight: false, composerFocused: false, accessibilityText: true))
        #expect(ThreadPose.segmentBarShown(mode: .pager, compactHeight: false, composerFocused: true, accessibilityText: false))
    }

    @Test func `the field scrolls past two lines at accessibility sizes`() {
        #expect(ComposerHeight.maxLines(accessibilityText: true) <= 2)
        #expect(ComposerHeight.maxLines(accessibilityText: false) == ComposerHeight.maxLines)
    }
}
