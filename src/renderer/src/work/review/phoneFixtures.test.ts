import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/*
 * The phone's weekly review (ios/TempCodeClient/Sources/TempCodeClient/Work/Review/WeekReview*.swift) is a Swift
 * port of src/shared/work/review.ts. This test runs the real rules over a set of cases and holds
 * ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/review/<case>.json to what they give: each file is a case's
 * inputs (the hosts' parts, the moment, the merge's options) and what the window makes of them (the merged review,
 * and every word the page says of it). A change to review.ts not carried to the phone fails this test, and
 * WeekReviewParityTests.swift fails a phone that differs from the files. UPDATE_FIXTURES=1 writes them.
 */

// The zone is fixed before any module makes its formats; each case names the zone its words are said in.
vi.hoisted(() => {
  process.env.TZ = "America/Chicago";
});
const ZONE = "America/Chicago";
const TOKYO = "Asia/Tokyo";

import {
  dayStart,
  dayWords,
  factsOf,
  hostOffWords,
  hoursWords,
  isWeek,
  knownZone,
  LEFT,
  localDay,
  madeWords,
  mergeReview,
  nothingWords,
  SETTLE_HOWS,
  SETTLE_WORDS,
  SETTLED_WORDS,
  shippedWords,
  slippedDetail,
  splitOlder,
  standsWords,
  stepWeek,
  toQuarter,
  totalWords,
  weekNamed,
  weekOf,
  weekWords,
  type HostPoint,
  type MergedJob,
  type ReviewBody,
  type ReviewEvent,
  type ReviewLifeos,
  type ReviewWeek,
  type ShippedRow,
  type SlippedRow,
} from "@shared/work/review";
import type { SectorKey } from "@shared/work/ids";

const ROOT = resolve(__dirname, "../../../../..");
const DIR = join(ROOT, "ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/review");

// ── the inputs, as plain JSON (the Swift test decodes each part's body as the contract's ReviewBody) ─────────────

type PartIn = { environmentId: string; body: ReviewBody; stale?: boolean };
type Opts = { home?: string | null; names?: Record<string, string>; order?: string[]; jobs?: Pick<MergedJob, "key" | "sector" | "name">[]; fresh?: boolean; whole?: boolean };
type Case = {
  name: string;
  /** the zone the window cuts weeks in, for the calendar asks */
  tz: string;
  now: number;
  parts: PartIn[];
  opts: Opts;
  /** moments the calendar is asked about: the week that holds `at`, and the week a host names by `named` */
  calendar: { at: number; named: number };
  /** moments `dayWords` is asked about, in the merged week */
  days: number[];
  /** lengths `hoursWords` and `toQuarter` are asked about */
  lengths?: number[];
};

// ── the week of Nov 16 2026 in Chicago, and its makers ───────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday Nov 16 2026, 00:00 in Chicago. */
const MON = Date.parse("2026-11-16T06:00:00Z");
const WEEK = weekOf(MON, ZONE);
/** Friday 4:00 PM: when the routine makes it. */
const FRIDAY = MON + 4 * DAY + 16 * HOUR;
/** The Monday after, 9:00 AM. */
const AFTER = WEEK.to + 9 * HOUR;
/** Thursday 2:02 PM: the week so far. */
const THURSDAY = MON + 3 * DAY + 14 * HOUR + 2 * MIN;
const B = MON - 7 * DAY;
const at = (day: number, hour: number, from = MON): number => from + day * DAY + hour * HOUR;

const JOBS = [
  { workspaceId: "w-cosmic", sector: "cosmic", name: "Cosmic" },
  { workspaceId: "w-hypixel", sector: "hypixel", name: "Hypixel" },
  { workspaceId: "w-purdue", sector: "purdue", name: "Purdue" },
  { workspaceId: "w-unify", sector: "unify", name: "Unify" },
  { workspaceId: "w-side", sector: null, name: "Side work" },
] as ReviewBody["jobs"];
const job = (sector: SectorKey | null): number => JOBS.findIndex((j) => j.sector === sector);

/** A sitting: a point every twelve minutes from `hour` for `hours`. */
const sit = (sector: SectorKey | null, day: number, hour: number, hours: number, kind: HostPoint[2] = "said", from = MON, jobs = JOBS): HostPoint[] =>
  Array.from({ length: Math.floor((hours * 60) / 12) + 1 }, (_, i) => [from + day * DAY + hour * HOUR + i * 12 * MIN, jobs.findIndex((j) => j.sector === sector), kind] as HostPoint);

const ev = (id: string, sector: SectorKey, title: string, startsAt: number, hours: number, people: string[] = [], others = people.length, more: Partial<ReviewEvent> = {}): ReviewEvent => ({
  id,
  sector,
  title,
  startsAt,
  endsAt: startsAt + hours * HOUR,
  allDay: false,
  declined: false,
  hidden: false,
  people,
  others,
  addresses: people.map((p) => `${p.toLowerCase().replace(/\s+/g, ".")}@example.com`),
  ...more,
});
const sent = (id: string, sector: SectorKey, subject: string, when: number, to: string[] = ["Riley Okafor"]) => ({ id, threadId: `t-${id}`, subject, to, addresses: to.map((p) => `${p.toLowerCase().replace(/\s+/g, ".")}@example.com`), at: when, sector });

const task = (id: string, sector: SectorKey, title: string, dueAt: number, more: Partial<SlippedRow> = {}): SlippedRow => ({ key: `task:${id}`, ref: { kind: "task", id, dueAt }, sector, workspaceId: null, title, at: dueAt, people: [], others: 0, open: true, ...more });
const waitRow = (threadId: string, sector: SectorKey, title: string, since: number, people: string[], others = people.length, more: Partial<SlippedRow> = {}): SlippedRow => ({ key: `mail:${threadId}:${since}`, ref: { kind: "mail", threadId, since }, sector, workspaceId: null, title, at: since, people, others, open: true, ...more });
const meetingRow = (eventId: string, sector: SectorKey, title: string, began: number, people: string[], others = people.length, more: Partial<SlippedRow> = {}): SlippedRow => ({ key: `meeting:${eventId}`, ref: { kind: "meeting", eventId }, sector, workspaceId: null, title, at: began, people, others, open: true, ...more });
const heldRow = (id: string, sector: SectorKey, workspaceId: string, title: string, since: number, more: Partial<SlippedRow> = {}): SlippedRow => ({ key: `held:host:${id}`, ref: { kind: "held", ref: { at: "host", id } }, sector, workspaceId, title, at: since, people: [], others: 0, open: true, ...more });
const approved = (id: string, sector: SectorKey, workspaceId: string, title: string, when: number): ShippedRow => ({ key: `held:host:${id}`, kind: "approved", sector, workspaceId, title, who: null, at: when, open: { at: "held", ref: { at: "host", id } } });

const EVENTS: ReviewEvent[] = [
  ev("e1", "cosmic", "Patch planning", at(0, 9), 1, ["Riley Okafor"]),
  ev("e2", "cosmic", "Economy review", at(2, 9), 1.5, ["Riley Okafor", "Mina Farrow"]),
  ev("e3", "cosmic", "Dev sync", at(2, 9.5), 1, ["Riley Okafor"]),
  ev("e4", "purdue", "Staff meeting", at(0, 13), 1, ["Dana Reyes", "Sam Park", "Ivy Chen"], 6),
  ev("e5", "purdue", "Budget review", at(3, 14), 1.5, ["Dana Reyes", "Sam Park"], 4),
  ev("e6", "ref", "Varsity doubleheader", at(1, 17), 3.5, ["Assigner"]),
  ev("e7", "life", "Holiday", at(3, 0), 24, [], 0, { allDay: true }),
  ev("e8", "hypixel", "Thumbnail call", at(2, 15), 1, ["Sam Lindqvist"], 1, { declined: true }),
  ev("e9", "life", "Dentist", at(4, 16), 1, [], 0, { hidden: true }),
  ev("e10", "unify", "Open-ended", at(1, 8), 0, [], 0, { endsAt: null }),
];

function lifeos(cut: number): ReviewLifeos {
  const within = <T extends { at: number }>(rows: T[]): T[] => rows.filter((r) => r.at < cut);
  return {
    events: EVENTS.filter((e) => e.startsAt < cut),
    sent: within([
      sent("m1", "cosmic", "Season 12 patch notes", at(0, 11)),
      sent("m2", "cosmic", "Crate odds for the wiki", at(1, 12)),
      sent("m3", "cosmic", "Store pricing for the weekend", at(3, 11), ["Riley Okafor", "Mina Farrow"]),
      sent("m4", "purdue", "Spring travel roster", at(4, 11), ["Dana Reyes", "Sam Park", "Ivy Chen"]),
      sent("m5", "hypixel", "Thumbnail notes for episode 40", at(2, 11), ["Sam Lindqvist"]),
    ]),
    done: within([
      { id: "k1", title: "Fix the crate drop rates", at: at(2, 15), sector: "cosmic" },
      { id: "k2", title: "Order the new jerseys", at: at(0, 15), sector: "purdue" },
      { id: "k3", title: "Renew the car registration", at: at(1, 12), sector: "life" },
    ]),
    answered: within([{ threadId: "t-a1", subject: "Dev server budget", by: "Riley Okafor", at: at(1, 14), sector: "cosmic" }]),
    answeredSince: MON - 30 * DAY,
  };
}

const POINTS: HostPoint[] = [
  ...sit("cosmic", 0, 10.25, 2.5),
  ...sit("cosmic", 2, 8.5, 2.25),
  ...sit("cosmic", 3, 19, 1.5, "edited"),
  ...sit("hypixel", 1, 13.5, 2.5),
  ...sit("purdue", 0, 14.25, 2.5),
  ...sit("purdue", 2, 15.25, 0.5, "pressed"),
  ...sit("purdue", 4, 13, 2.25),
  ...sit(null, 1, 20, 1),
];
/** The week before: Unify had six hours then and nothing now; Purdue much more. */
const BEFORE_POINTS: HostPoint[] = [
  ...sit("unify", 1, 9, 3, "said", B),
  ...sit("unify", 4, 13, 3, "said", B),
  ...sit("cosmic", 0, 10, 3, "said", B),
  ...sit("hypixel", 1, 14, 2.5, "said", B),
  ...sit("purdue", 0, 14, 3, "said", B),
  ...sit("purdue", 2, 14, 3, "said", B),
];
const span = (sector: SectorKey, day: number, hour: number, hours: number) => ({ sector, from: at(day, hour, B), to: at(day, hour + hours, B) });
const BEFORE_EVENTS = [span("cosmic", 0, 8.5, 1.5), span("purdue", 0, 13, 1), span("purdue", 3, 14, 4), span("ref", 1, 17, 3.5)];

const SLIPPED: SlippedRow[] = [
  task("s1", "hypixel", "Send the thumbnail drafts", at(1, 9)),
  waitRow("tw1", "hypixel", "Winter video schedule", at(-4, 10), ["Sam Lindqvist"]),
  meetingRow("e5", "purdue", "Budget review", at(3, 14), ["Dana Reyes", "Sam Park"], 4),
  task("s2", "purdue", "File the travel reimbursements", at(2, 9)),
  task("s3", "purdue", "Renew the arena booking", at(-9, 9)),
];
const HELD = heldRow("h1", "purdue", "w-purdue", "Reply to the facilities office", at(1, 10));
const APPROVED = approved("h7", "purdue", "w-purdue", "Post the bracket to #esports", at(3, 16));

/** The box's part: every job, the whole of LifeOS, and its own points, run time and held rows. */
function box(now: number, over: Partial<ReviewBody> = {}): ReviewBody {
  const cut = Math.min(now, WEEK.to);
  const beforeTo = B + (cut - WEEK.from);
  return {
    host: "box",
    from: WEEK.from,
    to: WEEK.to,
    tz: ZONE,
    madeAt: now,
    by: "owner",
    over: now >= WEEK.to,
    jobs: JOBS,
    lifeos: lifeos(cut),
    points: POINTS.filter((p) => p[0] < cut),
    ran: [
      [job("cosmic"), 31 * HOUR + 10 * MIN],
      [job("purdue"), 6 * HOUR + 40 * MIN],
      [job("hypixel"), 40 * 1000],
    ],
    slipped: { at: now, rows: [...SLIPPED.filter((r) => r.at < cut - HOUR), ...(HELD.at < cut - DAY ? [HELD] : [])] },
    shipped: APPROVED.at < cut ? [APPROVED] : [],
    before: { from: B, to: beforeTo, lifeos: { events: BEFORE_EVENTS.filter((e) => e.from < beforeTo).map((e) => ({ ...e, to: Math.min(e.to, beforeTo) })), sent: [] }, points: BEFORE_POINTS.filter((p) => p[0] < beforeTo) },
    left: [],
    ...over,
  };
}

const MAC_JOBS = [{ workspaceId: "m-cosmic", sector: "cosmic", name: "Cosmic" }] as ReviewBody["jobs"];
/** The Mac's part: a second Cosmic workspace with its own threads, and the same LifeOS. */
function mac(now: number, over: Partial<ReviewBody> = {}): ReviewBody {
  return {
    ...box(now),
    host: "mac",
    jobs: MAC_JOBS,
    points: sit("cosmic", 4, 13, 1.5, "said", MON, MAC_JOBS).filter((p) => p[0] < now),
    ran: [[0, 3 * HOUR]],
    slipped: { at: now, rows: [heldRow("h1", "cosmic", "m-cosmic", "Post the patch notes", at(2, 9))].filter((r) => r.at < now - DAY) },
    shipped: [],
    before: null,
    ...over,
  };
}

/** The routine made it on Friday; looked at the Monday after, what slipped is as it stood then. */
const friday = (over: Partial<ReviewBody> = {}): ReviewBody => box(AFTER, { by: "routine", slipped: box(FRIDAY).slipped, ...over });
const both = (b: ReviewBody, m: ReviewBody = mac(AFTER)): PartIn[] => [
  { environmentId: "env-box", body: b },
  { environmentId: "env-mac", body: m },
];
const reads = (t: number) => ({ events: t, sent: t, answered: t, done: t, due: t, waits: t, meetings: t });
const quiet = (body: ReviewBody): ReviewBody => ({ ...body, points: [], ran: [], shipped: [], slipped: { at: body.slipped.at, rows: [] }, before: null, lifeos: body.lifeos ? { ...body.lifeos, events: [], sent: [], done: [], answered: [] } : null });

const DAYS = [at(1, 9), at(3, 14), at(-4, 10), WEEK.to + HOUR];
const CAL = { at: THURSDAY, named: WEEK.from };

// ── the clock change: Chicago's week of Oct 26 2026 holds Sunday Nov 1, when the clocks go back (169 hours) ─────

const FALL = weekOf(Date.parse("2026-10-28T12:00:00Z"), ZONE);
const FALL_BEFORE = stepWeek(FALL, -1, ZONE);
function fallBody(now: number, over: Partial<ReviewBody> = {}): ReviewBody {
  const cut = Math.min(now, FALL.to);
  const elapsed = cut - FALL.from;
  // Sunday Nov 1 is the seventh day; 10:00 AM that day is 7 hours past 2:00 AM CST, since 1:00 AM came twice.
  const sunday = dayStart(FALL.from, ZONE, 6);
  const events = [ev("f1", "purdue", "Season kickoff", FALL.from + 10 * HOUR, 2, ["Dana Reyes"]), ev("f2", "ref", "Saturday tournament", dayStart(FALL.from, ZONE, 5) + 8 * HOUR, 8, ["Assigner"]), ev("f3", "ref", "Sunday final", sunday + 10 * HOUR, 3, ["Assigner"])].filter((e) => e.startsAt < cut);
  return {
    host: "box",
    from: FALL.from,
    to: FALL.to,
    tz: ZONE,
    madeAt: now,
    by: "owner",
    over: now >= FALL.to,
    jobs: JOBS,
    lifeos: { events, sent: [sent("fm1", "purdue", "Kickoff notes", FALL.from + 13 * HOUR, ["Dana Reyes"])].filter((m) => m.at < cut), done: [], answered: [], answeredSince: FALL.from + DAY },
    points: [...sit("purdue", 0, 13, 2, "said", FALL.from), ...sit("cosmic", 6, 1, 1.5, "said", FALL.from)].filter((p) => p[0] < cut),
    ran: [],
    slipped: { at: now, rows: [task("f-t1", "purdue", "Book the kickoff room", FALL.from + 2 * DAY + 9 * HOUR)].filter((r) => r.at < cut) },
    shipped: [],
    before: {
      from: FALL_BEFORE.from,
      to: FALL_BEFORE.from + Math.min(elapsed, FALL_BEFORE.to - FALL_BEFORE.from),
      lifeos: { events: [{ sector: "ref", from: FALL_BEFORE.from + 5 * DAY + 8 * HOUR, to: FALL_BEFORE.from + 5 * DAY + 20 * HOUR }, { sector: "purdue", from: FALL_BEFORE.from + 10 * HOUR, to: FALL_BEFORE.from + 11 * HOUR }], sent: [] },
      points: sit("cosmic", 6, 1, 1.5, "said", FALL_BEFORE.from),
    },
    left: [],
    ...over,
  };
}

// ── a Tokyo host's week, named from Chicago's ────────────────────────────────────────────────────────────────

const TOKYO_WEEK = weekNamed(WEEK.from, TOKYO);
function tokyoBody(now: number): ReviewBody {
  const t = (day: number, hour: number) => TOKYO_WEEK.from + day * DAY + hour * HOUR;
  return {
    host: "tokyo",
    from: TOKYO_WEEK.from,
    to: TOKYO_WEEK.to,
    tz: TOKYO,
    madeAt: now,
    by: "owner",
    over: now >= TOKYO_WEEK.to,
    jobs: [{ workspaceId: "t-hypixel", sector: "hypixel", name: "Hypixel" }],
    lifeos: { events: [ev("k1", "hypixel", "Asia server launch", t(1, 9), 2, ["Kenji Sato"])], sent: [sent("km1", "hypixel", "Launch checklist", t(1, 12), ["Kenji Sato"])], done: [], answered: [], answeredSince: null },
    points: sit("hypixel", 2, 10, 2, "said", TOKYO_WEEK.from, [{ workspaceId: "t-hypixel", sector: "hypixel", name: "Hypixel" }]),
    ran: [[0, 90 * MIN]],
    slipped: {
      at: now,
      rows: [task("kt1", "hypixel", "Translate the patch notes", t(2, 18)), meetingRow("k1", "hypixel", "Asia server launch", t(1, 9), ["Kenji Sato"]), waitRow("tk1", "hypixel", "Region pricing", t(-2, 23), ["Kenji Sato", "Aiko Mori"], 2)],
    },
    shipped: [],
    before: null,
    left: [],
  };
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────

const base = { tz: ZONE, opts: { home: "env-box" }, calendar: CAL, days: DAYS };

const CASES: Case[] = [
  // Two hosts, a week that is over, looked back on: LifeOS taken once from the home, Unify's six hours the week before shown.
  { ...base, name: "two-hosts-over", now: AFTER, parts: both(friday()), lengths: [0, 1, 7 * MIN, 7.5 * MIN, 22.5 * MIN, 59 * MIN + 31_000, HOUR, 4 * HOUR + 37 * MIN, 100 * HOUR] },
  // The week so far: the same span of last week, the words say so.
  { ...base, name: "so-far-thursday", now: THURSDAY, parts: both(box(THURSDAY), mac(THURSDAY)) },
  // Looked back on: kept rows dealt with since read open: false, and a meeting followed up in Prep on the Mac reads done.
  {
    ...base,
    name: "back-kept-closed",
    now: AFTER,
    parts: both(friday({ slipped: { at: FRIDAY, rows: box(FRIDAY).slipped.rows.map((r) => (r.key === "task:s2" || r.key === "task:s1" ? { ...r, open: false } : r)) } }), mac(AFTER, { prepped: ["e5"] })),
  },
  // The Mac did not answer this time: its part is from before. No comparison, desk not known, meetings as last known.
  { ...base, name: "one-host-stale", now: AFTER, opts: { home: "env-box", fresh: false }, parts: [{ environmentId: "env-box", body: friday() }, { environmentId: "env-mac", body: mac(FRIDAY), stale: true }] },
  // The Mac is home: LifeOS from it (its done list holds one more), the box's own rows still the box's.
  {
    ...base,
    name: "lifeos-from-home-mac",
    now: AFTER,
    opts: { home: "env-mac" },
    parts: both(friday(), mac(AFTER, { lifeos: { ...lifeos(WEEK.to), done: [...lifeos(WEEK.to).done, { id: "k9", title: "Book the arena", at: at(4, 9), sector: "purdue" }] } })),
  },
  // The box runs a build from before `read`: read by its lines, its calendar failed; the Mac read everything and names its reads.
  {
    ...base,
    name: "old-build-no-read",
    now: THURSDAY,
    parts: both(box(THURSDAY, { lifeos: { ...lifeos(THURSDAY), events: [] }, left: [LEFT.calendar] }), mac(THURSDAY, { read: reads(THURSDAY) })),
  },
  // Each host's held rows, one per host; a held row and a shipped one filed by their own sector though their workspace is another job's.
  {
    ...base,
    name: "held-on-hosts",
    now: AFTER,
    parts: both(
      friday({
        slipped: { at: FRIDAY, rows: [HELD, heldRow("h3", "cosmic", "w-purdue", "Post the patch notes", at(1, 11)), task("s1", "hypixel", "Send the thumbnail drafts", at(1, 9))] },
        shipped: [APPROVED, { ...approved("h4", "cosmic", "w-purdue", "Post the trailer", at(2, 10)), open: null }],
      }),
      mac(AFTER, { slipped: { at: FRIDAY, rows: [HELD, task("s1", "hypixel", "Send the thumbnail drafts", at(1, 9))] }, shipped: [approved("h8", "cosmic", "m-cosmic", "Publish the wiki page", at(3, 9))] }),
    ),
  },
  // The week of the clock change, still running on Sunday afternoon: compared over the same length of time.
  { ...base, name: "fall-back-running", now: dayStart(FALL.from, ZONE, 6) + 15 * HOUR, calendar: { at: dayStart(FALL.from, ZONE, 6) + 15 * HOUR, named: FALL.from }, days: [FALL.from + HOUR, FALL.to - HOUR, FALL.from - HOUR], parts: [{ environmentId: "env-box", body: fallBody(dayStart(FALL.from, ZONE, 6) + 15 * HOUR) }] },
  // The same week once over: 169 hours, compared whole.
  { ...base, name: "fall-back-over", now: FALL.to + 9 * HOUR, calendar: { at: FALL.to - MIN, named: FALL.from }, days: [FALL.from + HOUR, FALL.to - HOUR, FALL.to + HOUR], parts: [{ environmentId: "env-box", body: fallBody(FALL.to + 9 * HOUR) }] },
  // A Tokyo host's week, named from Chicago's: its words said in Tokyo.
  { ...base, tz: TOKYO, name: "tokyo-named", now: TOKYO_WEEK.from + 3 * DAY + 5 * HOUR, opts: {}, calendar: { at: TOKYO_WEEK.from + 3 * DAY, named: WEEK.from }, days: [TOKYO_WEEK.from + DAY, TOKYO_WEEK.from - DAY], parts: [{ environmentId: "env-tokyo", body: tokyoBody(TOKYO_WEEK.from + 3 * DAY + 5 * HOUR) }] },
  // The four slipped kinds, with tasks due before the week folded behind the rest.
  {
    ...base,
    name: "four-slipped-kinds",
    now: AFTER,
    parts: [
      {
        environmentId: "env-box",
        body: friday({
          slipped: {
            at: FRIDAY,
            rows: [
              task("s1", "purdue", "File the travel reimbursements", at(2, 9)),
              task("s3", "purdue", "Renew the arena booking", at(-9, 9)),
              task("s4", "purdue", "Update the roster page", at(-16, 9)),
              waitRow("tw1", "purdue", "Bus quote", Date.parse("2026-11-12T18:00:00Z"), ["Dana Reyes"], 1),
              waitRow("tw2", "purdue", "Field trip forms", at(1, 8), []),
              heldRow("h1", "purdue", "w-purdue", "Reply to the facilities office", at(1, 10)),
              meetingRow("e5", "purdue", "Budget review", at(3, 14), ["Dana Reyes", "Sam Park"], 4),
              meetingRow("e4", "purdue", "Staff meeting", at(0, 13), [], 0),
            ],
          },
        }),
      },
    ],
  },
  // Desk time under an event, of any job, is dropped; what is left is always "about".
  {
    ...base,
    name: "desk-under-event",
    now: AFTER,
    parts: [
      {
        environmentId: "env-box",
        body: {
          ...quiet(friday()),
          lifeos: { events: [ev("d1", "purdue", "Budget review", at(0, 10), 1, ["Dana Reyes"])], sent: [], done: [], answered: [], answeredSince: MON - DAY },
          points: [
            [at(0, 10) - 10 * MIN, job("cosmic"), "said"],
            [at(0, 10) + 5 * MIN, job("cosmic"), "said"],
            [at(0, 10) + 20 * MIN, job("cosmic"), "edited"],
            [at(0, 10) + 55 * MIN, job("cosmic"), "said"],
            [at(0, 10) + 65 * MIN, job("cosmic"), "said"],
            [at(1, 9), job("hypixel"), "sent"],
          ],
        },
      },
    ],
  },
  // The week before moved too little to say: no line.
  {
    ...base,
    name: "compare-not-shown",
    now: AFTER,
    parts: [
      {
        environmentId: "env-box",
        body: {
          ...quiet(friday()),
          lifeos: { events: [ev("c1", "purdue", "Planning", at(1, 9), 5)], sent: [], done: [], answered: [], answeredSince: MON - DAY },
          before: { from: B, to: WEEK.from, lifeos: { events: [{ sector: "purdue", from: at(1, 9, B), to: at(1, 13, B) }], sent: [] }, points: [] },
        },
      },
    ],
  },
  // An empty week, every `known`.
  { ...base, name: "empty-all-read", now: AFTER, parts: [{ environmentId: "env-box", body: quiet(friday()) }] },
  { ...base, name: "empty-calendar-failed", now: AFTER, parts: [{ environmentId: "env-box", body: { ...quiet(friday()), left: [LEFT.calendar] } }] },
  { ...base, name: "empty-threads-failed", now: AFTER, parts: [{ environmentId: "env-box", body: { ...quiet(friday()), left: [LEFT.threads] } }] },
  { ...base, name: "empty-lifeos-down", now: AFTER, parts: [{ environmentId: "env-box", body: { ...quiet(friday()), lifeos: null, left: [LEFT.lifeos], lifeosState: "signed-out" } }] },
  // Jobs the window knows of, a sector with no workspace named, the order asked for; a host is off.
  {
    ...base,
    name: "jobs-order-names",
    now: AFTER,
    opts: { home: "env-box", names: { unify: "Unify Platforms", life: "Life" }, order: ["unify", "purdue", "ref"], jobs: [{ key: "ref", sector: "ref", name: "Refereeing" }, { key: "cosmic", sector: "cosmic", name: "Cosmic" }], whole: false },
    parts: [
      {
        environmentId: "env-mac",
        body: mac(AFTER, { jobs: [{ workspaceId: "m-purdue", sector: "purdue", name: "Purdue Esports" }], points: [], ran: [], lifeos: { ...lifeos(WEEK.to), done: [{ id: "k5", title: "Renew the domain", at: at(1, 9), sector: "unify" }, { id: "k6", title: "Pay the dentist", at: at(2, 9), sector: "life" }] } }),
      },
    ],
  },
  // Neither host read LifeOS, each for its own reason; one answered from before.
  {
    ...base,
    name: "lifeos-down-two",
    now: AFTER,
    opts: { home: "env-box", fresh: false },
    parts: [
      { environmentId: "env-box", body: friday({ lifeos: null, left: [LEFT.lifeos, LEFT.held], lifeosState: "signed-out", before: null }) },
      { environmentId: "env-mac", body: mac(FRIDAY, { lifeos: null, left: [LEFT.lifeosKept], lifeosState: "pairing" }), stale: true },
    ],
  },
  // The box kept Friday's list and could not read its tasks on Monday; the Mac reads the week first and checks it.
  {
    ...base,
    name: "peer-checks-kept-task",
    now: AFTER,
    parts: both(
      friday({ over: true, lifeos: null, left: [LEFT.lifeosKept], read: {}, slipped: { at: FRIDAY, rows: [task("late", "purdue", "Late task", at(1, 9)), task("gone", "purdue", "Done since", at(2, 9))] } }),
      mac(AFTER, { read: reads(AFTER), slipped: { at: AFTER, rows: [task("late", "purdue", "Late task", at(1, 9))] } }),
    ),
  },
  // The newest list kept inside the week stands; an older one checks only the rows it held.
  {
    ...base,
    name: "newest-kept-list",
    now: AFTER,
    parts: both(
      friday({ left: [LEFT.tasks], read: { events: AFTER, sent: AFTER, answered: AFTER, waits: AFTER, meetings: AFTER }, slipped: { at: FRIDAY, rows: [task("old", "purdue", "Old task", at(1, 9)), task("fri", "purdue", "Friday's task", FRIDAY - 7 * HOUR)] } }),
      mac(AFTER, { read: reads(AFTER), slipped: { at: FRIDAY - DAY, rows: [task("old", "purdue", "Old task", at(1, 9), { open: false })] } }),
    ),
  },
  // The home could not read a put-off meeting: its meetings stand as last known, and the line stays.
  {
    ...base,
    name: "meetings-home-carried",
    now: FRIDAY,
    parts: both(
      box(FRIDAY, { left: [LEFT.carried], read: { ...reads(FRIDAY), meetings: undefined }, slipped: { at: FRIDAY, rows: [meetingRow("roster", "purdue", "Roster call", at(2, 13), ["Dana Reyes"])] } }),
      mac(FRIDAY, { read: reads(FRIDAY), slipped: { at: FRIDAY, rows: [meetingRow("budget", "purdue", "Budget review", at(3, 14), ["Dana Reyes"])] } }),
    ),
  },
  // A week first asked for after it ended: what slipped is as of today.
  { ...base, name: "not-made-in-week", now: AFTER, parts: [{ environmentId: "env-box", body: box(AFTER, { slipped: { at: AFTER, rows: [task("s2", "purdue", "File the travel reimbursements", at(2, 9))] } }) }] },
  // A running week counts to the moment its facts were read; a later host's read moves the span on, not the calendar.
  {
    ...base,
    name: "running-read-later",
    now: MON + 15 * HOUR,
    parts: [
      { environmentId: "env-box", body: { ...box(MON + 14 * HOUR + 2 * MIN), lifeos: { ...lifeos(MON + 14 * HOUR + 2 * MIN), events: [ev("r1", "purdue", "Budget review", MON + 14 * HOUR, 1.5, ["Dana Reyes"])] } } },
      { environmentId: "env-mac", body: mac(MON + 14 * HOUR + 8 * MIN, { lifeos: null, left: [LEFT.lifeos], points: [[MON + 14 * HOUR + 7 * MIN, 0, "said"]] }) },
    ],
  },
];

// ── what the window makes of a case ──────────────────────────────────────────────────────────────────────────

function fixtureOf(c: Case) {
  const names = c.opts.names;
  const merged = mergeReview(c.parts, c.now, { ...c.opts, ...(names ? { names: (s: SectorKey) => names[s] ?? s } : {}) });
  const cal = (w: ReviewWeek) => ({ from: w.from, to: w.to });
  const wk = weekOf(c.calendar.at, c.tz);
  const calendar = {
    weekOf: cal(wk),
    hours: (wk.to - wk.from) / HOUR,
    prev: cal(stepWeek(wk, -1, c.tz)),
    next: cal(stepWeek(wk, 1, c.tz)),
    named: cal(weekNamed(c.calendar.named, c.tz)),
    isWeek: isWeek(wk.from, wk.to, c.tz),
    isNotWeek: isWeek(wk.from + HOUR, wk.to, c.tz),
    dayStart: dayStart(c.calendar.at, c.tz),
    dayAfter: dayStart(c.calendar.at, c.tz, 1),
    dayBefore: dayStart(c.calendar.at, c.tz, -1),
    localDay: localDay(c.calendar.at, c.tz),
    knownZone: knownZone(c.tz),
  };
  const lengths = (c.lengths ?? []).map((ms) => ({ ms, quarter: toQuarter(ms), measured: hoursWords(ms, "measured"), estimate: hoursWords(ms, "estimate") }));
  if (!merged) return { ...c, expect: { merged: null, calendar, lengths } };
  const week = { from: merged.from, to: merged.to };
  const tz = merged.tz;
  const words = {
    week: weekWords(week, tz),
    made: madeWords(merged, tz, c.now),
    nothing: nothingWords(merged.known),
    hostOff: hostOffWords("The Mac"),
    days: c.days.map((t) => dayWords(t, week, tz)),
    jobs: merged.hours.map((h) => {
      const rows = merged.slipped.filter((r) => r.job === h.job);
      const split = splitOlder(rows, week);
      return {
        job: h.job,
        total: totalWords(h),
        stands: standsWords(h.stands),
        facts: factsOf(h),
        compare: merged.compare.find((x) => x.job === h.job)?.words ?? null,
        lead: split.lead.map((r) => r.key),
        older: split.older.map((r) => r.key),
      };
    }),
    shipped: merged.shipped.map((r) => ({ key: r.key, ...shippedWords(r) })),
    slipped: merged.slipped.map((r) => ({
      key: r.key,
      detail: slippedDetail(r, week, tz),
      settle: SETTLE_HOWS.map((how) => SETTLE_WORDS[r.ref.kind][how]),
      settled: SETTLE_HOWS.map((how) => SETTLED_WORDS[r.ref.kind][how]),
    })),
  };
  return { ...c, expect: { merged, calendar, lengths, words } };
}

// ── held to the files ────────────────────────────────────────────────────────────────────────────────────────

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe("the phone's weekly review fixtures", () => {
  it("are written in one zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
  });

  it("cover the week of the clock change, 169 hours long", () => {
    expect((FALL.to - FALL.from) / HOUR).toBe(169);
  });

  for (const c of CASES) {
    it(`${c.name} is the window's answer`, () => {
      const file = join(DIR, `${c.name}.json`);
      const want = text(fixtureOf(c));
      if (process.env.UPDATE_FIXTURES === "1") {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, want);
      }
      expect(readFileSync(file, "utf8"), `${c.name}.json is out of date: UPDATE_FIXTURES=1 writes it, then carry the change to Work/Review`).toBe(want);
    });
  }

  it("has no file without a case", () => {
    const names = new Set(CASES.map((c) => `${c.name}.json`));
    expect(readdirSync(DIR).filter((f) => !names.has(f))).toEqual([]);
  });
});
