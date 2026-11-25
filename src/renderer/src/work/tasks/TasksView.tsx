import { ConvexProvider } from "convex/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ContextChip } from "@shared/work";
import { playRunner } from "../routines/plays/runOn";
import { groupTasks, SNOOZE_CHOICES, SNOOZE_LABELS, TASK_GROUP_LABELS, TASK_GROUPS, type SnoozeChoice } from "work-kit/lifeos/tasks";
import { formatDue } from "work-kit/views/lib/format";
import { ChevronDown, Plus } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { ROW_CONTROLS, ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { reveal, yields } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { type Task, type TaskActions, type TasksClient, viewsClients } from "./client";
import { useMinute } from "./minute";
import { useKeptRows, WindowedRows, type RowPlace } from "../windowed";
import { NewTaskDialog } from "./NewTaskDialog";
import { shared, useShared } from "./store";
import { sessionWaits } from "../shell/lifeos";
import { downOf, useKeptOpen } from "../shell/lifeosDown";
import { StatusMark } from "../../components/ui/status";
import { useSessionMeta } from "../../lib/tcserver/store";
import { rowState } from "../../lib/sidebarRows";
import { marksAtRest } from "../../lib/threadStripModel";
import { openWorkView, useWorkView, workOpenPort } from "../../lib/workSwitch";
import { useLinkedThread } from "./links";
import { TaskSheet } from "./TaskSheet";
import { keepPlace, keptPlace } from "../shell/place";
import { CodeThreadDialog, type CodeThreadStart } from "./CodeThreadDialog";
import { startFiled, type StartPlace, type StartProject } from "./startScope";

/**
 * A Work workspace's Tasks (prototype workspace.html, "Four rows"): its
 * sector's open tasks from LifeOS, the first of Today as the lead with its
 * verbs, then Today, This week, Later and Waiting. Start thread puts the task
 * in a new thread's composer as a chip and runs nothing; Done is the owner
 * accepting the work, so a task a thread here worked completes with that
 * thread's link. A task a thread already works on shows that thread's mark,
 * and Open thread takes Start's place everywhere, so a second press never
 * makes a second thread (prototype workspace.html). Open a code thread… in a
 * task's menu starts one in a code workspace instead (CodeThreadDialog). The rows come through the shared task client
 * (work-kit's views) on the workspace's narrowed session.
 */

/** How long a ticked row holds so the tick reads, before it leaves (LifeOS's own). */
const HOLD_MS = 350;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The header's New task asks the view for its dialog. */
const newTask = shared(false);

/** New task, while its dialog can open: the body that holds it reads LifeOS, so a session that is down offers none. */
export function Head({ lifeos }: WorkViewProps) {
  if (downOf(lifeos)) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => newTask.set(true)}>
      <Plus />
      New task
    </Button>
  );
}

const closeNewTask = (): void => newTask.set(false);

/**
 * New task's dialog, the frame's (`Kept`), not the body's: a session that drops while it is open takes the rows away,
 * never what he typed. The dialog says the session's line and holds Add until it is back; a press made while the session
 * was on its way, which then went down, is dropped (`useKeptOpen`).
 */
export function Kept({ sector, lifeos }: WorkViewProps) {
  const adding = useShared(newTask);
  useEffect(() => closeNewTask, []);
  return useKeptOpen(adding, lifeos, closeNewTask) ? <NewTaskDialog sector={sector} session={lifeos} onClose={closeNewTask} /> : null;
}

export function View({ env, workspace, sector, lifeos, startThread }: WorkViewProps) {
  const clients = useMemo(() => viewsClients(env, workspace.id, sector), [env, workspace.id, sector]);
  // A task asked for from elsewhere (a person's page, Work Search) opens in its sheet: taken once, then cleared. Each
  // request is a fresh object, so the same task asked for twice opens its sheet twice.
  const wanted = useWorkView();
  const asked = wanted?.workspaceId === workspace.id && wanted.view === "tasks" ? wanted.task : undefined;
  const [openTask, setOpenTask] = useState<OpenRequest | undefined>(undefined);
  useEffect(() => {
    if (!asked) return;
    setOpenTask({ id: asked });
    openWorkView({ workspaceId: workspace.id, view: "tasks" });
  }, [asked, workspace.id]);
  const taken = useMemo(() => () => setOpenTask(undefined), []);
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!lifeos.client) return sessionWaits(lifeos) ? <TasksSkeleton /> : null;
  return (
    <ConvexProvider client={lifeos.client}>
      <Tasks client={clients.tasks} sector={sector} startThread={startThread} useThread={useLinkedThread} openTask={openTask} onOpenTaken={taken} workspaceId={workspace.id} place={workspace} />
    </ConvexProvider>
  );
}

/** A request to open a task's sheet: one object a request, so asking for the same task again is a new request. */
export type OpenRequest = { id: string };

/**
 * The task whose sheet is open. `listed`: opened from the open list (a row, the lead, the kept place), so the sheet
 * closes once the task leaves it; a task asked for by id (Work Search's done task) is read by id alone and stays.
 */
type Opened = { id: string; listed: boolean } | null;

const chipOf = (task: Task): ContextChip => ({ kind: "task", label: task.title, ref: { at: "lifeos", table: "tasks", id: task._id } });

/** A task's LifeOS project as Start thread files it: its id, and its name and state as the list read them. */
function projectOfTask(task: Task, projects: ReadonlyMap<string, { name: string }> | undefined): StartProject | null {
  const id = task.projectId;
  if (!id) return null;
  const row = projects?.get(id) as { name: string; status?: string } | undefined;
  return { id, name: row?.name, status: row?.status };
}

/** No thread lookup (a test, a preview): every task offers Start. */
const noThread = (): string | null => null;

/** A task's thread as a row draws it: its id and its state in the one vocabulary; null when no thread this window knows works on it. */
export type TaskThread = { id: string; state: ReturnType<typeof rowState> } | null;
type UseThread = (taskId: string) => string | null;

function useTaskThread(useThread: UseThread, taskId: string): TaskThread {
  const id = useThread(taskId);
  const meta = useSessionMeta(id);
  return id && meta ? { id, state: rowState({ status: meta.status }) } : null;
}

const openThread = (thread: NonNullable<TaskThread>): void => workOpenPort.get()?.(thread.id);

export function Tasks({
  client,
  sector = null,
  startThread,
  useThread = noThread,
  openTask,
  onOpenTaken,
  workspaceId,
  place,
}: {
  client: TasksClient;
  /** The workspace whose record keeps the open sheet; absent (a test, a preview), nothing is kept. */
  workspaceId?: string;
  /** Where Start thread files a task of a LifeOS project (startScope.ts); absent (a test, a preview), every start is loose. */
  place?: StartPlace;
  /** A task whose sheet opens when it is given (a person's page or Work Search asked for it), done tasks too. */
  openTask?: OpenRequest | undefined;
  /** Told once the sheet took `openTask`, so the request is cleared. */
  onOpenTaken?: () => void;
  /** The workspace's sector: a code workspace linked to it reads the task in LifeOS. */
  sector?: string | null;
  startThread: (about: ContextChip, at?: { cwd: string; projectId: string | null }) => void;
  useThread?: UseThread;
}) {
  // A push answers every open task again: each task that holds what it held stays the same object, so its memoised row
  // does not draw (the perf pass's M12).
  const tasks = useKeptRows(client.useOpenTasks() ?? null, idOfTask);
  const projects = client.useProjectsById();
  const actions = client.useTaskActions();
  const now = useMinute();
  // The rows are memoised: they reach the latest start through a ref, so a new function never redraws them.
  const latest = useRef(startThread);
  latest.current = startThread;
  // Start thread on a task of a LifeOS project files the thread under it (startScope.ts), from a row, the lead, a menu or the sheet.
  const filing = useRef({ place, projects });
  filing.current = { place, projects };
  const start = useMemo(() => (task: Task) => void startFiled(latest.current, filing.current.place, chipOf(task), projectOfTask(task, filing.current.projects)), []);
  const startCode = useMemo((): CodeThreadStart => (about, at) => latest.current(about, at), []);
  // The task whose sheet is open, kept in the workspace's record (lib/workReturn.ts) so coming back opens it again.
  const [opened, setOpened] = useState<Opened>(() => {
    const kept = workspaceId ? keptPlace<{ task: string }>(workspaceId, "tasks", { task: "string" }).task : undefined;
    return kept ? { id: kept, listed: true } : null;
  });
  const open = useMemo(() => (task: Task) => setOpened({ id: task._id, listed: true }), []);
  const takenRef = useRef(onOpenTaken);
  takenRef.current = onOpenTaken;
  useEffect(() => {
    if (!openTask) return;
    setOpened({ id: openTask.id, listed: false });
    takenRef.current?.();
  }, [openTask]);
  useEffect(() => {
    if (workspaceId) keepPlace(workspaceId, "tasks", { task: opened?.id });
  }, [workspaceId, opened]);
  // A task opened from the list and done or dropped since (here or on another computer) is no longer open: its sheet closes, quietly.
  const missing = !!opened?.listed && !!tasks && !tasks.some((t) => t._id === opened.id);
  useEffect(() => {
    if (missing) setOpened(null);
  }, [missing]);
  const [coding, setCoding] = useState<Task | null>(null);
  const code = useMemo(() => (task: Task) => setCoding(task), []);
  const groups = useMemo(() => (tasks ? groupTasks(tasks, now, zone) : null), [tasks, now]);
  if (!groups) return <TasksSkeleton />;
  // The open task as the list has it now, its own row; a task asked for by id that the list does not hold is read by id.
  const row = opened ? (tasks?.find((t) => t._id === opened.id) ?? null) : null;
  const sheetOf = opened && (row || !opened.listed) ? { id: opened.id, row } : null;
  const lead = groups.today[0] ?? null;
  const rest = TASK_GROUPS.map((g) => ({ g, rows: g === "today" ? groups.today.slice(1) : groups[g] })).filter((x) => x.rows.length);
  const projectOf = (task: Task | null | undefined): string | undefined => (task ? projects?.get(task.projectId ?? "")?.name : undefined);
  const sheet = (
    <>
      <TaskSheet open={sheetOf} projectOf={projectOf} onClose={() => setOpened(null)} onStart={start} onDone={(task) => actions.complete(task)} onCode={code} useThread={useThread} />
      {coding ? <CodeThreadDialog task={coding} sector={sector} onStart={startCode} onClose={() => setCoding(null)} /> : null}
    </>
  );
  if (!lead && !rest.length)
    return (
      <>
        <EmptyState title="Nothing open" />
        {sheet}
      </>
    );
  const meta = (task: Task) => metaOf(task, projectOf(task));
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      {lead ? <Lead task={lead} meta={meta(lead)} now={now} actions={actions} onStart={start} onOpen={open} onCode={code} useThread={useThread} /> : null}
      {rest.map(({ g, rows }, i) => (
        <section key={g} aria-label={TASK_GROUP_LABELS[g]} className={cn("flex flex-col", lead || i ? "mt-6" : "")}>
          {/* The heading starts on its rows' title edge: past the row's inset, the tick and its gap. */}
          <h2 className="mb-1 ps-9 pe-3 text-xs font-medium text-muted-foreground">{TASK_GROUP_LABELS[g]}</h2>
          {/* Past 80 rows only those near the screen are mounted, each with its place in the group (work/windowed.tsx). */}
          <WindowedRows
            count={rows.length}
            rowHeight={32}
            getKey={(index) => rows[index]!._id}
            sizeKey="work-tasks-list"
            render={(index, place) => {
              const task = rows[index]!;
              return (
                <TaskRow
                  key={task._id}
                  task={task}
                  meta={meta(task)}
                  due={task.dueAt === undefined ? undefined : formatDue(task.dueAt, now)}
                  overdue={task.dueAt !== undefined && task.dueAt < now}
                  actions={actions}
                  onStart={start}
                  onOpen={open}
                  onCode={code}
                  useThread={useThread}
                  place={place}
                />
              );
            }}
          />
        </section>
      ))}
      {sheet}
    </div>
  );
}

const idOfTask = (task: Task): string => task._id;

/** A due time inside a line ("Due yesterday"): LifeOS's row label, its day word in lower case after "Due". */
export function dueMidLine(ms: number, now: number): string {
  const due = formatDue(ms, now);
  return due === "Yesterday" || due === "Tomorrow" ? due.toLowerCase() : due;
}

/** A row's second line: who it waits on, else its project, else who asked. */
function metaOf(task: Task, project: string | undefined): string | undefined {
  if (task.waitingOn) return `Waiting on ${task.waitingOn}`;
  return project ?? task.source?.sender;
}

function Lead({
  task,
  meta,
  now,
  actions,
  onStart,
  onOpen,
  onCode,
  useThread,
}: {
  task: Task;
  meta: string | undefined;
  now: number;
  actions: TaskActions;
  onStart: (task: Task) => void;
  onOpen: (task: Task) => void;
  onCode: (task: Task) => void;
  useThread: UseThread;
}) {
  const overdue = task.dueAt !== undefined && task.dueAt < now;
  const thread = useTaskThread(useThread, task._id);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex flex-col gap-1 px-3" />}>
        {/* No mark beside the title (the owner's rule): the thread's state leads Open thread, as canvas.html's peek leads its line. */}
        <h1 className="min-w-0 text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{task.title}</h1>
        {meta || task.dueAt !== undefined ? (
          <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
            {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
            {task.dueAt !== undefined ? <span className={cn("shrink-0 tabular-nums", overdue ? "text-destructive" : "text-foreground")}>{meta ? ", " : ""}Due {dueMidLine(task.dueAt, now)}</span> : null}
          </p>
        ) : null}
        {/* The presses keep to the column the rows end on: under 22rem Open gives way first, since the task's menu holds it. */}
        <div data-lead-presses className="@container/leadpresses mt-3 flex items-center gap-2">
          {thread && marksAtRest(thread.state) ? (
            // Beside the button, not on its fill: the mark's tone must read on the page.
            <span data-lead-thread={thread.state} className="flex size-4 shrink-0 items-center justify-center">
              <StatusMark state={thread.state} word={false} />
            </span>
          ) : null}
          {thread ? (
            <Button size="sm" onClick={() => openThread(thread)}>
              Open thread
            </Button>
          ) : (
            <Button size="sm" onClick={() => onStart(task)}>
              Start thread
            </Button>
          )}
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
          <Button size="sm" variant="ghost" className="@max-[22rem]/leadpresses:hidden" onClick={() => onOpen(task)}>
            Open
          </Button>
        </div>
      </ContextMenuTrigger>
      <TaskMenu task={task} thread={thread} actions={actions} onStart={onStart} onOpen={onOpen} onCode={onCode} onDone={() => actions.complete(task)} />
    </ContextMenu>
  );
}

/** A task's menu, the lead's and a row's alike: its thread first, then a code thread, Open, Done and the snoozes. */
function TaskMenu({
  task,
  thread,
  actions,
  onStart,
  onOpen,
  onCode,
  onDone,
}: {
  task: Task;
  thread: TaskThread;
  actions: TaskActions;
  onStart: (task: Task) => void;
  onOpen: (task: Task) => void;
  onCode: (task: Task) => void;
  onDone: () => void;
}) {
  const runPlay = playRunner();
  return (
    <ContextMenuContent>
      {thread ? <ContextMenuItem onClick={() => openThread(thread)}>Open thread</ContextMenuItem> : <ContextMenuItem onClick={() => onStart(task)}>Start thread</ContextMenuItem>}
      <ContextMenuItem onClick={() => onCode(task)}>Open a code thread…</ContextMenuItem>
      {runPlay ? <ContextMenuItem onClick={() => runPlay(chipOf(task))}>Run a play…</ContextMenuItem> : null}
      <ContextMenuItem onClick={() => onOpen(task)}>Open</ContextMenuItem>
      <ContextMenuItem onClick={onDone}>Done</ContextMenuItem>
      <ContextMenuSeparator />
      {SNOOZE_CHOICES.map((choice: SnoozeChoice) => (
        <ContextMenuItem key={choice} onClick={() => actions.snooze(task, choice)}>
          Snooze {SNOOZE_LABELS[choice].toLowerCase()}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
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
  onOpen,
  onCode,
  useThread,
  place,
}: {
  task: Task;
  meta: string | undefined;
  due: string | undefined;
  overdue: boolean;
  /** Its place in a windowed group, for a screen reader. */
  place?: RowPlace;
  actions: TaskActions;
  onStart: (task: Task) => void;
  onOpen: (task: Task) => void;
  onCode: (task: Task) => void;
  useThread: UseThread;
}) {
  const [ticked, setTicked] = useState(false);
  const thread = useTaskThread(useThread, task._id);
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
      <ContextMenuTrigger render={<div role="listitem" {...place} className={cn("group/row flex min-h-8 items-start gap-2 rounded-md px-3 py-1.5", ROW_HOLDS)} />}>
        {/* The open control lies over the whole row, so keyboard focus rings the row; the tick and Start sit above it. */}
        <ItemButton data-row-open aria-label={`Open ${task.title}`} onClick={() => onOpen(task)} className={ROW_OPEN} />
        <Checkbox shape="round" className={cn("mt-0.5", ROW_CONTROLS)} checked={ticked} onCheckedChange={setTicked} aria-label={`Mark ${task.title} done`} />
        <span className={cn("flex min-w-0 flex-1 flex-col", ROW_SHOWS)}>
          <span className={cn("max-w-full truncate text-[13px] leading-5 text-foreground transition-colors duration-(--dur-fast)", ticked && "text-muted-foreground line-through")}>{task.title}</span>
          {meta ? <span className="max-w-full truncate text-xs text-muted-foreground">{meta}</span> : null}
        </span>
        {thread && marksAtRest(thread.state) ? (
          <span data-task-thread={thread.state} className={cn("flex h-5 shrink-0 items-center", ROW_SHOWS, yields("row"))}>
            <StatusMark state={thread.state} word={false} />
          </span>
        ) : null}
        {due ? <span className={cn("shrink-0 text-xs leading-5 tabular-nums", ROW_SHOWS, overdue ? "text-destructive" : "text-muted-foreground", yields("row"))}>{due}</span> : null}
        <span className={cn("absolute top-1.5 right-2", reveal("row", { row: true, overlay: true }))}>
          {thread ? (
            <Button size="xs" variant="ghost" onClick={() => openThread(thread)}>
              Open thread
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => onStart(task)}>
              Start
            </Button>
          )}
        </span>
      </ContextMenuTrigger>
      <TaskMenu task={task} thread={thread} actions={actions} onStart={onStart} onOpen={onOpen} onCode={onCode} onDone={() => setTicked(true)} />
    </ContextMenu>
  );
});

/** The list's shape while it loads, on the insets of what replaces it: the lead (title, due line, presses), then a group's heading and its rows. */
function TasksSkeleton() {
  return (
    <div aria-hidden data-tasks-bones className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      <div className="flex flex-col gap-1 px-3">
        <div className="flex h-6 items-center">
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-1/4" />
        </div>
        <div data-bones-presses className="mt-3 flex h-8 items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-lg" />
          <Skeleton className="h-8 w-14 rounded-lg" />
        </div>
      </div>
      <div className="mt-6 flex flex-col">
        <div data-bones-heading className="mb-1 flex h-4 items-center ps-9 pe-3">
          <Skeleton className="h-3 w-12" />
        </div>
        {["w-2/3", "w-1/2", "w-3/5", "w-2/5"].map((w) => (
          <div key={w} className="flex min-h-8 items-start gap-2 px-3 py-1.5">
            <Skeleton className="mt-0.5 size-4 rounded-full" />
            <div className="flex flex-1 flex-col">
              <div className="flex h-5 items-center">
                <Skeleton className={cn("h-3.5", w)} />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-1/5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
