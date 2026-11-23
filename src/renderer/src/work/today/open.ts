import { normalizeProjectPath } from "../../lib/recents";
import { openWorkView, workEnterPort, type OpenWorkView } from "../../lib/workSwitch";
import { project } from "../../stores/project";
import { shell, shellStore } from "../../stores/shell";
import type { TodayWorkspace } from "./types";

/** Today's id among the pages above the Work workspaces (lib/workPlaces.ts, work/places/registry.ts). */
export const TODAY = "today";

/** Open Today. The digest's notice and the Go menu call this. */
export function openToday(): void {
  shell.openWorkPlace(TODAY);
}

/** ⇧⌘T: open Today, or close it when it is the page on screen. */
export function toggleToday(): void {
  shell.toggleWorkPlace(TODAY);
}

/**
 * A row's thing in its own view: the window moves to the job's workspace and
 * opens the view on the thing (`{view: "tasks", task}`, `{view: "agenda",
 * event}`, `{view: "mail", mail}`). Today closes; ⇧⌘T brings it back as it
 * was, since the store keeps its rows, folds and scroll.
 */
export function goTo(workspace: Pick<TodayWorkspace, "path" | "workspaceId">, target: Omit<OpenWorkView, "workspaceId">): void {
  shell.closeViews();
  // As a press on the job's rail row: the window's workspace, its column and its landing thread. With no window
  // to ask (a test, a preview) the workspace alone is entered.
  const enter = workEnterPort.get();
  if (enter) enter(workspace.path);
  else project.enterWorkspace(normalizeProjectPath(workspace.path));
  openWorkView({ ...target, workspaceId: workspace.workspaceId });
}

/**
 * The rail's Add Work workspace menu, from the page's "No jobs yet". The
 * menu is the rail's own and opens at its control, so the control is pressed
 * for him; with the rail folded it is unfolded first.
 */
export function openAddWorkspace(): void {
  const press = (): boolean => {
    const control = document.querySelector<HTMLElement>('nav [aria-label="Add Work workspace…"], nav [aria-label="Add Work workspace"]');
    control?.click();
    return !!control;
  };
  if (press()) return;
  if (!shellStore.getState().projectRailOpen) shell.toggleProjectRail();
  requestAnimationFrame(() => void press());
}
