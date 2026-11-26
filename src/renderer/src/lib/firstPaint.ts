import { useEffect, useRef } from "react";
import { registry } from "./connection";
import { openStamps, type OpenStamp, type OpenStamps } from "./openStamps";

/**
 * A pane's first rows, timed from the press that opened the thread (a rail
 * row, a tab, a history pick, a search hit; the pane's mount when nothing
 * was pressed) to the paint after they land. Every open is counted in a
 * histogram of fixed buckets, written once an hour as
 * `[renderer] first-paint-hist n= p50= p90= p95= max= open= restore= reconnect=`
 * (nothing when no pane opened). Later than FIRST_PAINT_MS, the open also
 * writes one line through `stall.report` (stalls.log):
 * `[renderer] first-paint session=<id> host=<env> ms=<n> why=<open|restore|reconnect> queued=<ms> fetch=<ms> fold=<ms> text=<ms>`.
 * `why`: open for a press, reconnect for rows that came after the host's link
 * came back, restore for the rest (a pane shown at launch or by a window
 * restore). The four parts add up to `ms`: press to the transcript ask leaving
 * (the catch-up lane, the pane's mount), the ask to its answer (retries
 * included), folding the answer's rows, and from the fold to the rows painted;
 * a part this open did not need (rows already held) is 0.
 * A pane closed before its rows says nothing. Only a thread with persisted
 * rows is timed: a draft's first rows arrive when the person sends, so its
 * clock would count their typing.
 */
export const FIRST_PAINT_MS = 500;
/** A press older than this at the pane's mount did not open it. */
export const PRESS_FRESH_MS = 30_000;
/** A stamp this much older than the open's start belongs to an earlier load. */
export const STAMP_STALE_MS = 10_000;
/** The histogram's line, once an hour. */
export const FIRST_PAINT_HIST_MS = 3_600_000;

export type OpenWhy = "open" | "restore" | "reconnect";

export interface FirstPaintOptions {
  /** False for a draft (no persisted rows yet): nothing is timed or reported. */
  armed?: boolean;
  now?: () => number;
  /** Runs `fn` after the next paint (double rAF); a test passes its own. */
  afterPaint?: (fn: () => void) => void;
  report?: (line: string) => void;
  stamps?: OpenStamps;
  histogram?: FirstPaintHistogram;
}

export interface FirstPaintWatch {
  /** The pane has rows on screen now. */
  rows(): void;
  dispose(): void;
}

/** Upper bounds (ms) of the histogram's buckets; one more bucket holds the rest. */
const BUCKETS = [50, 100, 150, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000];

/** Every open's time in fixed buckets: memory never grows with the opens. */
export interface FirstPaintHistogram {
  add(ms: number, why: OpenWhy): void;
  /** The hour's line, and a fresh hour; null when nothing opened. */
  flush(): string | null;
}

export function createFirstPaintHistogram(): FirstPaintHistogram {
  const counts = new Array<number>(BUCKETS.length + 1).fill(0);
  const byWhy: Record<OpenWhy, number> = { open: 0, restore: 0, reconnect: 0 };
  let n = 0;
  let max = 0;
  // A percentile reads as its bucket's upper bound, never past the hour's worst.
  const at = (q: number): number => {
    const rank = Math.ceil(q * n);
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i];
      if (seen >= rank) return i < BUCKETS.length ? Math.min(BUCKETS[i], max) : max;
    }
    return max;
  };
  return {
    add(ms, why) {
      let i = 0;
      while (i < BUCKETS.length && ms > BUCKETS[i]) i++;
      counts[i] += 1;
      byWhy[why] += 1;
      n += 1;
      if (ms > max) max = ms;
    },
    flush() {
      if (n === 0) return null;
      const line = `first-paint-hist n=${n} p50=${at(0.5)} p90=${at(0.9)} p95=${at(0.95)} max=${max} open=${byWhy.open} restore=${byWhy.restore} reconnect=${byWhy.reconnect}`;
      counts.fill(0);
      byWhy.open = byWhy.restore = byWhy.reconnect = 0;
      n = 0;
      max = 0;
      return line;
    },
  };
}

/** The window's histogram, flushed hourly by the stall recorder (installStallRecorder). */
export const firstPaintHistogram = createFirstPaintHistogram();

/** Where an open's time went: each part starts where the last ended, so they add up to the whole. */
export function splitOpen(openedAt: number, paintedAt: number, stamp: OpenStamp | undefined): { queued: number; fetch: number; fold: number; text: number } {
  const step = (t: number | undefined, from: number): number =>
    t === undefined || t < openedAt - STAMP_STALE_MS ? from : Math.min(Math.max(t, from), paintedAt);
  const asked = step(stamp?.askedAt, openedAt);
  const answered = stamp?.askedAt === undefined ? asked : step(stamp.answeredAt, asked);
  const folded = stamp?.answeredAt === undefined ? answered : step(stamp.foldedAt, answered);
  return {
    queued: Math.round(asked - openedAt),
    fetch: Math.round(answered - asked),
    fold: Math.round(folded - answered),
    text: Math.round(paintedAt - folded),
  };
}

const doubleRaf = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

const reportLine = (line: string): void =>
  void registry
    .primary()
    .request("stall.report", { line })
    .catch(() => undefined);

export function watchFirstPaint(sessionId: string, environmentId: string, options: FirstPaintOptions = {}): FirstPaintWatch {
  const now = options.now ?? (() => performance.now());
  const afterPaint = options.afterPaint ?? doubleRaf;
  const report = options.report ?? reportLine;
  const stamps = options.stamps ?? openStamps;
  const histogram = options.histogram ?? firstPaintHistogram;
  let done = options.armed === false;
  const mountedAt = now();
  const pressAt = done ? undefined : stamps.peek(sessionId)?.pressAt;
  const pressed = pressAt !== undefined && mountedAt - pressAt <= PRESS_FRESH_MS;
  const openedAt = pressed ? pressAt : mountedAt;
  const opensAtStart = stamps.linkOpens(environmentId);
  return {
    rows() {
      if (done) return;
      done = true;
      afterPaint(() => {
        const paintedAt = now();
        const ms = Math.round(paintedAt - openedAt);
        const opens = stamps.linkOpens(environmentId);
        const why: OpenWhy = pressed ? "open" : opens >= 2 && opens > opensAtStart ? "reconnect" : "restore";
        const part = splitOpen(openedAt, paintedAt, stamps.take(sessionId));
        histogram.add(ms, why);
        if (ms > FIRST_PAINT_MS)
          report(
            `first-paint session=${sessionId} host=${environmentId} ms=${ms} why=${why} queued=${part.queued} fetch=${part.fetch} fold=${part.fold} text=${part.text}`,
          );
      });
    },
    dispose() {
      done = true;
    },
  };
}

/** SessionPane's hook: one watch per open thread with persisted rows, told when its rows arrive. */
export function useFirstPaintReport(sessionId: string, environmentId: string, hasRows: boolean, armed = true): void {
  const watch = useRef<FirstPaintWatch | null>(null);
  // A draft that becomes a thread in this pane (its first send) is not an open: its rows are his own words.
  const last = useRef<{ sessionId: string; environmentId: string; armed: boolean } | null>(null);
  useEffect(() => {
    const was = last.current;
    const sent = !!was && was.sessionId === sessionId && was.environmentId === environmentId && !was.armed;
    last.current = { sessionId, environmentId, armed };
    const current = watchFirstPaint(sessionId, environmentId, { armed: armed && !sent });
    watch.current = current;
    return () => current.dispose();
  }, [sessionId, environmentId, armed]);
  useEffect(() => {
    if (hasRows) watch.current?.rows();
  }, [hasRows, sessionId, environmentId]);
}

/**
 * The master's board, once per open: `board-paint master=<id> n=<rows> ms=<n> answer=<ms> render=<ms>`;
 * `ms` from the board's mount to its painted rows, `answer` until `batch.board` answered, `render` from
 * the answer to the paint.
 */
export function boardPaintLine(masterId: string, rows: number, openedAt: number, answeredAt: number | null, paintedAt: number): string {
  const answered = answeredAt === null ? paintedAt : Math.min(Math.max(answeredAt, openedAt), paintedAt);
  return `board-paint master=${masterId} n=${rows} ms=${Math.round(paintedAt - openedAt)} answer=${Math.round(answered - openedAt)} render=${Math.round(paintedAt - answered)}`;
}
