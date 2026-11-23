import { useMemo } from "react";
import type { TellGroup, TellRow } from "@shared/work/tell";
import { clockTime } from "../../lib/duration";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySource } from "../today/types";
import { nameOf } from "./notice";
import { loadHost, openTell, useDigest, type DigestView } from "./store";

/**
 * What the digest adds to Today (docs/agents/work-digest.md "The swap for
 * Today"): only what no section of Today reads for itself. Today reads held
 * items, meetings, tasks, waiting mail, files, clashes, chat and money from
 * their own pillars, so those are left out here and nothing shows twice. A
 * routine's result, a sign-in about to end, a guest's edit, an offered
 * grant, the Windows VM: these are told only through the digest, so their
 * rows go in Today's existing `also` section. No section of the digest's
 * own.
 */

/** The groups no section of Today reads. `people` is Today's own (waiting mail, chat) but for a guest's edit. */
export const ALSO_GROUPS: readonly TellGroup[] = ["results", "ending", "system"];
const ALSO_KINDS: readonly string[] = ["docs.guest"];
/** A receipt to confirm is Money's own section on Today, though its group is `results`. */
const NOT_ALSO: readonly string[] = ["money.confirm"];

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Today's rows of the digest: what was in today's digest, and what was told since, in the groups Today does not read itself. */
export function alsoRows(view: Pick<DigestView, "rows">, day: { from: number; to: number }, open: (row: TellRow) => void): TodayRow[] {
  const today = localDay(day.from);
  return view.rows
    .filter((r) => (r.day === today || (r.day === null && r.at >= day.from && r.at < day.to)) && !NOT_ALSO.includes(r.kind) && (ALSO_GROUPS.includes(r.group) || ALSO_KINDS.includes(r.kind)))
    .map((row) => ({
      key: `tell:${nameOf(row)}`,
      section: "also",
      sector: row.sector,
      title: row.title,
      ...(row.detail ? { detail: row.detail } : {}),
      at: row.at,
      when: clockTime(row.at),
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
