/**
 * One remote host's transcript fetches after its link comes back (a deploy,
 * an app update, a network blip, waking from sleep), and every load a
 * window makes at once: the thread on screen goes at once, every other one
 * waits its turn, one at a time, paced by the bytes it took.
 *
 * Before this lane the store asked for every mounted and kept transcript
 * together: on 2026-11-23 the owner's Mac asked the box for six at once,
 * the box held 8+ MiB unsent on that one socket, the window folded the
 * answers in blocks of 1.2 to 2.6 s, and a probe stuck behind them closed
 * the socket, so the next one asked for all six again.
 */

/** The link's rate assumed until a fetch has measured it. */
export const CATCH_UP_BYTES_PER_SEC = 2 * 1024 * 1024;
/** What background catch-up may take of the link's measured rate: the rest is the shown thread's. */
export const BACKGROUND_SHARE = 0.5;
/** A fetch smaller than this measures the round trip, not the rate. */
export const RATE_SAMPLE_BYTES = 64 * 1024;

/** The longest a background fetch waits for the shown thread's: on
 *  2026-11-24 a child opened in a master's view waited behind the master's
 *  fetches, a front that never emptied, and never loaded. */
export const FRONT_WAIT_MS = 2_000;

/** The longest the lane waits on one background fetch before the next one
 *  goes: the fetch keeps going and settles its own caller. */
export const TURN_WAIT_MS = 10_000;

export type CatchUpOptions = {
  /** Whether a thread is on screen: the focused pane's, or one a mounted
   *  view draws (a master's child, a subagent, a docked chat). It never waits here. */
  shown: (id: string) => boolean;
  /** Characters received on the link so far (`Link.bytesIn`). */
  bytesIn: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The clock for the two bounds (FRONT_WAIT_MS, TURN_WAIT_MS). */
  timer?: (ms: number) => Promise<void>;
  /** A fixed rate for the pace (tests); else the link's own, measured fetch by fetch. */
  bytesPerSec?: number;
};

/** One transcript's turn; a second ask while it waits takes the newer fetch and the same answer. */
type Waiting = { id: string; fetch: () => Promise<unknown>; start: () => Promise<void>; answer: Promise<unknown> };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CatchUpLane {
  private waiting: Waiting[] = [];
  private busy = false;
  /** The shown thread's fetches in flight: the next background one waits for them. */
  private front = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timer: (ms: number) => Promise<void>;
  /** The link's rate as background fetches measured it (bytes a second), null until one has. */
  private measured: number | null = null;

  constructor(private readonly options: CatchUpOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
    this.timer = options.timer ?? realSleep;
  }

  /**
   * The link's rate for the pace: a fixed one when given, else the mean of what the fetches big enough to say
   * measured (the newest weighed a third), so a fast LAN is never held to a slow link's pace and a slow link gives
   * the shown thread half of itself.
   */
  private rate(bytes: number, took: number): number {
    if (this.options.bytesPerSec) return this.options.bytesPerSec;
    if (bytes >= RATE_SAMPLE_BYTES && took > 0) {
      const sample = (bytes / took) * 1000;
      this.measured = this.measured === null ? sample : this.measured + (sample - this.measured) / 3;
    }
    return this.measured ?? CATCH_UP_BYTES_PER_SEC;
  }

  /** The link's rate as measured so far (bytes a second), null until a fetch said. */
  get linkRate(): number | null {
    return this.measured;
  }

  /** Transcripts waiting their turn, in order. */
  queued(): string[] {
    return this.waiting.map((w) => w.id);
  }

  /** Run one transcript's fetch: at once for the shown thread, else in turn. */
  run<T>(id: string, fetch: () => Promise<T>): Promise<T> {
    if (this.options.shown(id)) return this.inFront(fetch());
    const queued = this.waiting.find((w) => w.id === id);
    if (queued) {
      queued.fetch = fetch;
      return queued.answer as Promise<T>;
    }
    let running: Promise<void> | null = null;
    const w = { id, fetch } as Waiting;
    w.answer = new Promise<unknown>((resolve, reject) => {
      // Settles when the fetch does, whichever way; started once, by the pump or `promote`.
      w.start = () => (running ??= w.fetch().then(resolve, reject));
    });
    this.waiting.push(w);
    this.kick();
    return w.answer as Promise<T>;
  }

  /** Retry was pressed: if it waits here, it starts now. */
  promote(id: string): void {
    const at = this.waiting.findIndex((w) => w.id === id);
    if (at < 0) return;
    const [w] = this.waiting.splice(at, 1);
    void this.inFront(w.start());
  }

  /** What is on screen changed: every thread now on screen that waits here starts now. */
  promoteShown(): void {
    for (const w of this.waiting.filter((x) => this.options.shown(x.id))) this.promote(w.id);
  }

  private inFront<T>(run: Promise<T>): Promise<T> {
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.front.add(settled);
    void settled.then(() => this.front.delete(settled));
    return run;
  }

  /** The pump starts a few microtasks later: a window that is opening names
   *  its shown pane in the same turn as its loads, and FocusSignal settles
   *  that in a microtask of its own. */
  private kick(): void {
    if (this.busy || this.kicked) return;
    this.kicked = true;
    void Promise.resolve()
      .then(() => undefined)
      .then(() => {
        this.kicked = false;
        void this.pump();
      });
  }
  private kicked = false;

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        // The shown thread's page is never queued behind a background one on
        // the socket, but a front that keeps filling holds nothing for good.
        if (this.front.size > 0) {
          let waited = false;
          const bound = this.timer(FRONT_WAIT_MS).then(() => void (waited = true));
          while (this.front.size > 0 && !waited) await Promise.race([Promise.all(this.front), bound]);
        }
        // A thread on screen first, if it was asked for before the window drew it.
        const at = this.waiting.findIndex((x) => this.options.shown(x.id));
        const w = at >= 0 ? this.waiting.splice(at, 1)[0] : this.waiting.shift();
        if (!w) break;
        const before = this.options.bytesIn();
        const startedAt = this.now();
        await Promise.race([w.start(), this.timer(TURN_WAIT_MS)]);
        const bytes = Math.max(0, this.options.bytesIn() - before);
        const took = this.now() - startedAt;
        const owed = (bytes / (BACKGROUND_SHARE * this.rate(bytes, took))) * 1000 - took;
        // At least one macrotask between two transcripts, so the window paints and takes input.
        await this.sleep(Math.max(0, owed));
      }
    } finally {
      this.busy = false;
    }
  }
}
