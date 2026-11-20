/**
 * When a decoded frame is drawn (docs/agents/live-video.md "The viewer"):
 * the hold that evens out uneven arrival, and what the presenter does at each
 * refresh when frames stand in line.
 *
 * Ported from screen-relay 0.1.2 (github.com/vercel-labs/screen-relay,
 * `viewer/main.ts`: `observeArrival`, `isDue`, `presenterPhase`,
 * `trimDecoded`, `presentDecoded`, `present`), licensed under the Apache
 * License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Changed
 * here: the same rules as two classes with no DOM in them, so they run in a
 * worker and under test; the numbers are theirs.
 */

/** How far back the smallest arrival-minus-capture offset is searched, in ms. */
export const CLOCK_WINDOW_MS = 5000;
/** How far back arrival delays are measured to size the hold, in ms. */
export const JITTER_WINDOW_MS = 2000;
/** Share of recent arrivals the hold must cover. */
export const JITTER_QUANTILE = 0.95;
/** Longest hold in ms; a longer hold smooths more but delays what he sees after he types. */
export const MAX_HOLD_MS = 100;
/** Milliseconds the hold shrinks per millisecond that passes. */
export const HOLD_DECAY = 0.05;
/** Change in the offset, in ms, that restarts the clock. */
export const CLOCK_JUMP_MS = 500;

interface Sample {
  time: number;
  offset: number;
  late: number;
}

/**
 * The source stamps each frame with its capture time on a clock of its own.
 * The smallest recent difference between arrival and capture is the base a
 * frame is timed against; the hold is a high percentile of how much later
 * than that frames arrive, capped at `MAX_HOLD_MS`, and it shrinks slowly
 * once arrival is even again.
 */
export class ArrivalClock {
  holdMs = 0;
  private samples: Sample[] = [];
  private lows: Sample[] = [];

  /** One frame arrived: the base it is timed against. `timestampUs` is the source's capture time. */
  observe(timestampUs: number, arrivedMs: number): number {
    const offset = arrivedMs - timestampUs / 1000;
    const last = this.samples.at(-1);
    // an idle page or a long outage: the old clock says nothing about the new frames
    if (last && Math.abs(offset - last.offset) > CLOCK_JUMP_MS) this.reset();
    const previous = this.samples.at(-1)?.time ?? arrivedMs;
    const sample: Sample = { time: arrivedMs, offset, late: 0 };
    this.samples.push(sample);
    while (this.lows.length && this.lows[this.lows.length - 1].offset >= offset) this.lows.pop();
    this.lows.push(sample);
    while (this.samples[0].time < arrivedMs - CLOCK_WINDOW_MS) {
      if (this.lows[0] === this.samples[0]) this.lows.shift();
      this.samples.shift();
    }
    const base = this.lows[0].offset;
    sample.late = offset - base;
    const recent: number[] = [];
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].time >= arrivedMs - JITTER_WINDOW_MS; i--) recent.push(this.samples[i].late);
    recent.sort((a, b) => a - b);
    const target = Math.min(MAX_HOLD_MS, recent[Math.floor(JITTER_QUANTILE * (recent.length - 1))]);
    this.holdMs = target >= this.holdMs ? target : Math.max(target, this.holdMs - (arrivedMs - previous) * HOLD_DECAY);
    return base;
  }

  reset(): void {
    this.samples = [];
    this.lows = [];
    this.holdMs = 0;
  }
}

export type Phase = "idle" | "backlog" | "catchUp" | "overrun";

/**
 * What the presenter does this refresh: nothing, wait out a backlog, drop one
 * frame, or drop down to two. `draws` is 1 when this refresh will draw a
 * frame, so a line of three that the draw brings to two is idle.
 */
export function presenterPhase(due: number, draws: number, backlogMs: number, sinceCatchUpMs: number, headOverstayMs: number): Phase {
  if (due <= 2) return "idle";
  if (due > 12 || headOverstayMs > 200) return "overrun";
  if (due - draws <= 2) return "idle";
  return backlogMs < 500 || sinceCatchUpMs < 250 ? "backlog" : "catchUp";
}

/** One decoded frame waiting for its refresh. */
export interface Decoded<F> {
  generation: number;
  sequence: number;
  /** the source's capture time, in microseconds */
  timestamp: number;
  /** when its bytes arrived, on the viewer's clock, in ms */
  arrived: number;
  /** the clock's base when it arrived */
  base: number;
  frame: F;
}

export interface PresenterHooks<F> {
  /** put the frame on every canvas; the presenter retires it right after */
  draw(item: Decoded<F>): void;
  /** the frame is done with, drawn or passed over: free it, and ack it with how long it waited here */
  retire(item: Decoded<F>, waitMs: number, drawn: boolean): void;
}

/**
 * The line of decoded frames. One frame at most is drawn per refresh, and
 * every frame is retired in the order it came, drawn or passed over, since
 * the source credits only its oldest outstanding frame.
 */
export class Presenter<F> {
  private readonly decoded: Decoded<F>[] = [];
  private backlogSince: number | null = null;
  private lastCatchUp = -Infinity;
  /** a frame was drawn since the last refresh began */
  private drawnThisFrame = false;

  constructor(
    private readonly clock: ArrivalClock,
    private readonly hooks: PresenterHooks<F>,
  ) {}

  get waiting(): number {
    return this.decoded.length;
  }

  /** A frame is due once its capture time on the clock it arrived under, plus the hold, has passed; 1e-6 ms absorbs float rounding. */
  private due(item: Decoded<F>, now: number): boolean {
    return item.timestamp / 1000 + item.base + this.clock.holdMs <= now + 1e-6;
  }

  private dueCount(now: number): number {
    let count = 0;
    while (count < this.decoded.length && this.due(this.decoded[count], now)) count++;
    return count;
  }

  private trim(now: number, draws = 0): void {
    let due = this.dueCount(now);
    const head = this.decoded[0];
    const phase = presenterPhase(due, draws, now - (this.backlogSince ?? now), now - this.lastCatchUp, head ? now - head.arrived - this.clock.holdMs : 0);
    if (phase === "idle") {
      this.backlogSince = null;
      return;
    }
    this.backlogSince ??= now;
    if (phase === "backlog") return;
    do {
      const dropped = this.decoded.shift()!;
      due--;
      this.hooks.retire(dropped, now - dropped.arrived, false);
    } while (phase === "overrun" && due > 2);
    if (due <= 2) this.backlogSince = null;
    if (phase === "catchUp") this.lastCatchUp = now;
  }

  private show(item: Decoded<F>, now: number): void {
    this.hooks.draw(item);
    this.drawnThisFrame = true;
    this.hooks.retire(item, now - item.arrived, true);
  }

  /** A frame came out of the decoder. Drawn at once when nothing waits, nothing was drawn this refresh and it is due. True when a refresh is wanted. */
  push(item: Decoded<F>, now: number): boolean {
    const immediate = !this.decoded.length && !this.drawnThisFrame;
    this.decoded.push(item);
    this.trim(now);
    if (immediate && this.decoded.length && this.due(this.decoded[0], now)) this.show(this.decoded.shift()!, now);
    return true;
  }

  /** One refresh. True when another is wanted: a frame was drawn, or frames still wait. */
  refresh(now: number): boolean {
    this.drawnThisFrame = false;
    this.trim(now, 1);
    let drew = false;
    if (this.decoded.length && this.due(this.decoded[0], now)) {
      this.show(this.decoded.shift()!, now);
      drew = true;
    }
    return drew || this.decoded.length > 0;
  }

  /** Every waiting frame is retired undrawn, in order: the stream is going, and the source is owed its acks. */
  flush(now: number): void {
    for (const item of this.decoded.splice(0)) this.hooks.retire(item, now - item.arrived, false);
    this.backlogSince = null;
    this.lastCatchUp = -Infinity;
    this.drawnThisFrame = false;
  }
}
