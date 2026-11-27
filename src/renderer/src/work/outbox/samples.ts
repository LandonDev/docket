import type { ActKind } from "@shared/work";
import type { KindRows } from "../acts/kindRows";
import type { HostGrant, HostItem } from "./store";
import type { Section } from "./waiting";

/*
 * The Outbox's samples (docs/agents/loading-bones.md "Samples"): the rows,
 * the detail and a request's card as they stand while the first read is out.
 * Nobody reads the words; their lengths and the fields set give the bones
 * their shape. A fixed clock, so a row's time is a time's length.
 */

/** The clock the samples are read at: 14:00 on a Thursday. */
export const SAMPLE_NOW = new Date(2026, 10, 19, 14, 0).getTime();

const item = (n: number, kind: ActKind, summary: string, verb: string, minutes: number, over: Partial<HostItem> = {}): HostItem => ({
  ref: { at: "lifeos", table: "outbox", id: `sample:${n}` },
  environmentId: "sample:host",
  kind,
  workspaceId: "sample:ws",
  sessionId: null,
  sector: null,
  summary,
  verb,
  account: null,
  state: "held",
  payload: null,
  createdAt: SAMPLE_NOW - minutes * 60_000,
  decidedBy: null,
  decidedAt: null,
  n,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: SAMPLE_NOW - minutes * 60_000,
  ...over,
});

/** Waiting as most days hold it: two threads' groups, seven rows, the Outbox's first screen. */
export const SAMPLE_SECTIONS: Section<HostItem>[] = [
  {
    kind: "thread",
    key: "sample:thread:1",
    title: "Nationals roster",
    job: "Purdue Esports",
    sector: "purdue",
    items: [
      item(1, "mail.send", "Send to Priya Shah: Re: Travel for nationals", "Send", 12),
      item(2, "mail.send", "Send to Coach Alvarez: Roster for the spring split", "Send", 26),
      item(3, "calendar.op", "Add Scrim with IU on Tue, Dec 1 at 7:00 PM", "Add", 41),
      item(4, "chat.reply", "Reply to Maya in Esports staff: Van leaves at seven", "Reply", 58),
    ],
  },
  {
    kind: "thread",
    key: "sample:thread:2",
    title: "Weekend schedule",
    job: "Refereeing",
    sector: "ref",
    items: [
      item(5, "mail.send", "Send to the assignor: Saturday availability", "Send", 95),
      item(6, "calendar.op", "Add Varsity at North on Fri at 6:00 PM", "Add", 130),
      item(7, "office.edit", "Change Game log.xlsx: 3 cells", "Change", 180),
    ],
  },
];

const went = (n: number, kind: ActKind, summary: string, verb: string, minutes: number): HostItem =>
  item(n, kind, summary, verb, minutes + 1, { state: "sent", decidedBy: "owner", decidedAt: SAMPLE_NOW - minutes * 60_000 });

/** Done's first day. */
export const SAMPLE_DAYS: { label: string; items: HostItem[] }[] = [
  {
    label: "Today",
    items: [
      went(11, "mail.send", "Send to Priya Shah: Budget lines for the Fall league", "Send", 20),
      went(12, "calendar.op", "Add Varsity at North on Fri at 6:00 PM", "Add", 64),
      went(13, "mail.send", "Send to Coach Alvarez: Re: Jersey order", "Send", 110),
      went(14, "chat.reply", "Reply to Maya in Esports staff: Booked", "Reply", 170),
      went(15, "mail.send", "Send to the assignor: Saturday availability", "Send", 230),
      went(16, "share.guestLink", "Share Fall league budget.xlsx with Priya Shah", "Share", 300),
    ],
  },
];

/** The detail's item: a held mail, its facts and title. */
export const SAMPLE_ITEM: HostItem = { ...SAMPLE_SECTIONS[0]!.items[0]!, sector: "purdue", effect: "Goes after your 30-second undo." };

/** The detail's thing: a mail's header rows on the label column, and its body. */
export const SAMPLE_THING: { fields: KindRows["fields"]; body: string } = {
  fields: [
    { label: "To", value: "Priya Shah <priya.shah@purdue.edu>" },
    { label: "Subject", value: "Re: Travel for nationals" },
    { label: "From", value: "landon@purdue.edu" },
  ],
  body: "Hi Priya,\n\nSix players and two staff, leaving Thursday at 7 AM. The van is booked through RecWell, and the hotel holds four rooms.\n\nLandon",
};

const grant = (n: number, kind: ActKind, label: string, days: number): HostGrant => ({
  id: `sample:grant:${n}`,
  environmentId: "sample:host",
  workspaceId: "sample:ws",
  kind,
  matcher: null,
  label,
  madeFrom: { at: "lifeos", table: "outbox", id: `sample:${n}` },
  routineId: null,
  createdAt: SAMPLE_NOW - days * 86_400_000,
  removedAt: null,
});

/** The grants sheet's first read: one job's two grants. */
export const SAMPLE_GRANTS: HostGrant[] = [
  grant(1, "mail.send", "Replies to Priya Shah about travel", 3),
  grant(2, "calendar.op", "Scrims added to the Esports calendar", 12),
];
