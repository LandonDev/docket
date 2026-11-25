import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Link } from "./link";
import { withDeadline } from "./openRead";

export type HostRead<T> = {
  /** The host's answer; undefined until it has given one for this key. */
  value: T | undefined;
  /** Why the newest read failed (NO_ANSWER past the deadline); null once it answered. Kept while a read again is out, so a Retry stays in place until the answer replaces it. */
  error: string | null;
  /** Asks again, keeping the value and the failure shown meanwhile; settles once that read answers or fails. */
  retry: () => Promise<void>;
  /** Puts a value in place: a change this page made and the host took. */
  set: (value: T) => void;
};

type State<T> = { key: string; value: T | undefined; error: string | null };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A page's read from a host, the way docs/DESIGN.md "Panels…" says a page
 * reads (lib/connection/openRead.ts): it waits for the socket to open, is
 * asked again on every new socket until it has answered, and past
 * LOAD_DEADLINE_MS reports NO_ANSWER for the page to show with Retry; a late
 * answer still lands. Never a value made up from a failure: until the host
 * answers, `value` is undefined. A new `key` (the read's parameters) starts
 * over from nothing; `retry` and a socket opening keep what is shown, the
 * failure too, until the read answers; `retry`'s promise settles then.
 */
export function useHostRead<T>(link: Link | null | undefined, read: () => Promise<T>, key = ""): HostRead<T> {
  const [state, setState] = useState<State<T>>({ key, value: undefined, error: null });
  // Bumped by Retry and by a socket opening while the value is missing.
  const [attempt, setAttempt] = useState(0);
  // A read in flight waits for the open itself; only a settled miss asks again.
  const pending = useRef(false);
  // Retry presses waiting for the read they asked for: settled when it answers or fails.
  const waiters = useRef<(() => void)[]>([]);
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  const current: State<T> = state.key === key ? state : { key, value: undefined, error: null };
  const loaded = current.value !== undefined;

  useEffect(() => {
    if (!link || loaded) return;
    return link.onOpen(() => {
      if (!pending.current) setAttempt((n) => n + 1);
    });
  }, [link, loaded]);

  useEffect(() => {
    const mine = waiters.current.splice(0);
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      for (const done of mine) done();
    };
    if (!link) return settle();
    let live = true;
    pending.current = true;
    // The same read again keeps its failure until this one answers; another key starts over.
    setState((s) => (s.key === key ? s : { key, value: undefined, error: null }));
    // Asked at once on an open socket, so the request leaves with this render's effects;
    // otherwise at the next open, a waiter the cleanup drops so a superseded
    // read never sends on reconnect.
    let off: (() => void) | undefined;
    const answer = link.connected
      ? latest.current()
      : new Promise<void>((resolve) => {
          off = link.onOpen(() => {
            off?.();
            off = undefined;
            resolve();
          });
        }).then(() => latest.current());
    answer
      .then(
        (value) => {
          if (live) setState({ key, value, error: null });
          settle();
        },
        () => {},
      )
      .finally(() => {
        if (live) pending.current = false;
      });
    withDeadline(answer).catch((err: unknown) => {
      if (live) setState((s) => ({ key, value: s.key === key ? s.value : undefined, error: message(err) }));
      settle();
    });
    return () => {
      live = false;
      off?.();
      // A read superseded before it settled hands its presses to the next one.
      if (!settled) waiters.current.unshift(...mine);
    };
  }, [link, key, attempt]);
  // Gone: a Retry still waiting settles, so nothing waits on a page no longer shown.
  useEffect(
    () => () => {
      for (const done of waiters.current.splice(0)) done();
    },
    [],
  );

  // Stable across renders, so an effect that polls with `retry` keeps its timer.
  const retry = useCallback(
    (): Promise<void> =>
      new Promise<void>((done) => {
        waiters.current.push(done);
        setAttempt((n) => n + 1);
      }),
    [],
  );
  const set = useCallback((value: T) => setState({ key, value, error: null }), [key]);
  return { value: current.value, error: current.error, retry, set };
}
