import { useState } from "react";
import type { TodayRow } from "./types";

/** What a row shows: two rows that agree here draw the same, whatever their closures hold. */
function sameFacts(a: TodayRow, b: TodayRow): boolean {
  return (
    a.key === b.key &&
    a.section === b.section &&
    a.sector === b.sector &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.detailLate === b.detailLate &&
    a.at === b.at &&
    a.when === b.when &&
    a.whenLine === b.whenLine &&
    a.late === b.late &&
    a.past === b.past &&
    a.lead?.kind === b.lead?.kind &&
    (a.lead?.kind !== "glyph" || b.lead?.kind !== "glyph" || a.lead.glyph === b.lead.glyph) &&
    (a.acts?.length ?? 0) === (b.acts?.length ?? 0) &&
    (a.acts ?? []).every((act, i) => act.label === b.acts?.[i]?.label)
  );
}

/** `next`, with each row that shows what it showed before kept as the object it was; the same array when nothing moved. */
export function keepRows(prev: readonly TodayRow[], next: readonly TodayRow[]): readonly TodayRow[] {
  const before = new Map(prev.map((row) => [row.key, row]));
  const rows = next.map((row) => {
    const was = before.get(row.key);
    return was && sameFacts(was, row) ? was : row;
  });
  return rows.length === prev.length && rows.every((row, i) => row === prev[i]) ? prev : rows;
}

/**
 * A source's rows, each the same object for as long as it shows the same
 * (docs/agents/renderer-over-time.md): a minute's tick, or a live query
 * that answers again with what it had, redraws only the row that changed.
 * `ways` is what the rows' presses close over (the session they write
 * through, the jobs they open in): when it is another, every row is the new
 * one, so no row on the page acts through a session or a job that is gone.
 */
export function useStableRows(rows: readonly TodayRow[], ways: unknown): TodayRow[] {
  // A box of the hook's own, not a ref: it is read and written while rendering, which a ref may not be.
  const [kept] = useState<{ rows: readonly TodayRow[]; ways: unknown }>(() => ({ rows: [], ways }));
  kept.rows = kept.ways === ways ? keepRows(kept.rows, rows) : rows;
  kept.ways = ways;
  return kept.rows as TodayRow[];
}
