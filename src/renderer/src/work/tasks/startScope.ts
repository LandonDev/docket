import type { ContextChip } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { openLifeosProject } from "../shell/actions";
import type { WorkViewProps } from "../views/registry";

/**
 * Where a thread about a LifeOS task starts (docs/agents/work.md "Threads file into their projects"): under its
 * project's mirror, as Projects' Start a thread does (`work.project.open`, made the first time), so the thread sits
 * under the project in the column and on its page. A project that is finished, or that the host could not open, starts
 * it loose in the job with one quiet line; nothing blocks the start. Every view's Start thread on a task goes through
 * here: Tasks (its rows, lead, menu and sheet, which Today's Due rows open), and Mail on a mail whose task is known.
 */

/** The workspace a start is in: its host, and its folder, a project's cwd. */
export type StartPlace = Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
/** A LifeOS project as the start knows it: its id, and its name and state when it has read them. */
export type StartProject = { id: string; name?: string | undefined; status?: string | undefined };
/** Where the thread starts: under the mirror, or loose in the job with the line that says why (none when there was no project). */
export type StartScope = { at: { cwd: string; projectId: string }; line: null } | { at: null; line: string | null };
type Open = (place: StartPlace, lifeosProjectId: string, name?: string) => Promise<{ id: string }>;

const FINISHED = new Set(["done", "dropped"]);
/** How long a start waits for the host to open the mirror before it starts loose: LifeOS never holds his press. */
export const OPEN_WAIT_MS = 5_000;

/** The one quiet line of a start that could not file under its project. */
export function looseLine(project: StartProject, finished: string | null): string {
  const name = project.name?.trim() || "its project";
  return finished ? `Not filed in ${name}: it is ${finished}` : `Not filed in ${name}: it could not be opened`;
}

/** Waits for `p` at most `ms`, else rejects. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e)),
    );
  });
}

export async function startScope(place: StartPlace, project: StartProject | null | undefined, open: Open = openLifeosProject, waitMs = OPEN_WAIT_MS): Promise<StartScope> {
  if (!project) return { at: null, line: null };
  if (project.status && FINISHED.has(project.status)) return { at: null, line: looseLine(project, project.status) };
  try {
    const mirror = await within(open(place, project.id, project.name), waitMs);
    return { at: { cwd: place.path, projectId: mirror.id }, line: null };
  } catch (error) {
    // The host refuses a project finished since the window read it in its own words ("Fall LAN is done: reopen it…").
    const finished = /\bis (done|dropped)\b/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null;
    return { at: null, line: looseLine(project, finished) };
  }
}

const say = (line: string): void => void loadToast().then((api) => api(line));

/** A view's Start thread on a thing of a LifeOS project: the composer opens under the project, else loose with its line. */
export async function startFiled(
  start: WorkViewProps["startThread"],
  place: StartPlace | null | undefined,
  about: ContextChip,
  project: StartProject | null | undefined,
  o: { open?: Open; waitMs?: number; tell?: (line: string) => void } = {},
): Promise<void> {
  const scope = place && project ? await startScope(place, project, o.open, o.waitMs) : null;
  if (scope?.at) start(about, scope.at);
  else start(about);
  if (scope?.line) (o.tell ?? say)(scope.line);
}

/** What `mail:thread` answers of a mail's open task, all a start needs of it. */
type MailRead = (threadId: string) => Promise<{ task?: { projectId?: string | null } | null } | null | undefined>;

/**
 * The LifeOS project of a mail's open task (LifeOS keeps one task a mail thread), so Mail's Start thread files where a
 * start from that task would. None when the mail has no open task, the task no project, or LifeOS does not answer in
 * time: the thread then starts loose, as a mail's always did.
 */
export async function projectOfMail(read: MailRead, threadId: string, waitMs = OPEN_WAIT_MS): Promise<StartProject | null> {
  try {
    const id = (await within(read(threadId), waitMs))?.task?.projectId;
    return id ? { id } : null;
  } catch {
    return null;
  }
}
