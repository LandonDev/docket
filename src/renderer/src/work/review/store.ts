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
import { registry, TimeoutError } from "../../lib/connection";
import { loadPinnedProjects, loadProjectRailOrder, normalizeProjectPath, subscribeRailOrder } from "../../lib/recents";
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
/** The weeks Make again is reading now. */
const making = new Set<number>();
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
  /** Make again is reading the week: the rows stand, and the first line says so */
  making: boolean;
  /** hosts with Work on that are not linked now, each as its one line */
  off: string[];
  /** hosts that were asked and did not answer, with why; `kept`: what it answered before still stands in the page's numbers */
  errors: { environmentId: string; name: string; error: string; kept: boolean }[];
  /** Money's sums for the week, a job at a time, in cents: only the jobs whose ledger moved */
  money: ReadonlyMap<JobKey, JobMoney>;
};

/** What a job's ledger took in and paid out in the week, as Money sums it. */
export type JobMoney = { in: number; out: number };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Why a host did not answer, in his words: the transport's own message names the wire method. */
export const hostError = (err: unknown): string => (err instanceof TimeoutError ? "it timed out" : errorText(err));
/** The same as a sentence of its own (a toast's second line). */
export const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
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

/** The store's clock. */
export const reviewClock = (): number => now();

/** The week that holds now, and the one `by` weeks from a week. */
export const thisWeek = (): ReviewWeek => weekOf(now(), reviewZone());
export const weekBy = (week: ReviewWeek, by: number): ReviewWeek => stepWeek(week, by, reviewZone());
/** The week that holds a moment (a routine run's `open.at`). */
export const weekAt = (at: number): ReviewWeek => weekOf(at, reviewZone());

/** Asks the home host which zone it makes weeks in, once. */
export function loadZone(): Promise<void> {
  if (zoneAsked) return zoneAsked;
  const found = (async (): Promise<boolean> => {
    const ids = [home(), ...workSwitch.hosts()].filter((id): id is string => !!id && linked(id));
    for (const id of new Set(ids)) {
      try {
        const got = await registry.linkOf(id).request<{ weeks: ReviewKept[]; tz?: string }>("work.review.list", {});
        if (got.tz) {
          if (zone !== got.tz) {
            zone = got.tz;
            changed();
          }
          return true;
        }
      } catch {
        // The next host is asked; with none, the window's own zone stands.
      }
    }
    return false;
  })();
  // An ask no host answered (none linked yet, or none that knows) is not kept: the next one asks again.
  const asked = found.then((got) => {
    if (!got && zoneAsked === asked) zoneAsked = null;
  });
  zoneAsked = asked;
  return asked;
}

const loading = new Map<string, Promise<void>>();

/**
 * One host's part of a week, asked again. Two asks at once share one read; `after`: the ask must be answered by a
 * read that starts now (a press just changed what it will find), so it waits out a read already on its way and
 * asks again.
 */
export function loadHostWeek(environmentId: string, week: ReviewWeek, after = false): Promise<void> {
  const key = `${week.from}:${environmentId}`;
  const inFlight = loading.get(key);
  if (inFlight) return after ? inFlight.then(() => loadHostWeek(environmentId, week)) : inFlight;
  const tz = reviewZone();
  const load = registry
    .linkOf(environmentId)
    .request<ReviewBody>("work.review.week", { from: week.from, to: week.to, tz })
    .then(
      (body) => put(week.from, environmentId, { body, error: null, loaded: true }),
      // A host that fails keeps what it last answered: the page says so and still stands on it.
      (err: unknown) => put(week.from, environmentId, { body: weeks.get(week.from)?.get(environmentId)?.body ?? null, error: hostError(err), loaded: true }),
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
      // A read that failed says nothing of now: the sums it answered before are dropped, never shown as current.
      () => {
        if (money.get(week.from)?.delete(environmentId)) changed();
      },
    );
}

/** Every linked host with Work on, asked for the week. `after`: by reads that start now (`loadHostWeek`). */
export function loadWeek(week: ReviewWeek, after = false): Promise<void> {
  // The week is on record as asked for before any host answers: one that links later fills it in.
  if (!weeks.has(week.from)) weeks.set(week.from, new Map());
  const on = [...workSwitch.hosts()].filter(linked);
  for (const id of on) loadHostMoney(id, week);
  return Promise.all(on.map((id) => loadHostWeek(id, week, after))).then(() => undefined);
}

/** Make again: every host reads the week again, and the page says it is being made until they have. */
export function makeAgain(week: ReviewWeek): Promise<void> {
  making.add(week.from);
  changed();
  return loadWeek(week).finally(() => {
    making.delete(week.from);
    changed();
  });
}

/**
 * The Work workspaces in the rail's order: the ones he pinned first, as the rail lists them, then the order he
 * dragged them into (the rail's own saved lists), the rest as they came.
 */
function railWorkspaces() {
  const rank = new Map(loadProjectRailOrder().map((path, i) => [normalizeProjectPath(path), i]));
  const pinned = new Set(loadPinnedProjects().map(normalizeProjectPath));
  const at = (path: string): number => rank.get(normalizeProjectPath(path)) ?? Number.MAX_SAFE_INTEGER;
  const lead = (path: string): number => (pinned.has(normalizeProjectPath(path)) ? 0 : 1);
  return workspaceStore
    .getSnapshot()
    .workspaces.filter((w) => w.kind === "work")
    .map((w, i) => ({ w, i }))
    .sort((a, b) => lead(a.w.path) - lead(b.w.path) || at(a.w.path) - at(b.w.path) || a.i - b.i)
    .map(({ w }) => w);
}


/** The order jobs are listed in: the rail's. A job on two hosts takes the place of its first row there. */
function jobOrder(parts: readonly ReviewPart[]): JobKey[] {
  const hostOf = new Map(parts.map((p) => [p.environmentId, p.body.host]));
  return [...new Set(railWorkspaces().map((w) => jobKey(hostOf.get(w.environmentId) ?? w.environmentId, { workspaceId: w.id, sector: w.sector ?? null })))];
}

/**
 * Every Work job this window knows of, by the key the merge files it under: a job whose only host is off, or has
 * not answered yet, still has its row in Hours.
 */
function knownJobs(parts: readonly ReviewPart[]): { key: JobKey; sector: string | null; name: string }[] {
  const hostOf = new Map(parts.map((p) => [p.environmentId, p.body.host]));
  return railWorkspaces()
    .filter((w) => workSwitch.hosts().has(w.environmentId))
    .map((w) => ({ key: jobKey(hostOf.get(w.environmentId) ?? w.environmentId, { workspaceId: w.id, sector: w.sector ?? null }), sector: w.sector ?? null, name: w.name }));
}

/**
 * Money's rows placed on the review's jobs: a job on two hosts is the two ledgers added. A job one of whose ledgers
 * Money could not read whole (`problem`) shows no sum: the other ledger's figure is not the job's money.
 */
function moneyOf(from: number, parts: readonly ReviewPart[]): Map<JobKey, JobMoney> {
  const out = new Map<JobKey, JobMoney>();
  const broken = new Set<JobKey>();
  const hostOf = new Map(parts.map((p) => [p.environmentId, p.body.host]));
  for (const [environmentId, rows] of money.get(from) ?? []) {
    // The same hosts the review counts: one that is off adds no sums either.
    if (!workSwitch.hosts().has(environmentId) || !linked(environmentId)) continue;
    for (const row of rows) {
      const key = jobKey(hostOf.get(environmentId) ?? environmentId, row);
      if (row.problem) broken.add(key);
      if (row.in === 0 && row.out === 0) continue;
      const have = out.get(key) ?? { in: 0, out: 0 };
      out.set(key, { in: have.in + row.in, out: have.out + row.out });
    }
  }
  for (const key of broken) out.delete(key);
  return out;
}

function view(week: ReviewWeek): ReviewView {
  const cached = snapshots.get(week.from);
  if (cached) return cached;
  const on = [...workSwitch.hosts()];
  // A host that is off is not counted, as its line says: what it answered before it went is kept for its return, not merged.
  const live = on.filter(linked);
  const hosts = weeks.get(week.from);
  const parts: ReviewPart[] = live.flatMap((id) => {
    const host = hosts?.get(id);
    // From before: the host failed this time, or has linked again and not answered yet.
    return host?.body ? [{ environmentId: id, body: host.body, stale: host.error !== null || !host.loaded }] : [];
  });
  const next: ReviewView = {
    week,
    tz: reviewZone(),
    // Fresh only when every linked host's newest ask was answered (one still loading, or answering from before,
    // leaves the week before uncompared); whole only when no host is off besides: until then "nothing" is not known.
    review: mergeReview(parts, now(), { home: home(), names: (sector) => sectorName(sector), order: jobOrder(parts), jobs: knownJobs(parts), fresh: live.every((id) => hosts?.get(id)?.loaded && !hosts.get(id)?.error), whole: live.length === on.length }),
    settled: live.every((id) => hosts?.get(id)?.loaded),
    making: making.has(week.from),
    off: on.filter((id) => !linked(id)).map((id) => hostOffWords(hostName(id))),
    errors: live.flatMap((id) => {
      const host = hosts?.get(id);
      return host?.error ? [{ environmentId: id, name: hostName(id), error: host.error, kept: host.body !== null }] : [];
    }),
    money: moneyOf(week.from, parts),
  };
  snapshots.set(week.from, next);
  return next;
}

/** The week as it stands, outside React. */
export const reviewNow = (week: ReviewWeek): ReviewView => view(week);

function subscribe(listener: () => void): () => void {
  // A view read outside React while nothing listened (`reviewNow`) may be from before a change: the first to listen reads anew.
  if (listeners.size === 0) snapshots.clear();
  listeners.add(listener);
  const offRegistry = registry.subscribe(changed);
  const offSwitch = workSwitch.subscribe(changed);
  const offWorkspaces = workspaceStore.subscribe(changed);
  // A drag or a pin in the rail, which sits beside the page: the jobs follow at once.
  const offRail = subscribeRailOrder(changed);
  return () => {
    listeners.delete(listener);
    offRegistry();
    offSwitch();
    offWorkspaces();
    offRail();
    // Nothing hears the rail, the hosts or the workspaces while the page is closed: a view kept now would reopen in
    // the old order (a pin or a drag made meanwhile) until a host answered.
    if (listeners.size === 0) snapshots.clear();
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
    // By a read that starts after the write: one already on its way may have read the row before it.
    void loadWeek({ from: review.from, to: review.to }, true);
  }
}

export async function undoSettle(done: Settled, week: ReviewWeek): Promise<void> {
  if (!done.undo) return;
  try {
    await registry.linkOf(done.environmentId).request("work.review.undo", { token: done.undo });
  } finally {
    void loadWeek(week, true);
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
  making.clear();
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
  // A host that comes back fills in the weeks on screen, in the zone weeks are cut in (it may be the first to say).
  link.onOpen(() => {
    // What it answered before it went is from before: until it answers again its part is not fresh, nothing is
    // called empty on its word, and its sums wait for the new ones. This holds with no page open too: the next
    // one to open must not paint the old answer as new.
    for (const hosts of weeks.values()) {
      const had = hosts.get(link.environmentId);
      if (had) hosts.set(link.environmentId, { ...had, loaded: false, error: null });
    }
    for (const hosts of money.values()) hosts.delete(link.environmentId);
    changed();
    if (listeners.size === 0 || !workSwitch.hosts().has(link.environmentId)) return;
    void loadZone().then(() => {
      for (const from of weeks.keys()) {
        const week = { from, to: weekBy({ from, to: from }, 1).from };
        void loadHostWeek(link.environmentId, week);
        // Its sums too: they went with it, and what it said before it left may be old.
        loadHostMoney(link.environmentId, week);
      }
    });
  });
});
