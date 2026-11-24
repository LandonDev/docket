import { useEffect, useState, useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { errorText, type SectorKey } from "@shared/work";
import type { LifeosJwtAnswer, LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { registry } from "../../lib/connection";
import { linkMay } from "../../lib/linkMay";
import { nameInLine } from "../../lib/hostWords";
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
  /**
   * The host itself did not answer its status ask while its link stayed open (`useLifeosUnanswered`), or its session
   * ask (`work.lifeos.jwt`) ran out of time: the session is down as `unreachable`, never waiting, and its words name the computer ("The box did not answer"), not LifeOS.
   */
  unanswered?: true;
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

/** The JWT ask out for each session, with the generation it was made in: a second opener waits on it, never asks again. */
const opening = new Map<string, { generation: number; done: Promise<void> }>();

/**
 * The session for a host and sector, opened at the first ask while the host is connected to LifeOS. The session's
 * effect and Retry (`reopenLifeos`) can both ask at once: one JWT ask a host, sector and generation answers both, so a
 * second answer that fails later never replaces the client the first made.
 */
function openSession(environmentId: string, sector: SectorKey | null): Promise<void> {
  const key = keyOf(environmentId, sector);
  const generation = generations.get(key) ?? 0;
  const out = opening.get(key);
  if (out?.generation === generation) return out.done;
  const done = askSession(environmentId, sector, key, generation).finally(() => {
    if (opening.get(key)?.done === done) opening.delete(key);
  });
  opening.set(key, { generation, done });
  return done;
}

async function askSession(environmentId: string, sector: SectorKey | null, key: string, generation: number): Promise<void> {
  if (sessions.get(key)?.client) return;
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
    // A failure never takes the place of a client that reads.
    // An ask the host itself did not answer is its silence, said by its name (`unanswered`), the same test the status ask uses.
    if (!stale() && !sessions.get(key)?.client)
      putSession({
        environmentId,
        sector,
        client: null,
        state: "unreachable",
        ...(/^forbidden\b/.test(errorText(err)) ? { withheld: true as const } : isSilence(err) ? { unanswered: true as const } : {}),
      });
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
  // A status ask that went unanswered is no ask still out: the session is down, with the line and Retry every reader
  // already draws for one that did not answer. A later answer (a push, a reopened link, Retry) brings it back.
  const silent = useLifeosUnanswered(environmentId) && !status;
  const state = status?.lifeos.state ?? (silent ? "unreachable" : "connecting");
  const key = keyOf(environmentId, sector);
  useEffect(() => (environmentId ? retain(key) : undefined), [environmentId, key]);
  useEffect(() => {
    if (!environmentId) return;
    const open = sessions.get(key);
    if (state === "connected") {
      // A session that was down reads as on its way while its JWT is asked for: bones, not the old line.
      if (open && !open.client && open.state !== "connected") putSession({ environmentId, sector, client: null, state });
      void openSession(environmentId, sector);
    } else {
      if (open?.client) closeSession(key);
      if (open?.client || open?.state !== state || !!open?.unanswered !== silent) putSession({ environmentId, sector, client: null, state, ...(silent ? { unanswered: true as const } : {}) });
    }
  }, [environmentId, key, sector, state, silent]);
  const session = useSyncExternalStore(
    (fn) => {
      sessionListeners.add(fn);
      return () => void sessionListeners.delete(fn);
    },
    () => sessions.get(key) ?? null,
  );
  return session ?? { environmentId, sector, client: null, state, ...(silent ? { unanswered: true as const } : {}) };
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

/**
 * What a session that cannot read says, in words: a query's error and the frame's line read it. `host` is the name of
 * the computer the session reads through ("The box"), so a state that is the host's names it ("Work is off on the
 * box"); with none it is "this host". `unanswered` is the host's own silence, said by its name.
 */
export function sessionFailure(state: LifeosStateName | "unanswered", withheld?: boolean, host?: string | null): string {
  const at = host ? nameInLine(host) : "this host";
  if (withheld) return `This computer cannot read LifeOS through ${at}`;
  if (state === "unanswered") return `${host ?? "The host"} did not answer`;
  // LifeOS's own silence, signed out and a sign-in that waits name the computer too where it is known; "Not signed in
  // to LifeOS" and "LifeOS did not answer" stay at the head, the words the host's own text and `STATE_WORDS` share.
  if (state === "unreachable") return host ? `LifeOS did not answer ${at}` : "LifeOS did not answer";
  if (state === "refused") return `LifeOS refused ${at}'s sign-in`;
  if (state === "off") return `Work is off on ${at}`;
  if (state === "pairing") return host ? `The LifeOS sign-in on ${at} waits for your approval` : "The LifeOS sign-in waits for your approval";
  return host ? `Not signed in to LifeOS on ${at}` : "Not signed in to LifeOS";
}

/** A host's name as the registry knows it ("The box"), or null for one it does not. */
export const lifeosHostName = (environmentId: string): string | null => (environmentId && registry.environment(environmentId)?.name) || null;

/** What a session that cannot read says, its computer named (`sessionFailure`). */
export function sessionWords(session: Pick<LifeosSession, "environmentId" | "state" | "withheld" | "unanswered">): string {
  return sessionFailure(session.unanswered ? "unanswered" : session.state, session.withheld, lifeosHostName(session.environmentId));
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
  // The old line goes: the session is on its way again, and openSession says what it finds.
  if (sessions.get(key) && !sessions.get(key)!.client) putSession({ environmentId, sector, client: null, state: "connected" });
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
      setResult(waits ? { status: "loading" } : { status: "failed", error: sessionWords(session) });
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
  }, [session.client, session.state, session.withheld, session.unanswered, session.environmentId, waits, name, argsKey]);
  return result;
}

/** Test seam. */
export function resetLifeos(): void {
  for (const off of watched.values()) off();
  watched.clear();
  statuses.clear();
  unanswered.clear();
  opening.clear();
  for (const key of [...sessions.keys()]) closeSession(key);
  for (const timer of closing.values()) clearTimeout(timer);
  closing.clear();
  readers.clear();
}
