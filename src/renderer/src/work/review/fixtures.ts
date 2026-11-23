import { hostOffWords, LEFT, mergeReview, weekOf, type HostPoint, type PointKind, type ReviewBody, type ReviewEvent, type ReviewLifeos, type ShippedRow, type SlippedRow } from "@shared/work/review";
import type { ReviewView } from "./store";

/**
 * A made-up week across six jobs, for the preview pages and the tests: every
 * name and number here is invented. The bodies are what two hosts would
 * answer (the box holds every job, the Mac a second Cosmic workspace), and
 * the page's view comes from the same `mergeReview` the app uses, so a
 * fixture can never show a number the rules would not.
 */

export const TZ = "America/Chicago";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday Nov 16 2026, 00:00 in Chicago. */
export const MON = Date.parse("2026-11-16T06:00:00Z");
export const WEEK = weekOf(MON, TZ);
/** Friday 4:00 PM: when the routine makes it. */
export const FRIDAY = MON + 4 * DAY + 16 * HOUR;
/** The Monday after, 9:00 AM: looking back at the week. */
export const AFTER = WEEK.to + 9 * HOUR;
/** Thursday 2:02 PM: the week so far. */
export const THURSDAY = MON + 3 * DAY + 14 * HOUR + 2 * MIN;

const JOBS = [
  { workspaceId: "w-cosmic", sector: "cosmic", name: "Cosmic" },
  { workspaceId: "w-hypixel", sector: "hypixel", name: "Hypixel" },
  { workspaceId: "w-purdue", sector: "purdue", name: "Purdue" },
  { workspaceId: "w-ref", sector: "ref", name: "Ref" },
  { workspaceId: "w-unify", sector: "unify", name: "Unify" },
  { workspaceId: "w-life", sector: "life", name: "Life" },
];
const job = (sector: string): number => JOBS.findIndex((j) => j.sector === sector);
const at = (day: number, hour: number): number => MON + day * DAY + hour * HOUR;

/** A sitting: a point every twelve minutes from `hour` for `hours`. */
const sit = (sector: string, day: number, hour: number, hours: number, kind: PointKind = "said", from = MON): HostPoint[] =>
  Array.from({ length: Math.floor((hours * 60) / 12) + 1 }, (_, i) => [from + day * DAY + hour * HOUR + i * 12 * MIN, job(sector), kind] as HostPoint);

let eventN = 0;
const event = (sector: string, title: string, day: number, hour: number, hours: number, people: string[] = [], others = people.length): ReviewEvent => ({
  id: `e${++eventN}`,
  sector,
  title,
  startsAt: at(day, hour),
  endsAt: at(day, hour + hours),
  allDay: false,
  declined: false,
  hidden: false,
  people,
  others,
  addresses: people.map((p) => `${p.toLowerCase().replace(/\s+/g, ".")}@example.com`),
});

const EVENTS: ReviewEvent[] = [
  event("cosmic", "Patch planning", 0, 9, 1, ["Riley Okafor"]),
  event("cosmic", "Dev sync", 1, 9, 0.5, ["Riley Okafor"]),
  event("cosmic", "Economy review", 2, 9, 1.5, ["Riley Okafor", "Mina Farrow"]),
  event("cosmic", "Dev sync", 3, 9, 0.5, ["Riley Okafor"]),
  event("cosmic", "Release checklist", 4, 9, 1, ["Riley Okafor"]),
  event("cosmic", "Store pricing", 4, 10.5, 1, ["Mina Farrow"]),
  event("purdue", "Staff meeting", 0, 13, 1, ["Dana Reyes", "Sam Park", "Ivy Chen"], 6),
  event("purdue", "Budget review", 3, 14, 1.5, ["Dana Reyes", "Sam Park"], 4),
  event("purdue", "Lab walk-through", 2, 13, 2, ["Ivy Chen"]),
  event("ref", "Varsity doubleheader", 1, 17, 3.5, ["Assigner"]),
  event("ref", "JV game", 4, 18, 3, ["Assigner"]),
  event("life", "Dentist", 2, 16, 1),
];

const SENT_COSMIC = ["Season 12 patch notes", "Crate odds for the wiki", "Store pricing for the weekend", "Bug bash sign-up", "Vendor invoice for October", "Release window", "Mod tooling budget", "Server costs, a first pass", "Playtest invites", "Changelog draft", "Thanks for the report", "Economy numbers"];
const DONE_COSMIC = ["Fix the crate drop rates", "Ship the vote-party hotfix"];

function lifeos(): ReviewLifeos {
  const sent = [
    ...SENT_COSMIC.map((subject, i) => ({ id: `m${i}`, threadId: `tc${i}`, subject, to: ["Riley Okafor"], addresses: ["riley.okafor@example.com"], at: at(i % 5, 11 + (i % 4)), sector: "cosmic" })),
    { id: "mp1", threadId: "tp1", subject: "Spring travel roster", to: ["Dana Reyes"], addresses: ["dana.reyes@example.com"], at: at(4, 11), sector: "purdue" },
    { id: "mh1", threadId: "th1", subject: "Thumbnail notes for episode 40", to: ["Sam Lindqvist"], addresses: ["sam.lindqvist@example.com"], at: at(2, 11), sector: "hypixel" },
  ];
  return {
    events: EVENTS,
    sent,
    done: [
      ...DONE_COSMIC.map((title, i) => ({ id: `kc${i}`, title, at: at(2 + i, 15), sector: "cosmic" })),
      { id: "kp1", title: "Order the new jerseys", at: at(0, 15), sector: "purdue" },
      { id: "kl1", title: "Renew the car registration", at: at(1, 12), sector: "life" },
    ],
    answered: [{ threadId: "tc20", subject: "Dev server budget", by: "Riley Okafor", at: at(1, 14), sector: "cosmic" }],
    answeredSince: MON - 30 * DAY,
  };
}

const task = (id: string, sector: string, title: string, dueAt: number): SlippedRow => ({ key: `task:${id}`, ref: { kind: "task", id, dueAt }, sector, workspaceId: null, title, at: dueAt, people: [], others: 0, open: true });
const SLIPPED: SlippedRow[] = [
  task("k1", "hypixel", "Send the thumbnail drafts", at(1, 9)),
  { key: "mail:tw1", ref: { kind: "mail", threadId: "tw1", since: at(-4, 10) }, sector: "hypixel", workspaceId: null, title: "Winter video schedule", at: at(-4, 10), people: ["Sam Lindqvist"], others: 1, open: true },
  { key: "meeting:e8", ref: { kind: "meeting", eventId: "e8" }, sector: "purdue", workspaceId: null, title: "Budget review", at: at(3, 14), people: ["Dana Reyes", "Sam Park"], others: 4, open: true },
  task("k2", "purdue", "File the travel reimbursements", at(2, 9)),
  task("k3", "purdue", "Renew the arena booking", at(-9, 9)),
  task("k4", "purdue", "Update the roster page", at(-16, 9)),
  task("k5", "purdue", "Archive last season's forms", at(-30, 9)),
];
const HELD: SlippedRow = { key: "held:host:h1", ref: { kind: "held", ref: { at: "host", id: "h1" } }, sector: "purdue", workspaceId: "w-purdue", title: "Reply to the facilities office", at: at(1, 10), people: [], others: 0, open: true };
const APPROVED: ShippedRow = { key: "held:host:h7", kind: "approved", sector: "purdue", workspaceId: "w-purdue", title: "Post the bracket to #esports", who: null, at: at(3, 16), open: { at: "held", ref: { at: "host", id: "h7" } } };

/** Where he sat at the desk this week, and the week before (Unify had six hours then and nothing now). */
const POINTS: HostPoint[] = [
  ...sit("cosmic", 0, 10.25, 2.5),
  ...sit("cosmic", 1, 10, 2.75),
  ...sit("cosmic", 2, 10.75, 1.75),
  ...sit("cosmic", 3, 10, 2.25),
  ...sit("cosmic", 3, 19, 1.5, "edited"),
  ...sit("hypixel", 1, 13.5, 2.5),
  ...sit("hypixel", 2, 19, 2.75),
  ...sit("purdue", 0, 14.25, 2.5),
  ...sit("purdue", 1, 8, 1.25),
  ...sit("purdue", 2, 15.25, 0.5, "pressed"),
  ...sit("purdue", 3, 16, 2),
  ...sit("purdue", 4, 13, 2.25),
  ...sit("life", 0, 19.5, 1.25),
  ...sit("life", 2, 17.25, 1.25),
];
/** The week before: much the same, but Purdue took about nine hours then and Unify six. */
const B = MON - 7 * DAY;
const BEFORE_POINTS: HostPoint[] = [
  ...sit("unify", 1, 9, 3, "said", B),
  ...sit("unify", 4, 13, 3, "said", B),
  ...sit("cosmic", 0, 10, 3, "said", B),
  ...sit("cosmic", 1, 10, 3, "said", B),
  ...sit("cosmic", 2, 10, 2.5, "said", B),
  ...sit("cosmic", 3, 10, 2.5, "said", B),
  ...sit("hypixel", 1, 14, 2.5, "said", B),
  ...sit("hypixel", 2, 19, 2.5, "said", B),
  ...sit("purdue", 0, 14, 3, "said", B),
  ...sit("purdue", 2, 14, 3, "said", B),
  ...sit("life", 0, 19.5, 1.25, "said", B),
  ...sit("life", 2, 17.25, 1.25, "said", B),
];
const span = (sector: string, day: number, hour: number, hours: number) => ({ sector, from: B + day * DAY + hour * HOUR, to: B + day * DAY + (hour + hours) * HOUR });
const BEFORE_EVENTS = [span("cosmic", 0, 8.5, 1.5), span("cosmic", 2, 8.5, 1.5), span("cosmic", 4, 9, 2.5), span("purdue", 0, 13, 1), span("purdue", 3, 14, 1.5), span("ref", 1, 17, 3.5), span("ref", 4, 18, 3)];

function box(now: number, over: Partial<ReviewBody> = {}): ReviewBody {
  const cut = Math.min(now, WEEK.to);
  const all = lifeos();
  const within = <T extends { at: number }>(rows: T[]): T[] => rows.filter((r) => r.at < cut);
  return {
    host: "box",
    from: WEEK.from,
    to: WEEK.to,
    tz: TZ,
    madeAt: now,
    by: "owner",
    over: now >= WEEK.to,
    jobs: JOBS,
    lifeos: { ...all, events: all.events.filter((e) => e.startsAt < cut), sent: within(all.sent), done: within(all.done), answered: within(all.answered) },
    points: POINTS.filter((p) => p[0] < cut),
    ran: [
      [job("cosmic"), 31 * HOUR + 10 * MIN],
      [job("purdue"), 6 * HOUR + 40 * MIN],
      [job("hypixel"), 2 * HOUR + 5 * MIN],
    ],
    slipped: { at: now, rows: [...SLIPPED.filter((r) => r.at < cut), ...(HELD.at < cut - DAY ? [HELD] : [])] },
    shipped: APPROVED.at < cut ? [APPROVED] : [],
    before: { from: B, to: B + (cut - WEEK.from), lifeos: { events: BEFORE_EVENTS.filter((e) => e.from < B + (cut - WEEK.from)).map((e) => ({ ...e, to: Math.min(e.to, B + (cut - WEEK.from)) })), sent: [] }, points: BEFORE_POINTS.filter((p) => p[0] < B + (cut - WEEK.from)) },
    left: [],
    ...over,
  };
}

/** The Mac's part: a second Cosmic workspace with its own threads, and the same LifeOS. */
function mac(now: number): ReviewBody {
  return { ...box(now), host: "mac", jobs: [{ workspaceId: "m-cosmic", sector: "cosmic", name: "Cosmic" }], points: sit("cosmic", 4, 13, 1.5).map(([t, , kind]) => [t, 0, kind] as HostPoint), ran: [[0, 3 * HOUR]], slipped: { at: now, rows: [] }, shipped: [], before: null };
}

export type FixtureState = "full" | "sofar" | "back" | "clear" | "off" | "lifeos" | "loading" | "failed";

/** The page's view in one of its states, and the moment it is looked at. */
export function fixtureView(state: FixtureState): { view: ReviewView; now: number } {
  const now = state === "sofar" ? THURSDAY : AFTER;
  // Made-up sums, as Money would answer them: Cosmic invoiced and paid a vendor, Ref was paid for two games.
  const money = new Map([
    ["cosmic", { in: 240_000, out: 31_250 }],
    ["ref", { in: 19_000, out: 0 }],
  ]);
  const base = { week: WEEK, tz: TZ, settled: true, off: [] as string[], errors: [] as ReviewView["errors"], money: state === "lifeos" ? new Map() : money };
  const merged = (parts: { environmentId: string; body: ReviewBody }[]) => mergeReview(parts, now, { home: "env-box" });
  // The routine made it on Friday; looked at the Monday after, what slipped is as it stood then.
  const friday = (): ReviewBody => ({ ...box(now), by: "routine", slipped: { at: FRIDAY, rows: box(FRIDAY).slipped.rows } });
  const both = (b: ReviewBody) => [
    { environmentId: "env-box", body: b },
    { environmentId: "env-mac", body: mac(now) },
  ];
  switch (state) {
    case "loading":
      return { now, view: { ...base, settled: false, review: null } };
    case "sofar":
      return { now, view: { ...base, review: merged(both(box(now))) } };
    case "back": {
      const b = friday();
      // Since Friday he finished one task and followed up the meeting.
      const rows = b.slipped.rows.map((r) => (r.key === "task:k2" || r.key === "meeting:e8" ? { ...r, open: false } : r));
      return { now, view: { ...base, review: merged(both({ ...b, slipped: { at: FRIDAY, rows } })) } };
    }
    case "clear":
      return { now, view: { ...base, review: merged(both({ ...friday(), slipped: { at: FRIDAY, rows: [] } })) } };
    case "off":
      return { now, view: { ...base, off: [hostOffWords("The Mac")], review: merged([{ environmentId: "env-box", body: friday() }]) } };
    case "lifeos":
      return { now, view: { ...base, review: merged(both({ ...friday(), lifeos: null, slipped: { at: FRIDAY, rows: [HELD] }, before: null, left: [LEFT.lifeos] }).map((p) => ({ ...p, body: { ...p.body, lifeos: null, left: [LEFT.lifeos] } }))) } };
    case "failed":
      return { now, view: { ...base, errors: [{ environmentId: "env-mac", name: "The Mac", error: "the request timed out" }], review: merged([{ environmentId: "env-box", body: { ...friday(), left: [LEFT.threads, LEFT.held] } }]) } };
    default:
      return { now, view: { ...base, review: merged(both(friday())) } };
  }
}
