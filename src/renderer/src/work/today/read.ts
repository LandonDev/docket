import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registry, type Link } from "../../lib/connection";
import { resetHooks } from "./store";
import type { TodayEnv, TodayFailure, TodayWorkspace } from "./types";

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
};

/** `fresh`: answered in this read's own life; a value it started with is the last one any read had (`lastOf`). */
type Slot<T> = { workspace: TodayWorkspace; value?: T; has: boolean; fresh: boolean; error: string | null; pending: boolean; seq: number };

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

  const changed = (): void => {
    cached = null;
    for (const listener of listeners) listener();
  };

  const ask = (key: string): void => {
    const slot = slots.get(key);
    if (!slot || closed || !slot.workspace.open) return;
    const seq = ++slot.seq;
    slot.pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(TIMED_OUT)), timeoutMs);
    });
    let request: Promise<T>;
    try {
      request = linkOf(slot.workspace.environmentId).request<T>(method, paramsOf(slot.workspace), { timeoutMs, retry: false });
    } catch (err) {
      request = Promise.reject(err);
    }
    Promise.race([request, late])
      .then(
        (value) => {
          if (slots.get(key) !== slot || slot.seq !== seq) return;
          Object.assign(slot, { value, has: true, fresh: true, error: null, pending: false });
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
    for (const [key, slot] of slots) if (slot.workspace.environmentId === environmentId && (!workspaceId || slot.workspace.workspaceId === workspaceId)) ask(key);
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

  return {
    /** The jobs to read and how to ask each. A new job, and one whose host's link opened, is asked; one that left is forgotten. */
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
          const last = `${method}|${key}`;
          slots.set(key, lastOf.has(last) ? { workspace, value: lastOf.get(last) as T, has: true, fresh: false, error: null, pending: false, seq: 0 } : { workspace, has: false, fresh: false, error: null, pending: false, seq: 0 });
          ask(key);
        } else {
          const opened = workspace.open && !slot.workspace.open;
          slot.workspace = workspace;
          if (opened) ask(key);
        }
      }
      changed();
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
      // again on a push is not out: it shows until the new one lands.
      const out = live.filter((slot) => slot.workspace.open && slot.pending && (!slot.fresh || slot.error !== null));
      cached = {
        answers: live.filter((slot) => slot.has).map((slot) => ({ workspace: slot.workspace, value: slot.value as T })),
        loading: !started || out.length > 0,
        failed: [...failed.values()],
        stale: started && out.length > 0 && out.every((slot) => slot.has),
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
  const [read] = useState(() => eachWorkspace<T>(method, opts));
  const params = useRef(paramsOf);
  params.current = paramsOf;
  useEffect(() => {
    read.set(env.workspaces, (workspace) => params.current(workspace));
  }, [read, env.workspaces]);
  useEffect(() => () => read.close(), [read]);
  const asked = useRef(opts.again);
  useEffect(() => {
    if (Object.is(asked.current, opts.again)) return;
    asked.current = opts.again;
    read.again();
  }, [read, opts.again]);
  return useSyncExternalStore(read.subscribe, read.snapshot, read.snapshot);
}
