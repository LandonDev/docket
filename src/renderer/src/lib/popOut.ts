import { useSyncExternalStore } from "react";

/**
 * The pop-out's store (docs/DESIGN.md "Computers", "Pop out"): which computer
 * the small floating window shows, and which computer the Computers page
 * should put on its stage when he comes back to it from there. Apart from
 * the component (surfaces/threads/computer/PopOut.tsx, its own chunk), so the
 * page's Pop out button loads nothing until it is pressed.
 */

export interface PopOutTarget {
  host: string;
  /** the thread whose row it is: the pop-out follows its computer as the stage does (`findComputer`) */
  threadId: string;
  /** the picture's name: the window's title */
  name: string;
}

/** The frame name main's open handler lets through (src/main/popOut.ts POP_OUT_FRAME). */
export const POP_OUT_FRAME = "tc-popout";

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      if (next === value) return;
      value = next;
      for (const fn of [...listeners]) fn();
    },
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  };
}

const popOut = store<PopOutTarget | null>(null);
const stage = store<{ host: string; threadId: string } | null>(null);

export const openPopOut = (target: PopOutTarget): void => popOut.set(target);
export const closePopOut = (): void => popOut.set(null);
export const popOutTarget = (): PopOutTarget | null => popOut.get();
export const usePopOut = (): PopOutTarget | null => useSyncExternalStore(popOut.subscribe, popOut.get, () => null);

/** Back to the page: the Computers page puts this computer on its stage when it next draws, then forgets the ask. */
export const requestStage = (computer: { host: string; threadId: string }): void => stage.set(computer);
export const takeStageRequest = (): { host: string; threadId: string } | null => {
  const asked = stage.get();
  if (asked) stage.set(null);
  return asked;
};
export const useStageRequest = (): { host: string; threadId: string } | null => useSyncExternalStore(stage.subscribe, stage.get, () => null);
