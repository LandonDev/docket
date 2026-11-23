import { useEffect, useMemo, useState } from "react";
import type { SectorKey } from "@shared/work";
import { useEnvironmentStatuses, useEnvironments } from "../../lib/connection";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { workHome } from "../shell/actions";
import { reopenLifeos, useLifeosSession } from "../shell/lifeos";
import { lifeosHosts, pickHost, reachOf, sessionDown } from "./lifeos";
import { useMinute } from "../tasks/minute";
import { dayBounds, jobsOf, workspaceFor, type LifeosReach } from "./model";
import type { TodayEnv } from "./types";

const NONE: ReadonlySet<string> = new Set();

/**
 * What every source of Today is handed: the day, the jobs and one LifeOS
 * session for all sectors. LifeOS is one backend for every job, so its
 * sections are read once, on one host, never once per host: one fact never
 * shows twice, and a host that is slow or off holds up nothing.
 */

export function useTodayEnv(): { env: TodayEnv; reach: LifeosReach; lifeosHost: string | null; retryLifeos: (() => Promise<void>) | undefined } {
  const catalog = useWorkspaces();
  const workHosts = useWorkHosts();
  const statuses = useEnvironmentStatuses();
  const environments = useEnvironments();
  // The hosts whose link is open, as one string: a status that changes in any other way moves nothing here.
  const openKey = [...statuses].filter(([, s]) => s.transport === "open").map(([id]) => id).join("|");
  const jobs = useMemo(() => jobsOf(catalog, workHosts, new Set(openKey ? openKey.split("|") : [])), [catalog, workHosts, openKey]);
  const home = useMemo(() => workHome(environments), [environments, workHosts]);
  // One host's session is read. A host found signed out or out of reach gives way to the next that holds a job;
  // the set is forgotten when the hosts change and on Retry, so a host that came back is tried again.
  const hosts = useMemo(() => lifeosHosts(jobs, home), [jobs, home]);
  const hostsKey = hosts.join("|");
  const [wanting, setWanting] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: hostsKey, ids: NONE });
  const tried = wanting.key === hostsKey ? wanting.ids : NONE;
  const host = pickHost(hosts, tried);
  const lifeos = useLifeosSession(host ?? "", null);
  const down = !!host && sessionDown(lifeos);
  useEffect(() => {
    if (!down || !host || !hosts.some((id) => id !== host && !tried.has(id))) return;
    setWanting({ key: hostsKey, ids: new Set(tried).add(host) });
  }, [down, host, hosts, hostsKey, tried]);
  // The day turns at local midnight: the minute's tick moves the bounds only then.
  const { from, to } = dayBounds(useMinute());
  const env = useMemo<TodayEnv>(
    () => ({ day: { from, to }, workspaces: jobs, lifeos, workspaceOf: (sector: SectorKey) => workspaceFor(sector, jobs, home) }),
    [from, to, jobs, lifeos, home],
  );
  const retryLifeos = useMemo(
    () =>
      host
        ? async () => {
            setWanting({ key: hostsKey, ids: NONE });
            await reopenLifeos(hosts[0] ?? host, null);
          }
        : undefined,
    [host, hosts, hostsKey],
  );
  return { env, reach: reachOf(lifeos, host), lifeosHost: host, retryLifeos };
}
