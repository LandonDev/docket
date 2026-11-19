/**
 * What a held calendar act (`calendar.op`, LifeOS's `calendarOps`) says, as
 * the Outbox shows it: its fields in his words and the day it lands on. Pure,
 * so the act view and its tests share it.
 */

export type CalendarOpKind = "create" | "update" | "accept" | "decline" | "tentative" | "propose" | "cancel";

export interface CalendarOp {
  id: string;
  kind?: CalendarOpKind;
  account?: string;
  calendarId?: string;
  eventId?: string;
  eventTitle?: string;
  /** the event's start as the host bound it for the press; shown in place of a live read */
  eventStartsAt?: number;
  payload?: {
    title?: string;
    startsAt?: number;
    endsAt?: number;
    allDay?: boolean;
    location?: string;
    notes?: string;
    attendees?: { address: string; name?: string }[];
    uninvite?: string[];
    comment?: string;
    proposedStart?: number;
    proposedEnd?: number;
    series?: boolean;
  };
}

export interface DayEvent {
  _id: string;
  title: string;
  sector: string;
  startsAt: number;
  endsAt?: number;
  allDay: boolean;
  hidden?: boolean;
  location?: string;
}

const REPLY: Partial<Record<CalendarOpKind, string>> = { accept: "Yes", decline: "No", tentative: "Maybe" };

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Fri, Nov 20, 2:00 to 2:30 PM"; a day item is its day alone. */
export function whenWords(startsAt: number, endsAt: number | undefined, allDay = false): string {
  if (allDay) return day.format(startsAt);
  const start = time.format(startsAt);
  if (endsAt === undefined || endsAt <= startsAt) return `${day.format(startsAt)}, ${start}`;
  const end = time.format(endsAt);
  // One day period for both ends reads "2:00 to 2:30 PM".
  const startBare = start.replace(/\s?[AP]\.?M\.?$/i, "");
  const samePeriod = start.slice(startBare.length) === end.slice(end.replace(/\s?[AP]\.?M\.?$/i, "").length);
  return `${day.format(startsAt)}, ${samePeriod ? startBare : start} to ${end}`;
}

/**
 * The act's fields as a person reads them; the event (for a reply or change) fills what the act
 * leaves out. Everything that goes is shown: the server's `CalendarFieldsSchema` keys each have a
 * row here (agenda.test.ts holds it).
 */
export function opFields(op: CalendarOp, event: DayEvent | null): { label: string; value: string }[] {
  const p = op.payload ?? {};
  const rows: { label: string; value: string }[] = [];
  const title = p.title ?? event?.title ?? op.eventTitle;
  if (title) rows.push({ label: "Event", value: title });
  const startsAt = p.startsAt ?? op.eventStartsAt ?? event?.startsAt;
  if (startsAt !== undefined) rows.push({ label: "When", value: whenWords(startsAt, p.endsAt ?? event?.endsAt, p.allDay ?? event?.allDay) });
  if (op.kind === "propose" && p.proposedStart !== undefined) rows.push({ label: "Instead", value: whenWords(p.proposedStart, p.proposedEnd) });
  const where = p.location ?? event?.location;
  if (where) rows.push({ label: "Where", value: where });
  if (p.attendees?.length) rows.push({ label: "Invites", value: p.attendees.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") });
  if (p.uninvite?.length) rows.push({ label: "Uninvites", value: p.uninvite.join(", ") });
  if (p.series) rows.push({ label: "Applies to", value: "Every occurrence" });
  const reply = op.kind ? REPLY[op.kind] : undefined;
  if (reply) rows.push({ label: "Reply", value: reply });
  if (p.comment) rows.push({ label: "Note", value: p.comment });
  if (p.notes) rows.push({ label: "Details", value: p.notes });
  // An account's own calendar is named by its address; another (a shared or team one) by its id.
  const calendar = op.calendarId && op.calendarId !== op.account ? `${op.calendarId}, ${op.account ?? ""}`.replace(/, $/, "") : op.account;
  if (calendar) rows.push({ label: "Calendar", value: calendar });
  return rows;
}

/** When the act lands: a proposal's new time, else the act's own start, else its event's. */
export function opStart(op: CalendarOp, event: DayEvent | null): number | null {
  const p = op.payload ?? {};
  return (op.kind === "propose" ? p.proposedStart : undefined) ?? p.startsAt ?? op.eventStartsAt ?? event?.startsAt ?? null;
}

export type DayLine = { key: string; at: string; sector: string | null; title: string; own: boolean; minute: number };

/**
 * That day's events in time order, the act's own event marked; a new event the
 * act adds (or a change's new time) is a line of its own, marked, with no sector yet.
 */
export function dayLines(op: CalendarOp, events: readonly DayEvent[], event: DayEvent | null, sector: string | null): DayLine[] {
  const start = opStart(op, event);
  const lines: DayLine[] = events
    .filter((e) => !e.hidden)
    .map((e) => ({ key: e._id, at: e.allDay ? "All day" : time.format(e.startsAt), sector: e.sector, title: e.title, own: e._id === op.eventId, minute: e.allDay ? -1 : e.startsAt }));
  const moves = op.kind === "create" || (op.kind === "update" && op.payload?.startsAt !== undefined) || op.kind === "propose";
  if (moves && start !== null) {
    const title = op.payload?.title ?? event?.title ?? op.eventTitle ?? "New event";
    for (const line of lines) if (line.own) line.own = false;
    lines.push({ key: `act:${op.id}`, at: op.payload?.allDay ? "All day" : time.format(start), sector, title, own: true, minute: op.payload?.allDay ? -1 : start });
  }
  return lines.sort((a, b) => a.minute - b.minute);
}
