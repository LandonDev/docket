import type { DraftPlace } from "../../lib/projectDrafts";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { LIFEOS_CARD, type LifeosProjectRow } from "../../lib/workSwitch";
import { withLifeosCards } from "../../lib/workspaceSessions";

/**
 * Where a Work draft files, and where else it may (docs/agents/work.md "A Work draft"): its job, its project, the
 * job's projects as the column lists them (LifeOS's live projects, a card for one with no mirror yet, then the job's
 * own), and the other jobs. Pure: the row reads the catalog and hands it here.
 */

/** A project the menu offers: a mirror (or a project of the job's own), or a LifeOS project's card, opened first. */
export type FilingProject = { id: string; name: string; lifeosProjectId: string | null; card: boolean };

export type Filing = {
  /** The draft's job; null for a Work Chat, outside every job. */
  job: WorkspaceMeta | null;
  /** The project it files under now, null when loose in the job. */
  project: FilingProject | null;
  projects: readonly FilingProject[];
  /** Every other Work job, in the rail's order. */
  others: readonly WorkspaceMeta[];
};

type DraftWhere = { workspaceId?: string | null; projectId?: string | null };

export function filingOf(
  draft: DraftWhere,
  workspaces: readonly WorkspaceMeta[],
  catalog: readonly ProjectMeta[],
  lifeos: readonly LifeosProjectRow[],
): Filing {
  const job = workspaces.find((w) => w.id === draft.workspaceId && w.kind === "work") ?? null;
  const own = job ? catalog.filter((p) => p.workspaceId === job.id && p.environmentId === job.environmentId && !p.archived) : [];
  const projects: FilingProject[] = job
    ? withLifeosCards(own, job, lifeos).map((p) => ({
        id: p.id,
        name: p.name,
        lifeosProjectId: p.lifeosProjectId ?? null,
        card: p.id.startsWith(LIFEOS_CARD),
      }))
    : [];
  // A draft under a project the list does not hold (finished in LifeOS since) still names it.
  const known = catalog.find((p) => p.id === draft.projectId);
  const project =
    projects.find((p) => p.id === draft.projectId) ??
    (known ? { id: known.id, name: known.name, lifeosProjectId: known.lifeosProjectId ?? null, card: false } : null);
  const others = workspaces.filter((w) => w.kind === "work" && w.id !== job?.id);
  return { job, project, projects, others };
}

/** The place a pick files the draft at: a project (made real first when it is a card), or loose in a job. */
export function placeOf(job: Pick<WorkspaceMeta, "environmentId" | "id" | "path">, projectId: string | null): DraftPlace {
  return { environmentId: job.environmentId, projectId, workspaceId: job.id, cwd: job.path };
}

/** Two jobs of one name (a sector on two hosts) are told apart by their host. */
export function jobLabel(job: WorkspaceMeta, all: readonly WorkspaceMeta[], hostName: (environmentId: string) => string): string {
  const twin = all.some((w) => w.id !== job.id && w.kind === "work" && w.name === job.name);
  return twin ? `${job.name} on ${hostName(job.environmentId)}` : job.name;
}
