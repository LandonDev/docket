import { useSyncExternalStore } from "react";

/**
 * Where a job's Projects view stands while it is drawn, for the column (work/shell/WorkColumnRows.tsx): the job's
 * list, or the LifeOS project whose page (or task, or document) it shows. Written by the view after each commit and
 * cleared when it leaves, so the column lights the row he is on for as long as the page shows, however he came to it.
 * With it, the view's way back to the list, which the column's heading presses from inside a project. A leaf, so the
 * column's chunk never carries the project screens.
 */
export type ProjectsHere = { list: true } | { list: false; project: string | null };

const here = new Map<string, ProjectsHere>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

const same = (a: ProjectsHere | undefined, b: ProjectsHere | null): boolean =>
  !a ? !b : !!b && a.list === b.list && (a.list || (!b.list && a.project === b.project));

export function setProjectsHere(workspaceId: string, next: ProjectsHere | null): void {
  if (same(here.get(workspaceId), next)) return;
  if (next) here.set(workspaceId, next);
  else here.delete(workspaceId);
  for (const l of listeners) l();
}

/** Where the job's Projects view stands; null while it is not drawn. */
export function useProjectsHere(workspaceId: string): ProjectsHere | null {
  return useSyncExternalStore(subscribe, () => here.get(workspaceId) ?? null);
}

const backs = new Map<string, () => void>();

/** The view's way back to the job's list, set while the view is drawn. */
export function setProjectsBack(workspaceId: string, back: (() => void) | null): void {
  if (back) backs.set(workspaceId, back);
  else backs.delete(workspaceId);
}

export const projectsBack = (workspaceId: string): (() => void) | undefined => backs.get(workspaceId);
