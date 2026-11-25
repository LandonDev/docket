import { LIST_PLACE } from "work-kit/projects";
import { normalizeProjectPath } from "../../lib/recents";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { openWorkView, workEnterPort, workOpenPort, type OpenWorkView } from "../../lib/workSwitch";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { placeOf, setPlace, whenNewDismissed } from "../projects/place";

/**
 * Where the tracker's presses go (docs/agents/work-tracker.md "The page"). Each leaves the page first, as Search's and
 * Today's opens do: a row enters its job and opens the project's page in the job's Projects view; New project opens
 * that view with its New project dialog; a Threads cell opens the thread, which carries its own place.
 */

/** Into a job, on one of its views: the window's workspace (its column and its landing thread), then the view. */
export function goToJob(workspaceId: string, target: Omit<OpenWorkView, "workspaceId">): void {
  shell.closeViews();
  const workspace = workspaceStore.getSnapshot().workspaces.find((w) => w.id === workspaceId);
  if (workspace) {
    // As a press on the job's rail row; with no window to ask (a test, a preview) the workspace alone is entered.
    const enter = workEnterPort.get();
    if (enter) enter(workspace.path);
    else project.enterWorkspace(normalizeProjectPath(workspace.path));
  }
  openWorkView({ ...target, workspaceId });
}

/** A row's press: the project's page, in its job. */
export const openProjectPage = (workspaceId: string, projectId: string): void => goToJob(workspaceId, { view: "projects", project: projectId });

/**
 * New project for a job: the kit's dialog, over the job's own projects list, where its session and the page Create
 * lands on already are. Create lands on the new project; Cancel, Escape or a press outside bring him back to the
 * tracker he pressed it on, the job's list behind it.
 */
export function openNewProject(workspaceId: string): void {
  const was = placeOf(workspaceId);
  setPlace(workspaceId, { ...LIST_PLACE, at: "new", layout: was.layout, ...(was.display ? { display: was.display } : {}) });
  whenNewDismissed(workspaceId, () => shell.openWorkPlace(TRACKER));
  goToJob(workspaceId, { view: "projects" });
}

/** The tracker's place id (lib/workPlaces.ts). */
const TRACKER = "projects";

/** A Threads cell's press: the thread, wherever it lives. */
export function openTrackerThread(sessionId: string): void {
  shell.closeViews();
  workOpenPort.get()?.(sessionId);
}
