// A Work thread's head: what it left him, at the top of its transcript (docs/DESIGN.md "A thread's head").
import { useEffect, useState, type ReactNode } from "react";
import type { ThreadRecord, RecordMade, RecordWait, RecordWork } from "@shared/work/threadRecord";
import { kindOfEntry } from "@shared/work/files";
import { Outbox, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection";
import { openUrl } from "../../lib/native";
import { useSessionMetaValue } from "../../lib/tcserver/store";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workErrorWords } from "../../lib/workErrorWords";
import { openWorkView } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { KindGlyph as FileGlyph } from "../../work/files/KindGlyph";
import { openInFiles } from "../../work/files/openFrom";
import { Task } from "../../work/icons";
import { readThreadRecord } from "../../work/threads/record";
import { HeldDetail, rememberOutboxTab } from "../../work/outbox/OutboxView";
import { KindGlyph, rowWords } from "../../work/outbox/parts";
import { useOutbox, wantOutboxItem, type HostItem } from "../../work/outbox/store";
import { heldWhen } from "../../work/outbox/when";
import { useTranscriptHost } from "../transcriptSession";

/**
 * The head of a Work thread's transcript: what waits on him (a question, a
 * failure, a request, each held act), the LifeOS task it works on with who
 * it waits on, and what it made or changed, each row opening its thing. It
 * scrolls with the transcript and sits above the thread's first message, with
 * "From the task …" under it when the thread came from a task the head no
 * longer lists (one now done). Quiet: one row
 * grid, no card, held muted, amber only for a question, red for a failure.
 * The record is the host's (`work.threads.record`, work/threads/record.ts),
 * read again when the thread's folded outcome or state moves.
 */
export function WorkHead({ sessionId }: { sessionId: string }) {
  const env = useTranscriptHost();
  const record = useThreadRecord(env, sessionId);
  if (!env || !record) return null;
  return <WorkHeadView record={record} environmentId={env} />;
}

/** The record, read at mount and again when what the rail shows of the thread moves; null until it lands, or where the host refuses it. */
export function useThreadRecord(env: string | null | undefined, sessionId: string): ThreadRecord | null {
  const [record, setRecord] = useState<ThreadRecord | null>(null);
  // What moves when the record does: the folded outcome (an Outbox item, a Result) and the thread's own state.
  const outcome = useSessionMetaValue(sessionId, (meta) => `${meta.status}|${meta.workOutcome?.tone ?? ""}|${meta.workOutcome?.words ?? ""}`);
  // A held item decided anywhere moves the Outbox's own list, whatever the thread's outcome says.
  const waiting = useOutbox().waiting.filter((item) => item.environmentId === env).length;
  useEffect(() => {
    if (!env) return;
    let live = true;
    readThreadRecord(env, sessionId).then(
        (next) => live && setRecord(next),
        // A key that may not read it, or a host a release behind: the head is not drawn, the transcript is.
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [env, sessionId, outcome, waiting]);
  return record;
}

/** "Waiting on Sam Ortiz, 6 days": who, and for how long once it is a day. */
export function waitingWords(name: string, since: number | null, now = Date.now()): string {
  const days = since === null ? 0 : Math.floor((now - since) / 86_400_000);
  return days >= 1 ? `Waiting on ${name}, ${days} ${days === 1 ? "day" : "days"}` : `Waiting on ${name}`;
}

/** A task's second line: who it waits on, else when it is due; late in red. */
function taskLine(work: RecordWork, now: number): { text: string; late: boolean } | null {
  if (work.state === "done") return { text: "Done", late: false };
  const task = work.task;
  if (!task) return null;
  if (task.waitingOn) return { text: waitingWords(task.waitingOn.name, task.waitingOn.since, now), late: false };
  if (task.due === null) return null;
  const today = new Date(now).setHours(0, 0, 0, 0);
  return { text: `Due ${heldWhen(task.due, now)}`, late: task.due < today };
}

const failed = (error: unknown): void => void loadToast().then((toast) => toast.error(workErrorWords(error)));

/** Where a made thing opens: a Files tab of its job, a page on the web, or its project. */
function openMade(env: string, made: RecordMade): (() => void) | undefined {
  const open = made.open;
  if (!open) return undefined;
  if (open.at === "files") return () => void openInFiles({ id: open.workspaceId, environmentId: env }, { ref: open.ref, name: open.name }).catch(failed);
  if (open.at === "url") return () => void openUrl(open.url).catch(failed);
  return () => openWorkView({ workspaceId: open.workspaceId, view: "projects", project: open.projectId });
}

export function WorkHeadView({ record, environmentId: env, now = Date.now() }: { record: ThreadRecord; environmentId: string; now?: number }) {
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const outbox = useOutbox().waiting;
  const workspaces = useWorkspaces();
  const environments = useEnvironments();
  const tasks = record.works.filter((w) => w.table === "tasks");
  // The task it came from: the first it was linked to (its first send's chip). Said over the first message only when
  // the head has no row for it (a task now done): an open task is the head's own row, and nothing is said twice.
  const first = tasks.length ? tasks.reduce((a, b) => (b.at < a.at ? b : a)) : null;
  const from = first && first.state !== "open" ? first : null;
  const openTask = (work: RecordWork) => (record.workspaceId ? () => openWorkView({ workspaceId: record.workspaceId!, view: "tasks", task: work.id }) : undefined);
  const held = record.waits.flatMap((w) => (w.kind === "held" ? [w.item] : []));
  // The Outbox's own copy, kept current by its pushes, where it has one; else the record's.
  const itemOf = (key: string): HostItem | null => {
    const mine = held.find((i) => keyOf(i) === key);
    if (!mine) return null;
    return outbox.find((i) => i.environmentId === env && keyOf(i) === key) ?? { ...mine, environmentId: env };
  };
  const shownItem = heldKey ? itemOf(heldKey) : null;
  const rows: ReactNode[] = [
    ...record.waits.map((wait) => <WaitRow key={waitKey(wait)} wait={wait} env={env} now={now} onOpenHeld={setHeldKey} />),
    ...tasks.filter((w) => w.state === "open").map((work) => {
      const line = taskLine(work, now);
      return <Row key={`task:${work.id}`} lead={<Task className="size-3.5" />} title={work.title} detail={line?.text} late={line?.late} onOpen={openTask(work)} label={`Open the task ${work.title}`} />;
    }),
    ...record.made.map((made) => (
      <Row
        key={`made:${made.id}`}
        lead={<FileGlyph kind={kindOfEntry(made.name).kind} tinted={false} className="size-3.5 shrink-0" />}
        title={made.name}
        fact={`${made.verb} ${heldWhen(made.at, now)}`}
        onOpen={openMade(env, made)}
        label={made.open?.at === "files" ? `Open ${made.name} in Files` : `Open ${made.name}`}
      />
    )),
  ];
  if (!rows.length && !from) return null;
  return (
    <>
      {rows.length ? (
        <section data-work-head aria-label="What this thread left you" className="mb-5 flex min-w-0 flex-col border-b border-border pb-3">
          {rows}
        </section>
      ) : null}
      {from ? <FromTask title={from.title} onOpen={openTask(from)} /> : null}
      <Sheet open={shownItem !== null} onOpenChange={(open) => (open ? undefined : setHeldKey(null))}>
        <SheetContent side="right" width={520} showCloseButton={false} aria-label={shownItem?.summary ?? "Held item"} data-work-head-held>
          <div className="flex h-10 shrink-0 items-center justify-end border-b border-border ps-8 pe-6">
            <SheetClose aria-label="Close" render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}>
              <X />
            </SheetClose>
          </div>
          {shownItem ? (
            <HeldDetail
              key={heldKey}
              item={shownItem}
              workspace={workspaces.find((w) => w.environmentId === env && w.id === shownItem.workspaceId)?.name ?? "Work Chats"}
              host={environments.find((e) => e.id === env)?.name ?? "A host"}
              alone
              via="outbox"
              onOpenSession={() => setHeldKey(null)}
              onPressed={() => setHeldKey(null)}
              onReview={() => {
                setHeldKey(null);
                rememberOutboxTab("done");
                shell.openOutbox();
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

const keyOf = (item: Pick<HostItem, "ref">): string => `${item.ref.at}:${item.ref.id}`;
const waitKey = (wait: RecordWait): string => (wait.kind === "held" ? `held:${keyOf(wait.item)}` : wait.kind === "request" ? `request:${wait.id}` : wait.kind);

function WaitRow({ wait, env, now, onOpenHeld }: { wait: RecordWait; env: string; now: number; onOpenHeld: (key: string) => void }) {
  switch (wait.kind) {
    case "asks":
      // The question's own card is in the transcript; the head names it once, amber.
      return <Row lead={<StatusMark state="waiting" word={false} />} title="Asks you" />;
    case "failed":
      return <Row lead={<StatusMark state="failed" word={false} />} title={wait.words} detail={wait.cause ?? undefined} tone="failed" />;
    case "request":
      return (
        <Row
          lead={<Outbox className="size-3.5" />}
          title={wait.head}
          fact={`Asked ${heldWhen(wait.at, now)}`}
          label={`Open the request in the Outbox: ${wait.head}`}
          onOpen={() => {
            wantOutboxItem(`request:${env}:${wait.id}`);
            shell.openOutbox();
          }}
        />
      );
    case "held": {
      const item = wait.item;
      const { act, about } = rowWords(item);
      const sendFailed = item.state === "failed";
      const detail = sendFailed ? (item.error ?? "Couldn't send") : item.state === "stale" ? "Out of date" : (about ?? item.account ?? undefined);
      return (
        <Row
          lead={<KindGlyph kind={item.kind} className="size-3.5" />}
          title={act}
          detail={detail}
          late={sendFailed || item.state === "stale"}
          fact={`Held ${heldWhen(item.createdAt, now)}`}
          label={`Open ${act}`}
          onOpen={() => onOpenHeld(keyOf(item))}
        />
      );
    }
  }
}

/**
 * One row of the head: a 14px lead in the transcript's glyph column, the
 * title with an optional 12px second line, and a trailing fact. A row with
 * somewhere to go is a button (hover `foreground/5`, press `foreground/12`, at
 * once); its fill reaches 8px past the column so the glyphs sit on the
 * transcript's own.
 */
function Row({ lead, title, detail, late, fact, tone, onOpen, label }: { lead: ReactNode; title: string; detail?: string; late?: boolean; fact?: string; tone?: "failed"; onOpen?: () => void; label?: string }) {
  const body = (
    <>
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">{lead}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-[13px] leading-5", tone === "failed" ? "text-destructive" : "text-foreground")}>{title}</span>
        {detail ? <span className={cn("truncate text-xs leading-4", late ? "text-destructive" : "text-muted-foreground")}>{detail}</span> : null}
      </span>
      {fact ? <span className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{fact}</span> : null}
    </>
  );
  const frame = "-mx-2 flex min-h-8 min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left";
  if (!onOpen)
    return (
      <div data-head-row className={frame}>
        {body}
      </div>
    );
  return (
    <button type="button" data-head-row aria-label={label} onClick={onOpen} className={cn(frame, "focus-ring hover:bg-foreground/5 active:bg-foreground/12")}>
      {body}
    </button>
  );
}

/** "From the task …" over the first message: the task the thread came from, opening its sheet. */
function FromTask({ title, onOpen }: { title: string; onOpen?: () => void }) {
  return (
    <div data-from-task className="flex justify-end pb-1">
      <span className="flex max-w-[85%] min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
        <span className="shrink-0">From the task</span>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="min-w-0 truncate rounded-sm text-foreground focus-ring hover:underline">
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate text-foreground">{title}</span>
        )}
      </span>
    </div>
  );
}

/** The title bar's crumb rides this chunk too (chrome/ThreadHeader.tsx). */
export { WorkCrumb } from "../../chrome/WorkCrumb";
