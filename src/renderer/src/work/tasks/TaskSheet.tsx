import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { openUrl } from "../../lib/native";
import { useSessionMeta } from "../../lib/tcserver/store";
import { workOpenPort } from "../../lib/workSwitch";
import { formatDue } from "work-kit/views/lib/format";
import type { Task } from "./client";

/**
 * A task's Open: the task in full in a sheet over the view, as LifeOS reads
 * it (`tasks:get`): when it is due, its project, who it waits on, what it
 * came from in the words it was filed from, its notes. Start thread and Done
 * at its foot, as on the lead, then Open a code thread… as in its menu.
 */

type Detail = { task: Task & { description?: string; source?: Task["source"] & { quote?: string; permalink?: string } } } | null;

const get = makeFunctionReference<"query">("tasks:get");

type Props = {
  project: string | undefined;
  onClose: () => void;
  onStart: (task: Task) => void;
  onDone: (task: Task) => void;
  onCode: (task: Task) => void;
  /** The thread a link names for a task, if one works on it: Open thread takes Start thread's place. */
  useThread?: (taskId: string) => string | null;
};

const noThread = (): string | null => null;

export function TaskSheet({ task, ...props }: Props & { task: Task | null }) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right">{task ? <Body task={task} {...props} /> : null}</SheetContent>
    </Sheet>
  );
}

function Body({ task, project, onClose, onStart, onDone, onCode, useThread = noThread }: Props & { task: Task }) {
  const detail = useQuery(get, { id: task._id }) as Detail | undefined;
  const threadId = useThread(task._id);
  const thread = useSessionMeta(threadId) ? threadId : null;
  const full = detail?.task ?? task;
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
        {source?.quote ? <p className="border-l border-border pl-3 text-sm leading-[22px] whitespace-pre-wrap text-muted-foreground">{source.quote}</p> : null}
        {detail?.task.description ? <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground">{detail.task.description}</p> : null}
        {source?.permalink ? (
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => void openUrl(source.permalink!)}>
              Open where it came from
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
        {thread ? (
          <Button size="sm" onClick={() => (onClose(), workOpenPort.get()?.(thread))}>
            Open thread
          </Button>
        ) : (
          <Button size="sm" onClick={() => (onClose(), onStart(full))}>
            Start thread
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => (onClose(), onDone(full))}>
          Done
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (onClose(), onCode(full))}>
          Open a code thread…
        </Button>
      </div>
    </div>
  );
}
