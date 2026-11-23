import { makeFunctionReference } from "convex/server";
import { useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import { sessionWaits, useLifeosQuery, useLifeosSession, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import type { LifeosReach } from "./model";
import type { TodayEnv, TodayWorkspace } from "./types";

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

/** One sector's slot: its narrowed session and query while the sector is lacking, idle otherwise. Always the same hooks. */
function useSlot<V>(sector: SectorKey, lacking: ReadonlyMap<SectorKey, string>, name: string, args: Record<string, unknown>): LifeosQuery<V> | null {
  const host = lacking.get(sector) ?? null;
  const session = useLifeosSession(host ?? "", sector);
  const query = useLifeosQuery<V>(host ? session : IDLE, name, host ? { ...args, sector } : args);
  return host ? query : null;
}

export type Rows<T> = {
  /** Null until the all-sector read has answered. */
  rows: T[] | null;
  /** LifeOS refused the read itself, in its words. */
  error: string | null;
};

/**
 * A LifeOS list for every job: the all-sector session's rows, with the rows
 * of each sector that session lacks read on another host and merged by id.
 * `pick` takes the rows out of what the query answers.
 */
export function useLifeosRows<V, T>(env: TodayEnv, name: string, args: Record<string, unknown>, pick: (value: V) => readonly T[], idOf: (row: T) => string): Rows<T> {
  const main = useLifeosQuery<V>(env.lifeos, name, args);
  const caller = useLifeosQuery<{ sectors: "all" | string[] }>(env.lifeos, "auth:caller", {});
  const cover = caller.status === "ready" ? caller.value.sectors : null;
  const coverKey = cover === null ? "" : cover === "all" ? "all" : cover.join(",");
  const lacking = useMemo(() => lackingOf(cover, env.workspaces, env.lifeos.environmentId), [coverKey, env.workspaces, env.lifeos.environmentId]);
  const slots = [
    useSlot<V>(SLOTS[0]!, lacking, name, args),
    useSlot<V>(SLOTS[1]!, lacking, name, args),
    useSlot<V>(SLOTS[2]!, lacking, name, args),
    useSlot<V>(SLOTS[3]!, lacking, name, args),
    useSlot<V>(SLOTS[4]!, lacking, name, args),
    useSlot<V>(SLOTS[5]!, lacking, name, args),
  ];
  const [a, b, c, d, e, f] = slots;
  return useMemo(() => {
    if (main.status !== "ready") return { rows: null, error: main.status === "failed" ? main.error : null };
    const seen = new Set<string>();
    const rows: T[] = [];
    for (const value of [main.value, ...[a, b, c, d, e, f].flatMap((slot) => (slot?.status === "ready" ? [slot.value] : []))]) {
      for (const row of pick(value)) {
        const id = idOf(row);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    }
    return { rows, error: null };
    // `pick` and `idOf` are the caller's constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, a, b, c, d, e, f]);
}

/** A write to LifeOS as the session's owner; rejects when the session cannot write. */
export function mutate<T>(session: LifeosSession, name: string, args: Record<string, unknown>): Promise<T> {
  if (!session.client) return Promise.reject(new Error("LifeOS is not connected"));
  return session.client.mutation(makeFunctionReference<"mutation">(name), args) as Promise<T>;
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
    toast.error(`Couldn't ${failed}`);
    throw error;
  }
  toast(message, undo ? { action: { label: "Undo", onClick: () => void undo(result).catch(() => toast.error("Couldn't undo")) } } : undefined);
  return result;
}
