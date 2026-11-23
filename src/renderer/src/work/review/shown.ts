import { useSyncExternalStore } from "react";
import type { ReviewWeek } from "@shared/work/review";
import { thisWeek, weekAt, weekBy } from "./store";

/**
 * Which week the page shows: one small store, since the frame draws the
 * page's controls (`Head`) and the page (`View`) as two things. Null is this
 * week, so a page left open over a Sunday night shows the new week.
 */
let shownFrom: number | null = null;
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The first moment of the week shown; null: this week. */
export function useShownFrom(): number | null {
  const get = (): number | null => shownFrom;
  return useSyncExternalStore(subscribe, get, get);
}

/** The week shown, in the zone weeks are cut in now. */
export const shownWeek = (from: number | null = shownFrom): ReviewWeek => (from === null ? thisWeek() : weekAt(from));

/** Shows the week that holds `at`; this week is kept as "this week", whatever day it becomes. */
export function showWeekAt(at: number | null): void {
  const next = at === null || weekAt(at).from === thisWeek().from ? null : weekAt(at).from;
  if (next === shownFrom) return;
  shownFrom = next;
  changed();
}

/** One week back or on; never past this week. */
export function stepShown(by: number): void {
  const next = weekBy(shownWeek(), by);
  if (next.from > thisWeek().from) return;
  showWeekAt(next.from);
}

/** Test seam. */
export function resetShown(): void {
  shownFrom = null;
  changed();
}
