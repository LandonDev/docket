import { useEffect, useState, useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { errorText, type SectorKey } from "@shared/work";
import type { LifeosJwtAnswer, LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { registry } from "../../lib/connection";
import { linkMay } from "../../lib/linkMay";
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
/** Hosts whose last status ask went unanswered while the status is still unknown: no bones for them, a line with Retry. */
const unanswered = new Set<string>();

function putStatus(environmentId: string, status: LifeosStatus): void {
  statuses.set(environmentId, status);
  unanswered.delete(environmentId);
  for (const listener of statusListeners) listener();
}

function markUnanswered(environmentId: string, on: boolean): void {
  if (unanswered.has(environmentId) === on) return;
  if (on) unanswered.add(environmentId);
  else unanswered.delete(environmentId);
  for (const listener of statusListeners) listener();
}

/** An answer that never came: a wait that ran out, or the link that dropped under the ask. */
const isSilence = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name;
  return name === "ConnectionLostError" || name === "TimeoutError";
};

/** Ask one host for its LifeOS status, and keep it from the push from then on. */
export function watchLifeos(environmentId: string): void {
  if (watched.has(environmentId)) return;
  const link = registry.linkOf(environmentId);
  const ask = (): void => {
    // An ask that is out draws bones again, even after one that went unanswered.
    markUnanswered(environmentId, false);
    link
      .request<LifeosStatus>("work.lifeos.status")
      .then((status) => putStatus(environmentId, status))
      // A host that refused (Work off, or a build from before Work) says so: never "signed out", which asks for a sign-in
      // that cannot help. An ask that went unanswered leaves the status unknown and is marked, so a screen says so
      // with Retry (`useLifeosUnanswered`); the link's next open asks afresh on its own.
      .catch((err: unknown) => {
        if (!isSilence(err)) putStatus(environmentId, { lifeos: { state: "off" }, keys: [] });
        else if (!statuses.has(environmentId)) markUnanswered(environmentId, true);
      });
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
  try {
    putStatus(environmentId, await registry.linkOf(environmentId).request<LifeosStatus>("work.lifeos.status"));
  } catch (err) {
    if (isSilence(err) && !statuses.has(environmentId)) markUnanswered(environmentId, true);
    throw err;
  }
}

/** Whether a host's status is unknown because its last ask went unanswered while its link stayed open: no bones then. */
export function useLifeosUnanswered(environmentId: string | null | undefined): boolean {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    () => (environmentId ? unanswered.has(environmentId) : false),
  );
}

/** A host whose status ask went unanswered, by hand: a test's or a preview's seam. */
export function setLifeosUnanswered(environmentId: string): void {
  watched.set(environmentId, () => {});
  statuses.delete(environmentId);
  markUnanswered(environmentId, true);
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
  /**
   * The host answers, but this window's key is never handed its LifeOS session (a given computer's:
   * `work.lifeos.jwt` is in `DEVICE_REFUSED`). Not silence: Retry cannot help, and the frame says so.
   */
  withheld?: true;
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
  // A key the host never hands its session to is not asked: the answer is a refusal, which is not silence.
  if (!linkMay(environmentId, "work.lifeos.jwt")) {
    putSession({ environmentId, sector, client: null, state: "unreachable", withheld: true });
    return;
  }
  let first: LifeosJwtAnswer;
  try {
    first = await jwtOf(environmentId, sector);
  } catch (err) {
    if (!stale()) putSession({ environmentId, sector, client: null, state: "unreachable", ...(/^forbidden\b/.test(errorText(err)) ? { withheld: true as const } : {}) });
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

/**
 * Whether a session with no client is still on its way (the host is
 * connecting, or connected and its first JWT is out), so a screen draws its
 * bones. Any other state is a failure the view frame's line or its sign-in
 * says, and a screen draws nothing under it, never bones that pulse for ever.
 */
export function sessionWaits(session: Pick<LifeosSession, "client" | "state">): boolean {
  return !session.client && (session.state === "connecting" || session.state === "connected");
}

/** What a session that cannot read says, in words: a query's error and the frame's line read it. */
export function sessionFailure(state: LifeosStateName, withheld?: boolean): string {
  if (withheld) return "This computer cannot read LifeOS through this host";
  if (state === "unreachable") return "LifeOS did not answer";
  if (state === "refused") return "LifeOS refused this host's sign-in";
  if (state === "off") return "Work is off on this host";
  if (state === "pairing") return "The LifeOS sign-in waits for your approval";
  return "Not signed in to LifeOS";
}

/**
 * The LifeOS state a host's failure text names, or null for any other cause: the host's own sentences for a LifeOS it
 * could not ask (`UNAVAILABLE_WORDS` in src/main/server/work/lifeos/session.ts) and an answer that never came. A host
 * that sends such a reason inside an answer (Waiting on's days) is worded by `sessionFailure` from it, never verbatim.
 */
export function lifeosStateOf(reason: string): LifeosStateName | null {
  for (const [form, state] of STATE_WORDS) if (form.test(reason)) return state;
  return null;
}

const STATE_WORDS: [RegExp, LifeosStateName][] = [
  [/work is off on this host/i, "off"],
  [/not signed in to lifeos/i, "signed-out"],
  [/lifeos sign-in waits for approval/i, "pairing"],
  [/lifeos is still connecting/i, "connecting"],
  [/lifeos refused this host's sign-in/i, "refused"],
  [/lifeos is unreachable|\btimed out\b|^timeout\b|no answer in \d|fetch failed|\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/i, "unreachable"],
];

/**
 * Retry on the view frame's line: the host's status asked afresh, then, if
 * it says connected, the session's JWT asked again. The JWT can fail while
 * the host says connected, and a status that did not change starts nothing.
 */
export async function reopenLifeos(environmentId: string, sector: SectorKey | null): Promise<void> {
  await refreshLifeos(environmentId);
  if (statuses.get(environmentId)?.lifeos.state !== "connected") return;
  const key = keyOf(environmentId, sector);
  const was = sessions.get(key);
  if (was && !was.client) putSession({ ...was, state: "connected" });
  await openSession(environmentId, sector);
}

/** A session by hand: a test's or a preview's seam. */
export function setLifeosSession(session: LifeosSession): void {
  putSession(session);
}

/** What a live query has: its rows, still loading, or the error LifeOS gave. */
export type LifeosQuery<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: string };

/** A live query as the session's owner, `name` as LifeOS names it (`projects:list`). Loading only while the session is on its way; a session that cannot read fails the query. */
export function useLifeosQuery<T>(session: LifeosSession, name: string, args: Record<string, unknown>): LifeosQuery<T> {
  const argsKey = JSON.stringify(args);
  const [result, setResult] = useState<LifeosQuery<T>>({ status: "loading" });
  const waits = sessionWaits(session);
  useEffect(() => {
    const client = session.client;
    if (!client) {
      setResult(waits ? { status: "loading" } : { status: "failed", error: sessionFailure(session.state, session.withheld) });
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
  }, [session.client, session.state, waits, name, argsKey]);
  return result;
}

/** Test seam. */
export function resetLifeos(): void {
  for (const off of watched.values()) off();
  watched.clear();
  statuses.clear();
  unanswered.clear();
  for (const key of [...sessions.keys()]) closeSession(key);
  for (const timer of closing.values()) clearTimeout(timer);
  closing.clear();
  readers.clear();
}
