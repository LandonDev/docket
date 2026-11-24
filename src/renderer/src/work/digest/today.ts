import { useMemo } from "react";
import type { TellGroup, TellRow } from "@shared/work/tell";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySource } from "../today/types";
import { nameOf, rowWhen } from "./notice";
import { loadHost, openTell, useDigest, type DigestView } from "./store";

/**
 * What the digest adds to Today (docs/agents/work-digest.md "The swap for
 * Today"): only what no section of Today reads for itself. Today reads held
 * items, meetings, tasks, waiting mail, files, clashes, chat and money from
 * their own pillars, so those are left out here and nothing shows twice. A
 * routine's result, a sign-in about to end, a guest's edit, an offered
 * grant, the Windows VM, a receipt to confirm (Money's section on Today
 * lists only what is owed): these are told only through the digest, so their
 * rows go in Today's existing `also` section. No section of the digest's
 * own.
 */

/** The groups no section of Today reads. `people` is Today's own (waiting mail, chat) but for a guest's edit. */
export const ALSO_GROUPS: readonly TellGroup[] = ["results", "ending", "system"];
const ALSO_KINDS: readonly string[] = ["docs.guest"];

/** Kinds a section of Today reads for itself, whatever day they were told: held items and failed sends, mail and chat waiting, the review. */
const TODAY_OWN: readonly string[] = ["outbox.held", "outbox.failed", "mail.waiting", "messages.new", "review.ready"];
/** Kinds Today shows only on their day: a meeting, its prep or a clash whose clock falls today. */
const ON_ITS_DAY: readonly string[] = ["prep.starting", "prep.ready", "clashes.new"];

/**
 * Whether Today has a row for this tell on `today`: the digest's toast opens Today only when every row it counts
 * is there (DigestHost), else the list, so opening the day never marks seen something he was not shown.
 */
export function todayShows(row: Pick<TellRow, "group" | "kind" | "by">, today: string): boolean {
  if (ALSO_GROUPS.includes(row.group) || ALSO_KINDS.includes(row.kind) || TODAY_OWN.includes(row.kind)) return true;
  return ON_ITS_DAY.includes(row.kind) && row.by !== undefined && localDay(row.by) === today;
}

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Today's rows of the digest: what was in today's digest, and what was told since, in the groups Today does not read itself. */
export function alsoRows(view: Pick<DigestView, "rows">, day: { from: number; to: number }, open: (row: TellRow) => void): TodayRow[] {
  const today = localDay(day.from);
  return view.rows
    .filter((r) => (r.day === today || (r.day === null && r.at >= day.from && r.at < day.to)) && (ALSO_GROUPS.includes(r.group) || ALSO_KINDS.includes(r.kind)))
    .map((row) => ({
      key: `tell:${nameOf(row)}`,
      section: "also",
      sector: row.sector,
      title: row.title,
      ...(row.detail ? { detail: row.detail } : {}),
      at: row.at,
      // A row from last evening names its day, and a clock says "by …", as the sheet's rows do.
      when: rowWhen(row, Date.now(), undefined, today),
      open: () => open(row),
    }));
}

function useAlso(env: TodayEnv): TodayAnswer {
  const view = useDigest();
  const { from, to } = env.day;
  return useMemo(
    () => ({
      rows: alsoRows(view, { from, to }, openTell),
      loading: !view.loaded,
      failed: view.errors.map((e) => ({ ...e, retry: () => loadHost(e.environmentId) })),
    }),
    [view, from, to],
  );
}

export const source: TodaySource = { id: "digest", use: useAlso };
