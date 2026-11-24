import { useEffect, useState } from "react";
import { useMailClient, type BatchAct, type ThreadSummary } from "work-kit/mail";
import { TRIAGE_TICKED, type MailOffer } from "@shared/work/mailChat";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { localOf } from "./AddRow";
import { CARD, FOOT, HEAD } from "./cardParts";

type Rows = Extract<MailOffer, { rows: unknown }>["rows"];

/** The press's verb and its past, by act: "Archive 3", "Archived 3". */
const VERB: Record<Rows["act"], [string, string]> = { archive: ["Archive", "Archived"], read: ["Mark read", "Marked read"], needsMe: ["Mark needs me", "Marked needs me"], snooze: ["Snooze", "Snoozed"] };

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (ms: number): string => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

/** A row read again is the same row unless what the card shows or acts on changed: a client may answer a fresh object each time. */
const sameRow = (a: ThreadSummary | null, b: ThreadSummary | null): boolean =>
  a === b || (!!a && !!b && a.id === b.id && a.version === b.version && a.subject === b.subject && a.lastMessageAt === b.lastMessageAt && a.archived === b.archived);

/** The act as Mail's own bulk act takes it, or null when it cannot run (a snooze with no time to wake). */
export function batchOf(rows: Pick<Rows, "act" | "snoozeUntil">): BatchAct | null {
  if (rows.act === "archive") return { kind: "archive", archived: true };
  if (rows.act === "read") return { kind: "read", read: true };
  if (rows.act === "needsMe") return { kind: "flag", needsMe: true };
  const until = localOf(rows.snoozeUntil)?.getTime() ?? NaN;
  return Number.isFinite(until) && until > Date.now() ? { kind: "snooze", until } : null;
}

/**
 * Rows the chat proposes an act on ("Archive 4 notices"): each a mail of the job with a tick, ticked to start
 * (`TRIAGE_TICKED`); one press in the foot runs Mail's own bulk act on the ticked ones, with its one Undo. A row
 * this job's mail does not hold has no tick.
 */
export function RowsCard({ rows }: { rows: Rows }) {
  const client = useMailClient();
  const actions = client.useMailActions();
  const [threads, setThreads] = useState<Record<string, ThreadSummary | null>>({});
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => (TRIAGE_TICKED ? new Set() : new Set(rows.threadIds)));
  const [done, setDone] = useState<{ n: number; at: number } | null>(null);
  const act = batchOf(rows);
  const ticked = rows.threadIds.filter((id) => threads[id] && !unticked.has(id));
  const [verb, past] = VERB[rows.act];
  const run = (): void => {
    if (!act || ticked.length === 0) return;
    actions.batch(
      ticked.map((id) => threads[id]!),
      act,
    );
    setDone({ n: ticked.length, at: Date.now() });
  };
  return (
    <div data-mail-offer="rows" className={CARD}>
      <div className={HEAD}>
        <h4 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{rows.title}</h4>
      </div>
      <ul className="flex flex-col pb-1">
        {rows.threadIds.map((id) => (
          <RowOf
            key={id}
            id={id}
            ticked={!unticked.has(id)}
            locked={!!done}
            onThread={(thread) => setThreads((was) => (id in was && sameRow(was[id]!, thread) ? was : { ...was, [id]: thread }))}
            onTick={(on) =>
              setUnticked((was) => {
                const next = new Set(was);
                if (on) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        ))}
      </ul>
      <div className={FOOT}>
        {done ? (
          <span className="text-xs text-muted-foreground">
            {past} {done.n}, {clock(done.at)}
          </span>
        ) : (
          <Button variant="secondary" size="sm" disabled={!act || ticked.length === 0} onClick={run}>
            {verb} {ticked.length}
          </Button>
        )}
      </div>
    </div>
  );
}

function RowOf({ id, ticked, locked, onThread, onTick }: { id: string; ticked: boolean; locked: boolean; onThread(thread: ThreadSummary | null): void; onTick(on: boolean): void }) {
  const view = useMailClient().useMailThread(id);
  const thread = view?.thread ?? null;
  // The card's count reads the rows that loaded; one this job's mail does not hold has no tick.
  const loaded = view !== undefined;
  useEffect(() => {
    if (loaded) onThread(thread);
    // onThread compares rows by what they show, so an equal row read again changes nothing.
  }, [loaded, thread, onThread]);
  const sender = thread?.senders[0] ?? "";
  return (
    <li data-row={id} className="flex h-9 items-center gap-2.5 px-3">
      {view === undefined ? (
        <span className="size-3.5 shrink-0" />
      ) : thread ? (
        <Checkbox checked={ticked} disabled={locked} aria-label={thread.subject} onCheckedChange={(on) => onTick(!!on)} />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className={`min-w-0 flex-1 truncate text-[13px] ${thread ? "text-foreground" : "text-muted-foreground"}`}>{thread ? thread.subject : view === undefined ? "" : "Not in this job's mail"}</span>
      {sender ? <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{sender}</span> : null}
      {thread ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{day(thread.lastMessageAt)}</span> : null}
    </li>
  );
}
