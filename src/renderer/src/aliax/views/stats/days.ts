import type { StatsBundle } from "@shared/aliaxStats";

/** The days a day chart reads: the last 30, as the queries' window. */
const WINDOW_DAYS = 30;

const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const local = (day: string): Date => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

/**
 * Every calendar day of the window, oldest first, as local "YYYY-MM-DD": the
 * 30 days to the bundle's day (or its newest row's, if later), reaching back
 * further only to an older row. A day chart draws one slot for each, so an
 * idle week takes its week of room.
 */
export function windowDays(data: Pick<StatsBundle, "generatedAt" | "daily" | "cacheDaily" | "modelDaily">): string[] {
  const seen = [...data.daily, ...data.cacheDaily, ...data.modelDaily].map((r) => r.day).sort();
  if (seen.length === 0) return [];
  const today = data.generatedAt > 0 ? iso(new Date(data.generatedAt)) : seen[seen.length - 1]!;
  const end = local(today > seen[seen.length - 1]! ? today : seen[seen.length - 1]!);
  const back = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (WINDOW_DAYS - 1));
  const start = seen[0]! < iso(back) ? local(seen[0]!) : back;
  const days: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(iso(d));
  return days;
}

/** `rows` on every day of `days`, `empty(day)` where a day has none. */
export function fillDays<T extends { day: string }>(days: readonly string[], rows: readonly T[], empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => byDay.get(day) ?? empty(day));
}
