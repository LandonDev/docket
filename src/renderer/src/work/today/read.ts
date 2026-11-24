import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registry, type Link } from "../../lib/connection";
import { resetHooks } from "./store";
import type { TodayAnswer, TodayEnv, TodayFailure, TodayWorkspace } from "./types";

/**
 * A read that lives on hosts (docs/agents/work-today.md "Reading the hosts"):
 * one call per Work workspace on every host with Work on, each on its own.
 * It answers what has come back so far and never waits for all: a host that
 * is slow or off holds up no other. A call ends at six seconds; it is asked
 * again on the source's push and when a host's link opens. A host whose link
 * is not open is skipped (the page names it once, at its foot).
 */

export const EACH_TIMEOUT_MS = 6_000;
/** What a read that ran out of time fails with: the page says "did not answer" for it and adds nothing. */
export const TIMED_OUT = "It did not answer in time";

export type EachAnswer<T> = {
  /** What has come back, in the jobs' order. A job whose read failed keeps the value it had. */
  answers: { workspace: TodayWorkspace; value: T }[];
  /** Some job on an open host was asked and has neither answered nor failed yet. */
  loading: boolean;
  /** One line per host with a job that did not answer, with its Retry. */
  failed: TodayFailure[];
  /** It is `loading`, and every job still out has a value from an earlier read: what it shows is whole, only being read again. */
  stale: boolean;
  /** A job's host is offline, so it was not asked: what it holds is not known (the page names the host at its foot). */
  away: boolean;
};

/** What a source passes on of its read, beside its rows: one rule for every source whose rows live on hosts. */
export function readState(read: EachAnswer<unknown>): Pick<TodayAnswer, "loading" | "failed" | "stale" | "away"> {
  return { loading: read.loading, failed: read.failed, ...(read.stale ? { stale: true } : {}), ...(read.away ? { away: true } : {}) };
}

/** `fresh`: answered in this read's own life; a value it started with is the last one any read had (`lastOf`). */
type Slot<T> = {
  workspace: TodayWorkspace;
  value?: T;
  has: boolean;
  fresh: boolean;
  error: string | null;
  pending: boolean;
  seq: number;
  /** When it was last known current: its answer, or, for a read kept by pushes, the moment its last reader left. */
  at: number;
  /** A push or a reopened link named it while no reader listened: the next reader asks it. */
  dirty: boolean;
};

/** A slot that a reader coming back finds older than this is asked again; a newer one is shown as it is. */
export const FRESH_MS = 30_000;

/** The asks made in one turn of the event loop, by host: a read `perHost` asks each host once for all its jobs. */
let turn = 0;
let turning = false;
function turnOf(): number {
  if (!turning) {
    turning = true;
    queueMicrotask(() => {
      turn++;
      turning = false;
    });
  }
  return turn;
}

/**
 * The last value each job answered, for the life of the window, by method:
 * a read made afresh (the page reopened) starts with it, so each job shows
 * what it had until its own answer comes, and keeps it if that answer fails.
 * A job that leaves is forgotten.
 */
const lastOf = new Map<string, unknown>();
/** Test seam: what the reads had is forgotten. */
export function forgetEach(): void {
  lastOf.clear();
  forgetSharedReads();
}
resetHooks.add(forgetEach);

const keyOf = (w: Pick<TodayWorkspace, "environmentId" | "workspaceId">): string => `${w.environmentId}:${w.workspaceId}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type EachOptions = {
  /** The push that says the answer moved (`work.files`); one that names a `workspaceId` asks that job alone. */
  push?: string;
  timeoutMs?: number;
  /** A test's links. */
  linkOf?: (environmentId: string) => Link;
  /** What the asks depend on beside the jobs (the day): when it changes, every job is asked again. */
  again?: unknown;
  /** The host answers every job of its own to one ask (the same params for each): one ask a host, its answer each job's. */
  perHost?: boolean;
};

/** The read with no React: `set` the jobs and it asks; `subscribe` and `snapshot` for what has come back. */
export function eachWorkspace<T>(method: string, opts: EachOptions = {}) {
  const linkOf = opts.linkOf ?? ((id: string) => registry.linkOf(id));
  const timeoutMs = opts.timeoutMs ?? EACH_TIMEOUT_MS;
  const slots = new Map<string, Slot<T>>();
  const hosts = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  let paramsOf: (workspace: TodayWorkspace) => unknown = () => ({});
  let order: string[] = [];
  let cached: EachAnswer<T> | null = null;
  let closed = false;
  /** Whether it was handed its jobs: before that nothing was asked, and it is not known to hold nothing. */
  let started = false;
  /** A reader is mounted: pushes and reopened links ask at once. With none, they mark what they name for the next. */
  let listening = true;
  const hostAsks = new Map<string, { turn: number; request: Promise<T> }>();

  const changed = (): void => {
    cached = null;
    for (const listener of listeners) listener();
  };

  const ask = (key: string): void => {
    const slot = slots.get(key);
    if (!slot || closed || !slot.workspace.open) return;
    const seq = ++slot.seq;
    slot.pending = true;
    slot.dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(TIMED_OUT)), timeoutMs);
    });
    let request: Promise<T>;
    const environmentId = slot.workspace.environmentId;
    const shared = opts.perHost ? hostAsks.get(environmentId) : undefined;
    if (shared && shared.turn === turnOf()) request = shared.request;
    else {
      try {
        request = linkOf(environmentId).request<T>(method, paramsOf(slot.workspace), { timeoutMs, retry: false });
      } catch (err) {
        request = Promise.reject(err);
      }
      if (opts.perHost) hostAsks.set(environmentId, { turn: turnOf(), request });
    }
    Promise.race([request, late])
      .then(
        (value) => {
          if (slots.get(key) !== slot || slot.seq !== seq) return;
          Object.assign(slot, { value, has: true, fresh: true, error: null, pending: false, at: Date.now(), dirty: false });
          lastOf.set(`${method}|${key}`, value);
          changed();
        },
        (err: unknown) => {
          if (slots.get(key) !== slot || slot.seq !== seq) return;
          Object.assign(slot, { error: errorText(err), pending: false });
          changed();
        },
      )
      .finally(() => clearTimeout(timer));
    changed();
  };

  const askHost = (environmentId: string, workspaceId?: string): void => {
    for (const [key, slot] of slots) {
      if (slot.workspace.environmentId !== environmentId || (workspaceId && slot.workspace.workspaceId !== workspaceId)) continue;
      if (listening) ask(key);
      else slot.dirty = true;
    }
  };

  const watch = (environmentId: string): void => {
    if (hosts.has(environmentId)) return;
    let link: Link;
    try {
      link = linkOf(environmentId);
    } catch {
      return;
    }
    const offPush = opts.push
      ? link.onPush((push) => {
          if (push.push !== opts.push) return;
          askHost(environmentId, (push as { workspaceId?: string }).workspaceId);
        })
      : () => {};
    const offOpen = link.onOpen(() => askHost(environmentId));
    hosts.set(environmentId, () => {
      offPush();
      offOpen();
    });
  };

  /** A job's slot as a read starts it: with the last value any read had for it, if there is one. */
  const slotOf = (workspace: TodayWorkspace): Slot<T> => {
    const last = `${method}|${keyOf(workspace)}`;
    return lastOf.has(last)
      ? { workspace, value: lastOf.get(last) as T, has: true, fresh: false, error: null, pending: false, seq: 0, at: 0, dirty: false }
      : { workspace, has: false, fresh: false, error: null, pending: false, seq: 0, at: 0, dirty: false };
  };

  return {
    /**
     * The jobs it will read, before it asks: its first snapshot holds these
     * jobs' last values and no other's (a job removed while Today was closed
     * shows nothing). Asks nothing; `set` does.
     */
    prime(workspaces: readonly TodayWorkspace[]): void {
      if (started) return;
      order = workspaces.map(keyOf);
      for (const workspace of workspaces) if (!slots.has(keyOf(workspace))) slots.set(keyOf(workspace), slotOf(workspace));
      changed();
    },
    /** The jobs to read and how to ask each. A new job, one never asked, and one whose host's link opened, is asked; one that left is forgotten. */
    set(workspaces: readonly TodayWorkspace[], params: (workspace: TodayWorkspace) => unknown): void {
      closed = false;
      started = true;
      paramsOf = params;
      order = workspaces.map(keyOf);
      const live = new Set(order);
      for (const key of [...slots.keys()]) {
        if (live.has(key)) continue;
        slots.delete(key);
        lastOf.delete(`${method}|${key}`);
      }
      for (const environmentId of [...hosts.keys()]) {
        if (workspaces.some((w) => w.environmentId === environmentId)) continue;
        hosts.get(environmentId)?.();
        hosts.delete(environmentId);
      }
      for (const workspace of workspaces) {
        const key = keyOf(workspace);
        const slot = slots.get(key);
        watch(workspace.environmentId);
        if (!slot) {
          slots.set(key, slotOf(workspace));
          ask(key);
        } else {
          const opened = workspace.open && !slot.workspace.open;
          slot.workspace = workspace;
          if (opened || slot.seq === 0 || slot.dirty) ask(key);
        }
      }
      changed();
    },
    /**
     * Its last reader left: it stops asking. A read kept by a push was current until now; a push or a reopened link
     * from now marks what it names, and the next reader asks those.
     */
    pause(): void {
      listening = false;
      const now = Date.now();
      if (opts.push) for (const slot of slots.values()) if (slot.has && !slot.error && !slot.dirty) slot.at = now;
    },
    /** A reader is back: what is older than FRESH_MS, marked, or failed is asked by the `set` that follows. */
    resume(): void {
      listening = true;
      const now = Date.now();
      for (const slot of slots.values()) if (slot.error || now - slot.at > FRESH_MS) slot.dirty = true;
    },
    /** One host asked again (the Retry on its line). */
    retry(environmentId: string): void {
      askHost(environmentId);
    },
    /** Every job asked again (what it asks for moved: the day turned); an answer to the last ask is dropped. */
    again(): void {
      for (const key of slots.keys()) ask(key);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot(): EachAnswer<T> {
      if (cached) return cached;
      const live = order.map((key) => slots.get(key)).filter((slot): slot is Slot<T> => !!slot);
      const failed = new Map<string, TodayFailure>();
      for (const slot of live) {
        if (!slot.error || !slot.workspace.open || slot.pending || failed.has(slot.workspace.environmentId)) continue;
        const environmentId = slot.workspace.environmentId;
        failed.set(environmentId, { environmentId, error: slot.error, retry: () => askHost(environmentId) });
      }
      // Out: a job that has not answered this read, or whose failed read is asked again (Retry). A fresh value read
      // again on a push is not out: it shows until the new one lands. Before it is handed its jobs, each open job it
      // was primed with is out.
      const out = started ? live.filter((slot) => slot.workspace.open && slot.pending && (!slot.fresh || slot.error !== null)) : live.filter((slot) => slot.workspace.open);
      cached = {
        answers: live.filter((slot) => slot.has).map((slot) => ({ workspace: slot.workspace, value: slot.value as T })),
        loading: !started || out.length > 0,
        failed: [...failed.values()],
        stale: out.length > 0 && out.every((slot) => slot.has),
        away: live.some((slot) => !slot.workspace.open),
      };
      return cached;
    },
    /** Stops listening and forgets what came back; a later `set` starts it again. */
    close(): void {
      closed = true;
      for (const off of hosts.values()) off();
      hosts.clear();
      slots.clear();
      listeners.clear();
    },
  };
}

/**
 * `eachWorkspace` as a hook, for a `TodaySource` whose rows live on hosts:
 * `useEachWorkspace(env, "work.money.owed", (w) => ({ workspaceId: w.workspaceId }), { push: "work.money" })`.
 * `paramsOf` is read at each ask, so it may be written in line.
 */
export function useEachWorkspace<T>(env: TodayEnv, method: string, paramsOf: (workspace: TodayWorkspace) => unknown, opts: EachOptions = {}): EachAnswer<T> {
  const [shared] = useState(() => {
    const made = sharedRead<T>(method, opts);
    // Its first frame shows the jobs there are now, each with its last value: never a job that has since left.
    made.read.prime(env.workspaces);
    return made;
  });
  const read = shared.read;
  const params = useRef(paramsOf);
  params.current = paramsOf;
  // Before `set`: a reader coming back marks what went stale while none listened.
  useEffect(() => {
    if (shared.readers++ === 0) read.resume();
    return () => {
      if (--shared.readers === 0) read.pause();
    };
  }, [shared, read]);
  // A day that turned while none read asks every job once, before `set` would ask the stale ones again.
  useEffect(() => {
    if (shared.asked !== NOT_ASKED && !Object.is(shared.asked, opts.again)) read.again();
    shared.asked = opts.again;
  }, [shared, read, opts.again]);
  useEffect(() => {
    read.set(env.workspaces, (workspace) => params.current(workspace));
  }, [read, env.workspaces]);
  return useSyncExternalStore(read.subscribe, read.snapshot, read.snapshot);
}

/**
 * One read a method for the window, shared by every reader of it: Today's page and the keeper that runs its sources
 * while it is closed read the same slots, so opening or closing the page asks nothing the other already holds. With
 * no reader it keeps its slots and stops asking (`pause`).
 */
type SharedRead<T> = { read: ReturnType<typeof eachWorkspace<T>>; readers: number; asked: unknown };
const NOT_ASKED = Symbol("not asked");
const shared = new Map<string, SharedRead<unknown>>();
function sharedRead<T>(method: string, opts: EachOptions): SharedRead<T> {
  let made = shared.get(method) as SharedRead<T> | undefined;
  if (!made) shared.set(method, (made = { read: eachWorkspace<T>(method, opts), readers: 0, asked: NOT_ASKED } as SharedRead<T>));
  return made;
}

/** Every shared read closed and forgotten (`forgetEach`, a test's or a preview's reset). */
function forgetSharedReads(): void {
  for (const made of shared.values()) made.read.close();
  shared.clear();
}
