import { useMemo } from "react";
import type { SectorKey } from "@shared/work";
import type { TasksDone } from "@shared/contract-work-tasks";
import { isTodayTask, snoozeUntil } from "work-kit/lifeos/tasks";
import { formatDue } from "work-kit/views/lib/format";
import { registry } from "../../lib/connection";
import { useMinute } from "../tasks/minute";
import { act, mutate, sessionDown, useLifeosRows } from "./lifeos";
import { goTo } from "./open";
import { useStableRows } from "./stable";
import { comeBack, leave } from "./store";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Due: the tasks of every job that work-kit's own rule puts in its Today
 * group (pinned, or due before the next local midnight), from LifeOS's
 * `tasks:list` on the all-sector session, so this list and the Tasks view
 * never disagree. The tick is the Tasks view's: Done goes through the job's
 * host (`work.tasks.done`), so a task a thread worked completes with that
 * thread's link. Tomorrow snoozes it to the next morning.
 */

const SECTION: TodaySection = { id: "due", title: "Due", order: 30, empty: "Nothing due today", fold: 7, lifeos: true };

export type DueTask = { _id: string; title: string; sector: SectorKey; status: string; priority?: string; dueAt?: number; pinned?: boolean };

export const taskKey = (id: string): string => `task:${id}`;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Ways = {
  workspaceOf(sector: SectorKey): TodayWorkspace | null;
  open(workspace: TodayWorkspace, task: DueTask): void;
  done(workspace: TodayWorkspace, task: DueTask): Promise<void>;
  tomorrow(task: DueTask): Promise<void>;
};

/**
 * Today's tasks as rows: the most overdue first, then today's by time, then
 * those pinned with no date. The fact is what the Tasks view says of the due
 * time, late once it has passed. A sector with no job is left out.
 */
export function dueRows(tasks: readonly DueTask[], now: number, ways: Ways, timeZone = zone): TodayRow[] {
  return tasks
    .filter((task) => isTodayTask(task, now, timeZone) && ways.workspaceOf(task.sector))
    .map((task): TodayRow => {
      const workspace = ways.workspaceOf(task.sector)!;
      return {
        key: taskKey(task._id),
        section: SECTION.id,
        sector: task.sector,
        title: task.title,
        ...(task.dueAt !== undefined ? { at: task.dueAt, when: formatDue(task.dueAt, now), ...(task.dueAt < now ? { late: true } : {}) } : {}),
        lead: { kind: "tick", label: `Mark ${task.title} done`, run: () => ways.done(workspace, task) },
        open: () => ways.open(workspace, task),
        acts: [{ label: "Tomorrow", run: () => ways.tomorrow(task) }],
      };
    });
}

const pick = (value: DueTask[]): DueTask[] => value;
const idOf = (task: DueTask): string => task._id;
const NO_ARGS = {};
const NONE: readonly TodayRow[] = [];

/** One of his acts on a task: the row leaves at once, and comes back if the act fails or he undoes it. */
async function away<T>(key: string, run: () => Promise<T>): Promise<T> {
  leave(key);
  try {
    return await run();
  } catch (error) {
    comeBack(key);
    throw error;
  }
}

function useDue(env: TodayEnv): TodayAnswer {
  const now = useMinute();
  const read = useLifeosRows<DueTask[], DueTask>(env, "tasks:list", NO_ARGS, pick, idOf);
  const lifeos = env.lifeos;
  const built = useMemo(
    () =>
      read.rows &&
      dueRows(read.rows, now, {
        workspaceOf: env.workspaceOf,
        open: (workspace, task) => goTo(workspace, { view: "tasks", task: task._id }),
        done: (workspace, task) =>
          away(taskKey(task._id), () =>
            act({
              run: () => registry.linkOf(workspace.environmentId).request<TasksDone>("work.tasks.done", { workspaceId: workspace.workspaceId, taskId: task._id }),
              message: "Marked done",
              failed: "mark done",
              undo: () => mutate(lifeos, "tasks:reopen", { id: task._id }).finally(() => comeBack(taskKey(task._id))),
            }),
          ).then(() => undefined),
        tomorrow: (task) =>
          away(taskKey(task._id), () =>
            act({
              run: () => mutate(lifeos, "tasks:snooze", { id: task._id, until: snoozeUntil("tomorrow", Date.now(), zone) }),
              message: "Snoozed until tomorrow",
              failed: "snooze",
              undo: () => mutate(lifeos, "tasks:unsnooze", { id: task._id }).finally(() => comeBack(taskKey(task._id))),
            }),
          ).then(() => undefined),
      }),
    [read.rows, now, env.workspaceOf, lifeos],
  );
  const rows = useStableRows(built ?? NONE);
  const down = sessionDown(lifeos);
  const host = lifeos.environmentId;
  return useMemo<TodayAnswer>(() => {
    if (read.error && !down) return { rows: [], failed: [{ environmentId: host, error: read.error }] };
    if (!built) return { loading: true };
    return { rows };
  }, [built, rows, read.error, down, host]);
}

export const source: TodaySource = { id: "due", section: SECTION, use: useDue };
