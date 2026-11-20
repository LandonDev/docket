import { useSyncExternalStore } from "react";
import type { CanvasSource } from "@shared/work";
import { LIST_PLACE, type ProjectsPlace } from "work-kit/projects";

/**
 * Where a workspace's project screens stand (docs/agents/work-projects.md
 * "The place"): the kit has no router, so the host keeps its `place` and
 * hears every change. One a workspace, kept in this window's storage, so
 * coming back to Projects lands on the project, layout and tab he left. A
 * document opened in place from a project's Documents sits beside it, for
 * the window's life only.
 */

const KEY = "work.projects.place.v1";
const AT = new Set<ProjectsPlace["at"]>(["list", "new", "project", "task"]);

/** A stored place read back: anything that is not one is the list. */
export function parsePlace(raw: unknown): ProjectsPlace {
  if (!raw || typeof raw !== "object") return LIST_PLACE;
  const p = raw as Partial<ProjectsPlace>;
  if (!p.at || !AT.has(p.at) || (p.layout !== "list" && p.layout !== "board") || typeof p.tab !== "string") return LIST_PLACE;
  // A page with nothing to show, and a half-typed new project (the kit keeps its own draft), come back as the list.
  if ((p.at === "project" || p.at === "task") && typeof p.id !== "string") return LIST_PLACE;
  if (p.at === "new") return { ...LIST_PLACE, layout: p.layout, display: p.display };
  return p as ProjectsPlace;
}

function readAll(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const places = new Map<string, ProjectsPlace>();
const listeners = new Set<() => void>();
const tell = (): void => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function placeOf(workspaceId: string): ProjectsPlace {
  let place = places.get(workspaceId);
  if (!place) places.set(workspaceId, (place = parsePlace(readAll()[workspaceId])));
  return place;
}

export function setPlace(workspaceId: string, place: ProjectsPlace): void {
  places.set(workspaceId, place);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readAll(), [workspaceId]: place }));
  } catch {
    /* a window with no storage keeps the place for its own life */
  }
  tell();
}

export function usePlace(workspaceId: string): ProjectsPlace {
  return useSyncExternalStore(subscribe, () => placeOf(workspaceId));
}

/** A LifeOS document opened in place from a project's Documents, and where Back returns. */
export type OpenedDoc = { source: CanvasSource; title: string; project: { id: string; name: string } };
const opened = new Map<string, OpenedDoc>();

export function openDoc(workspaceId: string, doc: OpenedDoc | null): void {
  if (doc) opened.set(workspaceId, doc);
  else opened.delete(workspaceId);
  tell();
}

export function useOpenedDoc(workspaceId: string): OpenedDoc | null {
  return useSyncExternalStore(subscribe, () => opened.get(workspaceId) ?? null);
}

/** For tests: every workspace back at the list, nothing opened. */
export function resetPlaces(): void {
  places.clear();
  opened.clear();
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* no storage */
  }
  tell();
}
