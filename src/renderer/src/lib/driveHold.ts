import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * His Take over lasts while something of his shows the computer he drives
 * (docs/DESIGN.md "Computers"): the Computers page's tile, the full window,
 * the pop-out, a thread's browser canvas. Each such place holds the drive
 * while it is mounted. When the last one goes (he left the page, closed the
 * full window or the pop-out) the computer is handed back by itself, after a
 * moment, so a place that hands over to another (the page to the full window)
 * does not hand back between the two. Until 2026-11-22 the VM stayed his with
 * the page closed, and every thread's call was refused.
 */

/** How long the drive outlives its last place: room for one place to give way to the next. */
export const HAND_BACK_AFTER_MS = 1500;

const holds = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** One place holds the drive of `key` (`<host>\n<computer>`); the undo lets go, and the last to let go hands back. */
export function holdDrive(key: string, handBack: () => Promise<unknown>): (handBackIfLast: boolean) => void {
  holds.set(key, (holds.get(key) ?? 0) + 1);
  const pending = timers.get(key);
  if (pending) {
    clearTimeout(pending);
    timers.delete(key);
  }
  let released = false;
  return (handBackIfLast) => {
    if (released) return;
    released = true;
    const left = (holds.get(key) ?? 1) - 1;
    if (left > 0) return void holds.set(key, left);
    holds.delete(key);
    if (!handBackIfLast) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (!holds.has(key)) void handBack().catch(() => undefined);
      }, HAND_BACK_AFTER_MS),
    );
  };
}

/**
 * A place that shows `key` holds his drive while `driving` is true. Handed back by the button (or by the host), the
 * place lets go without handing back again; unmounted while he still drives, it lets go and the last place hands back.
 */
export function useDriveHold(key: string | null, driving: boolean, handBack: () => Promise<unknown>): void {
  const still = useRef(driving);
  const back = useRef(handBack);
  // set before a passive cleanup runs: a cleanup because driving turned false then knows not to hand back
  useLayoutEffect(() => {
    still.current = driving;
    back.current = handBack;
  });
  useEffect(() => {
    if (!key || !driving) return;
    const release = holdDrive(key, () => back.current());
    return () => release(still.current);
  }, [key, driving]);
}
