import { useSyncExternalStore } from "react";
import type { SessionMeta } from "@shared/events";
import { byPressing, type TrackerThread } from "@shared/work/tracker";
import { sessionStore } from "../../lib/tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";

/**
 * A sector's LifeOS projects and the Work threads filed under them, as this window's session store holds them
 * (docs/agents/work-tracker.md "The slots"): a project's threads live in its mirror (a TempCode project with
 * `lifeosProjectId`) in any Work workspace of the sector, on any host. Root threads only (a subagent's work is its
 * root's), not archived, with the outcome the host folded into each summary (`workOutcome`). Nothing is asked of a
 * host: the rail's summaries already carry it.
 */

/** Each LifeOS project's root threads, newest first. Pure: a test hands it rows. */
export function projectRoots(
  metas: readonly Pick<SessionMeta, "id" | "parentId" | "projectId" | "archived" | "scope" | "title" | "workOutcome" | "updatedAt">[],
  workspaces: readonly Pick<WorkspaceMeta, "id" | "kind" | "sector">[],
  projects: readonly Pick<ProjectMeta, "id" | "workspaceId" | "lifeosProjectId" | "archived">[],
  sector: string,
): ReadonlyMap<string, TrackerThread[]> {
  const jobs = new Set(workspaces.filter((w) => w.kind === "work" && w.sector === sector).map((w) => w.id));
  const lifeosOf = new Map<string, string>();
  for (const p of projects) if (p.lifeosProjectId && !p.archived && p.workspaceId && jobs.has(p.workspaceId)) lifeosOf.set(p.id, p.lifeosProjectId);
  const roots = new Map<string, TrackerThread[]>();
  for (const meta of metas) {
    if (meta.parentId || meta.archived || meta.scope !== "work" || !meta.projectId) continue;
    const lifeos = lifeosOf.get(meta.projectId);
    if (!lifeos) continue;
    const thread: TrackerThread = { sessionId: meta.id, title: meta.title, outcome: meta.workOutcome ?? null, updatedAt: meta.updatedAt };
    roots.set(lifeos, [...(roots.get(lifeos) ?? []), thread]);
  }
  for (const list of roots.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return roots;
}

/** The most pressing of a project's threads (a question, a failure, a held act, live work, then the newest). */
export const leadOf = (threads: readonly TrackerThread[] | undefined): TrackerThread | null => (threads?.length ? [...threads].sort(byPressing)[0]! : null);

/** What the readers draw of the roots: a change of anything else (a streamed turn, a model) keeps the same map. */
const keyOf = (roots: ReadonlyMap<string, TrackerThread[]>): string =>
  [...roots].map(([id, list]) => `${id}:${list.map((t) => `${t.sessionId}|${t.updatedAt}|${t.title}|${t.outcome?.tone ?? ""}|${t.outcome?.words ?? ""}`).join(",")}`).join(";");

const kept = new Map<string, { key: string; value: ReadonlyMap<string, TrackerThread[]> }>();

function snapshotOf(sector: string): ReadonlyMap<string, TrackerThread[]> {
  const { workspaces, projects } = workspaceStore.getSnapshot();
  const value = projectRoots(sessionStore.metas(), workspaces, projects, sector);
  const key = keyOf(value);
  const was = kept.get(sector);
  if (was?.key === key) return was.value;
  kept.set(sector, { key, value });
  return value;
}

const subscribe = (listener: () => void): (() => void) => {
  const metas = sessionStore.onMetaChange(listener);
  const catalog = workspaceStore.subscribe(listener);
  return () => {
    metas();
    catalog();
  };
};

/** A sector's projects' root threads, live; the same map while nothing a reader draws has moved. */
export function useProjectRoots(sector: string | null | undefined): ReadonlyMap<string, TrackerThread[]> {
  return useSyncExternalStore(subscribe, () => (sector ? snapshotOf(sector) : NONE), () => (sector ? snapshotOf(sector) : NONE));
}

const NONE: ReadonlyMap<string, TrackerThread[]> = new Map();
