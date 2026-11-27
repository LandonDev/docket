import type { BoardDigest } from "@server/shared/contract-batch";
import { STATUS_WORD, threadStateOf, type ThreadState } from "../../../components/ui/status";
import type { TodoItem } from "../../../lib/tcserver/todos";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { leadStripped } from "../../../lib/threads/agents";
import { marksAtRest, settledWithAgents } from "../../../lib/threadStripModel";
import { GROUP_LABEL, groupOf, type GroupedMeta } from "../../../lib/threadGroups";
import { detailText, sentenceStart } from "@shared/statusWords";
import { watchPhrase } from "@shared/watch";
import { clockTime } from "./useMasterModel";

/**
 * What a board row says under its title (docs/LAYOUT.md "Master"): the
 * thread's state in the vocabulary (components/ui/status.tsx) and what
 * that state is about, from its meta and its digest (the host's
 * `batch.board`, boardDigest.ts). The section heading says the state's
 * word, so the row says only the detail. Pure, so the dom tests read the
 * same rules the row draws.
 */

export type RowStatus = { state: ThreadState; detail: string };

const NO_TASKS: TodoItem[] = [];

/** The current task list from the digest, or none before the first. */
export function taskList(digest: Pick<BoardDigest, "todos">): TodoItem[] {
  return digest.todos ?? NO_TASKS;
}

/** The notes' State line, else the last words; empty when it has said nothing yet. */
export function summaryLine(digest: Pick<BoardDigest, "state" | "last">): string {
  return digest.state || digest.last || "";
}

/** The task in hand: the one in progress; null when none is. */
export function taskInHand(todos: readonly TodoItem[]): string | null {
  return todos.find((t) => t.status === "in_progress")?.content.trim() || null;
}

/** "3/7" once the thread has a task list; null before. */
export function taskTally(tasks: readonly TodoItem[]): string | null {
  if (tasks.length === 0) return null;
  return `${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`;
}

/** The thread types whose rows carry the task bar: the ones that work
 *  through a task list toward a branch. */
export const BAR_TYPES: ReadonlySet<string> = new Set(["implementation", "orchestration"]);

/** An implementation or orchestration row's tasks, done of total, once it
 *  has a task list, whatever its state; null for every other row. The bar
 *  line draws it while the thread is live, and while its list folds away
 *  (MasterRow); `taskBar` is the live rule alone. */
export function taskProgress(meta: Pick<SessionMeta, "threadType">, digest: Pick<BoardDigest, "todos">): { done: number; total: number } | null {
  const tasks = taskList(digest);
  if (tasks.length === 0 || !BAR_TYPES.has(meta.threadType ?? "")) return null;
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length };
}

/** The bar line's share, done of total: an implementation or orchestration
 *  row once it has a task list, until it sits under Done (finished, landed
 *  or stopped: groupOf); null for every other row, and for a finished one
 *  (they keep the tally at the end of line two). */
export function taskBar(meta: Pick<SessionMeta, "threadType"> & GroupedMeta, digest: Pick<BoardDigest, "todos">): { done: number; total: number } | null {
  return groupOf(meta) === "done" ? null : taskProgress(meta, digest);
}

/** A row's state and its detail. An idle thread on the board has had a
 *  turn, so it is done; one whose subagents still work is watching them
 *  (the strip's rule, threadStatus). The detail: the task in hand or the
 *  activity while working, the question or the approval while waiting,
 *  the failure, what it watches or waits for in the queue (without the
 *  lead the word already says), what a paused thread was doing, then for
 *  the child that blocks the batch's end the reason (`blocked`, batchWords'
 *  words), when it landed, else a research or orchestration thread's
 *  summary once done. A detail is written as the host says it (a sentence
 *  with its capital, a name or a count as it is) and ends without a full
 *  stop (docs/DESIGN.md "Status vocabulary"). */
export function rowStatus(
  meta: Pick<SessionMeta, "status" | "activity" | "statusDetail" | "failure" | "updatedAt" | "threadType" | "background">,
  digest: Pick<BoardDigest, "todos" | "state" | "last" | "question" | "failure">,
  landed: boolean,
  blocked: string | null = null,
): RowStatus {
  const own = threadStateOf(meta.status, { settled: meta.status === "idle" });
  const state = settledWithAgents(own, meta.background) ? "watching" : own;
  const activity = meta.activity?.trim() ?? "";
  const said = (detail: string | null | undefined): RowStatus => ({ state, detail: detailText(detail) ?? "" });
  // The batch's words for the child it waits on ("ended its turn without
  // completing", batchWords.ts) read as a sentence of their own here.
  const why = sentenceStart(detailText(blocked));
  switch (state) {
    case "working":
      return said((meta.threadType === "implementation" && taskInHand(taskList(digest))) || detailText(meta.statusDetail) || activity);
    case "waiting":
      return said(digest.question?.trim() || (activity ? `Approve ${activity}` : ""));
    case "failed":
      return said(digest.failure?.trim() || meta.failure?.summary.trim() || why);
    case "watching":
      return said(detailText(meta.statusDetail) || watchPhrase(meta.background) || leadStripped(activity, state));
    case "queued":
      return said(leadStripped(activity, state, meta.statusDetail));
    case "paused":
      // What it was doing: an implementation's task in hand, else the
      // activity (the host's bare "Paused" would repeat the word).
      return said((meta.threadType === "implementation" && taskInHand(taskList(digest))) || (/^paused\b/i.test(activity) ? "" : activity));
    case "stopped":
      return said(why);
    case "done":
      if (why) return said(why);
      if (landed) return said(`Landed ${clockTime(meta.updatedAt)}`);
      return said(meta.threadType === "research" || meta.threadType === "orchestration" ? summaryLine(digest) : "");
    default:
      return said(why);
  }
}

/** Line two would say nothing: no glyph at rest, the section already says
 *  the word, no detail and no tally. The row then draws line one alone
 *  (a Done chat or research child that never lands), never a blank strip. */
export function lineTwoEmpty(state: ThreadState, ownWord: boolean, detail: string, tally: string | null): boolean {
  return !marksAtRest(state) && !ownWord && !detail && !tally;
}

/** `lineTwoEmpty` from a row's facts, for a row whose task bar is not shown
 *  (the board's size estimate asks it before the row is drawn). */
export function oneLineRow(
  meta: Parameters<typeof rowStatus>[0] & GroupedMeta,
  digest: Parameters<typeof rowStatus>[1],
  landed: boolean,
  blocked: string | null = null,
): boolean {
  const { state, detail } = rowStatus(meta, digest, landed, blocked);
  const group = groupOf(meta);
  const tasks = taskList(digest);
  const tally = group === "done" && tasks.every((t) => t.status === "completed") ? null : taskTally(tasks);
  return lineTwoEmpty(state, STATUS_WORD[state] !== GROUP_LABEL[group], detail, tally);
}

/** The New pass dialog's one line under the title: the board row's own
 *  status, else the thread's last words. */
export function passLine(
  meta: Pick<SessionMeta, "status" | "activity" | "statusDetail" | "failure" | "updatedAt" | "threadType" | "background">,
  digest: BoardDigest,
  landed: boolean,
): RowStatus {
  const status = rowStatus(meta, digest, landed);
  return status.detail ? status : { state: status.state, detail: digest.last ?? "" };
}
