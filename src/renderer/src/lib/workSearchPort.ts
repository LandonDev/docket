/**
 * Work search's door (docs/agents/work-search.md "The window"): how the
 * key, the menu, the rail's mark and any screen open the one field over
 * everything in Work. All of Work search that the first paint holds: it
 * imports nothing. App hears it and mounts the picker's chunk; asked again
 * with no seed while the picker is open, the picker flips its scope.
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

/** An ask with no seed: the key itself. */
export const isBareSeed = (seed: WorkSearchSeed): boolean => !seed.text && !seed.workspaceId && !seed.kind;

export function openWorkSearch(seed: WorkSearchSeed = {}): void {
  for (const listener of [...listeners]) listener(seed);
}

/** Returns its off. */
export function onWorkSearch(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
