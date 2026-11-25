import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { errorText, type SectorKey } from "@shared/work";
import type { LifeosJwtAnswer, LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { registry } from "../../lib/connection";
import { linkMay } from "../../lib/linkMay";
import { connectingWords, lifeosDownWords } from "./lifeosWords";
import { workSwitch } from "../../lib/workSwitch";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { onWorkReopen } from "../reopenLane";

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
  rememberConnected(environmentId, status.lifeos.state === "connected");
  // Signed out, refused, Work off, LifeOS unreachable: no session of the host stays open, kept or read, and no row it
  // read stays kept. "connecting" is LifeOS on its way back at the host, which leaves both as they are.
  if (status.lifeos.state !== "connected" && status.lifeos.state !== "connecting") {
    for (const key of [...sessions.keys()]) if (key.startsWith(`${environmentId}|`) && sessions.get(key)?.client) closeSession(key);
    dropKept(`${environmentId}|`);
  }
  for (const listener of statusListeners) listener();
}

// ── the last status, across launches ─────────────────────────────────────

/**
 * The hosts whose last status said connected, kept across launches, so a launch asks for a session's JWT at once, side
 * by side with the status ask, rather than after its answer (one round trip to the host, not two). The JWT's own answer
 * says the state when it is not ok, and a status that says otherwise closes what it opened.
 */
const CONNECTED_KEY = "work.lifeos.connected.v1";
let connectedHosts: Set<string> | null = null;

function lastConnected(environmentId: string): boolean {
  if (!connectedHosts) {
    try {
      const parsed = JSON.parse(globalThis.localStorage?.getItem(CONNECTED_KEY) ?? "[]") as unknown;
      connectedHosts = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    } catch {
      connectedHosts = new Set();
    }
  }
  return connectedHosts.has(environmentId);
}

function rememberConnected(environmentId: string, on: boolean): void {
  if (lastConnected(environmentId) === on) return;
  if (on) connectedHosts!.add(environmentId);
  else connectedHosts!.delete(environmentId);
  try {
    globalThis.localStorage?.setItem(CONNECTED_KEY, JSON.stringify([...connectedHosts!]));
  } catch {
    // unstored: the next launch asks the status first
  }
}

/** The state a session opens by: the host's status, else connected while its last status in any launch was. */
const openState = (environmentId: string): LifeosStateName | undefined => statuses.get(environmentId)?.lifeos.state ?? (lastConnected(environmentId) ? "connected" : undefined);

function markUnanswered(environmentId: string, on: boolean): void {
  if (unanswered.has(environmentId) === on) return;
  if (on) unanswered.add(environmentId);
  else unanswered.delete(environmentId);
  for (const listener of statusListeners) listener();
}

/** An answer that never came: a wait that ran out, or the link that dropped under the ask (by its name, or the link's words). */
export const isSilence = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name;
  return name === "ConnectionLostError" || name === "TimeoutError" || /^no answer in \d/i.test((err as { message?: string } | null)?.message ?? "");
};

/** Ask one host for its LifeOS status, and keep it from the push from then on. */
export function watchLifeos(environmentId: string): void {
  if (watched.has(environmentId)) return;
  const link = registry.linkOf(environmentId);
  const ask = (): Promise<void> => {
    // An ask that is out draws bones again, even after one that went unanswered.
    markUnanswered(environmentId, false);
    return link
      .request<LifeosStatus>("work.lifeos.status")
      .then((status) => putStatus(environmentId, status))
      // A host that refused (Work off, or a build from before Work) says so: never "signed out", which asks for a
      // sign-in that cannot help.
      .catch((err: unknown) => (isSilence(err) ? unansweredAsk(environmentId, err) : putStatus(environmentId, { lifeos: { state: "off" }, keys: [] })));
  };
  const offPush = link.onPush((push) => {
    if (push.push === "work.lifeos") putStatus(environmentId, push.status);
  });
  // After a reconnect the status waits its turn behind the view on screen (work/reopenLane.ts).
  const offOpen = onWorkReopen(link, ask);
  if (link.connected) void ask();
  watched.set(environmentId, () => {
    offPush();
    offOpen();
  });
}

/**
 * A status ask that went unanswered marks the host (`useLifeosUnanswered`), so a screen says the host's silence with
 * Retry, even over a status it answered before: that status is no longer known to be true, and a down session says the
 * newest cause, never the cached one. Its next answer or push clears the mark; the link's next open asks afresh.
 */
function unansweredAsk(environmentId: string, err: unknown): void {
  if (isSilence(err)) markUnanswered(environmentId, true);
}

/** Ask one host for its LifeOS status now (Retry on "LifeOS did not answer"); rejects when the host does not answer. */
export async function refreshLifeos(environmentId: string): Promise<void> {
  watchLifeos(environmentId);
  try {
    putStatus(environmentId, await registry.linkOf(environmentId).request<LifeosStatus>("work.lifeos.status"));
  } catch (err) {
    unansweredAsk(environmentId, err);
    throw err;
  }
}

/** Whether a host's last status ask went unanswered while its link stayed open (no bones then), until its next answer or push. */
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
  return useLifeosStatusHeard(environmentId);
}

/** A host's LifeOS status as this window last heard it, asking nothing itself (the rail watches every Work host). */
export function useLifeosStatusHeard(environmentId: string | null | undefined): LifeosStatus | null {
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
/** Screens reading each session; at none it is kept open, idle, until IDLE_CLOSE_MS pass or a newer session needs its place. */
const readers = new Map<string, number>();
const closing = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped by every close: an answer that comes back after one is dropped. */
const generations = new Map<string, number>();
/**
 * A job he returns to finds its session open (docs/agents/work-lifeos.md "Sessions kept"): one left by its last reader
 * closes after 15 idle minutes, and at most KEEP_AT_MOST sessions with a client stay open, the least recently read
 * without a reader closed first. A session a screen reads is never closed for room.
 */
const IDLE_CLOSE_MS = 15 * 60_000;
const KEEP_AT_MOST = 8;
/** Sessions by when a screen last took or left one, oldest first. */
const touched = new Map<string, true>();
/** The column's live queries each open session holds subscribed while it is open, so they read at once on a return. */
const holds = new Map<string, Map<string, () => void>>();
const HOLDS_AT_MOST = 8;

function touch(key: string): void {
  touched.delete(key);
  touched.set(key, true);
}

function putSession(next: LifeosSession): void {
  const key = keyOf(next.environmentId, next.sector);
  const was = sessions.get(key);
  sessions.set(key, next);
  // A session gone down (signed out, refused, unreachable, withheld): the rows it read are no longer kept.
  if (!next.client && !sessionWaits(next)) dropKept(`${key}|`);
  if (next.client && !was?.client) {
    touch(key);
    if (!readers.get(key)) armIdle(key);
    makeRoom();
  }
  for (const listener of sessionListeners) listener();
}

/** Closes a session's client and forgets it; the next screen that asks opens it again. */
function closeSession(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  clearTimeout(closing.get(key));
  closing.delete(key);
  for (const off of holds.get(key)?.values() ?? []) off();
  holds.delete(key);
  touched.delete(key);
  const open = sessions.get(key);
  if (!open) return;
  sessions.delete(key);
  void open.client?.close();
  for (const listener of sessionListeners) listener();
}

/** Over KEEP_AT_MOST open sessions: the least recently read ones no screen reads now are closed. */
function makeRoom(): void {
  let open = [...sessions.values()].filter((s) => s.client).length;
  for (const key of [...touched.keys()]) {
    if (open <= KEEP_AT_MOST) return;
    if (readers.get(key) || !sessions.get(key)?.client) continue;
    closeSession(key);
    open--;
  }
}

function armIdle(key: string): void {
  clearTimeout(closing.get(key));
  closing.set(
    key,
    setTimeout(() => {
      closing.delete(key);
      if (!readers.get(key)) closeSession(key);
    }, IDLE_CLOSE_MS),
  );
}

function retain(key: string): () => void {
  clearTimeout(closing.get(key));
  closing.delete(key);
  readers.set(key, (readers.get(key) ?? 0) + 1);
  touch(key);
  return () => {
    const left = (readers.get(key) ?? 1) - 1;
    readers.set(key, left);
    if (left > 0) return;
    readers.delete(key);
    touch(key);
    armIdle(key);
  };
}

// Work off on a host: no client of this window stays open to LifeOS through it, a JWT still out for it makes none
// (its key's generation moves on), and no row read through it stays kept, whatever other host has Work on.
workSwitch.subscribe(() => {
  const on = workSwitch.hosts();
  const off = (key: string): boolean => !on.has(key.slice(0, key.indexOf("|")));
  for (const key of new Set([...sessions.keys(), ...opening.keys()])) if (off(key)) closeSession(key);
  for (const key of keptSessions()) if (off(key)) dropKept(`${key}|`);
});

/**
 * The loaded catalog's Work workspaces (ReturnHost calls it on each change): a workspace removed, or linked to another
 * sector, closes its sector's idle session and drops its rows. The all-sector session of a host goes with the host's
 * last Work workspace.
 */
export function keepLifeosOf(workspaces: readonly Pick<WorkspaceMeta, "environmentId" | "kind" | "sector">[]): void {
  const live = new Set<string>();
  for (const w of workspaces) {
    if (w.kind !== "work") continue;
    live.add(keyOf(w.environmentId, null));
    if (w.sector) live.add(keyOf(w.environmentId, w.sector as SectorKey));
  }
  const gone = new Set<string>();
  for (const key of [...sessions.keys(), ...keptSessions()]) if (!live.has(key)) gone.add(key);
  for (const key of gone) {
    if (!readers.get(key)) closeSession(key);
    dropKept(`${key}|`);
  }
}

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
  const stale = (): boolean => (generations.get(key) ?? 0) !== generation || openState(environmentId) !== "connected";
  // A key the host never hands its session to is not asked: the answer is a refusal, which is not silence.
  if (!linkMay(environmentId, "work.lifeos.jwt")) {
    putSession({ environmentId, sector, client: null, state: "unreachable", withheld: true });
    return;
  }
  // A launch's ask, made on the last status before this launch's is known, waits for the host's socket: the JWT then
  // goes beside the status ask, never behind it.
  if (!statuses.has(environmentId)) {
    const link = registry.linkOf(environmentId);
    if (!link.connected)
      await new Promise<void>((resolve) => {
        const off = link.onOpen(() => {
          off();
          resolve();
        });
      });
    if (stale() || sessions.get(key)?.client) return;
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
  // already draws for one that did not answer, over a cached failure too (a Retry the host did not answer says the host's
  // silence, not LifeOS's). A session that reads goes on reading: its client talks to LifeOS, not the host. A later answer
  // (a push, a reopened link, Retry) brings it back.
  const silent = useLifeosUnanswered(environmentId) && status?.lifeos.state !== "connected";
  const state = silent ? "unreachable" : (status?.lifeos.state ?? "connecting");
  // Before this launch's status answers, a host whose last status said connected is asked for its JWT at once.
  const ahead = !status && !silent && !!environmentId && lastConnected(environmentId);
  const key = keyOf(environmentId, sector);
  useEffect(() => (environmentId ? retain(key) : undefined), [environmentId, key]);
  useEffect(() => {
    if (!environmentId) return;
    const open = sessions.get(key);
    if (ahead) {
      void openSession(environmentId, sector);
    } else if (state === "connected") {
      // A computer kept from the session stays so: asking again is a refusal again.
      if (open?.withheld) return;
      // A session that was down reads as on its way while its JWT is asked for: bones, not the old line. Every fresh
      // answer or push that says connected asks again for a session that is down (its JWT failed, or the host went
      // silent under a Retry), so its line goes the moment the host answers, with no press; one that reads asks nothing.
      if (open && !open.client && (open.state !== "connected" || open.unanswered)) putSession({ environmentId, sector, client: null, state });
      void openSession(environmentId, sector);
    } else {
      if (open?.client) closeSession(key);
      if (open?.client || open?.state !== state || !!open?.unanswered !== silent) putSession({ environmentId, sector, client: null, state, ...(silent ? { unanswered: true as const } : {}) });
    }
    // `status` itself, not only its state: a fresh answer of the same state is the host back.
  }, [environmentId, key, sector, state, silent, ahead, status]);
  const session = useSyncExternalStore(
    (fn) => {
      sessionListeners.add(fn);
      return () => void sessionListeners.delete(fn);
    },
    () => sessions.get(key) ?? null,
  );
  // One object while nothing changes, so a reader that memoises on the session (Messages' live data) keeps its value.
  const fallback = useMemo<LifeosSession>(() => ({ environmentId, sector, client: null, state, ...(silent ? { unanswered: true as const } : {}) }), [environmentId, sector, state, silent]);
  return session ?? fallback;
}

/**
 * Starts a workspace's session ahead of its screens: a launch that comes back on a Work view (work/shell/ReturnHost.tsx)
 * asks for it beside the view's chunk, before the view mounts. Opened with no reader, it is kept as any other is.
 */
export function startLifeosSession(environmentId: string, sector: SectorKey | null): void {
  // A host this window does not hold (yet) is left to the view's own session, which waits for it.
  if (!environmentId || !registry.has(environmentId)) return;
  watchLifeos(environmentId);
  if (openState(environmentId) === "connected") void openSession(environmentId, sector);
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
 * box"); with none it is "this host". `unanswered` is the host's own silence, said by its name. The words themselves
 * are lifeosWords.ts's, which the capture window reads with no Convex client.
 */
export const sessionFailure = lifeosDownWords;

/** A host's name as the registry knows it ("The box"), or null for one it does not. */
export const lifeosHostName = (environmentId: string): string | null => (environmentId && registry.environment(environmentId)?.name) || null;

/**
 * Why a host could not search or read its LifeOS for a reader that only knows it failed (the composer's @, a play's
 * picker), in the rule's words from the state this window last heard of that host, its computer named: the host's own
 * silence, "LifeOS is still connecting", a state that is down, or, for a host that says connected (or nothing yet),
 * LifeOS's silence. Read once, asking nothing.
 */
export function lifeosHeardWords(environmentId: string): string {
  const host = lifeosHostName(environmentId);
  if (unanswered.has(environmentId)) return sessionFailure("unanswered", false, host);
  const state = statuses.get(environmentId)?.lifeos.state;
  if (state === "connecting") return connectingWords(host);
  return sessionFailure(!state || state === "connected" ? "unreachable" : state, false, host);
}

/** What a session that cannot read says, its computer named (`sessionFailure`). */
export function sessionWords(session: Pick<LifeosSession, "environmentId" | "state" | "withheld" | "unanswered">): string {
  return sessionFailure(session.unanswered ? "unanswered" : session.state, session.withheld, lifeosHostName(session.environmentId));
}

/** The LifeOS state a host's failure text names (lifeosWords.ts, where the words live). */
export { lifeosStateOf } from "./lifeosWords";

/**
 * Retry on the view frame's line: the host's status asked afresh, then, if
 * it says connected, the session's JWT asked again. The JWT can fail while
 * the host says connected, and a status that did not change starts nothing.
 */
export async function reopenLifeos(environmentId: string, sector: SectorKey | null): Promise<void> {
  const key = keyOf(environmentId, sector);
  try {
    await refreshLifeos(environmentId);
  } catch (err) {
    // The host did not answer the Retry: a session that is down says so now, in place of the cause it gave before, until
    // the host's next answer or push (which asks for the session again).
    const open = sessions.get(key);
    if (isSilence(err) && open && !open.client && !open.withheld && !open.unanswered) putSession({ ...open, unanswered: true });
    throw err;
  }
  if (statuses.get(environmentId)?.lifeos.state !== "connected") return;
  // The old line goes: the session is on its way again, and openSession says what it finds.
  if (sessions.get(key) && !sessions.get(key)!.client) putSession({ environmentId, sector, client: null, state: "connected" });
  await openSession(environmentId, sector);
}

/** A session by hand: a test's or a preview's seam. */
export function setLifeosSession(session: LifeosSession): void {
  putSession(session);
}

/**
 * What a live query has: its rows, still loading, or the error LifeOS gave. `kept` marks rows from the last-value cache,
 * painted while the live answer is on its way; the region they stand in is `aria-busy` until it lands (`useKeptRegion`).
 */
export type LifeosQuery<T> = { status: "loading" } | { status: "ready"; value: T; kept?: true } | { status: "failed"; error: string };

// ── rows kept ──────────────────────────────────────────────────────────

/**
 * The last value each live query read, keyed `host|sector|name|args`, in this window's memory alone: a query that
 * mounts again paints it while its live answer comes back (docs/agents/work-lifeos.md "Rows kept"). Reads only, never
 * a send. At most KEPT_AT_MOST entries, the least recently read dropped first; dropped with a host's sign-out or any
 * other state that is down, a session gone down, Work off, and a workspace removed.
 */
const kept = new Map<string, unknown>();
const KEPT_AT_MOST = 64;
const keptListeners = new Set<Listener>();

function remember(cacheKey: string, value: unknown): void {
  if (kept.get(cacheKey) === value) return;
  kept.delete(cacheKey);
  kept.set(cacheKey, value);
  while (kept.size > KEPT_AT_MOST) kept.delete(kept.keys().next().value!);
}

/** Drops every kept row whose key starts with `prefix` ("" for all). */
function dropKept(prefix: string): void {
  let dropped = false;
  for (const cacheKey of [...kept.keys()])
    if (cacheKey.startsWith(prefix)) {
      kept.delete(cacheKey);
      dropped = true;
    }
  if (dropped) for (const listener of keptListeners) listener();
}

/** The sessions (`host|sector`) that have rows kept. */
function keptSessions(): string[] {
  return [...new Set([...kept.keys()].map((cacheKey) => cacheKey.split("|", 2).join("|")))];
}

/** Holds a live query subscribed on its session while the session is open; the newest HOLDS_AT_MOST a session. */
function holdQuery(sessionKey: string, cacheKey: string, watch: ReturnType<ConvexReactClient["watchQuery"]>): void {
  const held = holds.get(sessionKey) ?? new Map<string, () => void>();
  holds.set(sessionKey, held);
  if (held.has(cacheKey)) return;
  held.set(
    cacheKey,
    watch.onUpdate(() => {
      try {
        const value = watch.localQueryResult();
        if (value !== undefined) remember(cacheKey, value);
      } catch {
        // the reader says the error
      }
    }),
  );
  if (held.size > HOLDS_AT_MOST) {
    const [oldest, off] = held.entries().next().value!;
    off();
    held.delete(oldest);
  }
}

/** A region of kept rows: its readers report a kept paint, and the region reads busy until each is live. */
type KeptScope = { add(): () => void; busy(): boolean; subscribe(fn: Listener): () => void };
const KeptScopeContext = createContext<KeptScope | null>(null);
export const KeptRegion = KeptScopeContext.Provider;

function keptScope(): KeptScope {
  let count = 0;
  const listeners = new Set<Listener>();
  const say = (): void => {
    for (const fn of listeners) fn();
  };
  return {
    add() {
      count++;
      say();
      return () => {
        count--;
        say();
      };
    },
    busy: () => count > 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/**
 * A reader outside LifeOS (Money's kept read) tells the region around it that it paints a kept answer while its live
 * one is out: the region reads `aria-busy` until it lands. Reported in a layout effect, so in the frame it first paints.
 */
export function useKeptPaint(keptPaint: boolean): void {
  const scope = useContext(KeptScopeContext);
  useLayoutEffect(() => (keptPaint && scope ? scope.add() : undefined), [keptPaint, scope]);
}

/** A region's scope for `KeptRegion`, and whether a reader inside it still paints kept rows (its `aria-busy`). */
export function useKeptRegion(): { scope: KeptScope; busy: boolean } {
  const [scope] = useState(keptScope);
  const busy = useSyncExternalStore(scope.subscribe, scope.busy, scope.busy);
  return { scope, busy };
}

const LOADING = { status: "loading" } as const;

/**
 * One reader of one query on one client: what it reads now (the live result, else the kept one, else loading), one
 * object for as long as that does not change.
 */
function queryReader<T>(client: ConvexReactClient | null, name: string, argsKey: string, cacheKey: string | null, failure: string | null, holdOn: string | null) {
  const watch = client && failure === null ? client.watchQuery(makeFunctionReference<"query">(name), JSON.parse(argsKey) as Record<string, unknown>) : null;
  let last: LifeosQuery<T> = LOADING;
  const same = (next: LifeosQuery<T>): LifeosQuery<T> => {
    if (next.status === last.status) {
      if (next.status === "loading") return last;
      if (next.status === "failed" && last.status === "failed" && next.error === last.error) return last;
      if (next.status === "ready" && last.status === "ready" && next.value === last.value && next.kept === last.kept) return last;
    }
    return (last = next);
  };
  // Read again only after the client said something changed (or on subscribing): one snapshot between updates, even
  // from a client that hands a new object on every read.
  let dirty = true;
  const keptOr = (): LifeosQuery<T> => (cacheKey && kept.has(cacheKey) ? same({ status: "ready", value: kept.get(cacheKey) as T, kept: true }) : same(LOADING));
  return {
    get(): LifeosQuery<T> {
      if (failure !== null) return same({ status: "failed", error: failure });
      if (!watch) return keptOr();
      if (!dirty) return last;
      dirty = false;
      let value: unknown;
      try {
        value = watch.localQueryResult();
      } catch (error) {
        return same({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
      if (value === undefined) return keptOr();
      if (cacheKey) remember(cacheKey, value);
      return same({ status: "ready", value: value as T });
    },
    subscribe(fn: Listener): () => void {
      const changed = (): void => {
        dirty = true;
        fn();
      };
      keptListeners.add(changed);
      dirty = true;
      if (!watch) return () => void keptListeners.delete(changed);
      // A hold is taken only on the session's own client: one a close already replaced holds nothing.
      if (holdOn && cacheKey && sessions.get(holdOn)?.client === client) holdQuery(holdOn, cacheKey, watch);
      const off = watch.onUpdate(changed);
      return () => {
        keptListeners.delete(changed);
        off();
      };
    },
  };
}

/** The option a column reader passes: its query held on its session while the session is open. */
export const HOLD = { hold: true } as const;

/**
 * A live query as the session's owner, `name` as LifeOS names it (`projects:list`). Read in the first render: a result
 * another reader holds paints at once, and else the last value this window read of it (`kept`) until the live answer
 * lands. Loading only while the session is on its way with nothing kept; a session that cannot read fails the query.
 * `hold` keeps the query subscribed on its session while the session is open (the column's facts and projects), so a
 * return reads it live at once.
 */
export function useLifeosQuery<T>(session: LifeosSession, name: string, args: Record<string, unknown>, options?: { hold?: boolean }): LifeosQuery<T> {
  const argsKey = JSON.stringify(args);
  const client = session.client;
  const failure = client || sessionWaits(session) ? null : sessionWords(session);
  const sessionKey = session.environmentId ? keyOf(session.environmentId, session.sector) : null;
  const cacheKey = sessionKey ? `${sessionKey}|${name}|${argsKey}` : null;
  const holdOn = options?.hold ? sessionKey : null;
  const reader = useMemo(() => queryReader<T>(client, name, argsKey, cacheKey, failure, holdOn), [client, name, argsKey, cacheKey, failure, holdOn]);
  const result = useSyncExternalStore(reader.subscribe, reader.get, reader.get);
  const scope = useContext(KeptScopeContext);
  const keptPaint = result.status === "ready" && !!result.kept;
  // A layout effect: the region reads busy in the same frame the kept rows first paint.
  useLayoutEffect(() => (keptPaint && scope ? scope.add() : undefined), [keptPaint, scope]);
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
  touched.clear();
  holds.clear();
  kept.clear();
  connectedHosts = null;
  globalThis.localStorage?.removeItem(CONNECTED_KEY);
}
