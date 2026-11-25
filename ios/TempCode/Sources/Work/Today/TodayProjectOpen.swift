import TempCodeClient

/// A Due row's Open project (the desktop's `openProject`): the project's own page in the detail, a route of its own
/// (`Route.lifeProject`) whose page makes the job's LifeOS session and waits for it, so a cold tap never pushes onto
/// a list that is not there yet, and a relaunch comes back on the project.
@MainActor
enum TodayProjectOpen {
    static func open(_ job: TodayWorkspace, projectId: String, navigator: ShellNavigator) {
        navigator.open(.lifeProject(environmentId: job.environmentId, workspaceId: job.workspaceId, projectId: projectId))
    }
}
