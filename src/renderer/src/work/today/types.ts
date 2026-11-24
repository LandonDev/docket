import type { ComponentType } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosSession } from "../shell/lifeos";

/**
 * Today's seam (docs/agents/work-today.md "Adding to Today"): types only.
 * A pillar adds to the page by writing `work/<slug>/today.ts` that exports
 * `source: TodaySource`, and one line in `TODAY_SOURCES` (sources.ts).
 */

/** A Work workspace with a sector, on a host with Work on: a job. */
export type TodayWorkspace = {
  environmentId: string;
  workspaceId: string;
  sector: SectorKey;
  name: string;
  path: string;
  /** Its host's link is open now. */
  open: boolean;
};

export type TodayEnv = {
  /** Today in local time: from this midnight to the next. It moves at midnight. */
  day: { from: number; to: number };
  /** Every job, on every host with Work on. */
  workspaces: TodayWorkspace[];
  /** One LifeOS session for all sectors, on the first host that can read it. */
  lifeos: LifeosSession;
  /** The job a LifeOS row of this sector opens in; null for a sector with no job. */
  workspaceOf(sector: SectorKey): TodayWorkspace | null;
};

/** A row's verb, shown on hover and focus. */
export type TodayAct = { label: string; run(): Promise<void> | void };

export type TodayRow = {
  /** `<kind>:<stable id>`; the same key twice is one row. */
  key: string;
  /** `held` 10, `meetings` 20, `due` 30, `waiting` 40, `files` 50, `also` 90, or a section of the source's own. */
  section: string;
  sector: SectorKey | null;
  /** The job's name, where the row knows the very workspace it belongs to (a held item, a row a host answered for one workspace); left out, the page names the sector's job. */
  job?: string;
  /** The 13px line, in plain words: no path, no URL. */
  title: string;
  /** The 12px muted line under it. */
  detail?: string;
  /** The detail is a fault (a send that failed): drawn in the failed tone. */
  detailLate?: boolean;
  /** What the section orders by, ascending; a row with none keeps its place after those with one. */
  at?: number;
  /** The trailing fact ("2:00 PM", "6 days"). */
  when?: string;
  /** One live line under `when` (a meeting's "Leave 5:10 PM", "in 25 min", "Now"). */
  whenLine?: string;
  /** `when` is overdue. */
  late?: boolean;
  /** It is over (a meeting that ended): drawn muted, and folded at the section's head. */
  past?: boolean;
  /** The 16px slot before the title: a task's tick, or the thing's kind. */
  lead?: { kind: "tick"; label: string; run(): Promise<void> } | { kind: "glyph"; glyph: ComponentType<{ className?: string }> };
  /** The workspace the row's presses act on, where it was built for one: a row the store kept whose workspace is no longer a job is not shown (model.ts `jobsOnly`). */
  workspace?: Pick<TodayWorkspace, "environmentId" | "workspaceId">;
  /** The row's press: its thing in its own view. */
  open(): void;
  /** At most two verbs. */
  acts?: TodayAct[];
};

/**
 * Something said about a row another source made, found by its key: a note
 * on its second line, a live line in place of its own, another press, one
 * more verb. A mark never makes a row.
 */
export type TodayMark = {
  key: string;
  note?: string;
  whenLine?: string;
  /** The note is a fault (a clash): drawn in the failed tone. */
  late?: boolean;
  open?: () => void;
  act?: TodayAct;
};

export type TodaySection = {
  id: string;
  title: string;
  order: number;
  /** The one line when it has no row. Empty (`""`): the section is drawn only while it has a row, with no bones and no bare heading. */
  empty: string;
  /** How many rows show before "N more"; none shows all. */
  fold?: number;
  /** It reads LifeOS: when no host can, the page says so once in place of every such section. */
  lifeos?: boolean;
  /** The shape its rows usually take, for the bones it draws before it answers: two lines, or a tick before one. Left out: one line. */
  bones?: "lines" | "tick";
};

/**
 * A read that did not come back. The page says "<host> did not answer" for
 * it, with `error` beside that when it names another cause than the wait;
 * `said` is the whole line in its place, for a read the host is not at fault
 * for ("LifeOS could not read tasks").
 */
export type TodayFailure = { environmentId: string; error: string; said?: string; retry?(): void | Promise<void> };

export type TodayAnswer = {
  rows?: TodayRow[];
  marks?: TodayMark[];
  /** Nothing has come back yet. */
  loading?: boolean;
  /** With `loading`: its rows are a whole earlier answer read again (a reopen), so no cue says more may come; the page is still not clear. */
  stale?: boolean;
  /** A read it needs was not made, its host offline: its section never says it is empty (the page names the host at its foot). */
  away?: boolean;
  failed?: TodayFailure[];
  /** One muted line at the foot of the source's own section ("Tomorrow starts at 9:00 AM with Staff sync"). */
  note?: string;
};

export type TodaySource = {
  id: string;
  /** A section of its own; leave out to add rows or marks to a section that exists. */
  section?: TodaySection;
  /** A hook, called while the page is open and kept warm after. */
  use(env: TodayEnv): TodayAnswer;
};
