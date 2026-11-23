import type { ReactNode } from "react";
import { defineChunk, type Chunk } from "../../lib/lazyChunk";
import { workPlaceRows } from "../../lib/workPlaces";
import { workSwitch } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";

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
  review: { chunk: () => import("../review") },
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

const DAY_START_KEY = "work.places.dayStart.v1";
const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * The place to open at the first focus of the day, if he asked for one:
 * `localStorage["work.<id>.opensAtDayStart"] = "true"` (no switch is drawn;
 * it is off unless set by hand). Answers it once a day, the first listed
 * place that has it set, and null every other time.
 */
export function placeForDayStart(now = Date.now()): string | null {
  try {
    const store = globalThis.localStorage;
    const place = workPlaceRows().find((row) => store?.getItem(`work.${row.id}.opensAtDayStart`) === "true");
    if (!place || store?.getItem(DAY_START_KEY) === dayOf(now)) return null;
    store?.setItem(DAY_START_KEY, dayOf(now));
    return place.id;
  } catch {
    return null;
  }
}

let watching = false;

/**
 * From the chunk's load on: a place set to open at the day's start opens at
 * the window's first focus of each day, while some host has Work on. The
 * chunk loads at idle once Work is on (lib/workPlaces.ts), so nothing of
 * this is in the first paint.
 */
export function watchDayStart(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const atFocus = (): void => {
    if (!workSwitch.anyOn()) return;
    const place = placeForDayStart();
    if (place) shell.openWorkPlace(place);
  };
  window.addEventListener("focus", atFocus);
  atFocus();
}
