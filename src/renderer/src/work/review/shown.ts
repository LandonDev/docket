import { useSyncExternalStore } from "react";
import { weekNamed, type ReviewWeek } from "@shared/work/review";
import { loadZone, reviewClock, reviewZone, thisWeek, weekAt, weekBy } from "./store";

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

/**
 * This week's first moment, read by what draws "this week": a page left open hears when the week turns (a timer set
 * for its end) and when the window comes back into view (a timer a sleeping machine held does not fire on time).
 * The timer never sleeps past a quarter hour, so a zone a host names after it was set (which moves the week's end)
 * is picked up well before that end.
 */
const TURN_CHECK_MS = 15 * 60_000;

export function useWeekTurn(): number {
  const get = (): number => thisWeek().from;
  return useSyncExternalStore(subscribeTurn, get, get);
}

function subscribeTurn(listener: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(turned, Math.min(TURN_CHECK_MS, Math.max(1_000, thisWeek().to - reviewClock() + 50)));
  };
  const turned = (): void => {
    listener();
    arm();
  };
  const seen = (): void => {
    if (document.visibilityState === "visible") turned();
  };
  arm();
  document.addEventListener("visibilitychange", seen);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", seen);
  };
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

/**
 * Shows the week a moment names (a routine run's row, Today's row), once the zone weeks are cut in is known: the
 * moment is a host's Monday midnight, which is still Sunday in a window to its west, and the host may cut weeks in a
 * zone of its own (`weekNamed`).
 */
export const showWeekNamed = (at: number): Promise<void> => loadZone().then(() => showWeekAt(weekNamed(at, reviewZone()).from));

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
