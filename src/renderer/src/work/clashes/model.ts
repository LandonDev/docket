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

/** What a way out does and who hears of it, under the event it is for (so the event is not named again). A move of an event with guests is mailed to them by its calendar. */
export function wayWords(way: Exclude<ClashWay, "late">, guests = false): string {
  if (way === "decline") return "Its organizer is told you declined.";
  if (way === "propose") return "Its organizer is asked for this time. Nothing moves until they agree.";
  return guests ? "It moves on your calendar, and its guests are told the new time." : "It moves on your calendar.";
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

const UNSET = "Pick a day and its times";
const SKIPPED = { from: "From is in the hour the clocks skip that day. Pick another time.", to: "To is in the hour the clocks skip that day. Pick another time." } as const;
/** The field a refusal is about, when it is about one alone: the step marks that field. */
export const fieldOf = (words: string | null): keyof typeof SKIPPED | null => (words === SKIPPED.from ? "from" : words === SKIPPED.to ? "to" : null);
const DAY = 24 * 60 * MINUTE;

/**
 * A clock time on a day (the day first, then the clock on it), or the words
 * that say why it is no time: a field left empty, or a clock time that day
 * never shows, since the hour the clocks skip would otherwise be read as an
 * hour later than what the field says.
 */
function clockOn(day: string, clock: string, field: keyof typeof SKIPPED): number | string {
  const at = new Date(`${day}T${clock}`).getTime();
  if (!Number.isFinite(at)) return UNSET;
  return dayField(at) === day && timeField(at) === clock ? at : SKIPPED[field];
}
const dayAfter = (day: string): string => {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + 1);
  return dayField(d.getTime());
};

/**
 * The start and end a form names, or the words that say what is wrong with
 * it. What goes out is what the fields show, read the plain way: From on the
 * Day, To the first time after it, the next day's when it is earlier on the
 * clock; the same minute is no span. A field he left as it was offered keeps
 * the instant offered, each on its own, since an hour the clocks repeat shows
 * one clock time for two instants; the offered end stands only while it is
 * still an end for the start, after it and under a day on.
 */
export function whenOf(form: TimeForm, offered?: { start: number; end: number }): { start: number; end: number } | string {
  const was = offered ? formOf(offered) : null;
  const sameDay = was !== null && form.day === was.day;
  const start = offered && sameDay && form.from === was?.from ? offered.start : clockOn(form.day, form.from, "from");
  if (typeof start === "string") return start;
  if (offered && sameDay && form.to === was?.to && offered.end > start && offered.end - start < DAY) return { start, end: offered.end };
  if (!form.to) return UNSET;
  if (form.to === form.from) return "It must end after it starts";
  let end = clockOn(form.day, form.to, "to");
  if (typeof end !== "string" && end <= start) end = clockOn(dayAfter(form.day), form.to, "to");
  if (typeof end === "string") return end;
  return end > start ? { start, end } : "It must end after it starts";
}

/** The same with nothing offered: every field is read as typed. */
export const spanOf = (form: TimeForm): { start: number; end: number } | string => whenOf(form);

/** Whether the end the form will send falls on the day after its Day: said under To. */
export function endsNextDay(form: TimeForm, offered?: { start: number; end: number }): boolean {
  const when = whenOf(form, offered);
  return typeof when !== "string" && dayField(when.end) !== form.day;
}
