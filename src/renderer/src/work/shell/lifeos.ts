import { useEffect, useState, useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { SectorKey } from "@shared/work";
import type { LifeosJwtAnswer, LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { registry } from "../../lib/connection";
import { workSwitch } from "../../lib/workSwitch";

/**
 * Work's screens and LifeOS (docs/agents/work-lifeos.md "The states a
 * screen must draw"): each host's LifeOS status, from `work.lifeos.status`
 * and kept by the `work.lifeos` push, and one LifeOS session per host and
 * sector, a Convex client of the screen's own fed JWTs by
 * `work.lifeos.jwt` (approve). A workspace's views read through a session
 * narrowed to its sector, so they can show no other's rows. The device
 * token never reaches this window.
 */

type Listener = () => void;

// ── status ─────────────────────────────────────────────────────────────

const statuses = new Map<string, LifeosStatus>();
const statusListeners = new Set<Listener>();
const watched = new Map<string, () => void>();

function putStatus(environmentId: string, status: LifeosStatus): void {
  statuses.set(environmentId, status);
  for (const listener of statusListeners) listener();
}

/** Ask one host for its LifeOS status, and keep it from the push from then on. */
export function watchLifeos(environmentId: string): void {
  if (watched.has(environmentId)) return;
  const link = registry.linkOf(environmentId);
  const ask = (): void => {
    link
      .request<LifeosStatus>("work.lifeos.status")
      .then((status) => putStatus(environmentId, status))
      // Off, or a host from before Work: it draws as signed out until it answers.
      .catch(() => putStatus(environmentId, { lifeos: { state: "signed-out" }, keys: [] }));
  };
  const offPush = link.onPush((push) => {
    if (push.push === "work.lifeos") putStatus(environmentId, push.status);
  });
  const offOpen = link.onOpen(ask);
  if (link.connected) ask();
  watched.set(environmentId, () => {
    offPush();
    offOpen();
  });
}

/** Ask one host for its LifeOS status now (Retry on "LifeOS did not answer"); rejects when the host does not answer. */
export async function refreshLifeos(environmentId: string): Promise<void> {
  watchLifeos(environmentId);
  putStatus(environmentId, await registry.linkOf(environmentId).request<LifeosStatus>("work.lifeos.status"));
}

/** A host's LifeOS status; null until it answers. */
export function useLifeosStatus(environmentId: string | null | undefined): LifeosStatus | null {
  useEffect(() => {
    if (environmentId) watchLifeos(environmentId);
  }, [environmentId]);
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    () => (environmentId ? (statuses.get(environmentId) ?? null) : null),
  );
}

/** One host's status by hand: a test's or a preview's seam. */
export function setLifeosStatus(environmentId: string, status: LifeosStatus): void {
  watched.set(environmentId, () => {});
  putStatus(environmentId, status);
}

// ── sessions ───────────────────────────────────────────────────────────

/** A screen's way into LifeOS for one sector (or all, for a Work Chat's screens and the add menu). */
export interface LifeosSession {
  environmentId: string;
  sector: SectorKey | null;
  /** The Convex client; null until the first JWT names the address. */
  client: ConvexReactClient | null;
  /** Why there is no client yet, or `connected`. */
  state: LifeosStateName;
}

const sessions = new Map<string, LifeosSession>();
const sessionListeners = new Set<Listener>();
const keyOf = (environmentId: string, sector: SectorKey | null): string => `${environmentId}|${sector ?? "*"}`;
/** Screens reading each session; at none it closes a moment later. */
const readers = new Map<string, number>();
const closing = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped by every close: an answer that comes back after one is dropped. */
const generations = new Map<string, number>();
const CLOSE_AFTER_MS = 5_000;

function putSession(next: LifeosSession): void {
  sessions.set(keyOf(next.environmentId, next.sector), next);
  for (const listener of sessionListeners) listener();
}

/** Closes a session's client and forgets it; the next screen that asks opens it again. */
function closeSession(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  const open = sessions.get(key);
  if (!open) return;
  sessions.delete(key);
  void open.client?.close();
  for (const listener of sessionListeners) listener();
}

function retain(key: string): () => void {
  clearTimeout(closing.get(key));
  closing.delete(key);
  readers.set(key, (readers.get(key) ?? 0) + 1);
  return () => {
    const left = (readers.get(key) ?? 1) - 1;
    readers.set(key, left);
    if (left > 0) return;
    readers.delete(key);
    closing.set(
      key,
      setTimeout(() => {
        closing.delete(key);
        if (!readers.get(key)) closeSession(key);
      }, CLOSE_AFTER_MS),
    );
  };
}

// Work off on every host: no client of this window stays open to LifeOS.
workSwitch.subscribe(() => {
  if (!workSwitch.anyOn()) for (const key of [...sessions.keys()]) closeSession(key);
});

const jwtOf = (environmentId: string, sector: SectorKey | null): Promise<LifeosJwtAnswer> =>
  registry.linkOf(environmentId).request<LifeosJwtAnswer>("work.lifeos.jwt", sector ? { sector } : {});

/** The session for a host and sector, opened at the first ask while the host is connected to LifeOS. */
async function openSession(environmentId: string, sector: SectorKey | null): Promise<void> {
  const key = keyOf(environmentId, sector);
  if (sessions.get(key)?.client) return;
  const generation = generations.get(key) ?? 0;
  // A close (a sign-out, Work off, the last screen gone) while the JWT was asked for wins over its answer.
  const stale = (): boolean => (generations.get(key) ?? 0) !== generation || statuses.get(environmentId)?.lifeos.state !== "connected";
  let first: LifeosJwtAnswer;
  try {
    first = await jwtOf(environmentId, sector);
  } catch {
    if (!stale()) putSession({ environmentId, sector, client: null, state: "unreachable" });
    return;
  }
  if (stale() || sessions.get(key)?.client) return;
  if (!first.ok) {
    putSession({ environmentId, sector, client: null, state: first.state });
    return;
  }
  const client = new ConvexReactClient(first.url, { skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false, logger: false });
  let handed: string | null = first.jwt;
  // The host keeps a JWT until two minutes before its end, so asking again is cheap and always fresh enough.
  client.setAuth(async () => {
    if (handed) {
      const jwt = handed;
      handed = null;
      return jwt;
    }
    const answer = await jwtOf(environmentId, sector).catch(() => null);
    return answer?.ok ? answer.jwt : null;
  });
  putSession({ environmentId, sector, client, state: "connected" });
}

/** The LifeOS session a screen reads through; opened once the host says it is connected, closed when it is not, and soon after the last screen that read it goes. */
export function useLifeosSession(environmentId: string, sector: SectorKey | null): LifeosSession {
  const status = useLifeosStatus(environmentId);
  const state = status?.lifeos.state ?? "connecting";
  const key = keyOf(environmentId, sector);
  useEffect(() => (environmentId ? retain(key) : undefined), [environmentId, key]);
  useEffect(() => {
    if (!environmentId) return;
    if (state === "connected") void openSession(environmentId, sector);
    else {
      const open = sessions.get(key);
      if (open?.client) closeSession(key);
      if (open?.client || open?.state !== state) putSession({ environmentId, sector, client: null, state });
    }
  }, [environmentId, key, sector, state]);
  const session = useSyncExternalStore(
    (fn) => {
      sessionListeners.add(fn);
      return () => void sessionListeners.delete(fn);
    },
    () => sessions.get(key) ?? null,
  );
  return session ?? { environmentId, sector, client: null, state };
}

/** A session by hand: a test's or a preview's seam. */
export function setLifeosSession(session: LifeosSession): void {
  putSession(session);
}

/** What a live query has: its rows, still loading, or the error LifeOS gave. */
export type LifeosQuery<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: string };

/** A live query as the session's owner, `name` as LifeOS names it (`projects:list`). */
export function useLifeosQuery<T>(session: LifeosSession, name: string, args: Record<string, unknown>): LifeosQuery<T> {
  const argsKey = JSON.stringify(args);
  const [result, setResult] = useState<LifeosQuery<T>>({ status: "loading" });
  useEffect(() => {
    const client = session.client;
    if (!client) {
      setResult({ status: "loading" });
      return;
    }
    const watch = client.watchQuery(makeFunctionReference<"query">(name), JSON.parse(argsKey) as Record<string, unknown>);
    const read = (): void => {
      try {
        const value = watch.localQueryResult();
        setResult(value === undefined ? { status: "loading" } : { status: "ready", value: value as T });
      } catch (error) {
        setResult({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    };
    read();
    return watch.onUpdate(read);
  }, [session.client, name, argsKey]);
  return result;
}

/** Test seam. */
export function resetLifeos(): void {
  for (const off of watched.values()) off();
  watched.clear();
  statuses.clear();
  for (const key of [...sessions.keys()]) closeSession(key);
  for (const timer of closing.values()) clearTimeout(timer);
  closing.clear();
  readers.clear();
}
