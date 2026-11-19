import type { ProjectMeta, WorkspaceMeta as WireWorkspaceMeta } from "@shared/domain";
import type { SectorKey, WorkspaceWorkSettings } from "@shared/work";
import type { LifeosStatus } from "@shared/contract-work-lifeos";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../lib/connection";
import type { Environment } from "../../lib/connection/types";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setWorkHome, workHome as homeOf } from "../../lib/workSwitch";

/**
 * What Work's chrome asks of a host (docs/agents/work.md, work-scope.md,
 * work-lifeos.md): make a Work workspace, link a code workspace to a sector,
 * open a LifeOS project as the project its threads live in, a workspace's
 * Work settings, the switch on every host. Each answer the host refuses
 * comes back as its own sentence, which the caller shows.
 */

/** The six sectors, in LifeOS's own order; their names come from LifeOS once it answers. */
export const SECTORS: readonly SectorKey[] = ["cosmic", "hypixel", "purdue", "ref", "unify", "life"];
const FALLBACK_NAME: Record<SectorKey, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };
export const sectorName = (sector: string, names?: ReadonlyMap<string, string>): string =>
  names?.get(sector) ?? FALLBACK_NAME[sector as SectorKey] ?? sector;

/** Where a new Work workspace is made (lib/workSwitch.ts `workHome`), for this window's hosts. */
export function workHome(environments: readonly Environment[] = registry.environments()): string | null {
  return homeOf(environments, registry.primaryEnvironmentId);
}
export { setWorkHome };

/** A Work workspace on `environmentId`, named for its sector unless named; the host makes its folder. */
export async function createWorkWorkspace(environmentId: string, opts: { sector: SectorKey | null; name: string }): Promise<WorkspaceMeta> {
  const link = registry.linkOf(environmentId);
  const meta = await link.request<WireWorkspaceMeta>("workspace.create", { kind: "work", name: opts.name, sector: opts.sector });
  await workspaceStore.refresh(link);
  return { ...meta, environmentId };
}

/** Links a code workspace to a sector (null unlinks); its threads then read and draft there. */
export async function linkSector(workspace: Pick<WorkspaceMeta, "id" | "environmentId">, sector: SectorKey | null): Promise<LifeosStatus> {
  const link = registry.linkOf(workspace.environmentId);
  const status = await link.request<LifeosStatus>("work.lifeos.link", { workspaceId: workspace.id, sector });
  // The host sends the workspaces push; this reads it at once for the menu that asked.
  await workspaceStore.refresh(link);
  return status;
}

/** The project that holds a Work workspace's threads about one LifeOS project, made the first time. */
export async function openLifeosProject(workspace: Pick<WorkspaceMeta, "id" | "environmentId">, lifeosProjectId: string, name: string): Promise<ProjectMeta & { environmentId: string }> {
  const link = registry.linkOf(workspace.environmentId);
  const project = await link.request<ProjectMeta>("work.project.open", { workspaceId: workspace.id, lifeosProjectId, name });
  await workspaceStore.refresh(link);
  return { ...project, environmentId: workspace.environmentId };
}

let localHost: Promise<string | null> | null = null;
/** This machine's own host id: the window names it "local", a host names it by its id (`mayUseDesktop` holds host ids). */
export function localHostId(): Promise<string | null> {
  const link = registry.link(LOCAL_ENVIRONMENT_ID);
  if (!link) return Promise.resolve(null);
  localHost ??= link.request<{ environmentId: string }>("remote.status", {}).then(
    (status) => status.environmentId,
    () => ((localHost = null), null),
  );
  return localHost;
}

/** A host id as the window's link names it ("local" for this machine), or null for a host it has no link to. */
export const linkIdOfHost = (hostId: string, local: string | null): string | null => (registry.has(hostId) ? hostId : hostId === local ? LOCAL_ENVIRONMENT_ID : null);
/** A link's host id: this machine's own, else the link's. */
export const hostIdOfLink = (linkId: string, local: string | null): string => (linkId === LOCAL_ENVIRONMENT_ID && local ? local : linkId);

export function workspaceSettings(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): Promise<WorkspaceWorkSettings> {
  return registry.linkOf(workspace.environmentId).request<WorkspaceWorkSettings>("work.workspace.get", { workspaceId: workspace.id });
}

export function setWorkspaceSettings(
  workspace: Pick<WorkspaceMeta, "id" | "environmentId">,
  patch: { mayUseDesktop?: string[]; model?: string | null; reasoning?: string | null; voice?: boolean },
): Promise<WorkspaceWorkSettings> {
  return registry.linkOf(workspace.environmentId).request<WorkspaceWorkSettings>("work.workspace.set", { workspaceId: workspace.id, patch });
}
