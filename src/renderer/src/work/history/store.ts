import { useEffect, useSyncExternalStore } from "react";
import type { HistoryBranch, HistoryCompare, HistoryVersions, HistoryWrite } from "@shared/contract-work-history";
import type { CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The renderer's copy of a document's history (the host's work/history):
 * each answer kept by what was asked, asked once, asked again after an act
 * that changes it. History has no push: an open view asks again when the
 * window comes back to it.
 */

export interface Asked<T> {
  value: T | null;
  error: string | null;
}

export type HistoryBranches = { branches: HistoryBranch[]; names: Record<string, string> };

const EMPTY: Asked<never> = { value: null, error: null };
const entries = new Map<string, Asked<unknown>>();
const listeners = new Map<string, Set<() => void>>();
/** what each key was last asked with, and the generation of that ask: an answer to an older one is dropped */
const asks = new Map<string, { env: string; method: string; params: Record<string, unknown>; gen: number }>();

const sourceKey = (source: CanvasSource): string => JSON.stringify(source);
const keyOf = (env: string, source: CanvasSource, what: string): string => `${env}\u0000${sourceKey(source)}\u0000${what}`;

function put(key: string, next: Asked<unknown>): void {
  entries.set(key, next);
  for (const l of listeners.get(key) ?? []) l();
}

/** Asks the host; while it answers, what was there stays on screen. A newer ask of the same key wins. */
async function ask(env: string, key: string, method: string, params: Record<string, unknown>): Promise<void> {
  const gen = (asks.get(key)?.gen ?? 0) + 1;
  asks.set(key, { env, method, params, gen });
  try {
    const value = await registry.linkOf(env).request(method, params);
    if (asks.get(key)?.gen === gen) put(key, { value, error: null });
  } catch (err) {
    if (asks.get(key)?.gen === gen) put(key, { value: entries.get(key)?.value ?? null, error: err instanceof Error ? err.message : String(err) });
  }
}

function useAsked<T>(env: string, source: CanvasSource, what: string | null, method: string, params: Record<string, unknown>): Asked<T> & { retry(): void } {
  const key = what === null ? null : keyOf(env, source, what);
  const entry = useSyncExternalStore(
    (l) => {
      if (!key) return () => undefined;
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(l);
      return () => set!.delete(l);
    },
    () => (key ? (entries.get(key) as Asked<T> | undefined) : undefined) ?? EMPTY,
  );
  useEffect(() => {
    if (key && !asks.has(key)) void ask(env, key, method, { source, ...params });
    // `params` is named by `what`, which is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ...entry, retry: () => key && void ask(env, key, method, { source, ...params }) };
}

export const useVersions = (env: string, source: CanvasSource) => useAsked<HistoryVersions>(env, source, "versions", "work.history.versions", {});

export const useCompare = (env: string, source: CanvasSource, from: string | null, to: string | null) =>
  useAsked<HistoryCompare>(env, source, from && to ? `compare|${from}|${to}` : null, "work.history.compare", { from, to });

export const useBranches = (env: string, source: CanvasSource) => useAsked<HistoryBranches>(env, source, "branches", "work.history.branches", {});

/** Everything kept for a document is stale after an act: asked again now, the old answer shown until the new one lands. */
export function refreshHistory(env: string, source: CanvasSource): void {
  const prefix = `${env}\u0000${sourceKey(source)}\u0000`;
  for (const [key, last] of [...asks]) {
    if (!key.startsWith(prefix)) continue;
    const what = key.slice(prefix.length);
    // Two versions compared never change; a side that is "live" does.
    if (what.startsWith("compare|") && !what.split("|").includes("live")) continue;
    void ask(last.env, key, last.method, last.params);
  }
}

export interface HistoryActions {
  restore(versionId: string): Promise<HistoryWrite>;
  decide(branchId: string, which: string[] | "all", accept: boolean): Promise<{ left: number }>;
}

export function historyActions(env: string, source: CanvasSource): HistoryActions {
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    try {
      return await registry.linkOf(env).request<T>(method, { source, ...params });
    } finally {
      refreshHistory(env, source);
    }
  };
  return {
    restore: (versionId) => call("work.history.restore", { versionId }),
    decide: (branchId, which, accept) => call("work.history.decide", { branchId, which, accept }),
  };
}

/** For a preview page or a test: an answer as if the host had given it. */
export function seedHistory(env: string, source: CanvasSource, seed: { versions?: HistoryVersions; branches?: HistoryBranches; compares?: Array<[string, string, HistoryCompare]> }): void {
  const seeded = (key: string, method: string, params: Record<string, unknown>, value: unknown) => {
    asks.set(key, { env, method, params: { source, ...params }, gen: 1 });
    put(key, { value, error: null });
  };
  if (seed.versions) seeded(keyOf(env, source, "versions"), "work.history.versions", {}, seed.versions);
  if (seed.branches) seeded(keyOf(env, source, "branches"), "work.history.branches", {}, seed.branches);
  for (const [from, to, value] of seed.compares ?? []) seeded(keyOf(env, source, `compare|${from}|${to}`), "work.history.compare", { from, to }, value);
}
