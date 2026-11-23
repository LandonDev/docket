import { digestLine, sectorName } from "@shared/work/digest";
import type { TellRow } from "@shared/work/tell";
import { clockTime, dayTime } from "../../lib/duration";
import type { DigestView, MergedDay } from "./store";

/**
 * What the desktop shows of the digest, decided here and nowhere else
 * (docs/agents/work-digest.md "Telling him (desktop)"). Pure: the host
 * component draws what these answer.
 *
 * The digest: one toast for every day he has not opened, on any host.
 * An interrupt: one toast a key; past three at once they fold into one.
 */

export const DIGEST_TOAST = "work-digest";
export const NOW_FOLD_TOAST = "work-now";
/** More interrupts than this at once are one toast. */
export const FOLD_PAST = 3;
/** An interrupt he neither opened nor dismissed leaves the window after a day; the list keeps it. */
export const NOW_KEEP_MS = 24 * 3_600_000;

/** A row's name across hosts: its key, else its own id on its host. */
export const nameOf = (row: Pick<TellRow, "key" | "host" | "id">): string => (row.key ? `k:${row.key}` : `i:${row.host}:${row.id}`);

const jobsOf = (rows: readonly TellRow[]): string[] => rows.flatMap((r) => (r.sector ? [sectorName(r.sector)] : []));

export interface DigestNotice {
  /** every day he has not opened, newest first */
  days: MergedDay[];
  line: string;
}

/** The digest's notice: the days not yet seen on any host and what waited in them; null when there is nothing to say. */
export function digestNotice(view: Pick<DigestView, "days" | "rows">): DigestNotice | null {
  const days = view.days.filter((d) => d.seenAt === null);
  if (days.length === 0) return null;
  const unseen = new Set(days.map((d) => d.day));
  const rows = view.rows.filter((r) => r.day !== null && unseen.has(r.day) && r.toldAt === null);
  if (rows.length === 0) return null;
  return { days, line: digestLine(rows.length, jobsOf(rows)) };
}

/** The interrupts still worth a toast: told at once, within a day, and not dismissed or opened in this window. Oldest first. */
export function openInterrupts(view: Pick<DigestView, "rows">, dismissed: ReadonlySet<string>, now: number): TellRow[] {
  return view.rows.filter((r) => r.toldAt !== null && now - r.toldAt < NOW_KEEP_MS && !dismissed.has(nameOf(r))).sort((a, b) => a.toldAt! - b.toldAt!);
}

export interface NowToast {
  id: string;
  title: string;
  /** the second line */
  detail?: string;
  /** the rows it stands for: one, or every folded one */
  rows: TellRow[];
}

/** One toast a row; past three, one toast for them all, which opens the list. */
export function nowToasts(rows: readonly TellRow[]): NowToast[] {
  if (rows.length > FOLD_PAST) return [{ id: NOW_FOLD_TOAST, title: `${rows.length} things need you now`, rows: [...rows] }];
  return rows.map((row) => ({ id: `${NOW_FOLD_TOAST}:${nameOf(row)}`, title: row.title, ...(row.detail ? { detail: row.detail } : {}), rows: [row] }));
}

export interface SystemNotice {
  key: string;
  title: string;
  body: string;
  silent?: boolean;
}

/** The same two things as system notifications, for a person looking at another app: the digest's is silent. */
export function systemNotices(digest: DigestNotice | null, toasts: readonly NowToast[]): SystemNotice[] {
  const out: SystemNotice[] = [];
  if (digest) out.push({ key: `digest:${digest.days[0]!.day}`, title: "Work", body: digest.line, silent: true });
  for (const toast of toasts) {
    const one = toast.rows.length === 1 ? toast.rows[0]! : null;
    out.push({ key: toast.id, title: one?.sector ? sectorName(one.sector) : "Work", body: toast.detail ? `${toast.title}: ${toast.detail}` : toast.title });
  }
  return out;
}

// ── the list ──────────────────────────────────────────────────────────────

export interface ListSection {
  id: string;
  title: string;
  rows: TellRow[];
}

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dates = new Map<string, Intl.DateTimeFormat>();
function dateWords(day: string, locale?: string): string {
  let fmt = dates.get(locale ?? "");
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    dates.set(locale ?? "", fmt);
  }
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return fmt.format(new Date(y, m - 1, d));
}

/** A section's rows: by job, then newest. A row about no one job comes last. */
function byJob(rows: readonly TellRow[]): TellRow[] {
  return [...rows].sort((a, b) => {
    if (a.sector !== b.sector) return a.sector === null ? 1 : b.sector === null ? -1 : a.sector < b.sector ? -1 : 1;
    return b.at - a.at;
  });
}

/**
 * The list's sections, newest first: what waits for the next digest, then
 * each day's digest ("Today, 8:00 AM", "Yesterday", then dates). A day whose
 * rows have all gone is left out.
 */
export function listSections(view: Pick<DigestView, "days" | "rows">, now: number, locale?: string): ListSection[] {
  const out: ListSection[] = [];
  const since = view.rows.filter((r) => r.day === null);
  if (since.length) out.push({ id: "since", title: "Since the digest", rows: byJob(since) });
  const today = localDay(now);
  const yesterday = localDay(now - 24 * 3_600_000);
  const madeAt = new Map(view.days.map((d) => [d.day, d.madeAt]));
  const days = [...new Set(view.rows.flatMap((r) => (r.day ? [r.day] : [])))].sort().reverse();
  for (const day of days) {
    const made = madeAt.get(day);
    const title = day === today ? (made ? `Today, ${clockTime(made, locale)}` : "Today") : day === yesterday ? "Yesterday" : dateWords(day, locale);
    out.push({ id: day, title, rows: byJob(view.rows.filter((r) => r.day === day)) });
  }
  return out;
}

/** A row's trailing fact: its clock in words when it has one ("by 2:00 PM"), else when it was told. */
export function rowWhen(row: Pick<TellRow, "by" | "at">, now: number, locale?: string): string {
  return row.by !== undefined ? `by ${dayTime(row.by, now, locale)}` : clockTime(row.at, locale);
}

/** The list's one empty line: since when Work has had nothing to tell him (the ledger keeps 30 days). */
export function emptyLine(now: number, locale?: string): string {
  const since = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(now - 30 * 24 * 3_600_000);
  return `Work has had nothing to tell you since ${since}.`;
}
