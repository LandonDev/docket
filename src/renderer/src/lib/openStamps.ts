/**
 * The clocks of a thread's open where no other clock runs: the press that
 * asked for it, the transcript ask leaving, its answer landing, the
 * answer's rows folded, and how many times each host's link has opened.
 * Written by the press (App.tsx), the transcript fetch (connection/
 * subscriptions.ts, tcserver/store.ts) and the link (connection/link.ts);
 * read once by the pane's first-paint watch (firstPaint.ts). Imports
 * nothing, so every one of those can write here without a cycle.
 *
 * Bounded: one small record a thread for the last OPENS_KEPT threads, one
 * number a host. Times are `performance.now()`, the long-task clock.
 */
export const OPENS_KEPT = 32;

export interface OpenStamp {
  /** The press that asked for this thread (a rail row, a tab, a history pick, a search hit). */
  pressAt?: number;
  /** The first transcript ask that left since the press (or since nothing was pressed). */
  askedAt?: number;
  /** Its answer landing: the first page after `askedAt`, retries included. */
  answeredAt?: number;
  /** That page's rows folded into the transcript. */
  foldedAt?: number;
}

export interface OpenStamps {
  press(sessionId: string): void;
  asked(sessionId: string): void;
  answered(sessionId: string): void;
  folded(sessionId: string): void;
  /** The thread's record, still kept (a watch peeks at its press when it starts). */
  peek(sessionId: string): OpenStamp | undefined;
  /** The thread's record, forgotten: the next press or ask starts a new one. */
  take(sessionId: string): OpenStamp | undefined;
  linkOpened(environmentId: string): void;
  /** How many sockets this host's link has had in this window: 0 never, 1 the first, 2+ a reconnect. */
  linkOpens(environmentId: string): number;
  /** Records kept now (the bound's test). */
  size(): number;
}

export function createOpenStamps(now: () => number = () => performance.now()): OpenStamps {
  const opens = new Map<string, OpenStamp>();
  const links = new Map<string, number>();
  const fresh = (sessionId: string, stamp: OpenStamp): OpenStamp => {
    opens.delete(sessionId);
    opens.set(sessionId, stamp);
    if (opens.size > OPENS_KEPT) opens.delete(opens.keys().next().value!);
    return stamp;
  };
  return {
    press(sessionId) {
      // An ask still out (a hover's prefetch, a load the press joins) is this open's: its answer is what he waits for.
      const out = opens.get(sessionId);
      const keep = out?.askedAt !== undefined && out.foldedAt === undefined ? { askedAt: out.askedAt, answeredAt: out.answeredAt } : {};
      fresh(sessionId, { ...keep, pressAt: now() });
    },
    asked(sessionId) {
      const stamp = opens.get(sessionId) ?? fresh(sessionId, {});
      stamp.askedAt ??= now();
    },
    answered(sessionId) {
      const stamp = opens.get(sessionId);
      if (stamp && stamp.askedAt !== undefined) stamp.answeredAt ??= now();
    },
    folded(sessionId) {
      const stamp = opens.get(sessionId);
      if (stamp && stamp.answeredAt !== undefined) stamp.foldedAt ??= now();
    },
    peek: (sessionId) => opens.get(sessionId),
    take(sessionId) {
      const stamp = opens.get(sessionId);
      opens.delete(sessionId);
      return stamp;
    },
    linkOpened(environmentId) {
      links.set(environmentId, (links.get(environmentId) ?? 0) + 1);
    },
    linkOpens: (environmentId) => links.get(environmentId) ?? 0,
    size: () => opens.size,
  };
}

/** The window's one set. */
export const openStamps = createOpenStamps();
