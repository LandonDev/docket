import Foundation
import TempCodeContract

/// Where a tap goes on Home, Work and Search. The app's shell resolves these in
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
    /// A place of the Work tab: its list, in the sidebar column. `job` narrows it to one Work
    /// workspace (an entry's key, `HomeSections.Entry.id`); nil is every job at once.
    case place(WorkPlace, job: String? = nil)
    /// The Outbox, the Digest and Computers as a save from before the Work tab named them. Nothing
    /// makes these now: `current` reads each as its place.
    case outbox
    case digest
    case computers
    /// One held item; `ref` is `OutboxModel.key(_:)` of its `HeldRef`.
    case outboxItem(environmentId: String, ref: String)
    /// Settings → Work: the switch, LifeOS, grants and tool rules, per host.
    case workSettings
    /// A Work workspace's house rules and their proposals (milestone 39's wire).
    case houseRules(environmentId: String, workspaceId: String)
    /// A Work workspace's LifeOS view (`mail`, `tasks`, `agenda`) or its `routines` (milestone 47).
    case workView(environmentId: String, workspaceId: String, view: String)
    /// One open file on its own page (the reader, docs/agents/work-phone-files.md): the canvas item as its
    /// host listed it, and the thread that holds it when there is one.
    case file(environmentId: String, item: CanvasItem, sessionId: String?)
    /// One conversation of a job's Messages, in the detail (Work/Messages): LifeOS's chat by its id, on the job's host.
    case chat(environmentId: String, workspaceId: String, chatId: String)
    /// A person's page (Work/People): LifeOS's person by id, read in the job that holds them.
    case person(environmentId: String, workspaceId: String, personId: String)
    /// A LifeOS project's page (Today's Open project), read through its job's own session, which the page makes
    /// and waits for; Codable, so a relaunch comes back on the project.
    case lifeProject(environmentId: String, workspaceId: String, projectId: String)
    /// A meeting's page (Work/Prep): the LifeOS event in its job, on the job's host.
    case prep(environmentId: String, workspaceId: String, eventId: String)
    /// One clash (Work/Clash), on the host that read it: by its id, or an event of it (a tell names the event).
    case clash(environmentId: String, clashId: String)
    /// A Microsoft form's answers (M5b), over the job's Forms.
    case msformAnswers(environmentId: String, workspaceId: String, formId: String)
    /// A folder or lens of a job's Files (Work/Files), in the sidebar column: its place, the folder, the title it
    /// shows, and the computer it is listed through when its job's host reaches it for the phone
    /// (`work.files.across`). Codable, so a relaunch comes back on the folder.
    case folder(environmentId: String, workspaceId: String, placeId: String, at: FolderRef, title: String, through: String? = nil)
    /// A file picked in Files, in the detail: seated and read on its page, or its Quick Look (`FilesOpen`).
    case filesFile(environmentId: String, workspaceId: String, placeId: String, entry: FileEntry)
}

public extension Route {
    /// The route as this build names it: a place saved under its old case is that place.
    var current: Route {
        switch self {
        case .outbox: .place(.outbox)
        case .digest: .place(.digest)
        case .computers: .place(.computers)
        default: self
        }
    }
}

/// The places of the Work tab, in the Work list's order. Each is a list in the sidebar column;
/// what he picks there opens in the detail.
public enum WorkPlace: String, Hashable, Codable, Sendable, CaseIterable {
    case today
    case outbox
    case mail
    case messages
    case tasks
    case agenda
    case files
    case people
    case review
    case digest
    case computers
    case connections

    /// The places this build draws. A place joins when its milestone lands: until then it has no
    /// row, and a notice that names it opens the Digest.
    public static let shipped: Set<WorkPlace> = [.today, .outbox, .mail, .messages, .tasks, .agenda, .files, .people, .review, .digest, .computers, .connections]
}

/// The four tabs, in the bar's order. Work is absent while every host has Work off.
public enum AppTab: String, Hashable, Codable, Sendable, CaseIterable, CodingKeyRepresentable {
    case home
    case work
    case inbox
    case search
}
