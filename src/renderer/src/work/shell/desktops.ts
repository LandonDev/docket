import { LOCAL_ENVIRONMENT_ID, registry } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { hostIdOfLink, linkIdOfHost, workspaceSettings } from "./actions";

/**
 * The desktops a job may use, sorted by how this window reaches them: Work search's "All files for …"
 * (search/desktops.ts) and Files' own search of every place (files/store.ts) each ask the linked ones themselves,
 * with the search Files already has there, and name the far ones as not searched (docs/agents/work-search.md
 * "Files on his computers", docs/agents/work-files.md "Search and Go to").
 */

export interface Desktops {
  /** desktops the window may ask itself, each for the first job in scope that may use it */
  linked: { link: string; host: string; name: string; workspaceId: string }[];
  /** desktops a job may use that this window has no link to, by name where it is known */
  far: string[];
}
export const NO_DESKTOPS: Desktops = { linked: [], far: [] };

export interface DesktopDeps {
  settings(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): Promise<{ mayUseDesktop: string[] }>;
  /** this machine's own host id */
  local(): Promise<string | null>;
  linkOf(hostId: string, local: string | null): string | null;
  connected(link: string): boolean;
  nameOf(link: string): string | undefined;
}

const live: DesktopDeps = {
  settings: workspaceSettings,
  local: async () => registry.statusOf(LOCAL_ENVIRONMENT_ID).lastHello?.environmentId ?? null,
  linkOf: linkIdOfHost,
  connected: (link) => registry.link(link)?.connected === true,
  nameOf: (link) => registry.environment(link)?.name,
};

/** The desktops the jobs in scope may use, sorted into the ones this window can ask and the ones it cannot. */
export async function desktopsFor(workspaces: readonly Pick<WorkspaceMeta, "id" | "environmentId">[], deps: Partial<DesktopDeps> = {}): Promise<Desktops> {
  const d = { ...live, ...deps };
  const local = await d.local();
  const linked = new Map<string, Desktops["linked"][number]>();
  const far = new Set<string>();
  await Promise.all(
    workspaces.map(async (workspace) => {
      const settings = await d.settings(workspace).catch(() => null);
      for (const host of settings?.mayUseDesktop ?? []) {
        const link = d.linkOf(host, local);
        // The job's own host searches itself.
        if (link === workspace.environmentId) continue;
        if (link && d.connected(link)) {
          if (!linked.has(link)) linked.set(link, { link, host: hostIdOfLink(link, local), name: d.nameOf(link) ?? "This computer", workspaceId: workspace.id });
        } else far.add((link && d.nameOf(link)) || d.nameOf(host) || "another computer");
      }
    }),
  );
  return { linked: [...linked.values()], far: [...far] };
}

