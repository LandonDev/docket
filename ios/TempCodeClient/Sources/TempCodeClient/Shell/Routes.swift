import Foundation
import TempCodeContract

/// Where a tap goes on Home and Search. The app's shell resolves these in
/// its split's two columns (`ShellPaths.column(of:)` says which); the values
/// live here so the navigation memory is a pure, tested value. The Inbox has
/// its own typed path (the app's `InboxRoute`).
public enum Route: Hashable, Codable, Sendable {
    /// `seq`: a row to land on (a search hit); the thread screen scrolls to it.
    case thread(environmentId: String, sessionId: String, seq: Int?)
    /// A workspace's projects and chats; `key` is `HomeSections.Entry.id`.
    case workspace(key: String)
    /// A project's shell in the detail: its strip over `thread` (the chip's
    /// id, `<environmentId>:<sessionId>`), or over the project's draft when
    /// `thread` is nil. `key` is the strip scope's key (`StripScope.key`): a
    /// project's `HomeProject.id`, or `loose:…` for a workspace's loose
    /// chats. `seq` is a row to land on, as on `thread`. The defaults keep
    /// the synthesized `Codable` decoding a route saved without them.
    case project(key: String, thread: String? = nil, seq: Int? = nil)
    case archivedThreads(environmentId: String, projectId: String)
    case archivedProjects(environmentId: String, workspaceId: String)
    case settings
    case hosts
    /// The Outbox: every Work host's held items in bands (milestone 46).
    case outbox
    /// Every computer being driven now, on every connected host, live (docs/agents/live-video.md).
    case computers
    /// One held item; `ref` is `OutboxModel.key(_:)` of its `HeldRef`.
    case outboxItem(environmentId: String, ref: String)
    /// Settings → Work: the switch, LifeOS, grants and tool rules, per host.
    case workSettings
    /// A Work workspace's house rules and their proposals (milestone 39's wire).
    case houseRules(environmentId: String, workspaceId: String)
    /// A Work workspace's LifeOS view (`mail`, `tasks`, `agenda`) or its `routines` (milestone 47).
    case workView(environmentId: String, workspaceId: String, view: String)
}

/// The three tabs.
public enum AppTab: String, Hashable, Codable, Sendable, CaseIterable, CodingKeyRepresentable {
    case home
    case inbox
    case search
}
