import type { MailtoDraft } from "work-kit/mail";
import { clockOf, isSecond, type Clash, type ClashList, type ClashSide, type ClashWay, type Leave } from "@shared/work/clashes";

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
 * hour after the other event ends that the drive allows. The later event
 * may ask him there before it starts (its arrive-by); a drive clash's
 * shortfall says by how long, and the offer leaves that time too.
 */
export function freeAfter(clash: Clash, eventId: string, now = Date.now()): { start: number; end: number } {
  const { side, other } = sideOf(clash, eventId);
  // The start lands on the quarter hour; the event keeps the length it has, a five minute one too.
  const length = side.endsAt > side.startsAt ? side.endsAt - side.startsAt : STEP;
  const drive = (clash.minutes ?? 0) * MINUTE;
  // He is short by the drive less the time from the earlier event's end to the later one's deadline: that gives the deadline, and how long before its start it is.
  // Whole minutes, down: the shortfall is rounded up, and a part of a minute must not cost him a quarter hour.
  const early = clash.kind === "drive" && clash.shortBy !== undefined ? Math.max(0, Math.floor((clash.b.startsAt - (clash.a.endsAt + drive - clash.shortBy * MINUTE)) / MINUTE)) * MINUTE : 0;
  if (side === clash.a) {
    const start = Math.floor((other.startsAt - early - drive - length) / STEP) * STEP;
    if (start > now && sameDay(start, side.startsAt)) return { start, end: start + length };
  }
  // Never a time already gone: once the other event is over, or he is past the drive, the next quarter hour from now.
  const start = Math.ceil(Math.max(other.endsAt + drive + (side === clash.b ? early : 0), now + 1) / STEP) * STEP;
  return { start, end: start + length };
}

/** How late he is to the later event if he keeps both: the time they share, or the minutes the drive is short. */
export function lateMinutes(clash: Clash): number {
  const short = clash.kind === "drive" ? (clash.shortBy ?? 0) : (clash.a.endsAt - clash.b.startsAt) / MINUTE + (clash.minutes ?? 0);
  return Math.max(1, Math.round(short));
}

/** The mail Running late… opens in Mail's composer: the people on the later event, and one line. */
export function lateDraft(clash: Clash, to: readonly string[], now = 0): MailtoDraft {
  const minutes = lateMinutes(clash);
  // Once the time he would have been there by is behind him (the earlier event's end and the drive, which an arrive-by does not move), the figure is no longer true: the line says he is late and leaves how late to him.
  const body = now > clash.a.endsAt + (clash.minutes ?? 0) * MINUTE ? "I'm running late." : `I'm running about ${minutes} ${minutes === 1 ? "minute" : "minutes"} late.`;
  return { to: [...to], cc: [], bcc: [], subject: `Running late: ${clash.b.title}`, body };
}

/** The pair's times and drive as one word: a step's offer was worked out from these, and is stale once they change. */
export const pairStamp = (clash: Clash): string => [clash.a.startsAt, clash.a.endsAt, clash.b.startsAt, clash.b.endsAt, clash.minutes ?? "", clash.shortBy ?? ""].join("|");

/** The verb on a way's button, and what its step says goes. */
export const WAY_LABEL: Record<ClashWay, string> = { decline: "Decline", propose: "Propose new time…", move: "Move…", late: "Running late…" };

/** What a way out does and who hears of it, under the event it is for (so the event is not named again). A move of an event with guests is mailed to them by its calendar. */
export function wayWords(way: Exclude<ClashWay, "late">, guests = false): string {
  if (way === "decline") return "Its organizer is told you declined.";
  if (way === "propose") return "Your reply turns to Maybe and its organizer is asked for this time. Nothing moves until they agree.";
  return guests ? "It moves on your calendar, and its guests are told the new time." : "It moves on your calendar.";
}

/**
 * What the toast says once the host has answered a way out. A calendar's act
 * is queued with LifeOS's sender then, not yet on the calendar, so it is said
 * as under way; only a move written in LifeOS itself is said as done. A host
 * that says neither is read as queued, the smaller claim.
 */
export function doneWords(way: Exclude<ClashWay, "late">, title: string, queued = true): string {
  if (way === "decline") return `Declining ${title}…`;
  if (way === "propose") return `Proposing a new time for ${title}…`;
  return queued ? `Moving ${title}…` : `Moved ${title}`;
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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Every instant a day shows a clock time at, in order (two in the hour the
 * clocks repeat), or the words that say why there is none: a field left
 * empty, or a clock time that day never shows, since the hour the clocks
 * skip would otherwise be read as an hour later than what the field says.
 */
function clocksOn(day: string, clock: string, field: keyof typeof SKIPPED): number[] | string {
  const at = new Date(`${day}T${clock}`).getTime();
  if (!Number.isFinite(at)) return UNSET;
  const shows = (ms: number) => dayField(ms) === day && timeField(ms) === clock;
  // The clocks go back an hour in most zones and half an hour in a few: either way the same clock, later.
  return shows(at) ? [at - HOUR, at - HOUR / 2, at, at + HOUR / 2, at + HOUR].filter(shows) : SKIPPED[field];
}
const noon = (day: string) => new Date(`${day}T12:00`);
const dayPlus = (day: string, days: number): string => {
  const d = noon(day);
  d.setDate(d.getDate() + days);
  return dayField(d.getTime());
};
/** Whole calendar days from one day to a later one. */
const daysApart = (from: string, to: string): number => Math.round((noon(to).getTime() - noon(from).getTime()) / DAY);

type Span = { start: number; end: number };
/** Under a day by the clock, not the hours (a day the clocks change is 23 or 25 long): it ends on the day it starts, or the next day before the clock comes round to its start. */
const underDay = (start: number, end: number): boolean => dayField(end) === dayField(start) || (dayField(end) === dayPlus(dayField(start), 1) && timeField(end) < timeField(start));

const AFTER = "It must end after it starts";

/**
 * The start and end a form names, or the words that say what is wrong with
 * it. What goes out is what the fields show, read the plain way: From on the
 * Day, To the first time after it, on the Day when there is one, else the
 * next day's when it is earlier on the clock; the same minute is no span. A
 * To is looked for on the day it falls on, so only that day's skipped hour
 * refuses it. A field he left as it was offered keeps the instant offered,
 * each on its own, since an hour the clocks repeat shows one clock time for
 * two instants. An offer under a day long stays under a day whatever he
 * edits; one a day long or more keeps the days its end is past its Day,
 * which the one Day field cannot say, and its To is read on that day alone.
 */
export function whenOf(form: TimeForm, offered?: Span): Span | string {
  return read(form, offered).when;
}

/** `whenOf`, with the day the To was looked for on last: the day a refused To is about. */
function read(form: TimeForm, offered?: Span): { when: Span | string; day?: string } {
  const was = offered ? formOf(offered) : null;
  const dayKept = was !== null && form.day === was.day;
  const starts = offered && dayKept && form.from === was?.from ? [offered.start] : clocksOn(form.day, form.from, "from");
  if (typeof starts === "string") return { when: starts };
  // A From typed into the repeated hour is its first time.
  const start = starts[0]!;
  const long = offered !== undefined && !underDay(offered.start, offered.end);
  const fits = (end: number) => end > start && (long || underDay(start, end));
  if (offered && dayKept && form.to === was?.to && fits(offered.end)) return { when: { start, end: offered.end } };
  if (!form.to) return { when: UNSET };
  /** An end that many days past the Day (in the repeated hour, the first of the two after the start), the words why that day has no such time, or the words that its time is no end for the start. */
  const endOn = (days: number): { when: Span | string; day: string } => {
    const day = dayPlus(form.day, days);
    const ends = clocksOn(day, form.to, "to");
    const end = typeof ends === "string" ? ends : ends.find(fits);
    return { when: typeof end === "number" ? { start, end } : (end ?? AFTER), day };
  };
  if (offered && long) return endOn(daysApart(dayField(offered.start), dayField(offered.end)));
  // Typed alike, the two fields are one minute, also in the hour the clocks repeat.
  if (form.to === form.from) return { when: AFTER };
  const today = endOn(0);
  // Later on the clock, it is the Day's own time or none; earlier, the Day's second time in a repeated hour, else the next day's.
  return typeof today.when !== "string" || form.to > form.from ? today : endOn(1);
}

/** The same with nothing offered: every field is read as typed. */
export const spanOf = (form: TimeForm): Span | string => whenOf(form);

const endDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
/**
 * What From and To say under them when the fields alone do not say which
 * instant goes. Either: "Second 1:30 AM" when it is the second time that
 * clock shows, the night the clocks go back. To: "Next day" when the end is
 * not on its Day, or the day itself when it is further on (said of a To the
 * clocks skip too, so its refusal has a day to be about).
 */
export function hintsOf(form: TimeForm, offered?: Span): { from?: string; to?: string } {
  const { when, day: sought } = read(form, offered);
  const second = (at: number) => (isSecond(at) ? `second ${clockOf(at)}` : undefined);
  const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
  const day = typeof when !== "string" ? dayField(when.end) : fieldOf(when) === "to" ? sought : undefined;
  const on = day === undefined || day === form.day ? undefined : day === dayPlus(form.day, 1) ? "Next day" : endDay.format(noon(day));
  if (typeof when === "string") return on ? { to: on } : {};
  const from = second(when.start);
  const to = [on, second(when.end)].filter(Boolean).join(", ");
  return { ...(from ? { from: capital(from) } : {}), ...(to ? { to: capital(to) } : {}) };
}
/** The line under To alone. */
export const endHint = (form: TimeForm, offered?: Span): string | undefined => hintsOf(form, offered).to;
