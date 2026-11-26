import { useSyncExternalStore } from "react";
import type { LifeosProjectRow } from "../../lib/workSwitch";

/**
 * A job's LifeOS projects with what its column's Projects rows need beyond a card's id and name: LifeOS's state
 * (paused and backlog fold into one quiet row) and the target date (local midnight, ms; the row's end). Kept here,
 * in Work's chunk, by the column's head (WorkColumn.tsx), and read by the Projects section (WorkColumnRows.tsx);
 * the first paint's `setLifeosProjects` keeps the id and name alone.
 */
export type ColumnProject = LifeosProjectRow & { status: string; targetDate: number | null };

const byWorkspace = new Map<string, readonly ColumnProject[]>();
const listeners = new Set<() => void>();
const NONE: readonly ColumnProject[] = [];

const same = (a: readonly ColumnProject[], b: readonly ColumnProject[]): boolean =>
  a.length === b.length && a.every((p, i) => p.id === b[i]!.id && p.name === b[i]!.name && p.status === b[i]!.status && p.targetDate === b[i]!.targetDate);

export function setColumnProjects(workspaceId: string, rows: readonly ColumnProject[]): void {
  if (same(byWorkspace.get(workspaceId) ?? NONE, rows)) return;
  byWorkspace.set(workspaceId, rows);
  for (const listener of listeners) listener();
}

/** The jobs whose LifeOS projects are still on their way (the head's first read is out): their Projects rows draw bones. */
const reading = new Set<string>();

export function setColumnProjectsReading(workspaceId: string, on: boolean): void {
  if (reading.has(workspaceId) === on) return;
  if (on) reading.add(workspaceId);
  else reading.delete(workspaceId);
  for (const listener of listeners) listener();
}

export function useColumnProjectsReading(workspaceId: string): boolean {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => reading.has(workspaceId),
  );
}

export function useColumnProjects(workspaceId: string): readonly ColumnProject[] {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => byWorkspace.get(workspaceId) ?? NONE,
  );
}
