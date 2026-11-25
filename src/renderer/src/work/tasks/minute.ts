import { useSyncExternalStore } from "react";

/**
 * One minute clock for the window (docs/agents/work-perf.md "One minute clock"): however many readers (Tasks, Agenda,
 * Today, Prep, the column's fact, Messages, the Digest), one timer, armed for the next minute's boundary while any
 * reads it and stopped when none does. Every reader sees the same time, so a row memoised on it moves with the others.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let current = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

const minuteOf = (at: number): number => Math.floor(at / 60_000);

function arm(): void {
  timer = setTimeout(() => {
    current = Date.now();
    for (const listener of [...listeners]) listener();
    arm();
  }, 60_000 - (Date.now() % 60_000));
}

function subscribe(listener: Listener): () => void {
  if (!listeners.size) {
    current = Date.now();
    arm();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size || !timer) return;
    clearTimeout(timer);
    timer = null;
  };
}

/** What the clock reads now: kept for the minute, so a render reads one time; a minute gone by with no reader moves it. */
function read(): number {
  if (!listeners.size && minuteOf(Date.now()) !== minuteOf(current)) current = Date.now();
  return current;
}

/** The time, moved on at each minute's boundary: a due time turns red, and a past event greys, within the minute. */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: the clock's readers and whether its one timer is armed. */
export const minuteForTest = {
  readers: (): number => listeners.size,
  armed: (): boolean => timer !== null,
};
