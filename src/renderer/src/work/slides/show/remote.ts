import { useEffect, useRef, useState } from "react";
import type { ShowLive, ShowPress, ShowPressAct, ShowPressAnswer } from "@shared/contract-work-slides";
import { registry } from "../../../lib/connection";
import { nextPress, type ShowAct, type ShowState } from "./state";
import { elapsedOf, type ShowTimer, type Target } from "./timer";

/**
 * The clicker's wire, as the desktop and the phone's page use it (docs/agents/work-slides.md "The clicker"): the
 * window that runs a show tells the deck's host its state and takes the presses its host hands it
 * (`work.slides.show.run`); another device reads the state (`work.slides.show.state`, the push `work.slides.show`)
 * and presses (`work.slides.show.press`).
 */

export type LiveState = Omit<ShowLive, "showId" | "itemId">;

export interface ShowRemote {
  itemId: string;
  /** the window that runs a show: its state (null: ended), the answer to the press it took last; held until the next press */
  run(showId: string, live: LiveState | null, answered?: { seq: number; applied: boolean }): Promise<{ press: ShowPress | null }>;
  /** the shows of this deck running now, wherever they run */
  state(): Promise<ShowLive[]>;
  press(showId: string, act: ShowPressAct, rev: number, at?: number): Promise<ShowPressAnswer>;
  /** a show of this deck changed, began or ended (null) */
  onLive(listener: (showId: string, live: ShowLive | null) => void): () => void;
  /** the wire came back after a cut, so pushes may have been missed */
  onOpen?(listener: () => void): () => void;
}

/**
 * A remote whose press answers are told as the push would tell them: a press dropped as the show moved on or ended
 * answers with the show as it is (null once it ended), so a clicker that missed a push while its socket was down
 * catches up with its next press instead of pressing a stale show, or a dead one, again and again.
 */
export function withPressAnswers(remote: ShowRemote): ShowRemote {
  const heard = new Set<(showId: string, live: ShowLive | null) => void>();
  return {
    ...remote,
    press: async (showId, act, rev, at) => {
      const answer = await remote.press(showId, act, rev, at);
      if ("dropped" in answer) for (const listener of heard) listener(showId, answer.live);
      return answer;
    },
    onLive: (listener) => {
      heard.add(listener);
      const off = remote.onLive(listener);
      return () => {
        heard.delete(listener);
        off();
      };
    },
  };
}

/** A held call is answered within 20 s by the host; past a minute it is the socket that failed. */
const RUN_TIMEOUT_MS = 60_000;

export function linkShowRemote(environmentId: string, itemId: string): ShowRemote {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  return withPressAnswers({
    itemId,
    run: (showId, live, answered) => link().request("work.slides.show.run", { itemId, showId, live, ...(answered ? { answered } : {}) }, { timeoutMs: RUN_TIMEOUT_MS, retry: false }),
    state: async () => (await link().request<{ shows: ShowLive[] }>("work.slides.show.state", { itemId })).shows,
    press: (showId, act, rev, at) => link().request("work.slides.show.press", { showId, act, rev, ...(at !== undefined ? { at } : {}) }, { retry: false }),
    onLive: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.slides.show" && push.itemId === itemId) listener(push.showId, push.live);
      }),
    onOpen: (listener) => link().onOpen(listener),
  });
}

/** The show's public state, as a clicker sees it; `rev` is the caller's. */
export function liveOf(state: ShowState, timer: ShowTimer, target: Target, title: string, now: number): Omit<LiveState, "rev"> {
  const slide = state.slides[state.at];
  const next = nextPress(state);
  const steps = Math.max(0, (slide?.steps?.length ?? 1) - 1);
  return {
    title,
    slide: slide?.number ?? 0,
    count: state.slides.length,
    step: state.step,
    steps,
    next:
      next.kind === "build"
        ? { kind: "build", step: next.step, of: next.of }
        : next.kind === "slide"
          ? { kind: "slide", number: state.slides[next.at]?.number ?? 0, title: state.slides[next.at]?.title ?? "" }
          : next,
    notes: slide?.notes ?? "",
    timer: { elapsed: elapsedOf(timer, now), paused: timer.pausedAt !== null, target },
    blank: state.blank,
    ended: state.ended,
  };
}

/** A press as the show's own reducer runs it; null for the timer's acts, which are not the reducer's. */
export function actOf(press: Pick<ShowPress, "act" | "at">): ShowAct | null {
  switch (press.act) {
    case "goto":
      return { t: "goto", number: press.at ?? 0 };
    case "next":
    case "prev":
    case "blank":
    case "end":
      return { t: press.act };
    default:
      return null;
  }
}

/** What moves the revision: everything but the running time. */
const keyOf = (live: Omit<LiveState, "rev">): string => JSON.stringify({ ...live, timer: { paused: live.timer.paused, target: live.timer.target } });

/** The shows this page runs itself: never a clicker of its own show. */
const own = new Set<string>();
export const isOwnShow = (showId: string): boolean => own.has(showId);

const newShowId = (): string => `show-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

/** How long a failed call waits before the window asks again: 2 s, then twice as long each time, to 30 s (a host a release behind knows no such call). */
export const RUN_RETRY_MS = 2000;
const RUN_RETRY_MOST_MS = 30_000;

/**
 * The window that runs a show keeps its host told (`live` null: nothing to tell yet) and runs each press its host
 * hands it with `apply`, but only a press made on the state it shows now: one made on a state it has since left is
 * answered as not applied. When it unmounts, the show ends on the host too.
 */
export function usePublish(remote: ShowRemote | undefined, read: () => Omit<LiveState, "rev"> | null, apply: (press: ShowPress) => void): void {
  const [showId] = useState(newShowId);
  const readRef = useRef(read);
  readRef.current = read;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const shown = read();
  const key = shown ? keyOf(shown) : null;
  const rev = useRef({ key: null as string | null, n: 0 });
  if (key !== null && key !== rev.current.key) rev.current = { key, n: rev.current.n + 1 };
  const kick = useRef<() => void>(() => undefined);
  // A press run (or dropped) is told with the state it made, once that state has rendered.
  const [told, setTold] = useState(0);

  useEffect(() => {
    if (!remote) return;
    let stopped = false;
    let calls = 0;
    let queued = false;
    let answered: { seq: number; applied: boolean } | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = RUN_RETRY_MS;
    const call = (): void => {
      queued = false;
      const now = readRef.current();
      if (stopped || !now) return;
      const mine = ++calls;
      const at = rev.current.n;
      const told = answered;
      answered = undefined;
      remote.run(showId, { ...now, rev: at }, told).then(
        ({ press }) => {
          if (stopped) return;
          wait = RUN_RETRY_MS;
          if (press) {
            // Only on the state it was made on: anything else would move a slide he did not see.
            const fresh = press.rev === rev.current.n;
            if (fresh) applyRef.current(press);
            answered = { seq: press.seq, applied: fresh };
            return setTold((n) => n + 1);
          }
          if (mine === calls) schedule();
        },
        () => {
          if (stopped || mine !== calls) return;
          if (told) answered ??= told;
          retry = setTimeout(schedule, wait);
          wait = Math.min(RUN_RETRY_MOST_MS, wait * 2);
        },
      );
    };
    // One call a turn: a press and the change it makes are told together.
    const schedule = (): void => {
      if (queued || stopped) return;
      queued = true;
      setTimeout(call, 0);
    };
    kick.current = schedule;
    own.add(showId);
    schedule();
    return () => {
      stopped = true;
      own.delete(showId);
      clearTimeout(retry);
      kick.current = () => undefined;
      void remote.run(showId, null).catch(() => undefined);
    };
  }, [remote, showId]);

  // Every change he can see is told at once, and every press taken.
  useEffect(() => {
    if (key !== null) kick.current();
  }, [key, told]);
}

/**
 * The shows of a deck running now, kept current by the push; empty while none runs or where there is no wire. Every
 * word goes through one check, a push, a press's answer and a list read whole alike: a show told ended never comes
 * back (a show's id is never used again), and a word about a state older than the newest heard changes nothing. A
 * list read whole gives way to what was heard while it was read, and only the newest read counts.
 */
export function useLiveShows(remote: ShowRemote | null): ShowLive[] {
  const [shows, setShows] = useState<ShowLive[]>([]);
  useEffect(() => {
    if (!remote) return;
    let live = true;
    const ended = new Set<string>();
    const newest = new Map<string, number>();
    /** Whether a word about a show is news: never one about a show that ended, nor about a state older than the newest. */
    const news = (showId: string, next: ShowLive | null): boolean => {
      if (ended.has(showId)) return false;
      if (!next) {
        ended.add(showId);
        newest.delete(showId);
        return true;
      }
      if (next.rev < (newest.get(showId) ?? -1)) return false;
      newest.set(showId, next.rev);
      return true;
    };
    /** The shows a word told of while the newest read of the list was on its way: newer than what the list says. */
    let heard: Set<string> | null = null;
    const off = remote.onLive((showId, next) => {
      if (!news(showId, next)) return;
      heard?.add(showId);
      setShows((was) => [...was.filter((s) => s.showId !== showId), ...(next ? [next] : [])]);
    });
    let reads = 0;
    const read = (): void => {
      const mine = ++reads;
      const since = (heard = new Set());
      void remote.state().then(
        (got) => {
          if (!live || mine !== reads) return;
          heard = null;
          // What the list says passes the same check; a show it leaves out, and nothing told of meanwhile, ended unheard.
          for (const id of [...newest.keys()]) if (!since.has(id) && !got.some((g) => g.showId === id)) news(id, null);
          const listed = got.filter((s) => news(s.showId, s));
          setShows((was) => {
            const out = new Map(was.filter((s) => since.has(s.showId)).map((s) => [s.showId, s]));
            for (const s of listed) if ((out.get(s.showId)?.rev ?? -1) <= s.rev) out.set(s.showId, s);
            return [...out.values()].filter((s) => !ended.has(s.showId));
          });
        },
        () => void (mine === reads && (heard = null)),
      );
    };
    read();
    // Back after a cut: the pushes it missed are read whole.
    const offOpen = remote.onOpen?.(read) ?? (() => undefined);
    return () => {
      live = false;
      off();
      offOpen();
    };
  }, [remote]);
  return shows;
}
