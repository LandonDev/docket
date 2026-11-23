/**
 * A show's timer (docs/DESIGN.md "The show"): the time since he started,
 * less the time it stood paused, against a target he may set. Pure: the
 * views read it against a clock they are handed.
 */

export interface ShowTimer {
  startedAt: number;
  /** when it was paused; null while it runs */
  pausedAt: number | null;
  /** the time it has stood paused, before this pause */
  held: number;
}

export const startTimer = (now: number): ShowTimer => ({ startedAt: now, pausedAt: null, held: 0 });
export const elapsedOf = (timer: ShowTimer, now: number): number => Math.max(0, (timer.pausedAt ?? now) - timer.startedAt - timer.held);
export const pauseTimer = (timer: ShowTimer, now: number): ShowTimer => (timer.pausedAt === null ? { ...timer, pausedAt: now } : timer);
export const resumeTimer = (timer: ShowTimer, now: number): ShowTimer => (timer.pausedAt === null ? timer : { ...timer, pausedAt: null, held: timer.held + (now - timer.pausedAt) });
/** Restart: from zero, keeping whether it was paused. */
export const restartTimer = (timer: ShowTimer, now: number): ShowTimer => ({ startedAt: now, pausedAt: timer.pausedAt === null ? null : now, held: 0 });

/** The targets the menu offers, in minutes; null is none. */
export const TARGETS = [10, 15, 20, 30] as const;
export type Target = number | null;

/** "4:07", "1:02:03": minutes and seconds, hours once there is one. */
export function clockOf(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** Whether he is past the target he set. */
export const overTarget = (elapsed: number, target: Target): boolean => target !== null && elapsed > target * 60_000;
