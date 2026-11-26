import { useQuery } from "convex/react";
import { Tip } from "../../components/tip";
import { useEffect } from "react";
import { makeFunctionReference } from "convex/server";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
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
  if (!full) return <SheetBones />;
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
        {detail === undefined ? (
          <div aria-hidden className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        ) : rows.length ? (
          <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
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
        {threadId === undefined ? (
          // The link read is out: a bone in the press's own shape holds its place, so Done does not move when it comes.
          <Skeleton aria-hidden data-press-bone className="h-7 w-[92px] rounded-md" />
        ) : threadId ? (
          <Button size="sm" onClick={() => (onClose(), void openTaskThread(threadId, () => onStart(full)))}>
            Open thread
          </Button>
        ) : (
          <Button size="sm" onClick={() => (onClose(), onStart(full))}>
            Start thread
          </Button>
        )}
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

/** A task asked for by id while LifeOS reads it: the title's bone and two lines, no presses until its state is known. */
function SheetBones() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>
          <Skeleton className="h-4 w-1/2" />
        </SheetTitle>
      </SheetHeader>
      <div aria-hidden className="flex flex-col gap-2 px-5">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    </div>
  );
}
