import type { SearchAnswer, SearchHit } from "@shared/work/search";
import { registry } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workHome, workSwitch } from "../../lib/workSwitch";
import type { SearchHost } from "./model";

/**
 * Who a search asks (docs/agents/work-search.md "The window"): every
 * connected host with Work on. The Work home is asked for what LifeOS
 * holds and the others are told to leave it (`own`), so LifeOS is asked
 * once however many hosts have Work on. A host with Work on that is not
 * connected is one quiet line.
 */

/** One job: a sector's Work workspaces on every host (one a sector a host), or a workspace with no sector by itself. */
export interface Job {
  /** the sector, or `ws:<id>` for a workspace with none */
  key: string;
  name: string;
  sector: string | null;
  /** its workspace on each host */
  ids: string[];
}

export function jobsOf(workspaces: readonly WorkspaceMeta[]): Job[] {
  const jobs = new Map<string, Job>();
  for (const w of workspaces) {
    if (w.kind !== "work") continue;
    const key = w.sector ?? `ws:${w.id}`;
    const job = jobs.get(key);
    if (job) job.ids.push(w.id);
    else jobs.set(key, { key, name: w.name, sector: w.sector ?? null, ids: [w.id] });
  }
  return [...jobs.values()];
}

export const jobOfWorkspace = (jobs: readonly Job[], workspaceId: string | null | undefined): Job | null => (workspaceId ? (jobs.find((job) => job.ids.includes(workspaceId)) ?? null) : null);

/** A host to ask, with the one workspace of the job it is held to, when it is. */
export type AskedHost = SearchHost & { workspaceId?: string };

export interface HostsDeps {
  environments(): { id: string; name: string; platform?: string }[];
  connected(id: string): boolean;
  /** hosts whose Work switch is on */
  on(): ReadonlySet<string>;
  /** the Work home among them */
  home(): string | null;
  workspaces(): readonly WorkspaceMeta[];
}

const live: HostsDeps = {
  environments: () => registry.environments(),
  connected: (id) => registry.link(id)?.connected === true,
  on: () => workSwitch.hosts(),
  home: () => workHome(registry.environments(), registry.primaryEnvironmentId),
  workspaces: () => workspaceStore.getSnapshot().workspaces,
};

/**
 * The hosts a search asks, the Work home first, and the ones it cannot.
 * Held to one job, only the hosts that have a workspace of it are asked,
 * each for its own. When the Work home is not connected the first host
 * that is stands in for it, so what LifeOS holds is still found.
 */
export function searchHosts(job: Job | null, deps: Partial<HostsDeps> = {}): { hosts: AskedHost[]; offline: string[] } {
  const d = { ...live, ...deps };
  const on = d.on();
  const workspaces = d.workspaces();
  const hosts: AskedHost[] = [];
  const offline: string[] = [];
  const home = d.home();
  for (const env of d.environments()) {
    if (!on.has(env.id)) continue;
    const workspaceId = job ? workspaces.find((w) => w.environmentId === env.id && job.ids.includes(w.id))?.id : undefined;
    if (job && !workspaceId) continue;
    if (!d.connected(env.id)) {
      offline.push(env.name);
      continue;
    }
    hosts.push({ id: env.id, name: env.name, home: env.id === home, ...(workspaceId ? { workspaceId } : {}) });
  }
  if (hosts.length && !hosts.some((h) => h.home)) hosts[0] = { ...hosts[0], home: true };
  return { hosts: hosts.sort((a, b) => Number(b.home) - Number(a.home)), offline };
}

/** One call of `work.search.query` to a host. */
export const askHost = (hostId: string, params: Record<string, unknown>): Promise<SearchAnswer> => registry.linkOf(hostId).request<SearchAnswer>("work.search.query", params);

/** He opened this: the hit's own host keeps it for Recent. Never waited on. */
export function tellOpened(hostId: string, hit: SearchHit): void {
  void registry
    .linkOf(hostId)
    .request("work.search.opened", { hit })
    .catch(() => {});
}
