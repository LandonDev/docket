import { keptReturns, RETURN_KEY, returnOf, returnWindow, windowSpots, type WorkSpot } from "../../lib/workReturn";

/**
 * The writer of "where he was" (lib/workReturn.ts holds the read the first paint needs; docs/agents/work-return.md).
 * Each window writes its own entry; twelve windows are kept, the least recently written go first.
 */
const WINDOWS = 12;
let spots: Record<string, WorkSpot> | null = null;

export { returnOf };

/** Merges into the workspace's record; a place set to undefined is dropped. */
export function keepReturn(workspaceId: string, patch: WorkSpot): void {
  spots ??= windowSpots(returnWindow());
  const was = spots[workspaceId] ?? {};
  const next = { ...was, ...patch, ...(patch.places ? { places: { ...was.places, ...patch.places } } : {}) };
  if (JSON.stringify(next) === JSON.stringify(was)) return;
  spots[workspaceId] = JSON.parse(JSON.stringify(next)) as WorkSpot;
  try {
    const all = keptReturns();
    all[returnWindow()] = { at: Math.max(Date.now(), ...Object.values(all).map((w) => w.at + 1)), spots };
    for (const id of Object.keys(all).sort((a, b) => all[a]!.at - all[b]!.at).slice(0, -WINDOWS)) delete all[id];
    globalThis.localStorage?.setItem(RETURN_KEY, JSON.stringify(all));
  } catch {
    // unstored: the next read finds what was stored before
  }
}

/** Test seam: forget what this window wrote, as a reload does; `newWindow`, as a relaunch does. */
export function forgetReturnWindow(newWindow = false): void {
  spots = null;
  if (newWindow) globalThis.sessionStorage?.removeItem(RETURN_KEY);
}
