import { useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { useEnvironmentStatuses, useEnvironments } from "../../lib/connection";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { workHome } from "../shell/actions";
import { sessionWaits, useLifeosSession, type LifeosSession } from "../shell/lifeos";
import { useMinute } from "../tasks/minute";
import { dayBounds, jobsOf, workspaceFor, type LifeosReach } from "./model";
import type { TodayEnv, TodayWorkspace } from "./types";

/**
 * What every source of Today is handed: the day, the jobs and one LifeOS
 * session for all sectors. LifeOS is one backend for every job, so its
 * sections are read once, on one host, never once per host: one fact never
 * shows twice, and a host that is slow or off holds up nothing.
 */

/** The host whose LifeOS session Today reads: the Work home when its link is open, else the first open host that holds a job. */
export function lifeosHost(jobs: readonly TodayWorkspace[], home: string | null): string | null {
  const open = [...new Set(jobs.filter((w) => w.open).map((w) => w.environmentId))];
  return open.find((id) => id === home) ?? open[0] ?? null;
}

/** Whether the session can be read, as the page says it. */
export function reachOf(session: Pick<LifeosSession, "client" | "state">, host: string | null): LifeosReach {
  if (!host) return "unreachable";
  if (session.client) return "ok";
  if (sessionWaits(session)) return "waiting";
  return session.state === "signed-out" || session.state === "refused" || session.state === "pairing" ? "signed-out" : "unreachable";
}

export function useTodayEnv(): { env: TodayEnv; reach: LifeosReach; lifeosHost: string | null } {
  const catalog = useWorkspaces();
  const workHosts = useWorkHosts();
  const statuses = useEnvironmentStatuses();
  const environments = useEnvironments();
  // The hosts whose link is open, as one string: a status that changes in any other way moves nothing here.
  const openKey = [...statuses].filter(([, s]) => s.transport === "open").map(([id]) => id).join("|");
  const jobs = useMemo(() => jobsOf(catalog, workHosts, new Set(openKey ? openKey.split("|") : [])), [catalog, workHosts, openKey]);
  const home = useMemo(() => workHome(environments), [environments, workHosts]);
  const host = lifeosHost(jobs, home);
  const lifeos = useLifeosSession(host ?? "", null);
  // The day turns at local midnight: the minute's tick moves the bounds only then.
  const { from, to } = dayBounds(useMinute());
  const env = useMemo<TodayEnv>(
    () => ({ day: { from, to }, workspaces: jobs, lifeos, workspaceOf: (sector: SectorKey) => workspaceFor(sector, jobs, home) }),
    [from, to, jobs, lifeos, home],
  );
  return { env, reach: reachOf(lifeos, host), lifeosHost: host };
}
