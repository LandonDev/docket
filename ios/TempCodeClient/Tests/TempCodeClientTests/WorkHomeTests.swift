import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Home's Work band (milestone 46): Work Chats and the Work workspaces show
/// only while their host's switch is on, and never among the code rows.
@Suite struct WorkHomeTests {
    private func ws(_ id: String, kind: WorkspaceKind? = nil, sector: String? = nil) -> WorkspaceMeta {
        WorkspaceMeta(id: id, name: id, path: "/repo/\(id)", git: kind != .work, kind: kind, sector: sector, createdAt: 1)
    }

    private func thread(_ id: String, workspaceId: String? = nil, scope: SessionScope? = nil, status: SessionStatus = .idle) -> SessionMeta {
        SessionMeta(id: id, parentId: nil, projectId: nil, workspaceId: workspaceId, threadType: .chat, planPath: nil, provider: .claude, model: "claude-opus-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: workspaceId.map { "/repo/\($0)" } ?? "/tmp/\(id)", status: status, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, scope: scope, createdAt: 1, updatedAt: 100)
    }

    private func host(workOn: Bool) -> HomeHostInput {
        HomeHostInput(
            environmentId: "box",
            name: "box",
            workspaces: [ws("code"), ws("purdue", kind: .work, sector: "purdue")],
            sessions: [thread("chat"), thread("work-chat", scope: .work, status: .waiting), thread("t1", workspaceId: "code"), thread("t2", workspaceId: "purdue", scope: .work)],
            workOn: workOn
        )
    }

    @Test func `with Work off Home is today's: no Work row, no Work thread among the chats`() {
        let home = HomeSections.home(hosts: [host(workOn: false)])
        #expect(home.work.isEmpty)
        #expect(home.entries.map(\.id) == [HomeSections.chatsKey, "box:code"])
        let chats = HomeSections.workspace(HomeSections.chatsKey, hosts: [host(workOn: false)])
        #expect(chats?.chats.map(\.id) == ["thread:box:chat"])
    }

    @Test func `with Work on the band holds Work Chats then each Work workspace, and the code rows are unchanged`() {
        let home = HomeSections.home(hosts: [host(workOn: true)])
        #expect(home.entries.map(\.id) == [HomeSections.chatsKey, "box:code"])
        #expect(home.work.map(\.id) == [HomeSections.workChatsKey, "box:purdue"])
        #expect(home.work[0].kind == .workChats)
        #expect(home.work[0].status == .needsYou(count: 1))
        guard case .workspace(let purdue) = home.work[1].kind else { Issue.record("no workspace"); return }
        #expect(purdue.members[0].workspace.sector == "purdue")
        let workChats = HomeSections.workspace(HomeSections.workChatsKey, hosts: [host(workOn: true)])
        #expect(workChats?.chats.map(\.id) == ["thread:box:work-chat"])
        #expect(HomeSections.workspace(HomeSections.workChatsKey, hosts: [host(workOn: false)])?.chats.isEmpty == true)
    }
}
