import type { ReactNode } from "react";
import { defineChunk, type Chunk } from "../../lib/lazyChunk";

/**
 * The pages above the Work workspaces (Today, the weekly review): one closed
 * list. A page's row in the rail is `WORK_PLACE_ROWS` (lib/workPlaces.ts,
 * first paint); its body is here, a chunk of its own. Open one with
 * `shell.openWorkPlace(id)`; `WorkPlacePage` draws the 40px header and the
 * page's `View` under it.
 */
export interface WorkPlaceProps {
  onClose(): void;
}

/** What a place's chunk exports. */
export interface WorkPlaceModule {
  View: (props: WorkPlaceProps) => ReactNode;
  /** The controls or facts at the header's end. */
  Head?: (props: WorkPlaceProps) => ReactNode;
  /** Read what the page reads before it opens: on its row's hover or focus (`intent`), and once at idle after launch (`idle`). */
  warm?(why: "intent" | "idle"): void;
  /** What the page needs before its first frame (its sources); the frame waits for it with the chunk. Keep it short: it must never hang. */
  ready?: Promise<void>;
}

export const WORK_PLACES: Record<string, { chunk: () => Promise<WorkPlaceModule> }> = {
  today: { chunk: () => import("../today") },
};

const chunks = new Map<string, Chunk<WorkPlaceModule>>();

/** A place's chunk, one for the life of the window; null for an id no place has. */
export function placeChunk(id: string): Chunk<WorkPlaceModule> | null {
  const place = WORK_PLACES[id];
  if (!place) return null;
  let chunk = chunks.get(id);
  if (!chunk) chunks.set(id, (chunk = defineChunk(`work-place-${id}`, () => place.chunk().then((module) => (module.ready ?? Promise.resolve()).then(() => module)))));
  return chunk;
}

/** Load a place's chunk and let it read ahead (lib/workPlaces.ts `warmWorkPlace`). */
export function warmPlace(id: string, why: "intent" | "idle"): void {
  void placeChunk(id)
    ?.load()
    .then(
      (m) => m.warm?.(why),
      () => {},
    );
}
