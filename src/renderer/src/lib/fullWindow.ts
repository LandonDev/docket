import { useSyncExternalStore } from "react";

/**
 * The full window's store (docs/DESIGN.md "Computers", "Full window"): which
 * computer fills the window, with the rail and the header gone. Apart from
 * the component (surfaces/threads/computer/FullWindow.tsx, its own chunk),
 * so a live picture anywhere can open it without loading it.
 */

export interface FullWindowTarget {
  /** the host the computer's row is on */
  host: string;
  /** the thread whose row it is: the full window follows its computer as the stage does (`findComputer`) */
  threadId: string;
  /** the picture's name, for the window's label */
  name: string;
}

let target: FullWindowTarget | null = null;
const listeners = new Set<() => void>();
const tell = (): void => {
  for (const fn of [...listeners]) fn();
};

export function openFullWindow(next: FullWindowTarget): void {
  target = next;
  tell();
}

export function closeFullWindow(): void {
  if (!target) return;
  target = null;
  tell();
}

export const fullWindowTarget = (): FullWindowTarget | null => target;

export function useFullWindow(): FullWindowTarget | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => target,
    () => null,
  );
}
