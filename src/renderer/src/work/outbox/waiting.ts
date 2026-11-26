import type { OutboxItem } from "@shared/contract-work-outbox";
import type { ActKind } from "@shared/work";
import { clockTime } from "../../lib/duration";
import { lifeosLine, lifeosWords, pastOf, payloadView, WORK_CHATS_KEY } from "./model";
import { heldWhen } from "./when";
import { summaryHead } from "@shared/work/outboxHead";

export { summaryHead };

/**
 * Waiting's order and the words its rows, the summary list and Done say
 * (docs/DESIGN.md "The Outbox", docs/agents/work-outbox.md "The screens"),
 * with no React. The views draw what these answer; waiting.test.ts reads them.
 */

/** What these read of an item: the store's `HostItem`, or a test's few fields. */
export type Item = Pick<OutboxItem, "ref" | "kind" | "state" | "workspaceId" | "sessionId" | "sector" | "summary" | "verb" | "payload" | "createdAt" | "decidedBy" | "decidedAt" | "routineRunId" | "scheduledFor" | "changed" | "dismissedAt" | "via" | "lifeos" | "reason" | "updatedAt"> & {
  environmentId: string;
  later?: true;
};

/** An item's key across hosts: the page's selection, ticks and `wantOutboxItem` all use it. */
export const itemKey = (item: Pick<Item, "environmentId" | "ref">): string => `${item.environmentId}:${item.ref.at}:${item.ref.id}`;

/** A send he timed: the host's own state, or a LifeOS mail scheduled from Mail (`scheduledFor` while it is sending). */
export const isScheduled = (item: Pick<Item, "state" | "scheduledFor">): boolean => item.state === "scheduled" || item.scheduledFor != null;

/** The calendar kinds, whose act is too late once the event begins (the host's `ActKindDef.by`). */
const CALENDAR: readonly ActKind[] = ["calendar.op", "office.calendar.op"];

/**
 * When a calendar act's event starts, read as the host reads its deadline: a LifeOS op's `eventStartsAt` or its
 * event's `startsAt`, an Outlook op's event's `start` or the invitation's `start`. Null for every other kind.
 */
export function startsAt(item: Pick<Item, "kind" | "payload">): number | null {
  if (!CALENDAR.includes(item.kind)) return null;
  const p = (item.payload ?? {}) as { eventStartsAt?: unknown; payload?: { startsAt?: unknown }; op?: unknown; event?: { start?: unknown }; start?: unknown };
  const at = item.kind === "calendar.op" ? (p.eventStartsAt ?? p.payload?.startsAt) : p.op === "create" ? p.event?.start : p.start;
  const n = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The end of tomorrow: an act whose event starts before it is in Starts soon. */
const soonUntil = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 2);
  return d.getTime();
};

export type Section<T> =
  | { kind: "failed" | "soon" | "scheduled"; key: string; title: string; items: T[] }
  | {
      kind: "thread";
      key: string;
      /** the thread's title, the routine's, or the job's own name where no thread made it */
      title: string;
      /** the job's name, muted after the title; null when the title already is it */
      job: string | null;
      sector: string | null;
      items: T[];
    };

export type Places = {
  /** The job's place in the rail (its workspaces' order); Work Chats after every job. */
  jobOrder: (environmentId: string, workspaceId: string | null) => number;
  /** The job's name ("Purdue Esports", "Work Chats"). */
  jobOf: (environmentId: string, workspaceId: string | null) => string;
  /** The thread's title, when the window knows it. */
  titleOf: (item: Item) => string | null;
};

const workspaceOf = (item: Pick<Item, "workspaceId">): string | null => (item.workspaceId === WORK_CHATS_KEY ? null : item.workspaceId);

/**
 * Waiting in the order he decides it: Not sent (failed, oldest first), Starts soon (a calendar act whose event
 * starts before the end of tomorrow, soonest first), then one group per thread (a routine's run is its own thread)
 * by the job's rail order and then the group's oldest item, then Scheduled (the sends he timed, soonest first).
 * Each section only when it has rows. An item is in one section alone.
 */
export function waitingSections<T extends Item>(items: readonly T[], places: Places, now = Date.now()): Section<T>[] {
  const failed: T[] = [];
  const soon: T[] = [];
  const scheduled: T[] = [];
  const threads = new Map<string, Extract<Section<T>, { kind: "thread" }> & { order: number; oldest: number }>();
  const until = soonUntil(now);
  for (const item of items) {
    if (isScheduled(item)) scheduled.push(item);
    else if (item.state === "failed") failed.push(item);
    else if (item.state !== "stale" && (startsAt(item) ?? Infinity) < until) soon.push(item);
    else {
      const ws = workspaceOf(item);
      const key = item.sessionId ? `${item.environmentId}:${item.sessionId}` : `${item.environmentId}:${ws ?? WORK_CHATS_KEY}:none`;
      let group = threads.get(key);
      if (!group) {
        const job = places.jobOf(item.environmentId, ws);
        const title = item.sessionId ? places.titleOf(item) : null;
        group = { kind: "thread", key, title: title ?? job, job: title ? job : null, sector: item.sector, items: [], order: places.jobOrder(item.environmentId, ws), oldest: item.createdAt };
        threads.set(key, group);
      }
      group.items.push(item);
      group.oldest = Math.min(group.oldest, item.createdAt);
    }
  }
  const byHeld = (a: T, b: T) => a.createdAt - b.createdAt;
  const out: Section<T>[] = [];
  if (failed.length) out.push({ kind: "failed", key: "failed", title: "Not sent", items: failed.sort(byHeld) });
  if (soon.length) out.push({ kind: "soon", key: "soon", title: "Starts soon", items: soon.sort((a, b) => startsAt(a)! - startsAt(b)!) });
  for (const { order: _o, oldest: _h, ...group } of [...threads.values()].sort((a, b) => a.order - b.order || a.oldest - b.oldest)) out.push({ ...group, items: group.items.sort(byHeld) });
  if (scheduled.length) out.push({ kind: "scheduled", key: "scheduled", title: "Scheduled", items: scheduled.sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0)) });
  return out;
}

/** Waiting's rows in the order the list draws them: what ↑ and ↓ step through. */
export const flatOrder = <T extends Item>(sections: readonly Section<T>[]): T[] => sections.flatMap((s) => s.items);

/** A group of more than five shows four and "N more". */
export const FOLD_AT = 5;
export const FOLD_SHOWS = 4;

const weekdays = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
/** A time ahead, as a row says it: "2:00 PM" today, "Wed 8:00 AM" this week, "Dec 4, 8:00 AM" past that. */
export function aheadTime(at: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const ahead = Math.round((day(at) - day(now)) / 86_400_000);
  if (ahead === 0) return clockTime(at);
  if (ahead > 0 && ahead < 7) return `${weekdays.format(at)} ${clockTime(at)}`;
  return `${dates.format(at)}, ${clockTime(at)}`;
}

/**
 * A row's one trailing word: when it goes (Scheduled), when its event starts (Starts soon, in the foreground),
 * "Out of date", "Sending", "Changed" (the thread rewrote it), else when it was held. Never amber.
 */
export function rowSide(item: Item, section: Section<Item>["kind"], now = Date.now()): { text: string; strong: boolean } {
  if (section === "scheduled" && item.scheduledFor != null) return { text: aheadTime(item.scheduledFor, now), strong: false };
  if (section === "soon") return { text: aheadTime(startsAt(item)!, now), strong: true };
  if (item.state === "stale") return { text: "Out of date", strong: false };
  if (item.state === "sending") return { text: "Sending", strong: false };
  if (item.changed?.by === "thread") return { text: "Changed", strong: false };
  return { text: heldWhen(item.createdAt, now), strong: false };
}

// ── what may be ticked, and what only its own page sends ──────────────────

/** What a tick may take: an item that waits on a plain press. A send that may have gone waits for his own Send again. */
export const tickable = (item: Pick<Item, "state" | "kind"> & { outcomeUnknown?: boolean }): boolean =>
  (item.state === "held" || item.state === "live" || item.state === "failed") && !item.outcomeUnknown && item.kind !== "computer.act";

/**
 * What goes only from its own page, alone (the host refuses it inside a press on many): an act read from a live
 * screen, a computer act, and a LifeOS reply that quotes the mail it answers (`quoted`, read whole).
 */
export const openOnly = (item: Pick<Item, "state" | "kind">, quoted = false): boolean => item.state === "live" || item.kind === "computer.act" || quoted;

// ── the summary list's head ────────────────────────────────────────────────

/** A press's result on one item, as the summary list shows it. */
export type RowResult = { state: "working" } | { state: "done"; words: string } | { state: "failed"; words: string };

/** What one item's press left, in its row's words: "Queued in LifeOS", "Posted", "Accepted", "Discarded", "Scheduled"; nothing for a plain send, whose check says it. */
export function doneWords(after: Pick<OutboxItem, "state" | "verb" | "lifeos" | "decidedAt" | "kind">, did: "send" | "discard" | "later"): string {
  if (did === "discard") return "Discarded";
  if (did === "later") return "Scheduled";
  const held = lifeosWords(after);
  if (held) return held.word;
  if (after.state === "sending") return "Sending";
  const past = pastOf(after.verb.split(" ")[0]!, after.kind);
  // A check beside "Sent" says one thing twice: the word stays only where it adds ("Posted", "Accepted", queued).
  return past === "Sent" ? "" : past;
}

/** The head once the press answered: "Sent 5, 1 not sent", "Discarded 3", "Scheduled 2". */
export function resultsHead(results: readonly RowResult[], did: "send" | "discard" | "later"): string {
  const done = results.filter((r): r is Extract<RowResult, { state: "done" }> => r.state === "done");
  // What LifeOS holds in its undo time is queued, never sent (docs/DESIGN.md): counted as it is.
  const queued = did === "send" ? done.filter((r) => r.words.startsWith("Queued in LifeOS")).length : 0;
  const went = done.length - queued;
  const failed = results.filter((r) => r.state === "failed").length;
  const word = { send: ["Sent", "not sent"], discard: ["Discarded", "not discarded"], later: ["Scheduled", "not scheduled"] }[did];
  const parts = [went ? `${word[0]} ${went}` : null, queued ? `queued ${queued} in LifeOS` : null, failed ? `${failed} ${word[1]}` : null].filter((p): p is string => p !== null);
  const line = parts.join(", ");
  return line ? line[0]!.toUpperCase() + line.slice(1) : "";
}

// ── Done ───────────────────────────────────────────────────────────────────

/** When an item was decided: his press, the grant, the discard, or putting an out-of-date one away. */
export const decidedAt = (item: Pick<Item, "decidedAt" | "dismissedAt" | "updatedAt">): number => item.dismissedAt ?? item.decidedAt ?? item.updatedAt;

/** Done's day headings, newest first: "Today", "Yesterday", "Mon, Nov 23" this week, "Nov 12" before. */
export function doneDays<T extends Item>(items: readonly T[], now = Date.now()): { label: string; items: T[] }[] {
  const sorted = [...items].sort((a, b) => decidedAt(b) - decidedAt(a));
  const days = new Map<string, T[]>();
  for (const item of sorted) {
    const label = dayLabel(decidedAt(item), now);
    days.set(label, [...(days.get(label) ?? []), item]);
  }
  return [...days].map(([label, items]) => ({ label, items }));
}
const longDays = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
export function dayLabel(at: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const ago = Math.round((day(now) - day(at)) / 86_400_000);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  return ago < 7 ? longDays.format(at) : dates.format(at);
}

/**
 * Who decided, in Done's words: "by you", "from another device", "by the grant Mail to Dana Lee", "from your
 * approval in Nationals roster" (a thread's request he answered), "scheduled by you".
 */
export function whoWords(item: Pick<Item, "decidedBy" | "via">, o: { grantLabel?: string | null; threadTitle?: string | null } = {}): string {
  if (item.decidedBy?.startsWith("grant:")) return o.grantLabel ? `by the grant ${o.grantLabel}` : "by a grant";
  if (item.via?.startsWith("request:")) return o.threadTitle ? `from your approval in ${o.threadTitle}` : "from your approval in its thread";
  if (item.via === "scheduled") return "scheduled by you";
  if (item.decidedBy === "owner:remote" || item.via === "phone") return "from another device";
  return "by you";
}

/**
 * A Done row's act, its line and its outcome: what went says so in the past; what did not go keeps its own words and
 * says why in the row's trailing slot ("Discarded", "Out of date", and what LifeOS did with a mail: "Queued in LifeOS
 * for 12m", "Back in drafts in LifeOS", "No longer in LifeOS"), which holds at every width while what it is about gives
 * way first, so a mail put back never reads as sent.
 */
export function doneLine(item: Item, words: { act: string; about: string | null }, now = Date.now()): { act: string; about: string | null; outcome?: string } {
  if (item.state === "discarded") return { act: words.act, about: words.about, outcome: "Discarded" };
  if (item.state === "stale") return { act: words.act, about: words.about, outcome: "Out of date" };
  const lifeos = lifeosLine(item, now);
  if (lifeos) return { act: words.act, about: words.about, outcome: lifeos };
  return { act: pastAct(words.act, item.verb, item.kind), about: words.about };
}

/** "Send to Dana Lee" → "Sent to Dana Lee", by the act's own verb. */
export function pastAct(act: string, verb: string, kind: string): string {
  return act.startsWith(verb) ? `${pastOf(verb, kind)}${act.slice(verb.length)}` : act;
}

// ── Send later ────────────────────────────────────────────────────────────

/** Send later's choices: in an hour (on the next five minutes), this afternoon while the morning lasts, tomorrow at 8. */
export function laterChoices(now = Date.now()): { label: string; at: number }[] {
  const FIVE = 5 * 60_000;
  const hour = Math.ceil((now + 3_600_000) / FIVE) * FIVE;
  const out = [{ label: "In an hour", at: hour }];
  const d = new Date(now);
  if (d.getHours() < 12) out.push({ label: "This afternoon", at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13).getTime() });
  out.push({ label: "Tomorrow morning", at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8).getTime() });
  return out;
}

// ── Show changes ──────────────────────────────────────────────────────────

export type Piece = { t: "same" | "ins" | "del"; s: string };

/**
 * Two texts' difference by words (the spaces kept with them): what both hold, what was taken out, what was put in.
 * Past a few thousand words each it gives up on the middle and says the old text went and the new came.
 */
export function wordDiff(a: string, b: string): Piece[] {
  if (a === b) return a ? [{ t: "same", s: a }] : [];
  const x = a.split(/(\s+)/).filter(Boolean);
  const y = b.split(/(\s+)/).filter(Boolean);
  if (x.length * y.length > 4_000_000) return [...(a ? [{ t: "del" as const, s: a }] : []), ...(b ? [{ t: "ins" as const, s: b }] : [])];
  const m = x.length;
  const n = y.length;
  const lcs: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Piece[] = [];
  const push = (t: Piece["t"], s: string) => {
    const last = out.at(-1);
    if (last?.t === t) last.s += s;
    else out.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      push("same", x[i]!);
      i++;
      j++;
    }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push("del", x[i++]!);
    else push("ins", y[j++]!);
  }
  while (i < m) push("del", x[i++]!);
  while (j < n) push("ins", y[j++]!);
  return out;
}

/**
 * What differs between the words the thread first wrote and what would go now: each field a person reads whose
 * value moved (with both), and the body's difference by words. Empty when nothing a person reads moved.
 */
export function changesOf(first: unknown, now: unknown): { fields: { label: string; was: string; now: string }[]; body: Piece[] | null } {
  const a = payloadView(first);
  const b = payloadView(now);
  const was = new Map(a.fields.map((f) => [f.path.join("."), f]));
  const fields: { label: string; was: string; now: string }[] = [];
  for (const f of b.fields) {
    const before = was.get(f.path.join("."));
    if ((before?.value ?? "") !== f.value) fields.push({ label: f.label, was: before?.value ?? "", now: f.value });
    was.delete(f.path.join("."));
  }
  for (const f of was.values()) fields.push({ label: f.label, was: f.value, now: "" });
  const body = (a.body?.text ?? "") === (b.body?.text ?? "") ? null : wordDiff(a.body?.text ?? "", b.body?.text ?? "");
  return { fields, body };
}
