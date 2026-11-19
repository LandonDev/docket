import { useEffect, useSyncExternalStore } from "react";
import type { WorkResult } from "@shared/contract-work-outbox";
import { registry } from "../../lib/connection";

/**
 * A Work thread's Results as its right panel reads them
 * (`work.outbox.results`, docs/agents/work-outbox.md "Results"): one list per
 * thread asked about, from its host. No module-level effect: the right
 * panel imports this file for every user; the Outbox store (store.ts) feeds
 * it the `work.outbox.result` push.
 */

export type HostResult = WorkResult & { environmentId: string };

/** `error`: why the newest read failed, kept apart from a list that is empty; the rows already read stay. */
type Entry = { environmentId: string; rows: HostResult[]; loaded: boolean; error: string | null };
const results = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Omit<Entry, "environmentId"> = { rows: [], loaded: false, error: null };
const loading = new Set<string>();
const again = new Set<string>();

const tag = (environmentId: string, rows: WorkResult[]): HostResult[] => rows.map((row) => ({ ...row, environmentId }));

function changed(): void {
  for (const listener of listeners) listener();
}

/** A thread's list from its host; a second ask while one runs is read by one more after it. */
export function loadResults(environmentId: string, sessionId: string): void {
  if (loading.has(sessionId)) {
    again.add(sessionId);
    return;
  }
  loading.add(sessionId);
  void registry
    .linkOf(environmentId)
    .request<{ results: WorkResult[] }>("work.outbox.results", { sessionId })
    .then(
      (answer) => void results.set(sessionId, { environmentId, rows: tag(environmentId, answer.results), loaded: true, error: null }),
      (err: unknown) =>
        void results.set(sessionId, { environmentId, rows: results.get(sessionId)?.rows ?? [], loaded: true, error: (err instanceof Error ? err.message : String(err)) || "The host did not answer" }),
    )
    .finally(() => {
      loading.delete(sessionId);
      changed();
      if (again.delete(sessionId)) loadResults(environmentId, sessionId);
    });
}

/** A Work thread's Results, live; asked of its host once it is shown. A subagent's own thread gets its own. */
export function useResults(environmentId: string, sessionId: string, enabled: boolean): Omit<Entry, "environmentId"> {
  const read = () => results.get(sessionId) ?? EMPTY;
  const entry = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    read,
  );
  useEffect(() => {
    if (enabled && results.get(sessionId)?.environmentId !== environmentId) loadResults(environmentId, sessionId);
  }, [enabled, environmentId, sessionId]);
  return entry;
}

export async function undoResult(row: HostResult): Promise<WorkResult> {
  const done = await registry.linkOf(row.environmentId).request<WorkResult>("work.outbox.undo", { id: row.id });
  applyResult(row.environmentId, done);
  return done;
}

/** Every write since a time on one host (the return from Away). */
export async function resultsSince(environmentId: string, since: number): Promise<HostResult[]> {
  const answer = await registry.linkOf(environmentId).request<{ results: WorkResult[] }>("work.outbox.results", { since });
  return tag(environmentId, answer.results);
}

/** A result the host made or undid: into the list of its root thread and of the thread that wrote it, where loaded. */
export function applyResult(environmentId: string, result: WorkResult): void {
  const row = { ...result, environmentId };
  for (const sessionId of new Set([result.rootId, result.sessionId])) {
    const entry = results.get(sessionId);
    if (!entry || entry.environmentId !== environmentId) continue;
    const at = entry.rows.findIndex((r) => r.id === result.id);
    const rows = at >= 0 ? entry.rows.map((r, i) => (i === at ? row : r)) : [row, ...entry.rows];
    results.set(sessionId, { ...entry, rows });
  }
  changed();
}

/** A host's link came back: what it made while the socket was down is read again. */
export function reloadResults(environmentId: string): void {
  for (const [sessionId, entry] of results) if (entry.environmentId === environmentId) loadResults(environmentId, sessionId);
}

/** Test seam. */
export function resetResults(): void {
  results.clear();
  loading.clear();
  again.clear();
  changed();
}
