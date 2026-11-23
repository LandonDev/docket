import type { SectorKey } from "@shared/work";
import type { TodayAnswer, TodayFailure, TodayMark, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Today's page worked out from what its sources answered, with no React
 * (docs/agents/work-today.md "The page"): one row per key, marks laid on,
 * sections by order, rows by `at`, the folds last. The view draws what this
 * answers; the tests read it.
 */

/** Today's own section for what no other section reads: drawn only while it has a row, never with an empty line. */
export const ALSO: TodaySection = { id: "also", title: "Also", order: 90, empty: "" };

/** Today in local time: this midnight to the next. Worked out by the calendar, so a day of 23 or 25 hours is one day. */
export function dayBounds(now: number): { from: number; to: number } {
  const d = new Date(now);
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
}

/** The local midnight `days` days after the one that starts `from`. */
export function dayAfter(from: number, days: number): number {
  const d = new Date(from);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

type CatalogRow = { id: string; environmentId: string; name: string; path: string; kind?: string; sector?: string | null };

/** The jobs: every Work workspace with a sector on a host with Work on, in the catalog's order. */
export function jobsOf(catalog: readonly CatalogRow[], workHosts: ReadonlySet<string>, openHosts: ReadonlySet<string>): TodayWorkspace[] {
  return catalog
    .filter((w) => w.kind === "work" && !!w.sector && workHosts.has(w.environmentId))
    .map((w) => ({ environmentId: w.environmentId, workspaceId: w.id, sector: w.sector as SectorKey, name: w.name, path: w.path, open: openHosts.has(w.environmentId) }));
}

/**
 * The job a LifeOS row of `sector` opens in. Work workspaces are matched by
 * sector, never by link: where two hosts hold one for the sector, the one on
 * the Work home, else the first whose link is open, else the first.
 */
export function workspaceFor(sector: SectorKey, jobs: readonly TodayWorkspace[], home: string | null): TodayWorkspace | null {
  const held = jobs.filter((w) => w.sector === sector);
  return held.find((w) => w.environmentId === home) ?? held.find((w) => w.open) ?? held[0] ?? null;
}

/** The hosts that hold a job and whose link is not open: each is named once at the page's foot. */
export function offlineHosts(jobs: readonly TodayWorkspace[]): string[] {
  return [...new Set(jobs.filter((w) => !w.open).map((w) => w.environmentId))];
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** One source and what it last answered. */
export type Fed = { source: Pick<TodaySource, "id" | "section">; answer: TodayAnswer };

/** A row with its marks laid on. */
function lay(row: TodayRow, marks: readonly TodayMark[]): TodayRow {
  if (marks.length === 0) return row;
  const out: TodayRow = { ...row };
  // A fault's note (a clash) is said before a plain one (prep is ready).
  const noted = marks.find((m) => m.note && m.late) ?? marks.find((m) => m.note);
  if (noted) {
    out.detail = noted.note;
    out.detailLate = !!noted.late;
  }
  // One Leave shows: a mark's line takes the place of the row's own.
  const lined = marks.find((m) => m.whenLine);
  if (lined) out.whenLine = lined.whenLine;
  const opened = marks.find((m) => m.open);
  if (opened?.open) out.open = opened.open;
  const acts = [...marks.flatMap((m) => (m.act ? [m.act] : [])), ...(row.acts ?? [])].slice(0, 2);
  if (acts.length) out.acts = acts;
  return out;
}

export type MergedSection = {
  def: TodaySection;
  rows: TodayRow[];
  /** A source that feeds it has not answered yet. */
  loading: boolean;
  failed: TodayFailure[];
  /** One muted line at its foot, from the source that owns it. */
  note?: string;
};

/**
 * Every source's answer as sections of rows. One row per key: the first
 * source to give it wins, in the registry's order. A mark is laid on the row
 * of its key and draws nothing when there is none. A row whose section no
 * source declares is left out (the Files section before Files lands).
 */
export function merge(fed: readonly Fed[], gone: ReadonlySet<string> = NO_KEYS): MergedSection[] {
  const sections = new Map<string, MergedSection>();
  const add = (def: TodaySection): void => {
    if (!sections.has(def.id)) sections.set(def.id, { def, rows: [], loading: false, failed: [] });
  };
  for (const { source } of fed) if (source.section) add(source.section);
  add(ALSO);
  const marks = new Map<string, TodayMark[]>();
  for (const { answer } of fed) for (const mark of answer.marks ?? []) marks.set(mark.key, [...(marks.get(mark.key) ?? []), mark]);
  const seen = new Set<string>();
  for (const { source, answer } of fed) {
    for (const row of answer.rows ?? []) {
      const section = sections.get(row.section);
      // A row his own act took off the page is gone before its source drops it.
      if (!section || seen.has(row.key) || gone.has(row.key)) continue;
      seen.add(row.key);
      section.rows.push(lay(row, marks.get(row.key) ?? []));
    }
    const own = source.section ? sections.get(source.section.id) : undefined;
    if (!own) continue;
    if (answer.loading) own.loading = true;
    if (answer.failed?.length) own.failed.push(...answer.failed);
    if (answer.note) own.note = answer.note;
  }
  const ordered = [...sections.values()].sort((a, b) => a.def.order - b.def.order);
  // A section with no empty line (Also, a pillar's "Owed") is drawn only while it has something to show:
  // a row, or a host that did not answer. It never draws bones or a bare heading.
  const shows = (s: MergedSection): boolean => !!s.def.empty || s.rows.length > 0 || s.failed.length > 0;
  for (const section of ordered) {
    // Stable: rows with no `at` keep their source's order after those with one.
    section.rows = section.rows.map((row, i) => ({ row, i })).sort((a, b) => (a.row.at ?? Infinity) - (b.row.at ?? Infinity) || a.i - b.i).map((x) => x.row);
  }
  return ordered.filter(shows);
}

/** What he has unfolded, by section id: its "N more", and its "N earlier". */
export type Folds = { more: ReadonlySet<string>; earlier: ReadonlySet<string> };
export const NO_FOLDS: Folds = { more: new Set(), earlier: new Set() };

export type ShownSection = {
  id: string;
  title: string;
  /** `bones`: never answered; `rows`; `empty`: answered, nothing in it. */
  state: "bones" | "rows" | "empty";
  /** A read that feeds it is still out: what it shows may not be all of it. */
  pending: boolean;
  /** The shape of its bones (`TodaySection.bones`). */
  bones?: TodaySection["bones"];
  empty: string;
  /** Rows that are over, folded at the head: how many, 0 once unfolded or with none. */
  earlier: number;
  rows: TodayRow[];
  /** Rows under the fold: how many, 0 once unfolded or with none. */
  more: number;
  failed: TodayFailure[];
  note?: string;
};

/** A section as the page draws it: its past rows folded at the head, then its first `fold` rows and how many more. */
export function fold(section: MergedSection, folds: Folds = NO_FOLDS): ShownSection {
  const { def } = section;
  const past = section.rows.filter((r) => r.past);
  const ahead = section.rows.filter((r) => !r.past);
  const showEarlier = folds.earlier.has(def.id);
  const cap = def.fold !== undefined && !folds.more.has(def.id) && ahead.length > def.fold ? def.fold : ahead.length;
  const rows = [...(showEarlier ? past : []), ...ahead.slice(0, cap)];
  // Rows it kept from before a slow or failed read still show; bones are for a section that has never answered.
  const state = section.rows.length > 0 ? "rows" : section.loading ? "bones" : "empty";
  return {
    id: def.id,
    title: def.title,
    state,
    pending: section.loading,
    ...(def.bones ? { bones: def.bones } : {}),
    empty: def.empty,
    earlier: showEarlier ? 0 : past.length,
    rows,
    more: ahead.length - cap,
    failed: section.failed,
    ...(section.note ? { note: section.note } : {}),
  };
}

/** Whether the one LifeOS session can be read: `waiting` while it is on its way. */
export type LifeosReach = "ok" | "waiting" | "unreachable" | "signed-out";

export type Block = { kind: "section"; section: ShownSection } | { kind: "lifeos"; reach: "unreachable" | "signed-out" };

export type TodayPage =
  /** No Work workspace has a sector. */
  | { kind: "no-jobs" }
  /** Everything answered, and nothing left; `line` is what the day's last section said of tomorrow, when it said it. */
  | { kind: "clear"; line?: string }
  /** `keys`: every stop of the arrows in page order, the rows and the fold lines between them. */
  | { kind: "day"; blocks: Block[]; offline: string[]; keys: string[] };

/** A fold line's place in the arrows' order: "2 earlier" at a section's head, "4 more" at its foot. */
export const foldKey = (which: keyof Folds, section: string): string => `fold:${which}:${section}`;
/** The fold a key names, or null for a row's. */
export function foldOf(key: string): { which: keyof Folds; section: string } | null {
  const [lead, which, ...rest] = key.split(":");
  return lead === "fold" && (which === "more" || which === "earlier") ? { which, section: rest.join(":") } : null;
}

/**
 * A section with nothing left in it: it answered whole, none of its reads
 * failed, and it holds no row but those that are over, whether its "N
 * earlier" is folded or open (the day settles the same way either way).
 */
const done = (s: ShownSection): boolean =>
  s.failed.length === 0 && (s.state === "empty" || (s.state === "rows" && !s.pending && s.more === 0 && s.rows.every((row) => row.past)));

/**
 * The whole page. While no host can read LifeOS, the sections that read it
 * give way to one line in the first one's place. "All clear" is said only
 * when every source answered whole, none failed, no host is offline and
 * nothing is left: a meeting that ended is not left. A source still out
 * that draws nothing while it waits (a section with no empty line, rows for
 * Also) counts too: it may yet bring a row.
 */
export function page(fed: readonly Fed[], opts: { jobs: readonly TodayWorkspace[]; lifeos: LifeosReach; folds?: Folds; gone?: ReadonlySet<string> }): TodayPage {
  if (opts.jobs.length === 0) return { kind: "no-jobs" };
  const down = opts.lifeos === "unreachable" || opts.lifeos === "signed-out" ? opts.lifeos : null;
  const blocks: Block[] = [];
  let said = false;
  for (const section of merge(fed, opts.gone)) {
    if (down && section.def.lifeos) {
      if (!said) blocks.push({ kind: "lifeos", reach: down });
      said = true;
      continue;
    }
    // A session on its way: a LifeOS section that has no rows yet is still to answer.
    const waiting = opts.lifeos === "waiting" && !!section.def.lifeos;
    blocks.push({ kind: "section", section: fold(waiting ? { ...section, loading: true } : section, opts.folds) });
  }
  const offline = offlineHosts(opts.jobs);
  const shown = blocks.flatMap((b) => (b.kind === "section" ? [b.section] : []));
  // LifeOS out of reach matters only where a section reads it: `said` is set when one gave way.
  const drawn = new Set(shown.map((s) => s.id));
  const out = fed.some(({ source, answer }) => !!answer.loading && !(source.section && drawn.has(source.section.id)));
  if (!said && !out && offline.length === 0 && shown.every(done)) {
    const line = shown.find((s) => s.note)?.note;
    return { kind: "clear", ...(line ? { line } : {}) };
  }
  const keys = shown.flatMap((s) => (s.state !== "rows" ? [] : [...(s.earlier > 0 ? [foldKey("earlier", s.id)] : []), ...s.rows.map((r) => r.key), ...(s.more > 0 ? [foldKey("more", s.id)] : [])]));
  return { kind: "day", blocks, offline, keys };
}
