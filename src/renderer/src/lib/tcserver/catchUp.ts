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

/** What background catch-up may take of the link, on average. */
export const CATCH_UP_BYTES_PER_SEC = 2 * 1024 * 1024;

/** The longest a background fetch waits for the shown thread's: on
 *  2026-11-24 a child opened in a master's view waited behind the master's
 *  fetches, a front that never emptied, and never loaded. */
export const FRONT_WAIT_MS = 2_000;

/** The longest the lane waits on one background fetch before the next one
 *  goes: the fetch keeps going and settles its own caller. */
export const TURN_WAIT_MS = 10_000;

export type CatchUpOptions = {
  /** The thread the window's focused pane shows, or the one it draws in
   *  its place (a master's child, `showInside`): it never waits here. */
  shown: () => string | null;
  /** Characters received on the link so far (`Link.bytesIn`). */
  bytesIn: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The clock for the two bounds (FRONT_WAIT_MS, TURN_WAIT_MS). */
  timer?: (ms: number) => Promise<void>;
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
  private readonly rate: number;

  constructor(private readonly options: CatchUpOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
    this.timer = options.timer ?? realSleep;
    this.rate = options.bytesPerSec ?? CATCH_UP_BYTES_PER_SEC;
  }

  /** Transcripts waiting their turn, in order. */
  queued(): string[] {
    return this.waiting.map((w) => w.id);
  }

  /** Run one transcript's fetch: at once for the shown thread, else in turn. */
  run<T>(id: string, fetch: () => Promise<T>): Promise<T> {
    if (id === this.options.shown()) return this.inFront(fetch());
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

  /** The shown thread moved, or Retry was pressed: if it waits here, it starts now. */
  promote(id: string | null): void {
    const at = id ? this.waiting.findIndex((w) => w.id === id) : -1;
    if (at < 0) return;
    const [w] = this.waiting.splice(at, 1);
    void this.inFront(w.start());
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
        // The shown thread first, if it was asked for before the window named it.
        const shown = this.options.shown();
        const at = this.waiting.findIndex((x) => x.id === shown);
        const w = at >= 0 ? this.waiting.splice(at, 1)[0] : this.waiting.shift();
        if (!w) break;
        const before = this.options.bytesIn();
        const startedAt = this.now();
        await Promise.race([w.start(), this.timer(TURN_WAIT_MS)]);
        const bytes = Math.max(0, this.options.bytesIn() - before);
        const owed = (bytes / this.rate) * 1000 - (this.now() - startedAt);
        // At least one macrotask between two transcripts, so the window paints and takes input.
        await this.sleep(Math.max(0, owed));
      }
    } finally {
      this.busy = false;
    }
  }
}
