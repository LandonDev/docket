import { byTarget as trackerOrder } from "@shared/work/tracker";
import type { ThreadState } from "../../components/ui/status";
import { rowState } from "../../lib/sidebarRows";
import { marksAtRest } from "../../lib/threadStripModel";
import type { ColumnProject } from "./columnProjects";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceIdOf } from "../../lib/tcserver/workspaces";
import { scopeTest, type ProjectGroup, type ThreadRow } from "../../lib/workspaceSessions";

/**
 * A Work job's column below its views (docs/agents/work.md "The column", docs/DESIGN.md "The column"): the job's
 * projects, one row each, then its threads, two lines each. Pure; the rows are drawn by
 * work/shell/WorkColumnRows.tsx. Every fact comes from the session summaries and LifeOS's `projects:list` the
 * column already keeps: no call per row.
 */

/** A row's lead slot, what is live: a state's mark (amber asks, red failed, the spinner, the quieter marks of a
 *  thread at rest), the Outbox's glyph for something held, or nothing. */
export type WorkLead = { kind: "state"; state: ThreadState } | { kind: "held" } | null;

/**
 * A thread's lead: a question first (its status, or a subagent's question folded into its outcome), then a
 * failure, then something held for his press, then the row's own mark (`marksAtRest`: working, watching, paused,
 * …). Held is the Outbox's glyph, muted, never amber (docs/DESIGN.md "Held is not Needs you").
 */
export function threadLead(row: ThreadRow, planReady = false): WorkLead {
  const state = rowState(row, planReady);
  const tone = row.workOutcome?.tone;
  if (state === "waiting" || tone === "asks") return { kind: "state", state: "waiting" };
  if (state === "failed" || tone === "failed") return { kind: "state", state: "failed" };
  if (tone === "held") return { kind: "held" };
  return marksAtRest(state) ? { kind: "state", state } : null;
}

/** What a project's lead can say, most pressing first: its threads' question, failure, held act, live work. */
const PROJECT_LEADS = ["waiting", "failed", "held", "working"] as const;
type ProjectLeadKey = (typeof PROJECT_LEADS)[number];

const leadKey = (lead: WorkLead): ProjectLeadKey | null => {
  if (!lead) return null;
  if (lead.kind === "held") return "held";
  // A thread watching its subagents still works for the project.
  if (lead.state === "watching") return "working";
  return (PROJECT_LEADS as readonly string[]).includes(lead.state) ? (lead.state as ProjectLeadKey) : null;
};

/** A project's lead: the most pressing of its root threads' leads, of the four a project says; else nothing. */
export function projectLead(threads: readonly ThreadRow[]): WorkLead {
  let best: number = PROJECT_LEADS.length;
  for (const thread of threads) {
    const key = leadKey(threadLead(thread));
    if (key) best = Math.min(best, PROJECT_LEADS.indexOf(key));
  }
  const key = (PROJECT_LEADS as readonly ProjectLeadKey[])[best];
  if (!key) return null;
  return key === "held" ? { kind: "held" } : { kind: "state", state: key };
}

/** LifeOS's states the column folds into one quiet row. */
const QUIET = new Set(["paused", "backlog"]);

export type WorkProjectRow = {
  /** The project's id here: a mirror's, or a LifeOS card's (`lifeos:<id>`) before its first thread. */
  id: string;
  lifeosProjectId: string | null;
  name: string;
  lead: WorkLead;
  target: number | null;
  /** LifeOS's state where it says paused or backlog (the fold's words count each); else null. */
  rest?: "paused" | "backlog";
};

export type WorkProjects = {
  /** The projects under way, by target date, none last. */
  rows: WorkProjectRow[];
  /** Paused and backlog with nothing live, behind the one quiet row ("1 paused, 1 in backlog"). */
  quiet: WorkProjectRow[];
};

/** The quiet fold's words, as the tracker says them: "1 paused, 2 in backlog". */
export function quietWords(quiet: readonly Pick<WorkProjectRow, "rest">[]): string {
  const paused = quiet.filter((p) => p.rest !== "backlog").length;
  const backlog = quiet.length - paused;
  return [paused ? `${paused} paused` : null, backlog ? `${backlog} in backlog` : null].filter(Boolean).join(", ");
}

/** The tracker's one order (src/shared/work/tracker.ts `byTarget`): by target date, none last, then by name. */
const byTarget = (a: WorkProjectRow, b: WorkProjectRow): number => trackerOrder({ targetDate: a.target, name: a.name }, { targetDate: b.target, name: b.name });

/**
 * The job's project rows from its groups (`groupWorkspaceSessions` over `withLifeosCards`) and LifeOS's rows:
 * sorted as the tracker sorts, by target date so a row never moves for what its threads do (no target last, then by
 * name); paused and backlog fold into `quiet` unless something in them is live, which keeps its
 * row in the list.
 */
export function workProjectRows(groups: readonly ProjectGroup[], lifeos: readonly (Pick<ColumnProject, "id" | "name"> & Partial<Pick<ColumnProject, "status" | "targetDate">>)[]): WorkProjects {
  const listed = new Map(lifeos.map((row) => [row.id, row]));
  const rows: WorkProjectRow[] = [];
  const quiet: WorkProjectRow[] = [];
  for (const group of groups) {
    const lifeosProjectId = group.project.lifeosProjectId ?? null;
    const from = lifeosProjectId ? listed.get(lifeosProjectId) : undefined;
    const status = from?.status;
    const row: WorkProjectRow = {
      id: group.project.id,
      lifeosProjectId,
      name: from?.name ?? group.project.name,
      lead: projectLead(group.threads),
      target: from?.targetDate ?? null,
      ...(status === "paused" || status === "backlog" ? { rest: status } : {}),
    };
    (status && QUIET.has(status) && !row.lead ? quiet : rows).push(row);
  }
  return { rows: rows.sort(byTarget), quiet: quiet.sort(byTarget) };
}

/** A thread row's second line: its project, then what it left him ("Spring LAN, 1 mail to send"); null when it
 *  has neither. One comma sentence. */
export function threadLine(project: string | null, row: Pick<ThreadRow, "workOutcome">): string | null {
  const facts = [project, row.workOutcome?.words].filter((fact): fact is string => !!fact);
  return facts.length ? facts.join(", ") : null;
}

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(undefined, options)));
  return f;
};
const startOfDay = (at: number): number => new Date(at).setHours(0, 0, 0, 0);
const daysBetween = (at: number, now: number): number => Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

/** A thread row's time: "10:02 AM" today, "Tue" within the week, "Nov 3" this year, "Nov 3, 2025" before. */
export function threadTime(at: number, now: number): string {
  const ago = daysBetween(at, now);
  if (ago <= 0) return format("clock", { hour: "numeric", minute: "2-digit" }).format(at);
  if (ago < 7) return format("weekday", { weekday: "short" }).format(at);
  if (new Date(at).getFullYear() === new Date(now).getFullYear()) return format("day", { month: "short", day: "numeric" }).format(at);
  return format("year", { month: "short", day: "numeric", year: "numeric" }).format(at);
}

/** A project row's end: its target date ("Dec 12", "Jan 9, 2028" in another year), and whether it has passed
 *  (late, red: docs/DESIGN.md "Red means late or failed"). */
export function targetWords(target: number, now: number): { words: string; late: boolean } {
  const sameYear = new Date(target).getFullYear() === new Date(now).getFullYear();
  const words = sameYear ? format("day", { month: "short", day: "numeric" }).format(target) : format("year", { month: "short", day: "numeric", year: "numeric" }).format(target);
  return { words, late: startOfDay(target) < startOfDay(now) };
}

/** An archived thread as the archived list names it (chrome/ThreadListPopover.tsx `ListedThread`). */
export type ArchivedThread = { id: string; title: string; type: SessionMeta["threadType"] | null; updatedAt: number };

/** The archived root threads of a scope (a job, its copies on other hosts, or Work Chats), loose and in projects
 *  alike, freshest first: the list behind the "3 archived" row. */
export function archivedThreads(
  metas: readonly SessionMeta[],
  scope: string | readonly string[],
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
): ArchivedThread[] {
  const inScope = scopeTest(scope);
  return metas
    .filter((meta) => meta.archived && !meta.parentId && inScope(workspaceIdOf(meta, projects, workspaces)))
    .map((meta) => ({ id: meta.id, title: meta.title, type: meta.threadType ?? null, updatedAt: meta.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
