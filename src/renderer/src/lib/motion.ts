import { useSyncExternalStore } from "react";

/**
 * What reduced motion means here, in one place (docs/DESIGN.md "Reduced
 * motion"). Reduced is fewer and gentler, never none: movement goes (slides,
 * rises, scales, glides, smooth scrolls) and fades stay, and the marks that
 * say work is going on (the spinner, the working mark, the shimmer, the
 * streaming reveal's fades) keep moving whatever the setting, so they never
 * read the rule at all.
 *
 * The person chooses in Settings → Appearance → Motion: Follow this computer
 * (the default: the system's reduce-motion setting, which Windows also turns
 * on when its animation effects are off), Full or Reduced. The choice is kept
 * per window origin, as the themes are. `initMotion` writes the resolved
 * value on <html> as `data-motion="full" | "reduced"`, and every stylesheet
 * and Tailwind's `motion-reduce:` and `motion-safe:` (index.css) read that,
 * never the media query; scripts read `reducedMotion()` or
 * `useReducedMotion()` (lib/motionRule.test.ts holds both).
 */

export type MotionPreference = "system" | "full" | "reduced";
export const MOTION_PREFERENCE_DEFAULT: MotionPreference = "system";

const MOTION_KEY = "monocode.motion";
const QUERY = "(prefers-reduced-motion: reduce)";
const CHANGE_EVENT = "monocode:motionchange";

const isPreference = (value: unknown): value is MotionPreference => value === "system" || value === "full" || value === "reduced";

export function isMotionKey(key: string): boolean {
  return key === MOTION_KEY;
}

export function loadMotionPreference(): MotionPreference {
  try {
    const raw = localStorage.getItem(MOTION_KEY);
    return isPreference(raw) ? raw : MOTION_PREFERENCE_DEFAULT;
  } catch {
    return MOTION_PREFERENCE_DEFAULT;
  }
}

export function saveMotionPreference(next: MotionPreference): void {
  try {
    if (next === MOTION_PREFERENCE_DEFAULT) localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, next);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const systemReduces = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.(QUERY)?.matches;

/** Whether movement is cut now: the person's choice, else the system's. */
export function reducedMotion(): boolean {
  const preference = loadMotionPreference();
  return preference === "system" ? systemReduces() : preference === "reduced";
}

/** Calls `listener` whenever the answer may have changed: a choice here or in
 *  another window, or the system's setting turning over. */
export function onMotionChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const query = window.matchMedia?.(QUERY);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || isMotionKey(event.key)) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  query?.addEventListener?.("change", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
    query?.removeEventListener?.("change", listener);
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(onMotionChange, reducedMotion, () => false);
}

/** Writes the answer on <html> and keeps it current. */
export function initMotion(root: HTMLElement = document.documentElement): () => void {
  const apply = (): void => {
    root.dataset.motion = reducedMotion() ? "reduced" : "full";
  };
  apply();
  return onMotionChange(apply);
}
