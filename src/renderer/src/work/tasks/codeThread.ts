import type { ContextChip } from "@shared/work";
import type { RailItem } from "../../lib/linkedRail";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";

/**
 * Open a code thread… on a task (docs/agents/work-tasks.md): the code
 * workspaces a thread can start in, as the rail lists them, and what that
 * thread is told of the task.
 */

/** A code workspace to start in: the rail row's first copy that can take the thread, and the projects in that copy. */
export type CodeWorkspace = {
  id: string;
  path: string;
  name: string;
  /** The LifeOS sector the workspace is linked to (work.lifeos.link), or null. */
  sector: string | null;
  environmentId: string;
  projects: { id: string; name: string }[];
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * The rail's code rows in the rail's order (pinned, then the rest), each as
 * its first copy on a host with Work on (the lead first): that host links
 * the thread to the task, and a host with Work off refuses a create that
 * names one. A row with no such copy is left out. Its projects are that
 * copy's own, so the thread runs on the host and in the workspace picked.
 */
export function codeWorkspaces(
  rows: readonly RailItem[],
  workspaces: readonly WorkspaceMeta[],
  projects: readonly ProjectMeta[],
  workHosts: ReadonlySet<string>,
): CodeWorkspace[] {
  const out: CodeWorkspace[] = [];
  for (const row of rows) {
    const copies = row.workspaceIds.map((id) => workspaces.find((w) => w.id === id));
    if (copies.some((w) => w?.kind === "work")) continue;
    const lead = copies.find((w) => w && workHosts.has(w.environmentId));
    if (!lead) continue;
    const own = projects
      .filter((p) => p.workspaceId === lead.id && !p.archived)
      .map((p) => ({ id: p.id, name: p.name }))
      .sort(byName);
    out.push({ id: lead.id, path: lead.path, name: lead.name, sector: lead.sector ?? null, environmentId: lead.environmentId, projects: own });
  }
  return out;
}

/** The project a code thread starts in: the one picked, while the workspace picked holds it; else none ("" is None). */
export function pickedProject(workspace: CodeWorkspace | null, pick: string): string {
  return workspace?.projects.some((p) => p.id === pick) ? pick : "";
}

const NOTES_MAX = 20_000;

/**
 * The task's chip for a code thread. It always names the LifeOS task, so the
 * host links the thread to it and Done names that thread. A workspace linked
 * to the task's sector reads LifeOS itself, as any linked workspace does;
 * any other is handed the title and notes as text, and nothing more.
 */
export function codeThreadChip(task: { _id: string; title: string }, notes: string | undefined, readsLifeos: boolean): ContextChip {
  const chip: ContextChip = { kind: "task", label: task.title.slice(0, 500), ref: { at: "lifeos", table: "tasks", id: task._id } };
  const text = notes?.trim();
  return readsLifeos || !text ? chip : { ...chip, quote: text.slice(0, NOTES_MAX) };
}
