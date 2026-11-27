import { useQuery } from "convex/react";
import { Tip } from "../../components/tip";
import { useEffect } from "react";
import { makeFunctionReference } from "convex/server";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Region } from "../../components/bones";
import { openUrl } from "../../lib/native";
import { formatDue } from "work-kit/views/lib/format";
import type { Task } from "./client";
import { openTaskThread, useLiveLink } from "./links";

/**
 * A task's Open: the task in full in a sheet over the view, as LifeOS reads
 * it (`tasks:get`): when it is due, its project, who it waits on, what it
 * came from in the words it was filed from, its notes. Start thread and Done
 * at its foot, as on the lead, then Open a code thread… as in its menu. A task
 * the open list does not hold (Work Search's done task) is read by its id
 * alone; done or dropped, its sheet only reads, its state at the foot.
 */

type Detail = { task: Task & { description?: string; completedAt?: number; source?: Task["source"] & { quote?: string; permalink?: string } } } | null;

const get = makeFunctionReference<"query">("tasks:get");

/**
 * A task no longer open, by its LifeOS status: its sheet offers nothing to do, and says so at its foot as a fact, never
 * a lone "Done" that reads as a press turned off: when it was done where LifeOS kept the time ("Done yesterday", "Done
 * Nov 24"), else "Marked done"; "Dropped" for a dropped one.
 */
export function closedWords(status: string, completedAt: number | undefined, now = Date.now()): string | undefined {
  if (status === "dropped") return "Dropped";
  if (status !== "done") return undefined;
  if (completedAt === undefined) return "Marked done";
  const day = formatDue(completedAt, now);
  const when = day === "Yesterday" || day === "Tomorrow" ? day.toLowerCase() : day;
  return `Done ${when}`;
}

type Props = {
  /** A task's project name, by its `projectId`. */
  projectOf: (task: Task | undefined) => string | undefined;
  onClose: () => void;
  onStart: (task: Task) => void;
  onDone: (task: Task) => void;
  /** The link's words while it is down: Done is held, with them as its tip (`HeldTip`). */
  heldWords?: string | null;
  onCode: (task: Task) => void;
  /** The thread a link names for a task, if one works on it: Open thread takes Start thread's place; undefined until the link read answers. */
  useThread?: (taskId: string) => string | null | undefined;
};

const noThread = (): string | null => null;

/** `open`: the task's id, and its row where the open list holds it (null: read by id alone). */
export function TaskSheet({ open, ...props }: Props & { open: { id: string; row: Task | null } | null }) {
  return (
    <Sheet open={open !== null} onOpenChange={(next) => !next && props.onClose()}>
      <SheetContent side="right">{open ? <Body key={open.id} id={open.id} row={open.row} {...props} /> : null}</SheetContent>
    </Sheet>
  );
}

function Body({ id, row, projectOf, onClose, onStart, onDone, heldWords = null, onCode, useThread = noThread }: Props & { id: string; row: Task | null }) {
  const detail = useQuery(get, { id }) as Detail | undefined;
  // A linked thread the window holds no meta for yet is still its thread: Open asks the hosts for it (links.ts); one
  // every host answered without (deleted) is none, so Start.
  const threadId = useLiveLink(useThread(id));
  // LifeOS's read over the list's row; a task the list does not hold is its read alone.
  const full = row ? { ...row, ...detail?.task } : (detail?.task ?? undefined);
  // Asked for by id and not found (gone since): nothing to show, so the sheet closes, quietly.
  const gone = detail === null && !row;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  return (
    <Region loading={!full} fill label="Loading the task" bones={SheetBones}>
      {full ? <TaskBody full={full} detail={detail} threadId={threadId} projectOf={projectOf} onClose={onClose} onStart={onStart} onDone={onDone} heldWords={heldWords} onCode={onCode} /> : null}
    </Region>
  );
}

type Full = NonNullable<Detail>["task"];

/** The sheet once the task is known: its facts, the words it came from, its notes, and its presses or its state. */
function TaskBody({ full, detail, threadId, projectOf, onClose, onStart, onDone, heldWords, onCode }: Omit<Props, "useThread"> & { full: Full; detail: Detail | undefined; threadId: string | null | undefined; heldWords: string | null }) {
  const closed = closedWords(full.status, detail?.task.completedAt);
  const project = projectOf(full);
  const source = detail?.task.source;
  const rows: { label: string; value: string }[] = [];
  if (full.dueAt !== undefined) rows.push({ label: "Due", value: formatDue(full.dueAt) });
  if (project) rows.push({ label: "Project", value: project });
  if (full.waitingOn) rows.push({ label: "Waiting on", value: full.waitingOn });
  if (source?.sender) rows.push({ label: "From", value: source.channel?.startsWith("#") ? `${source.sender} in ${source.channel}` : source.sender });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>{full.title}</SheetTitle>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pb-5">
        {/* LifeOS's read is out: its facts drawn from the sample; how many it holds is not known, so they land at their height. */}
        {detail === undefined || rows.length ? (
          <Region loading={detail === undefined} label="" snap bones={<Facts rows={SAMPLE_TASK_FACTS} />}>
            <Facts rows={rows} />
          </Region>
        ) : null}
        {/* The words it was filed from, muted: their tone sets them apart, with no rule down their side. */}
        {source?.quote ? <p className="text-sm leading-[22px] whitespace-pre-wrap text-muted-foreground">{source.quote}</p> : null}
        {detail?.task.description ? <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground">{detail.task.description}</p> : null}
        {source?.permalink ? (
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => void openUrl(source.permalink!)}>
              Open where it came from
            </Button>
          </div>
        ) : null}
      </div>
      {closed ? (
        // The presses' own row, its 28px line in their place: the sheet only reads.
        <p data-task-closed className="shrink-0 border-t border-border px-5 py-3 text-[13px] leading-7 text-muted-foreground">
          {closed}
        </p>
      ) : (
      // A narrow sheet wraps its presses to a second row rather than run one off its edge.
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        {/* The link read is out: the press itself drawn as bones holds its place, so Done does not move when it comes. */}
        <Region loading={threadId === undefined} label="" className="shrink-0" bones={StartPressBones}>
          {threadId ? (
            <Button size="sm" onClick={() => (onClose(), void openTaskThread(threadId, () => onStart(full)))}>
              Open thread
            </Button>
          ) : (
            <Button size="sm" onClick={() => (onClose(), onStart(full))}>
              Start thread
            </Button>
          )}
        </Region>
        {/* Held, it stays a Tab stop (`focusableWhenDisabled`), so the keyboard reaches the reason in its tip as the pointer does:
            the sheet covers the frame's line that says it. */}
        <Tip label={heldWords} disabled={!heldWords}>
          <Button size="sm" variant="secondary" disabled={!!heldWords} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={() => (onClose(), onDone(full))}>
            Done
          </Button>
        </Tip>
        <Button size="sm" variant="ghost" onClick={() => (onClose(), onCode(full))}>
          Open a code thread…
        </Button>
      </div>
      )}
    </div>
  );
}

type Fact = { label: string; value: string };

/** The task's facts: a muted name over its value, a row each. */
function Facts({ rows }: { rows: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a task's facts are drawn from while LifeOS reads them: when it is due and its project. */
export const SAMPLE_TASK_FACTS: readonly Fact[] = [
  { label: "Due", value: "Fri" },
  { label: "Project", value: "Spring LAN" },
];
/** What a sheet asked for by id is drawn from while LifeOS reads it. */
export const SAMPLE_TASK_TITLE = "Print the brackets for the fall cup";

/** The primary press on its way, the lead's and the sheet's: the button itself, at rest. */
export function StartPressBones() {
  return (
    <Button data-press-bone size="sm">
      Start thread
    </Button>
  );
}

/**
 * A task asked for by id while LifeOS reads it: its title and its facts, no presses until its state is known. The
 * title is written out in `SheetTitle`'s type, not the sheet's own title, which would name the dialog with the sample.
 */
function SheetBones() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <h2 className="text-base leading-6 font-semibold tracking-[-0.01em] text-balance text-foreground">{SAMPLE_TASK_TITLE}</h2>
      </SheetHeader>
      <div className="px-5">
        <Facts rows={SAMPLE_TASK_FACTS} />
      </div>
    </div>
  );
}
