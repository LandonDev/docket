/**
 * Work search's door (docs/agents/work-search.md "The window"): how the
 * key, the menu, the rail's mark and any screen open the one field over
 * everything in Work. Safe in the first paint: it imports nothing, of Work
 * or otherwise. App hears it and mounts the picker's chunk.
 *
 *   openWorkSearch()                        every job
 *   openWorkSearch({ text: "budget" })      with his words in the field
 *   openWorkSearch({ workspaceId, kind })   one job, one kind
 *
 * A screen that wants an everything-search calls this; it never draws a
 * second field for it.
 */
export interface WorkSearchSeed {
  /** his words, already in the field */
  text?: string;
  /** one job; absent: all jobs */
  workspaceId?: string;
  /** one kind alone ("mail", "file", …) */
  kind?: string;
}

type Listener = (seed: WorkSearchSeed) => void;
const listeners = new Set<Listener>();

/** An ask with no seed: the key itself. While the picker is open it flips the scope. */
export const isBareSeed = (seed: WorkSearchSeed): boolean => seed.text === undefined && seed.workspaceId === undefined && seed.kind === undefined;

/** One press of the key can arrive twice, by the window's own key handler and by the menu's accelerator: the second is dropped. */
const SAME_PRESS_MS = 80;
let lastBare = Number.NEGATIVE_INFINITY;

export function openWorkSearch(seed: WorkSearchSeed = {}, now: number = performance.now()): void {
  if (isBareSeed(seed)) {
    if (now - lastBare < SAME_PRESS_MS) return;
    lastBare = now;
  }
  for (const listener of [...listeners]) listener(seed);
}

/** The command's own ask (⌘⇧K, the menu's row): nothing while no host has Work on, since there is nothing to search. */
export function searchWork(workOn: boolean, now?: number): boolean {
  if (workOn) openWorkSearch({}, now);
  return workOn;
}

/** App's subscription; returns its off. */
export function onWorkSearch(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
