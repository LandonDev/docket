import { useSyncExternalStore } from "react";

/**
 * Full screen's store (docs/DESIGN.md "Computers", "Full screen"): which
 * computer fills the display, with the window taken full screen around it.
 * Apart from the component (surfaces/threads/computer/FullWindow.tsx, its
 * own chunk), so a live picture anywhere can open it without loading it.
 */

/** A place on his screen, in screen points: where a pressed picture was, so full screen grows it from there. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FullWindowTarget {
  /** the host the computer's row is on */
  host: string;
  /** the thread whose row it is: full screen follows its computer as the stage does (`findComputer`) */
  threadId: string;
  /** the picture's name, for the window's label */
  name: string;
  /** where the picture he pressed was; none for a key's entry, which has no motion */
  from?: ScreenRect;
}

let target: FullWindowTarget | null = null;
/** What ⌃⌘F takes full screen while none is: the Computers page's stage, while it shows a live picture. */
let offered: FullWindowTarget | null = null;
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

/** A rect of the page, on his screen: where the window is, plus where in it. */
export function screenRectOf(rect: { left: number; top: number; width: number; height: number }): ScreenRect {
  return { x: rect.left + window.screenX, y: rect.top + window.screenY, width: rect.width, height: rect.height };
}

/** Offers the computer ⌃⌘F takes full screen; answers what takes the offer back. */
export function offerFullScreen(next: FullWindowTarget): () => void {
  offered = next;
  tell();
  return () => {
    if (offered !== next) return;
    offered = null;
    tell();
  };
}

/** Whether View → Enter Full Screen does anything: full screen is open, or a computer is offered. */
export const canFullScreen = (): boolean => target !== null || offered !== null;

/** ⌃⌘F and View → Enter Full Screen: leaves full screen, else takes the offered computer into it, with no motion. */
export function toggleFullScreen(): void {
  if (target) closeFullWindow();
  else if (offered) openFullWindow({ host: offered.host, threadId: offered.threadId, name: offered.name });
}

export function subscribeFullWindow(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useFullWindow(): FullWindowTarget | null {
  return useSyncExternalStore(subscribeFullWindow, () => target, () => null);
}
