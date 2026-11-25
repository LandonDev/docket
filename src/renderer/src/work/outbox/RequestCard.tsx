import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { Tip } from "../../components/tip";
import { Outbox } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { clockTime } from "../../lib/duration";
import { keyHint } from "../../lib/keys";
import type { Block } from "../../lib/session";
import { storeTitleOf } from "../../lib/threadMentions";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workErrorWords } from "../../lib/workErrorWords";
import { Facts } from "../../surfaces/settings/hosts/Facts";
import { QUESTION_SHAPE } from "../../surfaces/QuestionCard";
import { NoticeLine } from "../../surfaces/transcript/NoticeLine";
import { useTranscriptHost } from "../../surfaces/transcriptSession";
import { pressFailWords } from "./failWords";
import { PickTime, useKeyVerbs, type DetailCommands } from "./HeldDetail";
import { WORK_CHATS_KEY } from "./model";
import { DetailColumn, VerbBar } from "./parts";
import { answerRequest, declineRequest, useRequest, viewRow, type HostRequest } from "./requests";
import { decideMany, loadHost, useOutbox, wantOutboxItem, type DecideDo, type HostItem } from "./store";
import { shell } from "../../stores/shell";
import { ownZone } from "work-kit/mail/lib/zones";
import { SummaryList, type SummaryRow } from "./SummaryList";
import { aheadTime, doneWords, itemKey, resultsHead, summaryHead, type RowResult } from "./waiting";

/**
 * A thread's request for his press (docs/DESIGN.md "The Outbox", "A
 * thread's request"): the items its thread asked about, each with what it
 * would do, ticked where he may press it as drawn, in the summary list. His
 * Send is the window's own `work.outbox.decide({request, receipts})` with
 * the ticked rows' receipts alone; Not now is `decline`. Held is not Needs
 * you: the card wears the Outbox glyph, muted, never the warning colour.
 *
 * Drawn two ways: the transcript's card under the thread's `outbox_request`
 * call (`OutboxRequestRow`), and the Outbox's detail for a row of Asked in
 * threads (`frame="page"`). Not now, run out and refused are one muted line.
 */

const toastError = (line: string) => void loadToast().then((t) => t.error(line));

/** What `outbox_request`'s result names: the request and its host, or the words it was refused with. */
export type RequestRef = { id: string; host: string } | { refused: string };

/** The tool's result, whichever envelope the harness kept it in: the JSON text, its structured content, a text part. */
export function requestOfBlock(block: Pick<Block, "role" | "tool">): RequestRef | null {
  if (block.role !== "tool" || !block.tool?.detail) return null;
  const found = refIn(block.tool.detail);
  if (block.tool.status === "completed" && found && typeof found !== "string") return found;
  // A refused call: its words, its first sentence the one an owner reads ("none of the owner's recent messages …").
  if (block.tool.status !== "completed" || typeof found === "string") {
    const text = typeof found === "string" ? found : textOf(block.tool.detail);
    return { refused: refusalWords(text) };
  }
  return null;
}

function textOf(detail: string): string {
  try {
    const value = JSON.parse(detail) as unknown;
    const text = partText(value);
    return text ?? detail;
  } catch {
    return detail;
  }
}

function partText(value: unknown): string | null {
  const content = Array.isArray(value) ? value : (value as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  const part = content.find((c): c is { type: "text"; text: string } => (c as { type?: unknown })?.type === "text");
  return part?.text ?? null;
}

/** `{outboxRequest: {id, host}}` anywhere in the envelope; else the text it carries (a refusal), else null. */
function refIn(detail: string): { id: string; host: string } | string | null {
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return detail;
  }
  const own = (v: unknown): { id: string; host: string } | null => {
    const r = (v as { outboxRequest?: { id?: unknown; host?: unknown } } | null)?.outboxRequest;
    return r && typeof r.id === "string" && typeof r.host === "string" ? { id: r.id, host: r.host } : null;
  };
  const record = value as { structuredContent?: unknown } | null;
  const found = own(value) ?? own(record?.structuredContent);
  if (found) return found;
  const text = partText(value);
  if (text === null) return null;
  try {
    return own(JSON.parse(text)) ?? text;
  } catch {
    return text;
  }
}

/** "Refused: none of the owner's … Do not ask again …" → its first sentence, without "Refused:". */
export function refusalWords(text: string): string {
  const body = text.replace(/^\s*(Refused|Error)\s*:\s*/i, "").trim();
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(body)?.[0] ?? body;
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** The transcript's row for a thread's `outbox_request` call: the card, or one muted line. */
export function OutboxRequestRow({ block }: { block: Block }) {
  const ref = useMemo(() => requestOfBlock(block), [block]);
  const threadHost = useTranscriptHost();
  if (!ref) return null;
  if ("refused" in ref) return <RequestLine lead="Not asked" detail={ref.refused} />;
  // The host the tool named; a thread on another host than this window's reads its own.
  return <RequestCard environmentId={ref.host || threadHost || ""} id={ref.id} />;
}

/** One muted line where the card was: Not now, run out, or refused. */
function RequestLine({ lead, detail }: { lead: string; detail?: string | null }) {
  return <NoticeLine data-outbox-request-line glyph={<Outbox className="size-3.5 text-muted-foreground" />} lead={lead} details={detail ? [detail] : []} />;
}

/** "Send 3", "Discard 2", "Approve 4" when the actions mix. */
export function pressLabel(dos: readonly ("send" | "discard" | "later")[]): string {
  const kinds = new Set(dos.map((d) => (d === "later" ? "send" : d)));
  const n = dos.length;
  if (kinds.size > 1) return `Approve ${n}`;
  return kinds.has("discard") ? `Discard ${n}` : `Send ${n}`;
}

/** "by you at 9:41 AM", "from another device at 9:41 AM". */
export const answeredWords = (r: Pick<HostRequest, "answeredBy" | "answeredAt">): string =>
  `${r.answeredBy === "owner:remote" ? "from another device" : "by you"}${r.answeredAt ? ` at ${clockTime(r.answeredAt)}` : ""}`;

type Row = HostRequest["rows"][number];
const rowKey = (env: string, row: Pick<Row, "ref">): string => `${env}:${row.ref.at}:${row.ref.id}`;

/** A row's word at its end while the request waits: what it does beyond a plain send, or why it cannot be pressed as drawn. */
function sideOf(row: Row): string | null {
  if (!row.open) return "No longer waiting";
  if (row.changed && !row.receipt) return "Changed since asked";
  if (row.do === "discard") return "Discard";
  if (row.do === "later" && row.at) return `Goes ${aheadTime(row.at)}`;
  return null;
}

/** What his press did to a row, in its row's words. */
function resultOf(row: Row): RowResult | undefined {
  if (!row.result) return undefined;
  if (!row.result.ok) return { state: "failed", words: workErrorWords(row.result.error ?? "") || (row.do === "discard" ? "It was not discarded" : "It did not go") };
  const after = { state: (row.result.state ?? row.item?.state ?? "sent") as HostItem["state"], verb: row.item?.verb ?? "Send", lifeos: row.item?.lifeos, decidedAt: row.item?.decidedAt ?? null, kind: row.item?.kind ?? "mail.send" };
  return { state: "done", words: doneWords(after, row.do) };
}

/** The ticks and what each row was first seen with: its first receipt, or that it was changed. */
export type TickMarks = { ticks: ReadonlyMap<string, string>; seen: ReadonlyMap<string, string | typeof CHANGED> };
const CHANGED = Symbol("changed");
const NO_MARKS: TickMarks = { ticks: new Map(), seen: new Map() };

/**
 * One copy of the request taken into the ticks: a row seen changed is marked so for good; a row whose first receipt
 * this is (unchanged, open) is ticked for that receipt. Nothing he ticked or unticked is undone. The same marks come
 * back when nothing is new, so a copy that adds nothing renders nothing.
 */
export function absorbRows(prev: TickMarks, env: string, rows: readonly Pick<Row, "ref" | "open" | "changed" | "receipt">[]): TickMarks {
  let ticks: Map<string, string> | null = null;
  let seen: Map<string, string | typeof CHANGED> | null = null;
  for (const r of rows) {
    if (!r.open) continue;
    const key = rowKey(env, r);
    if (r.changed) {
      if (prev.seen.get(key) !== CHANGED) (seen ??= new Map(prev.seen)).set(key, CHANGED);
      continue;
    }
    if (!r.receipt || (seen ?? prev.seen).has(key)) continue;
    (seen ??= new Map(prev.seen)).set(key, r.receipt);
    (ticks ??= new Map(prev.ticks)).set(key, r.receipt);
  }
  return ticks || seen ? { ticks: ticks ?? prev.ticks, seen: seen ?? prev.seen } : prev;
}

/** The request's press: the ticks, the sending, the answer, and Send again for what failed. */
function useRequestPress(request: HostRequest) {
  const env = request.environmentId;
  const { waiting } = useOutbox();
  // His ticks, bound to receipts (review finding 9): a tick counts only while the row still holds the receipt it was
  // given for, so a refresh that marks the row changed, or gives it another receipt or none, leaves it unticked. A
  // row's first receipt, unchanged and open, starts ticked when it arrives, though the first copy drawn had none (a
  // pushed copy); a row seen changed, or seen with another receipt, waits for his own tick.
  const [marks, setMarks] = useState<TickMarks>(() => absorbRows(NO_MARKS, env, request.rows));
  useEffect(() => setMarks((prev) => absorbRows(prev, env, request.rows)), [env, request.rows]);
  const ticks = marks.ticks;
  const isOn = (r: Row): boolean => r.open && !!r.receipt && ticks.get(rowKey(env, r)) === r.receipt;
  const [sending, setSending] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | "again" | null>(null);
  const [again, setAgain] = useState<ReadonlyMap<string, RowResult>>(new Map());
  const open = request.state === "open";
  const ticked = request.rows.filter(isOn);

  const send = async () => {
    if (!open || !ticked.length || busy) return;
    setBusy("send");
    setSending(new Set(ticked.map((r) => rowKey(env, r))));
    try {
      await answerRequest(env, request.id, ticked.map((r) => r.receipt!));
      // The Outbox's list read again at once: a retry on the card is judged against what the host now holds.
      void loadHost(env);
    } catch (err) {
      toastError(pressFailWords(err, "Nothing was sent"));
    } finally {
      setSending(null);
      setBusy(null);
    }
  };
  const decline = async () => {
    if (!open || busy) return;
    setBusy("decline");
    try {
      await declineRequest(env, request.id);
    } catch (err) {
      toastError(pressFailWords(err, "The request was not put away"));
    } finally {
      setBusy(null);
    }
  };
  // After the answer, what did not go is tried again only as it was asked and as he saw it (review finding 10): a Send
  // keeps the request's many-ness and the revision the card drew; a Later takes a new time he picks and is told; a row
  // that moved since, or that may have gone, is his to look at in its own detail, never retried from here.
  const failedRows = request.rows.filter((r) => r.result && !r.result.ok && r.item && r.do !== "discard" && !again.has(rowKey(env, r)));
  const moved = (r: Row): boolean => {
    const now = waiting.find((i) => i.environmentId === env && i.ref.at === r.ref.at && i.ref.id === r.ref.id);
    return !!r.item!.outcomeUnknown || !now || now.updatedAt !== r.item!.updatedAt || !!now.outcomeUnknown;
  };
  const toDetail = failedRows.filter(moved);
  const failed = failedRows.filter((r) => r.do === "send" && !moved(r));
  const failedLater = failedRows.filter((r) => r.do === "later" && !moved(r));
  const retry = async (rows: readonly Row[], choice: DecideDo) => {
    // The item as the card drew it: its revision is the one the retry names.
    const items = rows.map((r) => ({ ...r.item!, environmentId: env }));
    if (!items.length || busy) return;
    setBusy("again");
    setAgain((prev) => new Map([...prev, ...items.map((i) => [itemKey(i), { state: "working" } as RowResult] as const)]));
    const results = await decideMany(items, choice, { via: "outbox", many: true });
    setAgain((prev) => {
      const next = new Map(prev);
      for (const [key, r] of results)
        next.set(key, r.ok ? { state: "done", words: doneWords({ ...items.find((i) => itemKey(i) === key)!, ...r.item }, choice.do) } : { state: "failed", words: workErrorWords(r.error ?? "") || "It did not go" });
      return next;
    });
    setBusy(null);
  };
  const sendAgain = () => retry(failed, { do: "send" });
  const laterAgain = (at: number) => retry(failedLater, { do: "later", at, zone: ownZone() });
  const openDetail = () => {
    const r = toDetail[0];
    if (!r) return;
    wantOutboxItem(rowKey(env, r));
    shell.openOutbox();
  };
  const open1 = (item: HostItem) => {
    const row = request.rows.find((r) => r.ref.at === item.ref.at && r.ref.id === item.ref.id);
    if (open && row?.changed && !row.receipt) void viewRow(env, request.id, row.ref).catch((err) => toastError(pressFailWords(err, "It did not load")));
  };
  const toggle = (item: HostItem, on: boolean) => {
    const row = request.rows.find((r) => r.ref.at === item.ref.at && r.ref.id === item.ref.id);
    setMarks((prev) => {
      const ticks = new Map(prev.ticks);
      // His tick is for the receipt the row holds as he ticks it.
      if (on && row?.receipt) ticks.set(itemKey(item), row.receipt);
      else ticks.delete(itemKey(item));
      return { ...prev, ticks };
    });
  };

  // The rows the summary list draws: every row whose item this host still has.
  const rows: SummaryRow[] = request.rows.flatMap((r) => {
    if (!r.item) return [];
    const key = rowKey(env, r);
    const result = again.get(key) ?? (sending?.has(key) ? ({ state: "working" } as RowResult) : resultOf(r));
    return [{ item: { ...r.item, environmentId: env }, on: isOn(r), locked: !open || !r.receipt || !r.open, side: open ? sideOf(r) : r.result ? null : "Left out", ...(result ? { result } : {}) }];
  });
  const gone = request.rows.filter((r) => !r.item).length;
  const results = rows.flatMap((r) => (r.result && r.result.state !== "working" ? [r.result] : []));
  // The head: what the ticked rows do while it waits; what the press did once answered.
  const did = new Set(request.rows.filter((r) => r.result).map((r) => r.do));
  const head = open
    ? ticked.length
      ? summaryHead(
          ticked.filter((r) => r.do !== "discard").map((r) => r.item!),
          ticked.filter((r) => r.do === "discard").length,
        )
      : request.head
    : resultsHead(results, did.size === 1 && did.has("discard") ? "discard" : "send") || request.head;
  return { open, rows, gone, head, ticked, busy, send, decline, failed, failedLater, toDetail, sendAgain, laterAgain, openDetail, toggle, open1, label: pressLabel(ticked.map((r) => r.do)) };
}

/** Where a request came from, as an item's facts line says it: the job's dot and name, the thread, when it asked. */
function RequestFacts({ request, onOpenSession }: { request: HostRequest; onOpenSession?: (sessionId: string, environmentId: string) => void }) {
  const workspaces = useWorkspaces();
  const job =
    !request.workspaceId || request.workspaceId === WORK_CHATS_KEY
      ? "Work Chats"
      : (workspaces.find((w) => w.environmentId === request.environmentId && w.id === request.workspaceId)?.name ?? "A Work workspace");
  const title = storeTitleOf(request.sessionId);
  const from = title ? (
    onOpenSession ? (
      <span>
        from{" "}
        <button type="button" className="focus-ring rounded-sm underline decoration-current/40 underline-offset-3 hover:text-foreground" onClick={() => onOpenSession(request.sessionId, request.environmentId)}>
          {title}
        </button>
      </span>
    ) : (
      `from ${title}`
    )
  ) : null;
  return (
    <div className="flex min-h-7 items-center gap-1 text-xs text-muted-foreground">
      <SectorDot sector={request.sector} className="-ms-1 size-4 shrink-0" />
      <Facts parts={[job, from, clockTime(request.createdAt)]} className="min-w-0" />
    </div>
  );
}

/** "You asked: “send the roster mails, all ten”" */
function Asked({ quote }: { quote: string }) {
  return (
    <p data-outbox-request-quote className="text-[13px] leading-5 text-muted-foreground">
      You asked: “{quote}”
    </p>
  );
}

/**
 * A request by its host and id: read from the host once it mounts, kept current by the push. `frame="card"` is the
 * transcript's card; `frame="page"` is the Outbox's detail (facts, a 16px head, the bar at the pane's foot).
 */
export function RequestCard({
  environmentId,
  id,
  frame = "card",
  host,
  onOpenSession,
  commands,
}: {
  environmentId: string;
  id: string;
  frame?: "card" | "page";
  host?: (item: HostItem) => string;
  onOpenSession?: (sessionId: string, environmentId: string) => void;
  commands?: RefObject<DetailCommands | null>;
}) {
  const { request, error, retry } = useRequest(environmentId, id);
  if (!request) {
    if (error)
      return (
        <NoticeLine
          data-outbox-request-line
          glyph={<StatusMark state="failed" word={false} />}
          lead="The request did not load"
          details={[workErrorWords(error) || null].filter((d): d is string => !!d)}
          trailing={
            <Button variant="ghost" size="xs" onClick={retry}>
              Retry
            </Button>
          }
        />
      );
    return frame === "card" ? <Skeleton data-outbox-request-bones className="h-28 w-full rounded-xl" /> : <DetailBones />;
  }
  // Put away without his press, or by his Not now: one muted line, in the card's place and in the Outbox alike.
  if (request.state === "declined") return <RequestLine lead="Not now" detail={request.head} />;
  if (request.state === "void") return <RequestLine lead="No longer open" detail={request.why ? workErrorWords(request.why) || request.why : request.head} />;
  return <RequestBody key={`${request.environmentId}:${request.id}`} request={request} frame={frame} host={host} onOpenSession={onOpenSession} commands={commands} />;
}

function DetailBones() {
  return (
    <div role="status" aria-label="Loading the request" aria-busy className="mx-auto flex w-full max-w-[688px] flex-col px-8 pt-6">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-3 h-4 w-64 max-w-full" />
      <Skeleton className="mt-5 h-32 w-full rounded-lg" />
    </div>
  );
}

function RequestBody({ request, frame, host, onOpenSession, commands }: { request: HostRequest; frame: "card" | "page"; host?: (item: HostItem) => string; onOpenSession?: (sessionId: string, environmentId: string) => void; commands?: RefObject<DetailCommands | null> }) {
  const p = useRequestPress(request);
  const [picking, setPicking] = useState(false);
  const noop = () => {};
  useKeyVerbs(commands, { primary: () => void p.send(), edit: noop, discard: noop, later: noop, editing: () => false, cancelEdit: noop });
  const list = (
    <>
      <SummaryList head={null} rows={p.rows} onToggle={p.open ? p.toggle : undefined} onOpen={p.open1} host={host} />
      {p.gone ? <p className="border-t border-border pt-2 text-[13px] leading-5 text-muted-foreground">{p.gone === 1 ? "1 is no longer in the Outbox" : `${p.gone} are no longer in the Outbox`}</p> : null}
    </>
  );
  const decline = (
    <Button variant="ghost" size="sm" disabled={p.busy !== null} onClick={() => void p.decline()}>
      <BusyLabel busy={p.busy === "decline"} label="Not now" />
    </Button>
  );
  const primary = (
    <Tip label={p.label} shortcut={frame === "page" ? keyHint("mod+enter") : undefined}>
      <Button size="sm" disabled={p.busy !== null || p.ticked.length === 0} onClick={() => void p.send()}>
        <BusyLabel busy={p.busy === "send"} label={p.ticked.length ? p.label : "Send"} />
      </Button>
    </Tip>
  );
  const after: ReactNode = (
    <>
      <span data-outbox-request-by className="text-[13px] leading-5 text-muted-foreground tabular-nums">
        {answeredWords(request)}
      </span>
      {p.toDetail.length ? (
        <Button variant="ghost" size="sm" disabled={p.busy !== null} onClick={p.openDetail}>
          Open in the Outbox
        </Button>
      ) : null}
      {p.failedLater.length ? (
        <Button variant="secondary" size="sm" disabled={p.busy !== null} onClick={() => setPicking(true)}>
          Pick a new time…
        </Button>
      ) : null}
      {p.failed.length ? (
        <Button variant="secondary" size="sm" disabled={p.busy !== null} onClick={() => void p.sendAgain()}>
          <BusyLabel busy={p.busy === "again"} label={p.failed.length === 1 ? "Send again" : `Send ${p.failed.length} again`} />
        </Button>
      ) : null}
      {picking ? (
        <PickTime
          onClose={() => setPicking(false)}
          onPick={(at) => {
            setPicking(false);
            void p.laterAgain(at);
          }}
        />
      ) : null}
    </>
  );
  if (frame === "page")
    return (
      <>
        <DetailColumn>
          <header className="flex flex-col">
            <RequestFacts request={request} onOpenSession={onOpenSession} />
            <h1 aria-live="polite" className="mt-1 text-base font-semibold leading-6 tracking-[-0.01em] text-balance">
              {p.head}
            </h1>
          </header>
          <div className="mt-2">
            <Asked quote={request.quote} />
          </div>
          <div className="mt-4">{list}</div>
        </DetailColumn>
        <VerbBar>
          {p.open ? decline : null}
          <span className="flex-1" />
          {p.open ? primary : after}
        </VerbBar>
      </>
    );
  return (
    <section data-outbox-request aria-label={p.head} className={cn("w-full border border-border bg-card font-sans text-card-foreground", QUESTION_SHAPE)}>
      <div className="flex min-h-5 items-center gap-2">
        <Outbox aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 aria-live="polite" className="min-w-0 text-sm leading-5 font-medium text-balance">
          {p.head}
        </h3>
      </div>
      <div className="mt-1 ps-[22px]">
        <Asked quote={request.quote} />
      </div>
      <div className="mt-3">{list}</div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {p.open ? (
          <>
            {decline}
            {primary}
          </>
        ) : (
          after
        )}
      </div>
    </section>
  );
}
