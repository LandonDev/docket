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

export type CatchUpOptions = {
  /** The thread the window's focused pane shows: it never waits here. */
  shown: () => string | null;
  /** Characters received on the link so far (`Link.bytesIn`). */
  bytesIn: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  bytesPerSec?: number;
};

type Waiting = { id: string; start: () => Promise<void> };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CatchUpLane {
  private waiting: Waiting[] = [];
  private busy = false;
  /** The shown thread's fetches in flight: the next background one waits for them. */
  private front = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rate: number;

  constructor(private readonly options: CatchUpOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
    this.rate = options.bytesPerSec ?? CATCH_UP_BYTES_PER_SEC;
  }

  /** Transcripts waiting their turn, in order. */
  queued(): string[] {
    return this.waiting.map((w) => w.id);
  }

  /** Run one transcript's fetch: at once for the shown thread, else in turn. */
  run<T>(id: string, fetch: () => Promise<T>): Promise<T> {
    if (id === this.options.shown()) return this.inFront(fetch());
    return new Promise<T>((resolve, reject) => {
      let running: Promise<void> | null = null;
      // Settles when the fetch does, whichever way; started once, by the pump or `promote`.
      const start = (): Promise<void> => (running ??= fetch().then(resolve, reject));
      this.waiting.push({ id, start });
      this.kick();
    });
  }

  /** The shown thread moved: if it waits here, it starts now. */
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
        // The shown thread's page is never queued behind a background one on the socket.
        while (this.front.size > 0) await Promise.all(this.front);
        // The shown thread first, if it was asked for before the window named it.
        const shown = this.options.shown();
        const at = this.waiting.findIndex((x) => x.id === shown);
        const w = at >= 0 ? this.waiting.splice(at, 1)[0] : this.waiting.shift();
        if (!w) break;
        const before = this.options.bytesIn();
        const startedAt = this.now();
        await w.start();
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
