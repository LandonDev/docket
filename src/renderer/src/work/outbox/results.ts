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

/** `error`: why the newest read failed, kept apart from a list that is empty; the rows already read stay. `reading`: a read is out (Retry spins and waits). */
type Entry = { environmentId: string; rows: HostResult[]; loaded: boolean; error: string | null; reading: boolean };
const results = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Omit<Entry, "environmentId"> = { rows: [], loaded: false, error: null, reading: false };
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
  // What was read stays on screen, its error too, while the next read is out.
  const was = results.get(sessionId);
  if (was) {
    results.set(sessionId, { ...was, reading: true });
    changed();
  }
  void registry
    .linkOf(environmentId)
    .request<{ results: WorkResult[] }>("work.outbox.results", { sessionId })
    .then(
      (answer) => void results.set(sessionId, { environmentId, rows: tag(environmentId, answer.results), loaded: true, error: null, reading: false }),
      (err: unknown) =>
        void results.set(sessionId, {
          environmentId,
          rows: results.get(sessionId)?.rows ?? [],
          loaded: true,
          error: (err instanceof Error ? err.message : String(err)) || "The host did not answer",
          reading: false,
        }),
    )
    .finally(() => {
      loading.delete(sessionId);
      changed();
      if (again.delete(sessionId)) loadResults(environmentId, sessionId);
    });
}

/** Whether a thread's Results are held from its host, read or on their way: nothing more need be asked. */
export const resultsHeld = (environmentId: string, sessionId: string): boolean => results.get(sessionId)?.environmentId === environmentId || loading.has(sessionId);

/** A thread's Results as another answer carried them (an Outbox detail's `work.outbox.get`): held as a read of its own. */
export function seedResults(environmentId: string, sessionId: string, rows: WorkResult[]): void {
  if (loading.has(sessionId)) return;
  results.set(sessionId, { environmentId, rows: tag(environmentId, rows), loaded: true, error: null, reading: false });
  changed();
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

/** What the right panel counts to list Results: its rows, or one while a read failed with none, so the error and Retry show. */
export const resultsListed = (r: Pick<Entry, "rows" | "error">): number => r.rows.length || (r.error ? 1 : 0);

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

/**
 * Each root's Results moved, as heard here: the push of one made or undone (`env|root`), and a host whose link came back
 * (it may have missed some). A reader of what threads made (a project's Files, projects/kit.tsx) asks again at a move.
 */
const rootMoves = new Map<string, number>();
const hostBacks = new Map<string, number>();
/** Each host's last move of any root's, or its link back. */
const hostMoves = new Map<string, number>();
let moves = 0;
/** What has moved, as one number: a store's snapshot. */
export const resultsMoves = (): number => moves;
/** A root's Results as far as this window heard: a new stamp after each of its changes. */
export const resultsStamp = (environmentId: string, rootId: string): string => `${rootMoves.get(`${environmentId}|${rootId}`) ?? 0}.${hostBacks.get(environmentId) ?? 0}`;
/** A host's Results as far as this window heard, whichever root moved (an archived one this window does not hold too). */
export const resultsHostStamp = (environmentId: string): string => String(hostMoves.get(environmentId) ?? 0);
export function subscribeResults(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** A result the host made or undid: into the list of its root thread and of the thread that wrote it, where loaded. */
export function applyResult(environmentId: string, result: WorkResult): void {
  const row = { ...result, environmentId };
  moves++;
  rootMoves.set(`${environmentId}|${result.rootId}`, moves);
  hostMoves.set(environmentId, moves);
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
  moves++;
  hostBacks.set(environmentId, moves);
  hostMoves.set(environmentId, moves);
  changed();
  for (const [sessionId, entry] of results) if (entry.environmentId === environmentId) loadResults(environmentId, sessionId);
}

/** Test seam. */
export function resetResults(): void {
  results.clear();
  loading.clear();
  again.clear();
  rootMoves.clear();
  hostBacks.clear();
  hostMoves.clear();
  changed();
}
