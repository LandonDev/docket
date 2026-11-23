import { useSyncExternalStore } from "react";
import type { MoneySums } from "@shared/contract-work-money";
import type { ReviewKept, ReviewRoutine, ReviewSettled } from "@shared/contract-work-review";
import {
  hostOffWords,
  jobKey,
  localDay,
  mergeReview,
  stepWeek,
  weekOf,
  type JobKey,
  type MergedReview,
  type Placed,
  type ReviewBody,
  type ReviewPart,
  type ReviewWeek,
  type SettleHow,
  type SlippedRow,
} from "@shared/work/review";
import { registry } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workSwitch } from "../../lib/workSwitch";
import { sectorName, workHome } from "../shell/actions";

/**
 * The weekly review as the page reads it (docs/agents/work-review.md "The
 * window"): each host with Work on answers `work.review.week` with its own
 * part, and the parts are merged by sector here, with the one rule every
 * number comes from (src/shared/work/review.ts `mergeReview`). LifeOS's
 * facts are the same from every host, so they are taken once, from the Work
 * home when it has them. The page stands on the first host that answers;
 * later hosts fill in; a host that is off is one line, never a failure.
 *
 * Weeks are cut in the home host's time zone (`work.review.list` says it:
 * LifeOS's, the zone its Friday routine makes weeks in), so the week the
 * window asks for is the week a host kept. Until a host has said, the
 * window's own zone stands.
 */

type HostWeek = { body: ReviewBody | null; error: string | null; loaded: boolean };

/** Each week asked for, by its first moment: every host's answer so far. */
const weeks = new Map<number, Map<string, HostWeek>>();
/** Money's own sums for each week, a host at a time: read beside the review, never in its way. */
const money = new Map<number, Map<string, MoneySums["rows"]>>();
const listeners = new Set<() => void>();
const snapshots = new Map<number, ReviewView>();
let zone: string | null = null;
let zoneAsked: Promise<void> | null = null;
let now: () => number = Date.now;

export type ReviewView = {
  week: ReviewWeek;
  tz: string;
  /** null until a host has answered */
  review: MergedReview | null;
  /** every host that is on and linked has answered, or failed to */
  settled: boolean;
  /** hosts with Work on that are not linked now, each as its one line */
  off: string[];
  /** hosts that were asked and did not answer, with why */
  errors: { environmentId: string; name: string; error: string }[];
  /** Money's sums for the week, a job at a time, in cents: only the jobs whose ledger moved */
  money: ReadonlyMap<JobKey, JobMoney>;
};

/** What a job's ledger took in and paid out in the week, as Money sums it. */
export type JobMoney = { in: number; out: number };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const hostName = (id: string): string => registry.environment(id)?.name ?? "A host";
const linked = (id: string): boolean => registry.statusOf(id).transport === "open";
const home = (): string | null => workHome();

function changed(): void {
  snapshots.clear();
  for (const listener of listeners) listener();
}

/** The zone weeks are cut in. */
export const reviewZone = (): string => zone ?? localZone();

/** The week that holds now, and the one `by` weeks from a week. */
export const thisWeek = (): ReviewWeek => weekOf(now(), reviewZone());
export const weekBy = (week: ReviewWeek, by: number): ReviewWeek => stepWeek(week, by, reviewZone());
/** The week that holds a moment (a routine run's `open.at`). */
export const weekAt = (at: number): ReviewWeek => weekOf(at, reviewZone());

/** Asks the home host which zone it makes weeks in, once. */
export function loadZone(): Promise<void> {
  zoneAsked ??= (async () => {
    const ids = [home(), ...workSwitch.hosts()].filter((id): id is string => !!id && linked(id));
    for (const id of new Set(ids)) {
      try {
        const got = await registry.linkOf(id).request<{ weeks: ReviewKept[]; tz?: string }>("work.review.list", {});
        if (got.tz) {
          if (zone !== got.tz) {
            zone = got.tz;
            changed();
          }
          return;
        }
      } catch {
        // The next host is asked; with none, the window's own zone stands.
      }
    }
    zoneAsked = null;
  })();
  return zoneAsked;
}

const loading = new Map<string, Promise<void>>();

/** One host's part of a week, asked again. */
export function loadHostWeek(environmentId: string, week: ReviewWeek): Promise<void> {
  const key = `${week.from}:${environmentId}`;
  const inFlight = loading.get(key);
  if (inFlight) return inFlight;
  const tz = reviewZone();
  const load = registry
    .linkOf(environmentId)
    .request<ReviewBody>("work.review.week", { from: week.from, to: week.to, tz })
    .then(
      (body) => put(week.from, environmentId, { body, error: null, loaded: true }),
      // A host that fails keeps what it last answered: the page says so and still stands on it.
      (err: unknown) => put(week.from, environmentId, { body: weeks.get(week.from)?.get(environmentId)?.body ?? null, error: errorText(err), loaded: true }),
    )
    .finally(() => loading.delete(key));
  loading.set(key, load);
  return load;
}

function put(from: number, environmentId: string, host: HostWeek): void {
  let hosts = weeks.get(from);
  if (!hosts) weeks.set(from, (hosts = new Map()));
  hosts.set(environmentId, host);
  changed();
}

/**
 * One host's sums of money for the week, from Money's own wire: Money owns every sum of money, and the review
 * only shows them. A host with no Money, or one that does not answer, simply has none to show.
 */
function loadHostMoney(environmentId: string, week: ReviewWeek): void {
  const tz = reviewZone();
  void registry
    .linkOf(environmentId)
    .request<MoneySums>("work.money.sums", { from: localDay(week.from, tz), to: localDay(week.to, tz) })
    .then(
      (got) => {
        let hosts = money.get(week.from);
        if (!hosts) money.set(week.from, (hosts = new Map()));
        hosts.set(environmentId, got?.rows ?? []);
        changed();
      },
      () => {},
    );
}

/** Every linked host with Work on, asked for the week. */
export function loadWeek(week: ReviewWeek): Promise<void> {
  const on = [...workSwitch.hosts()].filter(linked);
  for (const id of on) loadHostMoney(id, week);
  return Promise.all(on.map((id) => loadHostWeek(id, week))).then(() => undefined);
}

/** The order jobs are listed in: the order the workspaces came in, which is the rail's. */
function jobOrder(parts: readonly ReviewPart[]): JobKey[] {
  const hostOf = new Map(parts.map((p) => [p.environmentId, p.body.host]));
  return workspaceStore
    .getSnapshot()
    .workspaces.filter((w) => w.kind === "work")
    .map((w) => jobKey(hostOf.get(w.environmentId) ?? w.environmentId, { workspaceId: w.id, sector: w.sector ?? null }));
}

/** Money's rows placed on the review's jobs: a job on two hosts is the two ledgers added. */
function moneyOf(from: number, parts: readonly ReviewPart[]): Map<JobKey, JobMoney> {
  const out = new Map<JobKey, JobMoney>();
  const hostOf = new Map(parts.map((p) => [p.environmentId, p.body.host]));
  for (const [environmentId, rows] of money.get(from) ?? []) {
    if (!workSwitch.hosts().has(environmentId)) continue;
    for (const row of rows) {
      if (row.in === 0 && row.out === 0) continue;
      const key = jobKey(hostOf.get(environmentId) ?? environmentId, row);
      const have = out.get(key) ?? { in: 0, out: 0 };
      out.set(key, { in: have.in + row.in, out: have.out + row.out });
    }
  }
  return out;
}

function view(week: ReviewWeek): ReviewView {
  const cached = snapshots.get(week.from);
  if (cached) return cached;
  const on = [...workSwitch.hosts()];
  const hosts = weeks.get(week.from);
  const parts: ReviewPart[] = on.flatMap((id) => {
    const body = hosts?.get(id)?.body;
    return body ? [{ environmentId: id, body }] : [];
  });
  const next: ReviewView = {
    week,
    tz: reviewZone(),
    review: mergeReview(parts, now(), { home: home(), names: (sector) => sectorName(sector), order: jobOrder(parts) }),
    settled: on.filter(linked).every((id) => hosts?.get(id)?.loaded),
    off: on.filter((id) => !linked(id)).map((id) => hostOffWords(hostName(id))),
    errors: on.flatMap((id) => {
      const error = hosts?.get(id)?.error;
      return error ? [{ environmentId: id, name: hostName(id), error }] : [];
    }),
    money: moneyOf(week.from, parts),
  };
  snapshots.set(week.from, next);
  return next;
}

/** The week as it stands, outside React. */
export const reviewNow = (week: ReviewWeek): ReviewView => view(week);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const offRegistry = registry.subscribe(changed);
  const offSwitch = workSwitch.subscribe(changed);
  const offWorkspaces = workspaceStore.subscribe(changed);
  return () => {
    listeners.delete(listener);
    offRegistry();
    offSwitch();
    offWorkspaces();
  };
}

export function useReview(week: ReviewWeek): ReviewView {
  const get = (): ReviewView => view(week);
  return useSyncExternalStore(subscribe, get, get);
}

// ── presses ───────────────────────────────────────────────────────────────

/**
 * The host a press on a slipped row goes to. A held item's is the host that holds it. A nudge needs a
 * workspace of the job, so it goes to one that has one. Everything else is LifeOS's, and goes to the host its
 * rows were read from, which also keeps the marks.
 */
export function settleHost(review: MergedReview, row: Placed<SlippedRow>, how: SettleHow): string {
  if (row.ref.kind === "mail" && how === "now") {
    const job = review.jobs.find((j) => j.key === row.job);
    const at = job?.at.find((a) => a.environmentId === row.environmentId) ?? job?.at.find((a) => linked(a.environmentId));
    if (at) return at.environmentId;
  }
  return row.environmentId;
}

export type Settled = ReviewSettled & { environmentId: string };

/** His press on a slipped row; the week is read again whatever came back. */
export async function settleRow(review: MergedReview, row: Placed<SlippedRow>, how: SettleHow): Promise<Settled> {
  const environmentId = settleHost(review, row, how);
  try {
    const done = await registry.linkOf(environmentId).request<ReviewSettled>("work.review.settle", { row: row.ref, how, tz: review.tz, ...(row.sector ? { sector: row.sector } : {}) });
    return { ...done, environmentId };
  } finally {
    void loadWeek({ from: review.from, to: review.to });
  }
}

export async function undoSettle(done: Settled, week: ReviewWeek): Promise<void> {
  if (!done.undo) return;
  try {
    await registry.linkOf(done.environmentId).request("work.review.undo", { token: done.undo });
  } finally {
    void loadWeek(week);
  }
}

/** He opened the week: the hosts that made it ready hear, so Today's row and the digest's line go. */
export function markSeen(week: ReviewWeek): void {
  for (const id of workSwitch.hosts()) if (linked(id)) void registry.linkOf(id).request("work.review.seen", { from: week.from }).catch(() => {});
}

/** The Friday routine, for the menu's row: the home host's, else the first host that has one. */
export async function loadRoutine(): Promise<(NonNullable<ReviewRoutine> & { environmentId: string }) | null> {
  const ids = [home(), ...workSwitch.hosts()].filter((id): id is string => !!id && linked(id));
  for (const id of new Set(ids)) {
    try {
      const got = await registry.linkOf(id).request<ReviewRoutine>("work.review.routine", {});
      if (got) return { ...got, environmentId: id };
    } catch {
      // A host from before this method has no routine to name.
    }
  }
  return null;
}

/** Test seam. */
export function resetReviewStore(opts: { now?: () => number; zone?: string | null } = {}): void {
  weeks.clear();
  money.clear();
  loading.clear();
  zone = opts.zone ?? null;
  zoneAsked = null;
  now = opts.now ?? Date.now;
  changed();
}

// A review a host just made (its routine, or another window): an open page reads that week again.
registry.onLink((link, event) => {
  if (event === "removed") {
    for (const hosts of weeks.values()) hosts.delete(link.environmentId);
    for (const hosts of money.values()) hosts.delete(link.environmentId);
    changed();
    return;
  }
  link.onPush((push) => {
    if (push.push !== "work.review" || push.seen || listeners.size === 0) return;
    for (const from of weeks.keys()) if (from === push.from) void loadHostWeek(link.environmentId, { from, to: weekBy({ from, to: from }, 1).from });
  });
  // A host that comes back fills in the weeks on screen.
  link.onOpen(() => {
    if (listeners.size === 0 || !workSwitch.hosts().has(link.environmentId)) return;
    for (const from of weeks.keys()) void loadHostWeek(link.environmentId, { from, to: weekBy({ from, to: from }, 1).from });
  });
});
