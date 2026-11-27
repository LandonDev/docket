import type { JobHours, MergedJob, MergedReview, Placed, ShippedRow, SlippedRow } from "@shared/work/review";

/**
 * What the review is drawn from while the first host answers (docs/agents/loading-bones.md): a week of six jobs, each
 * with hours, and three rows of Shipped and of Slipped for the first two. Nobody reads the words; their lengths, and
 * which parts are set, give the bones the page's shape. Fixed literals: no clock, ids that start `sample:`.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday Nov 16 2026, 00:00 in Chicago. */
const MON = Date.parse("2026-11-16T06:00:00Z");
const at = (day: number, hour: number): number => MON + day * DAY + hour * HOUR;

const job = (sector: string, name: string): MergedJob => ({ key: `sample:${sector}`, sector, name, at: [] });
const JOBS: MergedJob[] = [job("cosmic", "Cosmic"), job("hypixel", "Hypixel"), job("purdue", "Purdue"), job("ref", "Ref"), job("unify", "Unify"), job("life", "Life")];

/** Each job's hours: the bars' lengths vary as a week's do, every row with a bar and a total. */
const hours = (key: string, calendar: number, desk: number): JobHours => ({ job: key, calendarMs: calendar * HOUR, deskMs: desk * HOUR, ranMs: 0, events: 0, stands: { said: 0, sent: 0, pressed: 0, edited: 0 } });
const HOURS: JobHours[] = [hours("sample:cosmic", 6, 9.5), hours("sample:hypixel", 0, 5.25), hours("sample:purdue", 5, 8), hours("sample:ref", 6.5, 0), hours("sample:unify", 0, 1.5), hours("sample:life", 1, 1.75)];

const sent = (n: number, jobKey: string, title: string, who: string | null, day: number): Placed<ShippedRow> => ({ key: `sample:shipped-${n}`, kind: who ? "sent" : "finished", sector: null, workspaceId: null, title, who, at: at(day, 11), open: null, job: jobKey, environmentId: "sample:host" });
const SHIPPED: Placed<ShippedRow>[] = [
  sent(1, "sample:cosmic", "Season 12 patch notes", "Riley Okafor", 4),
  sent(2, "sample:cosmic", "Fix the crate drop rates", null, 3),
  sent(3, "sample:cosmic", "Store pricing for the weekend", "Mina Farrow", 1),
  sent(4, "sample:hypixel", "Thumbnail notes for episode 40", "Sam Lindqvist", 2),
  sent(5, "sample:hypixel", "Order the new mic arms", null, 1),
  sent(6, "sample:hypixel", "Winter schedule", "Sam Lindqvist", 0),
];

const due = (n: number, jobKey: string, title: string, day: number): Placed<SlippedRow> => ({ key: `sample:slipped-${n}`, ref: { kind: "task", id: `sample:task-${n}`, dueAt: at(day, 9) }, sector: null, workspaceId: null, title, at: at(day, 9), people: [], others: 0, open: true, job: jobKey, environmentId: "sample:host" });
const SLIPPED: Placed<SlippedRow>[] = [
  due(1, "sample:cosmic", "Write up the economy review", 2),
  due(2, "sample:cosmic", "Answer the vendor about October", 3),
  due(3, "sample:cosmic", "Plan the bug bash", 4),
  due(4, "sample:hypixel", "Send the thumbnail drafts", 1),
  due(5, "sample:hypixel", "Book the studio for Thursday", 3),
  due(6, "sample:hypixel", "Review the cut of episode 41", 4),
];

export const SAMPLE_REVIEW: MergedReview = {
  from: MON,
  to: MON + 7 * DAY,
  tz: "America/Chicago",
  madeAt: at(4, 16),
  by: "routine",
  over: true,
  jobs: JOBS,
  hours: HOURS,
  compare: [],
  shipped: SHIPPED,
  slipped: SLIPPED,
  slippedAt: at(4, 16),
  answersKept: true,
  lifeosFrom: "sample:host",
  left: [],
  known: { calendar: true, calendarCounted: true, desk: true, shipped: true, slipped: true },
};

/** The first line's words while the week is read: as long as "Made Fri 4:00 PM". */
export const SAMPLE_MADE = "Made Fri 4:00 PM";
/** A LifeOS line while that computer's week is read again: a line of the rule's length. */
export const SAMPLE_LIFEOS_LINE = "LifeOS is reading this computer's part of the week again.";

/**
 * The sample narrowed to the jobs the window knows of (`ReviewView.jobs`), so a one-job week does not move when it
 * lands: a row of Hours a job, and Shipped's and Slipped's groups for at most two of them.
 */
export function sampleReview(jobs: number | null | undefined): MergedReview {
  const count = Math.min(JOBS.length, Math.max(1, jobs || JOBS.length));
  if (count === JOBS.length) return SAMPLE_REVIEW;
  const kept = JOBS.slice(0, count);
  const keys = new Set(kept.map((j) => j.key));
  return { ...SAMPLE_REVIEW, jobs: kept, hours: HOURS.filter((h) => keys.has(h.job)), shipped: SHIPPED.filter((r) => keys.has(r.job)), slipped: SLIPPED.filter((r) => keys.has(r.job)) };
}
