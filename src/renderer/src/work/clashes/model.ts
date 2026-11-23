import type { MailtoDraft } from "work-kit/mail";
import type { Clash, ClashList, ClashSide, ClashWay, Leave } from "@shared/work/clashes";

/**
 * What the screens need of a clash list, worked out once: each event's clashes,
 * its leave-by, and the set of events that clash at all. Pure, for its tests.
 */
export type ClashMarks = {
  /** false until LifeOS has answered: a row then keeps the leave-by it already had */
  ready: boolean;
  clashes: ReadonlyMap<string, readonly Clash[]>;
  leaves: ReadonlyMap<string, Leave>;
  marked: ReadonlySet<string>;
};

export const NO_MARKS: ClashMarks = { ready: false, clashes: new Map(), leaves: new Map(), marked: new Set() };

export function marksOf(list: ClashList): ClashMarks {
  const clashes = new Map<string, Clash[]>();
  for (const clash of list.clashes) {
    for (const side of [clash.a, clash.b]) clashes.set(side.eventId, [...(clashes.get(side.eventId) ?? []), clash]);
  }
  return { ready: true, clashes, leaves: new Map(list.leaves.map((l) => [l.eventId, l])), marked: new Set(clashes.keys()) };
}

const MINUTE = 60_000;
/** Times he is offered land on the quarter hour. */
const STEP = 15 * MINUTE;

export const sideOf = (clash: Clash, eventId: string): { side: ClashSide; other: ClashSide } =>
  eventId === clash.a.eventId ? { side: clash.a, other: clash.b } : { side: clash.b, other: clash.a };

/**
 * The time a move or a proposal starts filled with: the first quarter hour
 * after the other event ends that the drive between them allows, for as long
 * as the event runs now.
 */
export function freeAfter(clash: Clash, eventId: string): { start: number; end: number } {
  const { side, other } = sideOf(clash, eventId);
  const start = Math.ceil((other.endsAt + (clash.minutes ?? 0) * MINUTE) / STEP) * STEP;
  return { start, end: start + Math.max(STEP, side.endsAt - side.startsAt) };
}

/** How late he is to the later event if he keeps both: the time they share, or the minutes the drive is short. */
export function lateMinutes(clash: Clash): number {
  const short = clash.kind === "drive" ? (clash.shortBy ?? 0) : (clash.a.endsAt - clash.b.startsAt) / MINUTE + (clash.minutes ?? 0);
  return Math.max(1, Math.round(short));
}

/** The mail Running late… opens in Mail's composer: the people on the later event, and one line. */
export function lateDraft(clash: Clash, to: readonly string[]): MailtoDraft {
  const minutes = lateMinutes(clash);
  return { to: [...to], cc: [], bcc: [], subject: `Running late: ${clash.b.title}`, body: `I'm running about ${minutes} ${minutes === 1 ? "minute" : "minutes"} late.` };
}

/** The verb on a way's button, and what its step says goes. */
export const WAY_LABEL: Record<ClashWay, string> = { decline: "Decline", propose: "Propose new time…", move: "Move…", late: "Running late…" };

export function wayWords(way: Exclude<ClashWay, "late">, title: string): string {
  if (way === "decline") return `Declines ${title}. Its organizer is told.`;
  if (way === "propose") return `Asks the organizer of ${title} for this time. Nothing moves until they agree.`;
  return `Moves ${title} on your calendar.`;
}

/** What the toast says once a way out went. */
export function doneWords(way: Exclude<ClashWay, "late">, title: string): string {
  if (way === "decline") return `Declined ${title}`;
  if (way === "propose") return `New time proposed for ${title}`;
  return `Moved ${title}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayField = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeField = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export type TimeForm = { day: string; from: string; to: string };
export const formOf = (span: { start: number; end: number }): TimeForm => ({ day: dayField(span.start), from: timeField(span.start), to: timeField(span.end) });

/** The start and end a form names, or the words that say what is wrong with it. */
export function spanOf(form: TimeForm): { start: number; end: number } | string {
  const start = new Date(`${form.day}T${form.from}`).getTime();
  const end = new Date(`${form.day}T${form.to}`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Pick a day and its times";
  if (end <= start) return "It must end after it starts";
  return { start, end };
}
