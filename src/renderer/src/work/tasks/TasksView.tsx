import { ConvexProvider } from "convex/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ContextChip } from "@shared/work";
import { groupTasks, SNOOZE_CHOICES, SNOOZE_LABELS, TASK_GROUP_LABELS, TASK_GROUPS, type SnoozeChoice } from "work-kit/lifeos/tasks";
import { formatDue } from "work-kit/views/lib/format";
import { ChevronDown } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { reveal, yields } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { type Task, type TaskActions, type TasksClient, viewsClients } from "./client";
import { useMinute } from "./minute";

/**
 * A Work workspace's Tasks (prototype workspace.html, "Four rows"): its
 * sector's open tasks from LifeOS, the first of Today as the lead with its
 * verbs, then Today, This week, Later and Waiting. Start thread puts the task
 * in a new thread's composer as a chip and runs nothing; Done is the owner
 * accepting the work, so a task a thread here worked completes with that
 * thread's link. The rows come through the shared task client
 * (work-kit's views) on the workspace's narrowed session.
 */

/** How long a ticked row holds so the tick reads, before it leaves (LifeOS's own). */
const HOLD_MS = 350;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function View({ env, workspace, sector, lifeos, startThread }: WorkViewProps) {
  const clients = useMemo(() => viewsClients(env, workspace.id, sector), [env, workspace.id, sector]);
  if (!lifeos.client) return <TasksSkeleton />;
  return (
    <ConvexProvider client={lifeos.client}>
      <Tasks client={clients.tasks} startThread={startThread} />
    </ConvexProvider>
  );
}

const chipOf = (task: Task): ContextChip => ({ kind: "task", label: task.title, ref: { at: "lifeos", table: "tasks", id: task._id } });

export function Tasks({ client, startThread }: { client: TasksClient; startThread: (about: ContextChip) => void }) {
  const tasks = client.useOpenTasks();
  const projects = client.useProjectsById();
  const actions = client.useTaskActions();
  const now = useMinute();
  // The rows are memoised: they reach the latest start through a ref, so a new function never redraws them.
  const latest = useRef(startThread);
  latest.current = startThread;
  const start = useMemo(() => (task: Task) => latest.current(chipOf(task)), []);
  const groups = useMemo(() => (tasks ? groupTasks(tasks, now, zone) : null), [tasks, now]);
  if (!groups) return <TasksSkeleton />;
  const lead = groups.today[0] ?? null;
  const rest = TASK_GROUPS.map((g) => ({ g, rows: g === "today" ? groups.today.slice(1) : groups[g] })).filter((x) => x.rows.length);
  if (!lead && !rest.length) return <EmptyState title="Nothing open" />;
  const meta = (task: Task) => metaOf(task, projects?.get(task.projectId ?? "")?.name);
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      {lead ? <Lead task={lead} meta={meta(lead)} now={now} actions={actions} onStart={start} /> : null}
      {rest.map(({ g, rows }, i) => (
        <section key={g} aria-label={TASK_GROUP_LABELS[g]} className={cn("flex flex-col", lead || i ? "mt-6" : "")}>
          <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">{TASK_GROUP_LABELS[g]}</h2>
          {rows.map((task) => (
            <TaskRow
              key={task._id}
              task={task}
              meta={meta(task)}
              due={task.dueAt === undefined ? undefined : formatDue(task.dueAt, now)}
              overdue={task.dueAt !== undefined && task.dueAt < now}
              actions={actions}
              onStart={start}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** A row's second line: who it waits on, else its project, else who asked. */
function metaOf(task: Task, project: string | undefined): string | undefined {
  if (task.waitingOn) return `Waiting on ${task.waitingOn}`;
  return project ?? task.source?.sender;
}

function Lead({ task, meta, now, actions, onStart }: { task: Task; meta: string | undefined; now: number; actions: TaskActions; onStart: (task: Task) => void }) {
  const overdue = task.dueAt !== undefined && task.dueAt < now;
  return (
    <div className="flex flex-col gap-1 px-3">
      <h1 className="text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{task.title}</h1>
      {meta || task.dueAt !== undefined ? (
        <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
          {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
          {task.dueAt !== undefined ? <span className={cn("shrink-0 tabular-nums", overdue ? "text-destructive" : "text-foreground")}>{meta ? ", " : ""}Due {formatDue(task.dueAt, now)}</span> : null}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={() => onStart(task)}>
          Start thread
        </Button>
        <Button size="sm" variant="secondary" onClick={() => actions.complete(task)}>
          Done
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
            Snooze
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SNOOZE_CHOICES.map((choice: SnoozeChoice) => (
              <DropdownMenuItem key={choice} onClick={() => actions.snooze(task, choice)}>
                {SNOOZE_LABELS[choice]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * One task: its done circle, its title over one muted line, its due time at
 * the end, which gives way to Start on hover. Memoised, with stable props:
 * what depends on the clock is worked out by the list.
 */
const TaskRow = memo(function TaskRow({
  task,
  meta,
  due,
  overdue,
  actions,
  onStart,
}: {
  task: Task;
  meta: string | undefined;
  due: string | undefined;
  overdue: boolean;
  actions: TaskActions;
  onStart: (task: Task) => void;
}) {
  const [ticked, setTicked] = useState(false);
  // A Done that failed (its toast says so) puts the row back as it was.
  const complete = () => void Promise.resolve(actions.complete(task)).then((r) => r === undefined && setTicked(false));
  const done = useRef(complete);
  done.current = complete;
  useEffect(() => {
    if (!ticked) return;
    const timer = window.setTimeout(() => done.current(), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [ticked]);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div role="listitem" className="group/row relative flex min-h-11 items-start gap-2 rounded-md px-3 py-1.5 transition-colors duration-(--dur-hover) hover:bg-muted" />}
      >
        <Checkbox shape="round" className="mt-0.5" checked={ticked} onCheckedChange={setTicked} aria-label={`Mark ${task.title} done`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-[13px] leading-5 text-foreground transition-colors duration-(--dur-fast)", ticked && "text-muted-foreground line-through")}>{task.title}</span>
          {meta ? <span className="truncate text-xs text-muted-foreground">{meta}</span> : null}
        </span>
        {due ? <span className={cn("shrink-0 text-xs leading-5 tabular-nums", overdue ? "text-destructive" : "text-muted-foreground", yields("row"))}>{due}</span> : null}
        <span className={cn("absolute top-1.5 right-2", reveal("row", { row: true, overlay: true }))}>
          <Button size="xs" variant="ghost" onClick={() => onStart(task)}>
            Start
          </Button>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onStart(task)}>Start thread</ContextMenuItem>
        <ContextMenuItem onClick={() => setTicked(true)}>Done</ContextMenuItem>
        <ContextMenuSeparator />
        {SNOOZE_CHOICES.map((choice: SnoozeChoice) => (
          <ContextMenuItem key={choice} onClick={() => actions.snooze(task, choice)}>
            Snooze {SNOOZE_LABELS[choice].toLowerCase()}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function TasksSkeleton() {
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-9 py-6">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-3 w-1/4" />
      <div className="mt-8 flex flex-col gap-4">
        {["w-2/3", "w-1/2", "w-3/5", "w-2/5"].map((w) => (
          <div key={w} className="flex flex-col gap-1.5">
            <Skeleton className={cn("h-3.5", w)} />
            <Skeleton className="h-3 w-1/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
