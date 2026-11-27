import { ConvexProvider } from "convex/react";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ContextChip } from "@shared/work";
import { useHostLinkDown } from "../shell/hostLinkDown";
import { playRunner } from "../routines/plays/runOn";
import { groupTasks, SNOOZE_CHOICES, SNOOZE_LABELS, TASK_GROUP_LABELS, TASK_GROUPS, type SnoozeChoice } from "work-kit/lifeos/tasks";
import { formatDue } from "work-kit/views/lib/format";
import { ChevronDown, Plus } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { HeldTip } from "../../components/heldTip";
import { Tip, useTruncated } from "../../components/tip";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { ROW_CONTROLS, ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { reveal, yields } from "../../components/ui/reveal";
import { CHECKBOX_BOX, CHECKBOX_SHAPES } from "../../components/ui/checkbox-box";
import { Bones, Region } from "../../components/bones";
import { cn } from "../../lib/cn";
import { moveBetweenRows } from "../rowKeys";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { type Task, type TaskActions, type TasksClient, viewsClients } from "./client";
import { useMinute } from "./minute";
import { useKeptRows, WindowedRows, type RowPlace } from "../windowed";
import { NewTaskDialog } from "./NewTaskDialog";
import { OFFLINE_WORDS, useComputerOffline } from "./offline";
import { shared, useShared } from "./store";
import { sessionWaits } from "../shell/lifeos";
import { downOf, useKeptOpen } from "../shell/lifeosDown";
import { StatusMark } from "../../components/ui/status";
import type { OutcomeTone } from "@shared/work/threadRecord";
import { hasOutcomeMark, OutcomeMark } from "../threads/mark";
import { useSessionMeta } from "../../lib/tcserver/store";
import { rowState } from "../../lib/sidebarRows";
import { marksAtRest } from "../../lib/threadStripModel";
import { openWorkView, useWorkView, workOpenPort } from "../../lib/workSwitch";
import { openTaskThread, useLinkedThread, useLiveLink } from "./links";
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
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it. The
  // list's own region follows them once the session is in, so they do not hold again.
  if (!lifeos.client)
    return sessionWaits(lifeos) ? (
      <Bones label="Loading tasks">
        <TasksBones />
      </Bones>
    ) : null;
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

/**
 * A task's thread as a row draws it: its id, its state in the one vocabulary and what it left him (`workOutcome`);
 * null when no link names a thread; undefined until the link read answers, so neither Start nor Open thread is
 * offered before it is known which is right. A linked thread the window holds no meta for yet keeps its id with no
 * state (and so no mark): it offers Open thread, never Start (links.ts `openTaskThread`), until every host answers
 * without it (deleted): then it is null, and the task offers Start (`useLiveLink`).
 */
export type TaskThread = { id: string; state: ReturnType<typeof rowState> | null; tone: OutcomeTone | null } | null | undefined;
/** The thread a task's open link names; null for none; undefined while the read is out or failed. */
type UseThread = (taskId: string) => string | null | undefined;

function useTaskThread(useThread: UseThread, taskId: string): TaskThread {
  const id = useLiveLink(useThread(taskId));
  const meta = useSessionMeta(id);
  if (id === undefined) return undefined;
  if (!id) return null;
  return { id, state: meta ? rowState({ status: meta.status }) : null, tone: meta?.workOutcome?.tone ?? null };
}

/**
 * The plan's mark for a task's thread (work/projects/kit.tsx `ThreadMark`): what the thread left him first (the
 * Outbox's glyph muted for something held, amber asks, red failed, the spinner working), else its state at rest.
 */
export function taskThreadMark(thread: NonNullable<TaskThread>): { key: string; mark: ReactNode } | null {
  if (hasOutcomeMark(thread.tone)) return { key: thread.tone!, mark: <OutcomeMark tone={thread.tone} /> };
  return thread.state && marksAtRest(thread.state) ? { key: thread.state, mark: <StatusMark state={thread.state} word={false} /> } : null;
}

/** A thread the window knows opens at once; one it holds no meta for is asked of the hosts first, and not found offers `start`. */
const openThread = (thread: NonNullable<TaskThread>, start: () => void): void => void (thread.state ? workOpenPort.get()?.(thread.id) : openTaskThread(thread.id, start));

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
  // The link's words while it is down: Done is held, and its tooltip says why.
  const heldWords = useHostLinkDown(place?.environmentId);
  const doneHeld = !!heldWords;
  const now = useMinute();
  // The rows are memoised: they reach the latest start through a ref, so a new function never redraws them.
  const latest = useRef(startThread);
  latest.current = startThread;
  // Start thread on a task of a LifeOS project files the thread under it (startScope.ts), from a row, the lead, a menu or the sheet.
  const filing = useRef({ place, projects });
  filing.current = { place, projects };
  const start = useMemo(() => (task: Task) => void startFiled(latest.current, filing.current.place, chipOf(task), projectOfTask(task, filing.current.projects)), []);
  const startCode = useMemo((): CodeThreadStart => (about, at) => latest.current(about, at), []);
  // The task whose sheet is open, kept in the workspace's record (lib/workReturn.ts) so coming back opens it again; one
  // asked for by id (a done task from Work search) comes back read by id, never closed for not being on the list.
  const [opened, setOpened] = useState<Opened>(() => {
    const kept = workspaceId ? keptPlace<{ task: string; byId: boolean }>(workspaceId, "tasks", { task: "string", byId: "boolean" }) : {};
    return kept.task ? { id: kept.task, listed: !kept.byId } : null;
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
    if (workspaceId) keepPlace(workspaceId, "tasks", opened ? { task: opened.id, ...(opened.listed ? {} : { byId: true }) } : { task: undefined });
  }, [workspaceId, opened]);
  // A task opened from the list and done or dropped since (here or on another computer) is no longer open: its sheet closes, quietly.
  const missing = !!opened?.listed && !!tasks && !tasks.some((t) => t._id === opened.id);
  useEffect(() => {
    if (missing) setOpened(null);
  }, [missing]);
  const [coding, setCoding] = useState<Task | null>(null);
  const code = useMemo(() => (task: Task) => setCoding(task), []);
  const groupsRead = useMemo(() => (tasks ? groupTasks(tasks, now, zone) : null), [tasks, now]);
  /** The list once the open tasks are read: the lead and its groups, or "Nothing open". */
  const listOf = (groups: NonNullable<typeof groupsRead>): ReactNode => {
    // The open task as the list has it now, its own row; a task asked for by id that the list does not hold is read by id.
    const row = opened ? (tasks?.find((t) => t._id === opened.id) ?? null) : null;
    const sheetOf = opened && (row || !opened.listed) ? { id: opened.id, row } : null;
    const lead = groups.today[0] ?? null;
    const rest = TASK_GROUPS.map((g) => ({ g, rows: g === "today" ? groups.today.slice(1) : groups[g] })).filter((x) => x.rows.length);
    const projectOf = (task: Task | null | undefined): string | undefined => (task ? projects?.get(task.projectId ?? "")?.name : undefined);
    const sheet = (
      <>
        <TaskSheet heldWords={heldWords} open={sheetOf} projectOf={projectOf} onClose={() => setOpened(null)} onStart={start} onDone={(task) => actions.complete(task)} onCode={code} useThread={useThread} />
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
    const meta = (task: Task, inWaiting = false) => metaOf(task, projectOf(task), inWaiting);
    return (
      // ↑ and ↓ move between the rows, as in People and on a meeting's page; Tab still walks each row's tick and Start.
      <div onKeyDown={rowKeys} className={LIST}>
        {lead ? <Lead heldWords={heldWords} task={lead} meta={meta(lead)} now={now} actions={actions} onStart={start} onOpen={open} onCode={code} useThread={useThread} /> : null}
        {rest.map(({ g, rows }, i) => (
          <section key={g} aria-label={TASK_GROUP_LABELS[g]} className={cn("flex flex-col", lead || i ? "mt-6" : "")}>
            {/* The heading starts on its rows' title edge: past the row's inset, the tick and its gap. */}
            <h2 className={GROUP_HEADING}>{TASK_GROUP_LABELS[g]}</h2>
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
                  doneHeld={doneHeld}
                  heldWords={heldWords}
                    key={task._id}
                    task={task}
                    meta={meta(task, g === "waiting")}
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
  };
  return (
    <Region loading={!groupsRead} label="Loading tasks" bones={TasksBones}>
      {groupsRead ? listOf(groupsRead) : null}
    </Region>
  );
}

const idOfTask = (task: Task): string => task._id;

/** A due time inside a line ("Due yesterday"): LifeOS's row label, its day word in lower case after "Due". */
export function dueMidLine(ms: number, now: number): string {
  const due = formatDue(ms, now);
  return due === "Yesterday" || due === "Tomorrow" ? due.toLowerCase() : due;
}

/** A row's second line: who it waits on, else its project, else who asked. Under the Waiting heading the name alone: the heading says the rest. */
export function metaOf(task: Pick<Task, "waitingOn" | "source">, project: string | undefined, inWaiting = false): string | undefined {
  if (task.waitingOn) return inWaiting ? task.waitingOn : `Waiting on ${task.waitingOn}`;
  return project ?? task.source?.sender;
}

/** The list's arrow keys: from anywhere in a row (its tick, its Start) to the open control of the row before or after. */
const rowKeys = (e: KeyboardEvent<HTMLElement>): void => void moveBetweenRows(e, '[role="listitem"]', "[data-row-open]");

function Lead({
  task,
  meta,
  now,
  actions,
  onStart,
  onOpen,
  onCode,
  heldWords,
  useThread,
}: {
  task: Task;
  meta: string | undefined;
  now: number;
  actions: TaskActions;
  onStart: (task: Task) => void;
  onOpen: (task: Task) => void;
  onCode: (task: Task) => void;
  /** The link's words while it is down; Done is held with them as its tip. */
  heldWords: string | null;
  useThread: UseThread;
}) {
  const doneHeld = !!heldWords;
  const offline = useComputerOffline();
  const overdue = task.dueAt !== undefined && task.dueAt < now;
  const thread = useTaskThread(useThread, task._id);
  const lead = thread ? taskThreadMark(thread) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={LEAD} />}>
        {/* No mark beside the title (the owner's rule): the thread's state leads Open thread, as canvas.html's peek leads its line. */}
        <h1 className={LEAD_TITLE}>{task.title}</h1>
        {meta || task.dueAt !== undefined ? (
          <p className={LEAD_LINE}>
            {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
            {task.dueAt !== undefined ? <span className={cn("shrink-0 tabular-nums", overdue ? "text-destructive" : "text-foreground")}>{meta ? ", " : ""}Due {dueMidLine(task.dueAt, now)}</span> : null}
          </p>
        ) : null}
        {/* The presses keep to the column the rows end on: under 22rem Open gives way first, since the task's menu holds it. */}
        <div data-lead-presses className={LEAD_PRESSES}>
          {lead ? (
            // Beside the button, not on its fill: the mark's tone must read on the page.
            <span data-lead-thread={lead.key} className="flex size-4 shrink-0 items-center justify-center">
              {lead.mark}
            </span>
          ) : null}
          {/* The link read is out: the press itself drawn as bones holds its place, so Done and Snooze do not move when it comes. */}
          <Region loading={thread === undefined} label="" className="shrink-0" bones={PressBones}>
            {thread ? (
              <Button size="sm" onClick={() => openThread(thread, () => onStart(task))}>
                Open thread
              </Button>
            ) : (
              <Button size="sm" onClick={() => onStart(task)}>
                Start thread
              </Button>
            )}
          </Region>
          <Tip label={heldWords} disabled={!heldWords}>
            <Button size="sm" variant="secondary" disabled={doneHeld} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={() => actions.complete(task)}>
              Done
            </Button>
          </Tip>
          {/* Snooze writes to LifeOS itself: held only while this computer is offline, a Tab stop whose tip says so. */}
          <DropdownMenu>
            <Tip label={OFFLINE_WORDS} disabled={!offline}>
              <DropdownMenuTrigger disabled={offline} render={<Button size="sm" variant="ghost" focusableWhenDisabled className="aria-disabled:opacity-50" />}>
                Snooze
                <ChevronDown />
              </DropdownMenuTrigger>
            </Tip>
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
      <TaskMenu doneHeld={doneHeld} task={task} thread={thread} actions={actions} onStart={onStart} onOpen={onOpen} onCode={onCode} onDone={() => actions.complete(task)} />
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
  doneHeld,
}: {
  task: Task;
  thread: TaskThread;
  actions: TaskActions;
  onStart: (task: Task) => void;
  onOpen: (task: Task) => void;
  onCode: (task: Task) => void;
  onDone: () => void;
  doneHeld: boolean;
}) {
  const runPlay = playRunner();
  // Snooze writes to LifeOS itself: held only while this computer is offline.
  const offline = useComputerOffline();
  return (
    <ContextMenuContent>
      {thread === undefined ? null : thread ? <ContextMenuItem onClick={() => openThread(thread, () => onStart(task))}>Open thread</ContextMenuItem> : <ContextMenuItem onClick={() => onStart(task)}>Start thread</ContextMenuItem>}
      <ContextMenuItem onClick={() => onCode(task)}>Open a code thread…</ContextMenuItem>
      {runPlay ? <ContextMenuItem onClick={() => runPlay(chipOf(task))}>Run a play…</ContextMenuItem> : null}
      <ContextMenuItem onClick={() => onOpen(task)}>Open</ContextMenuItem>
      <ContextMenuItem disabled={doneHeld} onClick={onDone}>Done</ContextMenuItem>
      <ContextMenuSeparator />
      {SNOOZE_CHOICES.map((choice: SnoozeChoice) => (
        <ContextMenuItem key={choice} disabled={offline} onClick={() => actions.snooze(task, choice)}>
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
  doneHeld,
  heldWords,
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
  doneHeld: boolean;
  /** The link's words while Done is held, its tick's tip. */
  heldWords: string | null;
  useThread: UseThread;
}) {
  const [ticked, setTicked] = useState(false);
  const thread = useTaskThread(useThread, task._id);
  const lead = thread ? taskThreadMark(thread) : null;
  const { ref: cutRef, cut } = useTruncated(`${task.title}\n${meta ?? ""}`);
  // A Done that failed (its toast says so) puts the row back as it was.
  const complete = () => void Promise.resolve(actions.complete(task)).then((r) => r === undefined && setTicked(false));
  const done = useRef(complete);
  done.current = complete;
  useEffect(() => {
    if (!ticked) return;
    if (doneHeld) return setTicked(false);
    const timer = window.setTimeout(() => done.current(), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [ticked, doneHeld]);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div role="listitem" {...place} className={cn("group/row", ROW, ROW_HOLDS)} />}>
        {/* The open control lies over the whole row, so keyboard focus rings the row; the tick and Start sit above it. */}
        {/* A title or line the column cuts is said whole on the row's hover and focus, only while one is cut (Agenda's rule). */}
        <Tooltip disabled={!cut}>
          <TooltipTrigger render={<ItemButton data-row-open aria-label={`Open ${task.title}`} onClick={() => onOpen(task)} className={ROW_OPEN} />} />
          <TooltipContent side="top" align="start">
            {task.title}
            {meta ? <span className="block">{meta}</span> : null}
          </TooltipContent>
        </Tooltip>
        {/* Its press reaches 8px a side, a 32px target that ends where the title starts, so the title opens the row. */}
        {/* Held, the tick says why on hover (`HeldTip`), as Done on the lead and in the sheet does. */}
        <HeldTip held={heldWords} className={ROW_CONTROLS}>
          <Checkbox shape="round" className={cn("mt-0.5 after:-inset-x-2", ROW_CONTROLS)} checked={ticked} disabled={doneHeld} onCheckedChange={setTicked} aria-label={`Mark ${task.title} done`} />
        </HeldTip>
        <span ref={cutRef} className={cn(ROW_WORDS, ROW_SHOWS)}>
          <span className={cn(ROW_TITLE, "transition-colors duration-(--dur-fast)", ticked && "text-muted-foreground line-through")}>{task.title}</span>
          {meta ? <span className={ROW_META}>{meta}</span> : null}
        </span>
        {lead ? (
          <span data-task-thread={lead.key} className={cn("flex h-5 shrink-0 items-center", ROW_SHOWS, yields("row"))}>
            {lead.mark}
          </span>
        ) : null}
        {due ? <span className={cn("shrink-0 text-xs leading-5 tabular-nums", ROW_SHOWS, overdue ? "text-destructive" : "text-muted-foreground", yields("row"))}>{due}</span> : null}
        {/* The 24px press centred on the title's 20px line. */}
        <span className={cn("absolute top-1 right-2", reveal("row", { row: true, overlay: true }))}>
          {thread === undefined ? null : thread ? (
            <Button size="xs" variant="ghost" onClick={() => openThread(thread, () => onStart(task))}>
              Open thread
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => onStart(task)}>
              Start thread
            </Button>
          )}
        </span>
      </ContextMenuTrigger>
      <TaskMenu doneHeld={doneHeld} task={task} thread={thread} actions={actions} onStart={onStart} onOpen={onOpen} onCode={onCode} onDone={() => setTicked(true)} />
    </ContextMenu>
  );
});

/*
 * The list's boxes and type, shared by the rows and the bones that stand for them, so a drawn row is the row that lands.
 */
const LIST = "mx-auto flex w-full max-w-[720px] flex-col px-6 py-6";
const LEAD = "flex flex-col gap-1 px-3";
const LEAD_TITLE = "min-w-0 text-base leading-6 font-semibold tracking-[-0.01em] text-foreground";
const LEAD_LINE = "flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground";
const LEAD_PRESSES = "@container/leadpresses mt-3 flex items-center gap-2";
const GROUP_HEADING = "mb-1 ps-9 pe-3 text-xs font-medium text-muted-foreground";
const ROW = "flex min-h-8 items-start gap-2 rounded-md px-3 py-1.5";
const ROW_WORDS = "flex min-w-0 flex-1 flex-col";
const ROW_TITLE = "max-w-full truncate text-[13px] leading-5 text-foreground";
const ROW_META = "max-w-full truncate text-xs text-muted-foreground";

/** What the list is drawn from while it loads: a lead and one group of four rows, each with its line (Waiting's, a project). */
export const SAMPLE_TASKS = {
  lead: { title: "Send the spring budget to the committee", meta: "Spring LAN", due: "Due Fri" },
  group: "This week",
  rows: [
    { id: "sample:task-1", title: "Book the bus for the regional", meta: "Waiting on Dana Lee" },
    { id: "sample:task-2", title: "Approve the scrim schedule", meta: "Spring LAN" },
    { id: "sample:task-3", title: "Order the prize headsets for the finals", meta: "Equipment" },
    { id: "sample:task-4", title: "Ask about the east hall", meta: "Facilities" },
  ],
} as const;

/** The primary press on its way: the button itself, at rest. */
function PressBones() {
  return (
    <Button data-press-bone size="sm">
      Start thread
    </Button>
  );
}

/**
 * The list at rest, drawn from the sample in the lead's and the rows' own boxes and type. Written out, not the rows
 * themselves: a row asks the hosts for its thread, subscribes to the window's threads and takes the list's keys.
 */
function TasksBones() {
  const { lead, group, rows } = SAMPLE_TASKS;
  return (
    <div data-tasks-bones className={LIST}>
      <div className={LEAD}>
        <h1 className={LEAD_TITLE}>{lead.title}</h1>
        <p className={LEAD_LINE}>
          <span className="min-w-0 truncate">{lead.meta}</span>
          <span className="shrink-0 tabular-nums">, {lead.due}</span>
        </p>
        <div data-bones-presses className={LEAD_PRESSES}>
          <PressBones />
          <Button size="sm" variant="secondary">
            Done
          </Button>
          <Button size="sm" variant="ghost">
            Snooze
            <ChevronDown />
          </Button>
          <Button size="sm" variant="ghost" className="@max-[22rem]/leadpresses:hidden">
            Open
          </Button>
        </div>
      </div>
      <div className="mt-6 flex flex-col">
        <h2 data-bones-heading className={GROUP_HEADING}>
          {group}
        </h2>
        {rows.map((row) => (
          <div key={row.id} className={ROW}>
            {/* The tick's own box; empty, it is drawn as one block. */}
            <span skullet-block="" className={cn(CHECKBOX_BOX, CHECKBOX_SHAPES.round, "mt-0.5")} />
            <span className={ROW_WORDS}>
              <span className={ROW_TITLE}>{row.title}</span>
              <span className={ROW_META}>{row.meta}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
