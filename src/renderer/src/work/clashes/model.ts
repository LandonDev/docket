import type { MailtoDraft } from "work-kit/mail";
import type { Clash, ClashList, ClashSide, ClashWay, Leave } from "@shared/work/clashes";

/**
 * What the screens need of a clash list, worked out once: each event's clashes,
 * its leave-by, and the set of events that clash at all. Pure, for its tests.
 */
export type ClashMarks = {
  /** false until LifeOS has answered: a row then keeps the leave-by it already had */
  ready: boolean;
  /** why the read failed, in words, when it did */
  failed?: string;
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

const sameDay = (x: number, y: number) => new Date(x).toDateString() === new Date(y).toDateString();

/**
 * The time a move or a proposal starts filled with, for as long as the event
 * runs now. The earlier event is offered the latest quarter hour that still
 * ends a drive before the later one starts, while that is ahead of `now` and
 * on its own day: moving it later than the thing it clashes with is rarely
 * what he wants. Otherwise, and for the later event, it is the first quarter
 * hour after the other event ends that the drive allows.
 */
export function freeAfter(clash: Clash, eventId: string, now = Date.now()): { start: number; end: number } {
  const { side, other } = sideOf(clash, eventId);
  const length = Math.max(STEP, side.endsAt - side.startsAt);
  const drive = (clash.minutes ?? 0) * MINUTE;
  if (side === clash.a) {
    const start = Math.floor((other.startsAt - drive - length) / STEP) * STEP;
    if (start > now && sameDay(start, side.startsAt)) return { start, end: start + length };
  }
  const start = Math.ceil((other.endsAt + drive) / STEP) * STEP;
  return { start, end: start + length };
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

/** What a way out does and who hears of it, under the event it is for (so the event is not named again). */
export function wayWords(way: Exclude<ClashWay, "late">): string {
  if (way === "decline") return "Its organizer is told you declined.";
  if (way === "propose") return "Its organizer is asked for this time. Nothing moves until they agree.";
  return "It moves on your calendar.";
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

/** Whether the form's To is the day after its Day: an end at or before the start's clock runs past midnight. */
export const endsNextDay = (form: TimeForm): boolean => Boolean(form.from && form.to) && form.to < form.from;

/**
 * The start and end a form names, or the words that say what is wrong with
 * it. A To earlier on the clock than From is the next day's, so an event may
 * run past midnight; the same minute is no span at all.
 */
export function spanOf(form: TimeForm): { start: number; end: number } | string {
  const start = new Date(`${form.day}T${form.from}`).getTime();
  const sameDayEnd = new Date(`${form.day}T${form.to}`);
  if (endsNextDay(form)) sameDayEnd.setDate(sameDayEnd.getDate() + 1);
  const end = sameDayEnd.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Pick a day and its times";
  if (end <= start) return "It must end after it starts";
  return { start, end };
}
