import { makeFunctionReference } from "convex/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SectorKey } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import { reopenLifeos, sessionWaits, useLifeosQuery, useLifeosSession, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import type { LifeosReach } from "./model";
import { toastUp } from "./store";
import type { TodayAnswer, TodayEnv, TodayFailure, TodayRow, TodayWorkspace } from "./types";

/**
 * How Today reads LifeOS (docs/agents/work-today.md "One LifeOS session"):
 * LifeOS is one backend for every job, so its sections are read once,
 * through one session for all sectors on one host, never once per host.
 * `work.lifeos.jwt {}` answers a JWT of the host's whole device session
 * (`auth:token` with no sectors): every sector, unless that session was
 * made narrower. `auth:caller` says which; a job whose sector the session
 * lacks is read through a session narrowed to that sector on another host
 * that holds the job, and the rows are merged by id.
 */

/** The hosts whose LifeOS session Today may read, in the order it tries them: the Work home, then each open host that holds a job. */
export function lifeosHosts(jobs: readonly TodayWorkspace[], home: string | null): string[] {
  const open = [...new Set(jobs.filter((w) => w.open).map((w) => w.environmentId))];
  return home && open.includes(home) ? [home, ...open.filter((id) => id !== home)] : open;
}

/** The host to read now: the first not found wanting; when all were, the first, whose state the page then says. */
export function pickHost(hosts: readonly string[], wanting: ReadonlySet<string>): string | null {
  return hosts.find((id) => !wanting.has(id)) ?? hosts[0] ?? null;
}

/** A session that cannot read and is not on its way: signed out, refused, unreachable, off. */
export const sessionDown = (session: Pick<LifeosSession, "client" | "state">): boolean => !session.client && !sessionWaits(session);

/** Whether the session can be read, as the page says it. */
export function reachOf(session: Pick<LifeosSession, "client" | "state">, host: string | null): LifeosReach {
  if (!host) return "unreachable";
  if (session.client) return "ok";
  if (sessionWaits(session)) return "waiting";
  return session.state === "signed-out" || session.state === "refused" || session.state === "pairing" ? "signed-out" : "unreachable";
}

/** The six sectors, as fixed slots for the narrowed reads. */
const SLOTS: readonly SectorKey[] = ["cosmic", "hypixel", "purdue", "ref", "unify", "life"];
/** A slot with nothing to read: no client, and not on its way. */
const IDLE: LifeosSession = { environmentId: "", sector: null, client: null, state: "off" };

/** The sectors the all-sector session lacks that some job needs, each with a host other than the session's that holds that job. */
export function lackingOf(cover: "all" | readonly string[] | null, jobs: readonly TodayWorkspace[], host: string): Map<SectorKey, string> {
  const out = new Map<SectorKey, string>();
  if (cover === null || cover === "all") return out;
  for (const job of jobs) {
    if (cover.includes(job.sector) || out.has(job.sector) || !job.open || job.environmentId === host) continue;
    out.set(job.sector, job.environmentId);
  }
  return out;
}

/** The jobs' sectors the all-sector session lacks and no other open host holds: nothing can read them, and the page must say so. */
export function uncoveredOf(cover: "all" | readonly string[] | null, jobs: readonly TodayWorkspace[], host: string): SectorKey[] {
  if (cover === null || cover === "all") return [];
  const read = lackingOf(cover, jobs, host);
  return [...new Set(jobs.map((job) => job.sector).filter((sector) => !cover.includes(sector) && !read.has(sector)))];
}

type Slot<V> = { query: LifeosQuery<V>; session: LifeosSession } | null;

/** One sector's slot: its narrowed session and query while the sector is lacking, idle otherwise. Always the same hooks. */
function useSlot<V>(sector: SectorKey, lacking: ReadonlyMap<SectorKey, string>, name: string, args: Record<string, unknown>): Slot<V> {
  const host = lacking.get(sector) ?? null;
  const session = useLifeosSession(host ?? "", sector);
  const query = useLifeosQuery<V>(host ? session : IDLE, name, host ? { ...args, sector } : args);
  // The same object while the query and the session are the same: what reads it is memoised on it.
  return useMemo(() => (host ? { query, session } : null), [host, query, session]);
}

/** A read some job needs that did not come back: the session's cover (`sector` null), one sector's narrowed read, or a sector no open host's session can read at all. */
export type Lost = { environmentId: string; sector: SectorKey | null; error: string };

/** What a sector no session covers fails with. */
export const NOT_COVERED = "No signed-in host can read this job";

export type Rows<T> = {
  /** Null until the all-sector read has answered. */
  rows: T[] | null;
  /** LifeOS refused the read itself, in its words. */
  error: string | null;
  /** A read some job needs is still out (the session's cover, a sector read on another host): `rows` may not be all of them yet. */
  pending: boolean;
  /** The reads beside the first that failed: `rows` lacks what they would have brought. */
  lost: readonly Lost[];
  /** Ask again: every read is dropped and made afresh, and a session that failed is opened again. */
  retry(): Promise<void>;
  /** The session a row of this sector was read through, and so the one its writes go through: the sector's own narrowed session where the first one lacks it. */
  sessionOf(sector: SectorKey): LifeosSession;
};

const NO_LOST: readonly Lost[] = [];

/**
 * A LifeOS list for every job: the all-sector session's rows, with the rows
 * of each sector that session lacks read on another host and merged by id.
 * `pick` takes the rows out of what the query answers. The list is whole
 * only once the session's cover and every such read have answered too:
 * until then it is `pending`, and one that failed is `lost`, so the page
 * never calls a section empty on half an answer.
 */
export function useLifeosRows<V, T>(env: TodayEnv, name: string, args: Record<string, unknown>, pick: (value: V) => readonly T[], idOf: (row: T) => string): Rows<T> {
  // Retry lets go of every read for one render: a query LifeOS refused is asked again only once no one holds it.
  // With no cover to go by, the sector reads rest too, and start again when the session says its cover.
  const [resting, setResting] = useState(false);
  useEffect(() => {
    if (resting) setResting(false);
  }, [resting]);
  const session = resting ? IDLE : env.lifeos;
  const main = useLifeosQuery<V>(session, name, args);
  const caller = useLifeosQuery<{ sectors: "all" | string[] }>(session, "auth:caller", NO_ARGS);
  const cover = caller.status === "ready" ? caller.value.sectors : null;
  const coverKey = cover === null ? "" : cover === "all" ? "all" : cover.join(",");
  const host = env.lifeos.environmentId;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the cover by its value
  const lacking = useMemo(() => lackingOf(cover, env.workspaces, host), [coverKey, env.workspaces, host]);
  const slots = [
    useSlot<V>(SLOTS[0]!, lacking, name, args),
    useSlot<V>(SLOTS[1]!, lacking, name, args),
    useSlot<V>(SLOTS[2]!, lacking, name, args),
    useSlot<V>(SLOTS[3]!, lacking, name, args),
    useSlot<V>(SLOTS[4]!, lacking, name, args),
    useSlot<V>(SLOTS[5]!, lacking, name, args),
  ];
  const [a, b, c, d, e, f] = slots;
  // A row is written through the session that read it. The same function while the sessions are the same.
  const [sa, sb, sc, sd, se, sf] = [a?.session, b?.session, c?.session, d?.session, e?.session, f?.session];
  const first = env.lifeos;
  const sessionOf = useMemo(() => {
    const narrowed = new Map<SectorKey, LifeosSession>();
    [sa, sb, sc, sd, se, sf].forEach((s, at) => s && narrowed.set(SLOTS[at]!, s));
    return (sector: SectorKey): LifeosSession => narrowed.get(sector) ?? first;
  }, [first, sa, sb, sc, sd, se, sf]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the cover by its value
  const uncovered = useMemo(() => uncoveredOf(cover, env.workspaces, host), [coverKey, env.workspaces, host]);
  const lostNow = useRef<readonly Lost[]>(NO_LOST);
  const retry = useCallback(async () => {
    await Promise.all(lostNow.current.map((lost) => reopenLifeos(lost.environmentId, lost.sector).catch(() => {})));
    setResting(true);
  }, []);
  const read = useMemo<Rows<T>>(() => {
    if (main.status !== "ready") return { rows: null, error: main.status === "failed" ? main.error : null, pending: false, lost: NO_LOST, retry, sessionOf };
    const seen = new Set<string>();
    const rows: T[] = [];
    const lost: Lost[] = caller.status === "failed" ? [{ environmentId: host, sector: null, error: caller.error }] : [];
    let pending = caller.status === "loading";
    const each = [a, b, c, d, e, f].map((slot) => slot?.query);
    for (const value of [main.value, ...each.flatMap((slot) => (slot?.status === "ready" ? [slot.value] : []))]) {
      for (const row of pick(value)) {
        const id = idOf(row);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    }
    each.forEach((slot, at) => {
      const sector = SLOTS[at]!;
      if (slot?.status === "loading") pending = true;
      if (slot?.status === "failed") lost.push({ environmentId: lacking.get(sector) ?? host, sector, error: slot.error });
    });
    // A job whose sector no open host's session covers: its rows are missing, and nothing is on its way.
    for (const sector of uncovered) lost.push({ environmentId: host, sector, error: NOT_COVERED });
    return { rows, error: null, pending, lost: lost.length ? lost : NO_LOST, retry, sessionOf };
    // `pick` and `idOf` are the caller's constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, caller, a, b, c, d, e, f, lacking, uncovered, host, retry, sessionOf]);
  useEffect(() => {
    lostNow.current = read.lost;
  }, [read.lost]);
  return read;
}

const NO_ARGS = {};

/**
 * What a LifeOS section answers from its read (`rows` null: still to build).
 * A read LifeOS refused is said in the section with a Retry, in plain words
 * (`what`: "meetings", "tasks"); a read still out keeps the section from
 * saying it is empty; one beside the first that failed is said under the
 * rows that did arrive, naming the job it left out where it was one job's
 * (`jobName`).
 */
export function answerOf(
  read: Pick<Rows<unknown>, "error" | "pending" | "lost" | "retry">,
  rows: TodayRow[] | null,
  lifeos: LifeosSession,
  what: string,
  note?: string,
  jobName?: (sector: SectorKey) => string | undefined,
): TodayAnswer {
  const failure = (environmentId: string, error: string, sector?: SectorKey | null): TodayFailure => {
    const of = `${sector && jobName?.(sector) ? `${jobName(sector)}'s ` : ""}${what}`;
    // No session covers the job: asking again reads with the same cover, so the line says the cause and offers no Retry.
    // It goes by itself when a host that can read the job is back.
    if (error === NOT_COVERED) return { environmentId, error, said: `No signed-in host can read ${of}` };
    return { environmentId, error, said: `LifeOS could not read ${of}`, retry: read.retry };
  };
  // A session that is down is the page's one line (model.ts `page`), never each section's.
  if (read.error && !sessionDown(lifeos)) return { rows: [], failed: [failure(lifeos.environmentId, read.error)] };
  if (!rows) return { loading: true };
  return {
    rows,
    ...(read.pending ? { loading: true } : {}),
    ...(read.lost.length ? { failed: read.lost.map((lost) => failure(lost.environmentId, lost.error, lost.sector)) } : {}),
    ...(note ? { note } : {}),
  };
}

/** A write to LifeOS as the session's owner; rejects when the session cannot write. */
export function mutate<T>(session: LifeosSession, name: string, args: Record<string, unknown>): Promise<T> {
  if (!session.client) return Promise.reject(new Error("LifeOS is not connected"));
  return session.client.mutation(makeFunctionReference<"mutation">(name), args) as Promise<T>;
}

/**
 * A toast of the page's own, counted while it is up (store.ts `toastsUp`):
 * in a narrow column the page gives it a strip of its own. `options` go to
 * the toast: they count it down when it is closed or its time runs out.
 * Sonner calls neither for a press on the toast's own action, nor for a
 * toast dismissed by code: whoever does either calls `down` itself.
 */
export function shown(): { options: { onDismiss(): void; onAutoClose(): void }; down(): void } {
  const down = toastUp();
  return { options: { onDismiss: down, onAutoClose: down }, down };
}

/**
 * One of his acts on a row: it says what it did in one toast, with Undo
 * where there is a way back, and its own words when it fails. It rejects on
 * a failure, so the row that asked comes back as it was.
 */
export async function act<T>({ run, message, failed, undo }: { run: () => Promise<T>; message: string; failed: string; undo?: (result: T) => Promise<unknown> }): Promise<T> {
  const toast = await loadToast();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    toast.error(`Couldn't ${failed}`, shown().options);
    throw error;
  }
  const up = shown();
  const onUndo = (): void => {
    // The press takes the toast away at once: its place is given back at once too.
    up.down();
    void undo!(result).catch(() => toast.error("Couldn't undo", shown().options));
  };
  toast(message, { ...up.options, ...(undo ? { action: { label: "Undo", onClick: onUndo } } : {}) });
  return result;
}
