import { useSyncExternalStore } from "react";
import type { CanvasSource } from "@shared/work";
import { PLACE_KEY } from "./bones";
import { GROUPINGS, LIST_PLACE, ORDERS, SHOW_PARTS, type Display, type ProjectsPlace } from "work-kit/projects";

/**
 * Where a workspace's project screens stand (docs/agents/work-projects.md
 * "The place"): the kit has no router, so the host keeps its `place` and
 * hears every change. One a workspace, kept in this window's storage, so
 * coming back to Projects lands on the project, layout and tab he left. A
 * document opened in place from a project's Documents sits beside it, for
 * the window's life only.
 */

const KEY = PLACE_KEY;
const AT = new Set<ProjectsPlace["at"]>(["list", "new", "project", "task"]);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Display as stored, kept only when every part of it is one the screens know. */
function parseDisplay(raw: unknown): Display | undefined {
  const d = raw as Partial<Display> | null | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.show)) return undefined;
  if (!ORDERS.some((o) => o.value === d.order) || !GROUPINGS.some((g) => g.value === d.group)) return undefined;
  if (!d.show.every((part) => SHOW_PARTS.some((s) => s.value === part))) return undefined;
  return { order: d.order!, group: d.group!, show: d.show };
}

/** A stored place read back, field by field: anything that is not one is the list, and a part that is not one is left out. */
export function parsePlace(raw: unknown): ProjectsPlace {
  if (!raw || typeof raw !== "object") return LIST_PLACE;
  const p = raw as Partial<ProjectsPlace>;
  if (!p.at || !AT.has(p.at) || (p.layout !== "list" && p.layout !== "board") || typeof p.tab !== "string") return LIST_PLACE;
  const display = parseDisplay(p.display);
  // A page with nothing to show, and a half-typed new project (the kit keeps its own draft), come back as the list.
  if (p.at === "new" || ((p.at === "project" || p.at === "task") && typeof p.id !== "string")) return { ...LIST_PLACE, layout: p.layout, ...(display ? { display } : {}) };
  const peek = text(p.peek);
  const from = text(p.from);
  return { at: p.at, ...(p.id ? { id: p.id } : {}), layout: p.layout, tab: p.tab, ...(peek ? { peek } : {}), ...(from ? { from } : {}), ...(display ? { display } : {}) };
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

/** Where New project's dismissal goes instead of the job's list, a workspace: the tracker, when it opened the dialog. */
const dismissTo = new Map<string, () => void>();

/**
 * Send New project's Cancel, Escape or outside press to `back` (the tracker's New project, tracker/open.ts), once:
 * Create still lands on the new project, and a later New project from the job's own list goes back to the list.
 * Set after the place is at `new`.
 */
export function whenNewDismissed(workspaceId: string, back: () => void): void {
  dismissTo.set(workspaceId, back);
}

export function setPlace(workspaceId: string, place: ProjectsPlace): void {
  const was = placeOf(workspaceId).at;
  // Entering or leaving New project ends a return set for an earlier one; leaving it for the list is a dismissal.
  const back = was === "new" && place.at === "list" ? dismissTo.get(workspaceId) : undefined;
  if ((was === "new") !== (place.at === "new")) dismissTo.delete(workspaceId);
  places.set(workspaceId, place);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readAll(), [workspaceId]: place }));
  } catch {
    /* a window with no storage keeps the place for its own life */
  }
  tell();
  back?.();
}

export function usePlace(workspaceId: string): ProjectsPlace {
  return useSyncExternalStore(subscribe, () => placeOf(workspaceId));
}

/** A LifeOS document opened in place from a project's Documents, and where Back returns. */
export type OpenedDoc = { source: CanvasSource; project: { id: string; name: string } };
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
  dismissTo.clear();
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* no storage */
  }
  tell();
}
