import type { HeldRef } from "@shared/work";
import type { MergedJob } from "@shared/work/review";
import { registry } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { openWorkView, workOpenPort } from "../../lib/workSwitch";
import { project } from "../../stores/project";
import { shell } from "../../stores/shell";
import { startThreadAbout } from "../shell/WorkColumn";
import { WORK_VIEWS } from "../views/registry";

/**
 * Where a row of the review goes when pressed: its thing in its own view. A
 * task opens in Tasks, a mail in Mail, a meeting in Agenda, each in the
 * job's workspace, which comes forward; a held item opens the Outbox, whose
 * press it stays. A job with no workspace on a host this window reaches has
 * nowhere to open, and its rows are plain.
 */
export type Target =
  | { at: "task"; id: string }
  | { at: "mail"; threadId: string }
  | { at: "meeting"; eventId: string }
  | { at: "held"; ref: HeldRef };

/** The job's workspace this window can open: one on a linked host, the first first. */
export function workspaceOf(job: Pick<MergedJob, "at">): WorkspaceMeta | null {
  const all = workspaceStore.getSnapshot().workspaces;
  for (const at of job.at) {
    if (registry.statusOf(at.environmentId).transport !== "open") continue;
    const workspace = all.find((w) => w.environmentId === at.environmentId && w.id === at.workspaceId);
    if (workspace) return workspace;
  }
  return null;
}

export const canOpen = (job: Pick<MergedJob, "at">, target: Target): boolean => target.at === "held" || workspaceOf(job) !== null;

export function openTarget(job: Pick<MergedJob, "at">, target: Target): void {
  if (target.at === "held") return void shell.openOutbox();
  const workspace = workspaceOf(job);
  if (!workspace) return;
  shell.closeViews();
  project.enterWorkspace(workspace.path);
  if (target.at === "task") openWorkView({ workspaceId: workspace.id, view: "tasks", task: target.id });
  else if (target.at === "mail") openWorkView({ workspaceId: workspace.id, view: "mail", mail: target.threadId });
  else openWorkView({ workspaceId: workspace.id, view: "agenda", event: target.eventId });
}

/**
 * Follow up a meeting: its page in Prep once Prep's view is in this build (notes, tasks and the follow-up mail
 * start there); until then a new thread in the job's workspace with the event's chip in its composer.
 */
export function followUp(job: Pick<MergedJob, "at">, event: { id: string; title: string }): void {
  const workspace = workspaceOf(job);
  if (!workspace) return;
  if ("prep" in WORK_VIEWS) {
    shell.closeViews();
    project.enterWorkspace(workspace.path);
    return openWorkView({ workspaceId: workspace.id, view: "prep", event: event.id });
  }
  startThreadAbout({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event.id } }, null, workspace.path);
}

/** The thread a nudge started, opened where it runs. */
export function openThread(sessionId: string): void {
  shell.closeViews();
  workOpenPort.get()?.(sessionId);
}
