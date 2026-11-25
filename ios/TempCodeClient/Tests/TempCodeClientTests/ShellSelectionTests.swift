import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The open Duo's two columns: what a list picks for the detail, and when the sidebar shows
/// (docs/IOS-DESIGN.md "iPhone Duo", "Work in every pose").
@Suite struct ShellSelectionTests {
    private let tiled = ShellPose.split(sidebar: .tiled)

    @Test func `with nothing picked the list picks its first row that needs him`() {
        #expect(ShellSelection.decide(first: ["b", "a"], present: ["a", "b", "c"], detail: .empty, pose: tiled, onScreen: true) == .open("b"))
        // Nothing needs him: the right side stays empty rather than open a row he did not ask for.
        #expect(ShellSelection.decide(first: [], present: ["a"], detail: .empty, pose: tiled, onScreen: true) == .keep)
    }

    @Test func `a pick that is still in the list is kept, whatever arrives above it`() {
        #expect(ShellSelection.decide(first: ["new", "a"], present: ["new", "a"], detail: .row("a"), pose: tiled, onScreen: true) == .keep)
    }

    @Test func `a pick whose row left makes way for the next, and with none left the detail clears`() {
        #expect(ShellSelection.decide(first: ["b"], present: ["b"], detail: .row("a"), pose: tiled, onScreen: true) == .open("b"))
        #expect(ShellSelection.decide(first: [], present: [], detail: .row("a"), pose: tiled, onScreen: true) == .clear)
    }

    @Test func `what he opened from elsewhere is never replaced`() {
        #expect(ShellSelection.decide(first: ["a"], present: ["a"], detail: .other, pose: tiled, onScreen: true) == .keep)
    }

    @Test func `nothing is picked for him in a stack, in the overlay pose, or by a list that is not on screen`() {
        for pose in [ShellPose.stack(short: false), .stack(short: true), .split(sidebar: .overlay)] {
            #expect(ShellSelection.decide(first: ["a"], present: ["a"], detail: .empty, pose: pose, onScreen: true) == .keep)
            #expect(ShellSelection.decide(first: ["b"], present: ["b"], detail: .row("a"), pose: pose, onScreen: true) == .keep)
        }
        #expect(ShellSelection.decide(first: ["a"], present: ["a"], detail: .empty, pose: tiled, onScreen: false) == .keep)
    }

    // MARK: - wide routes and the sidebar

    @Test func `LifeOS's screens, an open file and a thread with a file beside it are wide; the rest are not`() throws {
        let item = try JSONDecoder().decode(CanvasItem.self, from: Data(#"{"id":"i1","sessionId":"s1","workspaceId":"w1","kind":"pdf","title":"Rules","source":{"at":"file","host":"box","path":"/w/rules.pdf"},"state":"open","position":0,"rev":1,"createdAt":1,"updatedAt":1}"#.utf8))
        for view in ["mail", "tasks", "agenda"] {
            #expect(ShellPaths.wide(of: .workView(environmentId: "e", workspaceId: "w", view: view)))
        }
        for view in ["projects", "routines", "files", "forms"] {
            #expect(!ShellPaths.wide(of: .workView(environmentId: "e", workspaceId: "w", view: view)))
        }
        #expect(ShellPaths.wide(of: .file(environmentId: "e", item: item, sessionId: nil)))
        // The same reader opened from Files is as wide.
        let pdf = FileEntry(key: "file:box:/w/A.pdf", ref: .file(.init(host: "box", path: "/w/A.pdf")), folder: nil, name: "A.pdf", kind: .pdf)
        #expect(ShellPaths.wide(of: .filesFile(environmentId: "e", workspaceId: "w", placeId: "folder", entry: pdf)))
        #expect(ShellPaths.wide(of: .thread(environmentId: "e", sessionId: "s", seq: nil), hasItem: true))
        #expect(!ShellPaths.wide(of: .thread(environmentId: "e", sessionId: "s", seq: nil)))
        #expect(ShellPaths.wide(of: .project(key: "p", thread: "e:s"), hasItem: true))
        // A project's draft has no thread, so no item.
        #expect(!ShellPaths.wide(of: .project(key: "p"), hasItem: true))
        #expect(!ShellPaths.wide(of: .outboxItem(environmentId: "e", ref: "host:h1"), hasItem: true))
        #expect(!ShellPaths.wide(of: .settings))
        #expect(!ShellPaths.wide(of: nil))
    }

    @Test func `LifeOS's places for every job take the detail and are wide; the other places stay lists in the sidebar`() {
        for place in [WorkPlace.mail, .tasks, .agenda] {
            #expect(ShellPaths.column(of: .place(place)) == .detail)
            #expect(ShellPaths.wide(of: .place(place)))
            // Narrowed to a job by the filter, it is the same screen and as wide.
            #expect(ShellPaths.wide(of: .place(place, job: "box:w1")))
        }
        for place in WorkPlace.allCases where ![.mail, .tasks, .agenda].contains(place) {
            #expect(ShellPaths.column(of: .place(place)) == .sidebar)
            #expect(!ShellPaths.wide(of: .place(place)))
        }
    }

    @Test func `his press over Tasks for every job is Tasks' own: Agenda opens with the sidebar put away, and his toggle is kept`() {
        let tasks = ShellPaths.identity(of: .place(.tasks)), agenda = ShellPaths.identity(of: .place(.agenda))
        var visibility = SidebarVisibility(preference: true)
        #expect(!visibility.shown(route: tasks, wide: ShellPaths.wide(of: .place(.tasks))))
        visibility.toggled(to: true, route: tasks, wide: true)
        #expect(visibility.shown(route: tasks, wide: true))
        visibility.left(to: agenda)
        #expect(!visibility.shown(route: agenda, wide: ShellPaths.wide(of: .place(.agenda))))
        #expect(visibility.preference)
        // Back on an ordinary route his own toggle stands.
        #expect(visibility.shown(route: ShellPaths.identity(of: .settings), wide: false))
    }

    @Test func `a wide route hides the sidebar and leaves his toggle as it was`() {
        let visibility = SidebarVisibility(preference: true)
        #expect(visibility.shown(route: "thread", wide: false))
        #expect(!visibility.shown(route: "mail", wide: true))
        #expect(visibility.preference)
        // His toggle off stays off on an ordinary route.
        #expect(!SidebarVisibility(preference: false).shown(route: "thread", wide: false))
    }

    @Test func `his press on a wide route is that route's alone and is forgotten when he leaves it`() {
        var visibility = SidebarVisibility(preference: true)
        visibility.toggled(to: true, route: "mail", wide: true)
        #expect(visibility.shown(route: "mail", wide: true))
        #expect(visibility.preference)
        // Another wide route is hidden: the override named Mail.
        #expect(!visibility.shown(route: "tasks", wide: true))
        // The same screen again (a fold, a push over it) keeps it.
        visibility.left(to: "mail")
        #expect(visibility.shown(route: "mail", wide: true))
        visibility.left(to: "thread")
        #expect(visibility.override == nil)
        #expect(!visibility.shown(route: "mail", wide: true))
    }

    @Test func `his press on an ordinary route is his toggle, and a wide route's press never writes it`() {
        var visibility = SidebarVisibility(preference: true)
        visibility.toggled(to: false, route: "thread", wide: false)
        #expect(!visibility.preference)
        #expect(visibility.override == nil)
        visibility.toggled(to: true, route: "mail", wide: true)
        #expect(!visibility.preference)
        #expect(visibility.shown(route: "mail", wide: true))
        #expect(!visibility.shown(route: "thread", wide: false))
    }

    @Test func `a held sidebar write applies only over the route it was written for, as wide as it was`() {
        let tiled = ShellPose.split(sidebar: .tiled)
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        let write = HeldVisibilityWrite(shown: true, pose: tiled, at: t0, route: "file:e:1", wide: true)
        #expect(write.applies(pose: tiled, poseChangedAt: t0.addingTimeInterval(-30), route: "file:e:1", wide: true))
        // He picked another route from the sidebar inside the hold, with no fold: the write is not that route's.
        #expect(!write.applies(pose: tiled, poseChangedAt: t0.addingTimeInterval(-30), route: "thread:e:s", wide: false))
        #expect(!write.applies(pose: tiled, poseChangedAt: t0.addingTimeInterval(-30), route: "file:e:1", wide: false))
    }
}
