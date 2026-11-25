/**
 * Whether the link to a computer is poor (docs/DESIGN.md "Computers", "The
 * delay"): the one rule the bar's delay reads, pure, so the stream and its
 * test see the same answer. It turns poor when frames run 120 ms late at the
 * 95th centile over the last 3 s (with 3 s of frames seen), or when the
 * relay closes the stream as `slow` twice within a minute. It clears after
 * 5 s clean: no frame that late and no `slow` close in that time. Times are
 * ms on one clock; a frame's lateness is how long after its due time it
 * arrived (the worker's arrival against the frame clock).
 */

/** A frame this late, or later, counts against the link. */
export const LATE_MS = 120;
/** The window the 95th centile is read over, and the history it needs. */
export const LATE_WINDOW_MS = 3000;
/** Two `slow` closes within this time make it poor. */
export const SLOW_WINDOW_MS = 60_000;
/** Clean for this long, it is good again. */
export const CLEAR_AFTER_MS = 5000;

/** The 95th centile of a list (nearest rank); 0 of none. */
export function p95(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}

export class LinkHealth {
  private frames: { at: number; late: number }[] = [];
  private firstAt: number | null = null;
  private slows: number[] = [];
  private poorSince: number | null = null;
  private lastBad = -Infinity;

  /** A frame arrived `late` ms after it was due. */
  frame(at: number, late: number): void {
    this.firstAt ??= at;
    this.frames.push({ at, late });
    while (this.frames.length && this.frames[0]!.at <= at - LATE_WINDOW_MS) this.frames.shift();
    if (late >= LATE_MS) this.lastBad = at;
    if (at - this.firstAt >= LATE_WINDOW_MS && p95(this.frames.map((f) => f.late)) >= LATE_MS) this.turnPoor(at);
  }

  /** The relay closed the stream as `slow` (its socket held too much unsent). */
  slowClose(at: number): void {
    this.slows = [...this.slows.filter((t) => t > at - SLOW_WINDOW_MS), at];
    this.lastBad = at;
    if (this.slows.length >= 2) this.turnPoor(at);
  }

  /** The stream opened again from nothing (a new stream, not a reopen): the frames' history starts over. */
  restart(): void {
    this.frames = [];
    this.firstAt = null;
  }

  private turnPoor(at: number): void {
    this.poorSince ??= at;
    this.lastBad = Math.max(this.lastBad, at);
  }

  /** The link's word at `at`: poor until it has been clean for CLEAR_AFTER_MS. */
  state(at: number): "good" | "poor" {
    if (this.poorSince !== null && at - this.lastBad >= CLEAR_AFTER_MS) {
      this.poorSince = null;
      this.slows = [];
    }
    return this.poorSince === null ? "good" : "poor";
  }
}
