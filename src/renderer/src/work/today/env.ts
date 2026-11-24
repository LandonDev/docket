import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosStatus } from "@shared/contract-work-lifeos";
import { useEnvironmentStatuses, useEnvironments } from "../../lib/connection";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { workHome } from "../shell/actions";
import { reopenLifeos, useLifeosSession, useLifeosStatusHeard } from "../shell/lifeos";
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

export function useTodayEnv(): { env: TodayEnv; reach: LifeosReach; lifeosHost: string | null; retryLifeos: (() => Promise<void>) | undefined; open: ReadonlySet<string> } {
  const catalog = useWorkspaces();
  const workHosts = useWorkHosts();
  const statuses = useEnvironmentStatuses();
  const environments = useEnvironments();
  // The hosts whose link is open, as one string: a status that changes in any other way moves nothing here.
  const openKey = [...statuses].filter(([, s]) => s.transport === "open").map(([id]) => id).join("|");
  const open = useMemo<ReadonlySet<string>>(() => new Set(openKey ? openKey.split("|") : []), [openKey]);
  const jobs = useMemo(() => jobsOf(catalog, workHosts, open), [catalog, workHosts, open]);
  const home = useMemo(() => workHome(environments), [environments, workHosts]);
  // One host's session is read. A host found signed out or out of reach gives way to the next that holds a job;
  // the set is forgotten when the hosts change, so a host that came back is tried again.
  const hosts = useMemo(() => lifeosHosts(jobs, home), [jobs, home]);
  const hostsKey = hosts.join("|");
  const [wanting, setWanting] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: hostsKey, ids: NONE });
  const tried = wanting.key === hostsKey ? wanting.ids : NONE;
  const host = pickHost(hosts, tried);
  const lifeos = useLifeosSession(host ?? "", null);
  const down = !!host && sessionDown(lifeos);
  // A computer tried again (below) first shows the session it was passed over on, which its own effect then asks for
  // afresh: it is judged on what that ask finds, not on the old state.
  const revived = useRef<string | null>(null);
  useEffect(() => {
    if (revived.current === host) {
      revived.current = null;
      if (down) return;
    }
    if (!down || !host || !hosts.some((id) => id !== host && !tried.has(id))) return;
    setWanting({ key: hostsKey, ids: new Set(tried).add(host) });
  }, [down, host, hosts, hostsKey, tried]);
  // A computer passed over that says connected again is tried again, while the one read now is down: its rows come back
  // with no press. Never under a Retry, which keeps the computer its line names until the ask is back.
  const [asking, setAsking] = useState(false);
  const passed = useMemo(() => hosts.filter((id) => id !== host && tried.has(id)), [hosts, host, tried]);
  const back = useCallback(
    (id: string) => {
      revived.current = id;
      setWanting((was) => (was.key === hostsKey && was.ids.has(id) ? { key: hostsKey, ids: new Set([...was.ids].filter((one) => one !== id)) } : was));
    },
    [hostsKey],
  );
  useBackAgain(passed, down && !asking, back);
  // The day turns at local midnight: the minute's tick moves the bounds only then.
  const { from, to } = dayBounds(useMinute());
  const env = useMemo<TodayEnv>(
    () => ({ day: { from, to }, workspaces: jobs, lifeos, workspaceOf: (sector: SectorKey) => workspaceFor(sector, jobs, home) }),
    [from, to, jobs, lifeos, home],
  );
  // Retry asks the computer the line names, and keeps it while the ask is out: the hosts passed over stay passed over,
  // so the line never jumps to another computer's state under his press.
  const retryLifeos = useMemo(
    () =>
      host
        ? async () => {
            setAsking(true);
            try {
              await reopenLifeos(host, null);
            } finally {
              setAsking(false);
            }
          }
        : undefined,
    [host],
  );
  return { env, reach: reachOf(lifeos, host), lifeosHost: host, retryLifeos, open };
}

/** How many computers passed over Today hears again; past that many, one comes back when the hosts change. */
export const PASSED_MOST = 4;

/**
 * Calls `back` for a computer passed over once its status, heard afresh since it was passed over, says connected, while
 * `listening`. Each passed computer sits in a fixed slot, so the hooks never change in number. A status heard while not
 * listening is acted on once listening again. `back` is one lasting function.
 */
function useBackAgain(passed: readonly string[], listening: boolean, back: (id: string) => void): void {
  const ids = Array.from({ length: PASSED_MOST }, (_, at) => passed[at] ?? null);
  const heard = [useLifeosStatusHeard(ids[0]), useLifeosStatusHeard(ids[1]), useLifeosStatusHeard(ids[2]), useLifeosStatusHeard(ids[3])];
  // The status each was passed over on: only a newer one can bring it back.
  const since = useRef(new Map<string, LifeosStatus | null>());
  const [a, b, c, d] = heard;
  const key = ids.join("|");
  useEffect(() => {
    const seen = since.current;
    for (const id of [...seen.keys()]) if (!ids.includes(id)) seen.delete(id);
    ids.forEach((id, at) => {
      if (!id) return;
      const status = heard[at] ?? null;
      if (!seen.has(id)) return void seen.set(id, status);
      if (listening && status !== seen.get(id) && status?.lifeos.state === "connected") back(id);
    });
    // The slots by their ids, the statuses by their objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, a, b, c, d, listening, back]);
}
