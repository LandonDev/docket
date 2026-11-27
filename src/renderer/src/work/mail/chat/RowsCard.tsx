import { useEffect, useState } from "react";
import { useMailClient, type BatchAct, type ThreadSummary } from "work-kit/mail";
import { TRIAGE_TICKED, type MailOffer } from "@shared/work/mailChat";
import { Region } from "../../../components/bones";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { workErrorWords } from "../../../lib/workErrorWords";
import { answerOf } from "../writeAnswer";
import { localOf } from "./AddRow";
import { CARD, FOOT, HEAD } from "./cardParts";

type Rows = Extract<MailOffer, { rows: unknown }>["rows"];

/** The press's verb and its past, by act: "Archive 3", "Archived 3". */
const VERB: Record<Rows["act"], [string, string]> = { archive: ["Archive", "Archived"], read: ["Mark read", "Marked read"], needsMe: ["Mark needs me", "Marked needs me"], snooze: ["Snooze", "Snoozed"] };

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (ms: number): string => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

/** The act in words, for the line a refusal leaves: "LifeOS did not archive them". */
const REFUSED: Record<Rows["act"], (them: string) => string> = { archive: (t) => `archive ${t}`, read: (t) => `mark ${t} read`, needsMe: (t) => `mark ${t} needs me`, snooze: (t) => `snooze ${t}` };

/** The card's own line when LifeOS refused the act and its answer has no plainer words. */
export const refusedLine = (act: Rows["act"], n: number): string => `LifeOS did not ${REFUSED[act](n === 1 ? "it" : "them")}`;

/** The line for rows the job's mail does not hold: "1 other is not in this job's mail", or all of them. */
export function elsewhereLine(elsewhere: number, all: number): string {
  if (elsewhere === all) return all === 1 ? "Not in this job's mail" : "None of these are in this job's mail";
  return elsewhere === 1 ? "1 other is not in this job's mail" : `${elsewhere} others are not in this job's mail`;
}

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
 * Rows the chat proposes an act on ("Billing notices", the press naming the verb and count): each a mail of the job with a tick, ticked to start
 * (`TRIAGE_TICKED`); one press in the foot runs Mail's own bulk act on the ticked ones, with its one Undo. A row
 * this job's mail does not hold has no tick.
 */
export function RowsCard({ rows }: { rows: Rows }) {
  const client = useMailClient();
  const actions = client.useMailActions();
  const [threads, setThreads] = useState<Record<string, ThreadSummary | null>>({});
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => (TRIAGE_TICKED ? new Set() : new Set(rows.threadIds)));
  // The act's own answer drives the card: "Archived 3" only once LifeOS took the write; a refusal gives the rows back with why,
  // and so does a confirmed Undo, with no line.
  const [state, setState] = useState<{ at: "busy" } | { at: "done"; n: number; when: number } | { at: "refused"; why: string } | null>(null);
  const act = batchOf(rows);
  const ticked = rows.threadIds.filter((id) => threads[id] && !unticked.has(id));
  // Rows the job's mail does not hold: no subject to show and nothing to act on, so one line under the rest says how many.
  const elsewhere = rows.threadIds.filter((id) => threads[id] === null).length;
  const [verb, past] = VERB[rows.act];
  const busy = state?.at === "busy";
  // Until every row has read its mail, the count is not known: the press says its verb alone, never "Archive 0".
  const known = rows.threadIds.every((id) => id in threads);
  const run = (): void => {
    if (!act || ticked.length === 0 || busy) return;
    const n = ticked.length;
    setState({ at: "busy" });
    void answerOf(() =>
      actions.batch(
        ticked.map((id) => threads[id]!),
        act,
      ),
    ).then((answer) => {
      if (!answer.ok) return setState({ at: "refused", why: workErrorWords(answer.error, { write: true }) || refusedLine(rows.act, n) });
      const when = Date.now();
      setState({ at: "done", n, when });
      // The toast's Undo put them back: the card says so by giving the rows back, as before the press.
      void answer.undone?.then(() => setState((was) => (was?.at === "done" && was.when === when ? null : was)));
    });
  };
  return (
    <div data-mail-offer="rows" className={CARD}>
      <div className={HEAD}>
        <h4 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{rows.title}</h4>
      </div>
      <ul aria-busy={!known || undefined} className="flex flex-col pb-1">
        {rows.threadIds.map((id) => (
          <RowOf
            key={id}
            id={id}
            ticked={!unticked.has(id)}
            locked={busy || state?.at === "done"}
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
        {elsewhere ? <li className="flex h-9 items-center px-3 text-xs text-muted-foreground">{elsewhereLine(elsewhere, rows.threadIds.length)}</li> : null}
      </ul>
      {state?.at === "refused" ? (
        <p data-rows-refused role="alert" className="px-3 pt-1 pb-2.5 text-xs leading-5 text-destructive">
          {state.why}
        </p>
      ) : null}
      <div className={FOOT}>
        {state?.at === "done" ? (
          <span className="text-xs text-muted-foreground">
            {past} {state.n}, {clock(state.when)}
          </span>
        ) : (
          <Button variant="secondary" size="sm" disabled={!act || !known || ticked.length === 0 || busy} onClick={run}>
            <BusyLabel busy={busy} label={known ? `${verb} ${ticked.length}` : verb} />
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
  // A mail the job's mail does not hold is said once, under the rows (`elsewhereLine`).
  if (loaded && !thread) return null;
  // Still reading: the row itself, drawn from a sample (a tick, a subject, a sender, a date), never a blank 36px.
  return (
    <li data-row={id} data-row-bones={loaded ? undefined : ""} className="flex min-h-9 flex-col">
      <Region loading={!loaded} label="" bones={<RowLine {...SAMPLE_ROW} ticked locked onTick={() => {}} />}>
        {thread ? <RowLine subject={thread.subject} sender={sender} date={day(thread.lastMessageAt)} ticked={ticked} locked={locked} onTick={onTick} /> : null}
      </Region>
    </li>
  );
}

/** What a row is drawn with while its mail reads. */
const SAMPLE_ROW = { subject: "Your November invoice is ready", sender: "Billing", date: "Nov 3" } as const;

function RowLine({ subject, sender, date, ticked, locked, onTick }: { subject: string; sender: string; date: string; ticked: boolean; locked: boolean; onTick(on: boolean): void }) {
  return (
    <div className="flex h-9 items-center gap-2.5 px-3">
      <Checkbox checked={ticked} disabled={locked} aria-label={subject} onCheckedChange={(on) => onTick(!!on)} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{subject}</span>
      {sender ? <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{sender}</span> : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{date}</span>
    </div>
  );
}
