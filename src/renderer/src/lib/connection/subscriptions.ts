import type { EventRow } from "@server/shared/events";
import type { EventsPage } from "@server/shared/wire";
import type { Link } from "./link";

/**
 * What the owner of one transcript gives the subscription set: where its
 * fold is, and how to take a page. `page.reset` is D2's rule: the gap
 * outgrew the budget and the host sent a fresh tail, so the owner throws
 * its fold away before folding the rows.
 */
export type SubscriptionHandlers = {
  /** The highest seq folded so far; the resume asks for what follows it. */
  cursor(): number;
  /** The time of the row at the cursor, when known: a resume names it (`afterTs`), and a host
   *  that gave that seq to another row (a crash between a row's push and its write) answers `reset`. */
  cursorTs?(): number | undefined;
  /** A fetch is in flight: hold live pushes until `end`. */
  begin?(): void;
  /** May fold in slices across tasks; `end` waits for it. */
  page(page: EventsPage): void | Promise<void>;
  /** The thread is on screen in this window: its asks say `shown`, and the host serves them on its interactive lane. */
  shown?(): boolean;
  /** The history request is leaving now (after any subscribe it waited on): the open's clock (openStamps.ts). */
  asked?(): void;
  /** `ok` false: the read failed. Its held pushes stay held for the next read, so the cursor stays behind the gap. */
  end?(ok: boolean, error?: unknown): void;
  /** `session.subscribe` was refused: the session is gone from the host. */
  gone?(reason: string): void;
};

/** One shape for both profiles: a local socket answers the bare rows and
 *  the head is read off their seqs (a tail that starts after 1 has older
 *  rows behind it); a remote socket says so itself. */
export function asPage(result: EventRow[] | EventsPage, tailFirst: boolean): EventsPage {
  if (Array.isArray(result)) {
    return {
      rows: result,
      moreBefore: tailFirst && result.length > 0 && result[0].seq > 1,
      moreAfter: false,
      reset: false,
    };
  }
  return result;
}

export const RESUME_CONCURRENCY = 4;

/** A resume from a cursor names the time of the row it holds there. */
function resumeTs(afterSeq: number, handlers: SubscriptionHandlers): { afterTs?: number } {
  const ts = afterSeq > 0 ? handlers.cursorTs?.() : undefined;
  return ts === undefined ? {} : { afterTs: ts };
}

/** A cold open's deadline: its answer is a tail of at most TAIL_BYTES (1 MiB,
 *  about 150 KiB on the deflated socket), the same 8 s that marks a host slow.
 *  An answer not here by then was lost or is stuck; the link's own deadline
 *  (30 s) is for a read of any size. */
export const COLD_OPEN_DEADLINE_MS = 8_000;

const realTimer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The first answer of `first`, or, once `deadline` passes with it still out,
 * of `first` and a second ask made then, whichever lands first. The first is
 * never given up: a late answer that wins is kept. Both failing fails with
 * the last failure; the loser's outcome is dropped.
 */
export function firstOfTwo<T>(
  first: Promise<T>,
  again: () => Promise<T>,
  deadline: Promise<void>,
): Promise<{ answer: T; second: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = 1;
    let asked = false;
    const won = (answer: T, second: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ answer, second });
    };
    const lost = (err: unknown): void => {
      if (settled) return;
      out--;
      // Before the deadline a failure is the open's, as it always was.
      if (out === 0 || !asked) {
        settled = true;
        reject(err);
      }
    };
    first.then((answer) => won(answer, false), lost);
    void deadline.then(() => {
      if (settled) return;
      asked = true;
      out++;
      again().then((answer) => won(answer, true), lost);
    });
  });
}

/**
 * The durable `session.subscribe` set of one environment. A subscription
 * belongs to the socket that made it, so on every replacement session
 * (`link.onOpen`) the set forgets what was subscribed and `resumeAll()`
 * re-subscribes each session and resumes it from its owner's cursor with
 * `afterSeq`, a few at a time. The owner (the session store) decides what
 * is in the set: it adds a transcript when it loads one and removes it when
 * it unloads one, so a reconnect never replays transcripts nobody is looking at.
 */
export class Subscriptions {
  private handlers = new Map<string, SubscriptionHandlers>();
  /** Session ids subscribed on the CURRENT socket. */
  private live = new Set<string>();
  // The fetch on its way per session, with the owner it was made for.
  private inFlight = new Map<string, { owner: SubscriptionHandlers; run: Promise<EventsPage> }>();
  private detach: (() => void)[];

  constructor(
    readonly link: Link,
    private readonly concurrency = RESUME_CONCURRENCY,
    /** The clock of COLD_OPEN_DEADLINE_MS. */
    private readonly timer: (ms: number) => Promise<void> = realTimer,
  ) {
    this.detach = [
      link.onOpen(() => this.live.clear()),
      link.onClose(() => this.live.clear()),
    ];
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.handlers.clear();
    this.live.clear();
  }

  has(sessionId: string): boolean {
    return this.handlers.has(sessionId);
  }

  ids(): string[] {
    return [...this.handlers.keys()];
  }

  /** True when the current socket carries this session's pushes. */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId) && this.link.connected;
  }

  add(sessionId: string, handlers: SubscriptionHandlers): void {
    this.handlers.set(sessionId, handlers);
  }

  /**
   * Subscribe on the current socket without fetching: for a session this
   * window just created, whose rows arrive as pushes from the start. A later
   * replacement session resumes it from its cursor like any other member.
   */
  async subscribe(sessionId: string): Promise<void> {
    if (!this.handlers.has(sessionId)) throw new Error(`not subscribed: ${sessionId}`);
    if (this.live.has(sessionId)) return;
    await this.link.request("session.subscribe", { sessionId });
    this.live.add(sessionId);
  }

  /** Leave the set; the socket is told when it is up. */
  remove(sessionId: string): void {
    this.handlers.delete(sessionId);
    if (this.live.delete(sessionId) && this.link.connected)
      void this.link.request("session.unsubscribe", { sessionId }).catch(() => undefined);
  }

  /**
   * Subscribe on the current socket if not yet, then fetch what follows the
   * owner's cursor (`tail` for a cold open). The page is handed to the owner
   * and returned; a second call while one is in flight joins it.
   */
  resume(sessionId: string, options: { tail?: number } = {}): Promise<EventsPage> {
    const handlers = this.handlers.get(sessionId);
    if (!handlers) return Promise.reject(new Error(`not subscribed: ${sessionId}`));
    const pending = this.inFlight.get(sessionId);
    // Joined only by the owner it was made for: a fetch for an owner that has
    // since left (an unloaded transcript opened again) hands its page to
    // nobody, and the new owner would finish its load with nothing folded,
    // an empty thread on screen. It is waited out.
    if (pending) {
      if (pending.owner === handlers) return pending.run;
      return pending.run.catch(() => undefined).then(() => this.resume(sessionId, options));
    }
    const run = (async (): Promise<EventsPage> => {
      let done = false;
      let error: unknown;
      handlers.begin?.();
      const subscribe = async (): Promise<void> => {
        try {
          await this.link.request("session.subscribe", { sessionId });
        } catch (err) {
          if (this.handlers.get(sessionId) === handlers)
            handlers.gone?.(err instanceof Error ? err.message : String(err));
          throw err;
        }
        this.live.add(sessionId);
      };
      try {
        // Over a remote link the subscription rides the history request:
        // one round trip to the host instead of two (about 200 ms each
        // from the Mac to the box). A local socket answers in microseconds
        // and keeps the two plain requests.
        const together = !this.live.has(sessionId) && this.link.profile === "remote";
        if (!this.live.has(sessionId) && !together) await subscribe();
        const afterSeq = handlers.cursor();
        const tailFirst = options.tail !== undefined && afterSeq === 0;
        // The owner retries a failed resume itself (the store's load, the
        // next replacement session), so the link does not ask again here.
        let result: EventRow[] | EventsPage;
        const params = {
          sessionId,
          afterSeq,
          ...(tailFirst ? { tail: options.tail } : resumeTs(afterSeq, handlers)),
          ...(handlers.shown?.() ? { shown: true } : {}),
        };
        const ask = (extra: { subscribe?: true }): Promise<EventRow[] | EventsPage> =>
          this.link.request<EventRow[] | EventsPage>("session.events", { ...params, ...extra }, { retry: false });
        handlers.asked?.();
        try {
          const first = ask(together ? { subscribe: true } : {});
          // A cold open past its deadline asks again at once, the first kept:
          // whichever lands first is folded, the other dropped. The second
          // goes without `subscribe` (the first asked for it), so the host
          // holds one subscription; a page that does not say `subscribed`
          // subscribes after it and folds the gap, as for an older host
          // (`session.subscribe` is one subscription a socket and thread).
          result = tailFirst
            ? (await firstOfTwo(first, () => ask({}), this.timer(COLD_OPEN_DEADLINE_MS))).answer
            : await first;
        } catch (err) {
          // The host may have subscribed before the answer was lost: a live
          // subscription the set does not know would fold pushes into a
          // transcript that is starting over.
          if (together && this.link.connected)
            void this.link.request("session.unsubscribe", { sessionId }).catch(() => undefined);
          throw err;
        }
        const page = asPage(result, tailFirst);
        if (this.handlers.get(sessionId) === handlers) await handlers.page(page);
        if (together) {
          if (page.subscribed) {
            this.live.add(sessionId);
            // An owner that left while this was on its way has nobody to fold the pushes.
            if (!this.handlers.has(sessionId)) this.remove(sessionId);
          } else {
            // A host that predates the flag read the page unsubscribed:
            // subscribe now and fold what landed between the two.
            await subscribe();
            const gap = await this.link.request<EventRow[] | EventsPage>(
              "session.events",
              {
                sessionId,
                afterSeq: handlers.cursor(),
                ...resumeTs(handlers.cursor(), handlers),
                ...(handlers.shown?.() ? { shown: true } : {}),
              },
              { retry: false },
            );
            if (this.handlers.get(sessionId) === handlers) await handlers.page(asPage(gap, false));
          }
        }
        done = true;
        return page;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        handlers.end?.(done, error);
      }
    })().finally(() => {
      if (this.inFlight.get(sessionId)?.run === run) this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, { owner: handlers, run });
    return run;
  }

  /** After a replacement session: every member subscribes and resumes again. */
  async resumeAll(): Promise<void> {
    const ids = this.ids();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++];
        if (!this.handlers.has(id)) continue;
        await this.resume(id).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));
  }
}
