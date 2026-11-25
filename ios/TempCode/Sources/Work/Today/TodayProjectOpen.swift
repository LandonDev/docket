import LifeKitUI
import SwiftUI
import TempCodeClient

/// A Due row's Open project (the desktop's `openProject`): the job's Projects view, then the project's own page pushed
/// over it, where that view's `projectDestinations` draws it. Kept apart so Today's screen needs no LifeKitUI names.
@MainActor
enum TodayProjectOpen {
    static func open(_ job: TodayWorkspace, projectId: String, navigator: ShellNavigator) {
        navigator.open(.workView(environmentId: job.environmentId, workspaceId: job.workspaceId, view: "projects"))
        navigator.detailStack.append(ProjectLink(id: projectId))
    }
}
