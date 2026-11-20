import { whenWords } from "../agenda/calendarAct";
import { htmlWords } from "../outbox/model";

/**
 * What a held Outlook calendar act (`office.calendar.op`) says, as the Outbox
 * shows it: the same rows as LifeOS's calendar act (agenda/calendarAct.ts
 * `opFields`), from its two payload shapes (src/main/server/work/office/tools.ts):
 * an invitation (`op: "create"`, the event as it goes) and a reply to one
 * (`op: "answer"`, the event's subject, start and organizer read from Outlook).
 * Everything that goes is a row; the host id is bookkeeping and never shown.
 */

type Created = { op: "create"; event: { subject?: string; start?: string; end?: string; location?: string; body?: string; attendees?: string[]; account?: string } };
/** `end` and `location` are bound by the host when the answer is held (office/held.ts), and the press refuses an event that moved. */
type Answered = { op: "answer"; subject?: string; start?: string; end?: string; location?: string; organizer?: string; answer?: "accept" | "decline" | "tentative"; comment?: string };
export type OfficeCalendarOp = Created | Answered;

const REPLY = { accept: "Yes", decline: "No", tentative: "Maybe" } as const;

const at = (iso: string | undefined): number | undefined => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
/** An invitation's body as he reads it: its words, with links and images named, when Outlook's body is html. */
const words = (body: string): string => (/<[a-z][\s\S]*>/i.test(body) ? htmlWords(body) : body.trim());

export function officeOpFields(payload: unknown): { label: string; value: string }[] {
  const op = (payload ?? {}) as OfficeCalendarOp;
  const rows: { label: string; value: string }[] = [];
  if (op.op === "create") {
    const e = op.event ?? {};
    if (e.subject) rows.push({ label: "Event", value: e.subject });
    const start = at(e.start);
    if (start !== undefined) rows.push({ label: "When", value: whenWords(start, at(e.end)) });
    if (e.location) rows.push({ label: "Where", value: e.location });
    // The account it goes from, bound by the host when it was held: the press never takes Outlook's default of that moment.
    if (e.account) rows.push({ label: "From", value: e.account });
    if (e.attendees?.length) rows.push({ label: "Invites", value: e.attendees.join(", ") });
    if (e.body?.trim()) rows.push({ label: "Details", value: words(e.body) });
    return rows;
  }
  if (op.subject) rows.push({ label: "Event", value: op.subject });
  const start = at(op.start);
  if (start !== undefined) rows.push({ label: "When", value: whenWords(start, at(op.end)) });
  if (op.location) rows.push({ label: "Where", value: op.location });
  if (op.organizer) rows.push({ label: "From", value: op.organizer });
  if (op.answer && REPLY[op.answer]) rows.push({ label: "Reply", value: REPLY[op.answer] });
  if (op.comment) rows.push({ label: "Note", value: op.comment });
  return rows;
}
