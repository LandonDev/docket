import { digestLine, nowLine, sectorName } from "@shared/work/digest";
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
  /** the rows it counts */
  rows: HostRow[];
  line: string;
}

/**
 * The digest's notice: the days not yet seen on any host and what waited in
 * them; null when there is nothing to say. A row waited when it was not told
 * at once before its day was made: one whose clock came due later, and so
 * interrupted after all, is still part of the day he has not opened.
 */
type HostRow = TellRow & { environmentId?: string };
export function digestNotice(view: { days: readonly MergedDay[]; rows: readonly HostRow[] }): DigestNotice | null {
  const days = view.days.filter((d) => d.seenAt === null);
  if (days.length === 0) return null;
  const byDay = new Map(days.map((d) => [d.day, d]));
  // By its own host's clock: a host that made its day late told its rows before that, not before another host's earlier time.
  const madeFor = (r: HostRow): number => {
    const day = byDay.get(r.day!)!;
    return (r.environmentId ? day.madeBy?.[r.environmentId] : undefined) ?? day.madeAt;
  };
  const rows = view.rows.filter((r) => r.day !== null && byDay.has(r.day) && (r.toldAt === null || r.toldAt > madeFor(r)));
  if (rows.length === 0) return null;
  return { days, rows, line: digestLine(rows.length, jobsOf(rows)) };
}

/** Whether the unseen days are today alone: only then does Today, which shows today alone, show all the notice spoke for. */
export function onlyToday(days: readonly Pick<MergedDay, "day">[], now: number): boolean {
  return days.length > 0 && days.every((d) => d.day === localDay(now));
}

/**
 * What a closed, opened or heard interrupt is kept under: the thing told, its key and its clock, never when a host
 * told it. Two hosts' copies of one meeting are one telling, so closing it on one closes it on the other and it
 * sounds once; a deadline brought forward is a new telling, and a send that fails again is a new key (its attempt).
 */
export const tellingOf = (row: Pick<TellRow, "key" | "host" | "id" | "by">): string => `${nameOf(row)}@${row.by ?? ""}`;

/** Two 32-bit FNV-1a passes with different seeds: a fingerprint, not a secret. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019d) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}`;
}

/**
 * Which tellings a system notice says, short enough to cross to main whole (src/main/notice.ts keeps a telling of
 * 1,000 characters at most): the list itself while it is short, else a fingerprint of the whole ordered list, so a
 * long fold whose one deadline moved is still a new notice.
 */
export function tellingsOf(rows: readonly Pick<TellRow, "key" | "host" | "id" | "by">[]): string {
  const joined = rows.map(tellingOf).join(" ");
  return joined.length <= 200 ? joined : `${rows.length}#${fingerprint(joined)}`;
}

/** The interrupts still worth a toast: told at once, within a day, and not dismissed or opened in this window. Oldest first. */
export function openInterrupts(view: Pick<DigestView, "rows">, dismissed: ReadonlySet<string>, now: number): TellRow[] {
  return view.rows.filter((r) => r.toldAt !== null && now - r.toldAt < NOW_KEEP_MS && !dismissed.has(tellingOf(r))).sort((a, b) => a.toldAt! - b.toldAt!);
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
  /** which tellings it says (`tellingOf`): the same thing told again in the same words is still a new notice */
  telling?: string;
}

/**
 * The same two things as system notifications, for a person looking at another app: the digest's is silent. A
 * thing's detail is a line of its own, never joined by a colon (most titles hold one already). A notice sounds only
 * when it holds a telling not heard before (`heard`): a thing that joins the fold sounds, while a fold that loses a
 * thing, or breaks up into the things he already heard one by one, says so quietly.
 */
export function systemNotices(digest: DigestNotice | null, toasts: readonly NowToast[], heard: (row: TellRow) => boolean = () => false): SystemNotice[] {
  const out: SystemNotice[] = [];
  if (digest) out.push({ key: `digest:${digest.days[0]!.day}`, title: "Work", body: digest.line, silent: true });
  for (const toast of toasts) {
    const one = toast.rows.length === 1 ? toast.rows[0]! : null;
    // Folded: every open one by name, newest first, as the phone's banner says it (`nowLine`); the toast keeps its short count.
    const body = one ? (toast.detail ? `${toast.title}\n${toast.detail}` : toast.title) : nowLine([...toast.rows].reverse().map((r) => r.title));
    out.push({ key: toast.id, title: one?.sector ? sectorName(one.sector) : "Work", body, telling: tellingsOf(toast.rows), ...(toast.rows.every(heard) ? { silent: true } : {}) });
  }
  return out;
}

// ── the list ──────────────────────────────────────────────────────────────

export interface ListSection {
  id: string;
  title: string;
  /** the day its heading names: today for what waits */
  day: string;
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
  const today = localDay(now);
  if (since.length) out.push({ id: "since", title: "Since the digest", day: today, rows: byJob(since) });
  // The calendar day before, not 24 hours back: the night the clocks change, those differ.
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  const yesterday = localDay(before.getTime());
  const madeAt = new Map(view.days.map((d) => [d.day, d.madeAt]));
  const days = [...new Set(view.rows.flatMap((r) => (r.day ? [r.day] : [])))].sort().reverse();
  for (const day of days) {
    const made = madeAt.get(day);
    const title = day === today ? (made ? `Today, ${clockTime(made, locale)}` : "Today") : day === yesterday ? "Yesterday" : dateWords(day, locale);
    out.push({ id: day, title, day, rows: byJob(view.rows.filter((r) => r.day === day)) });
  }
  return out;
}

/**
 * A row's trailing fact: its clock in words when it has one ("by Nov 26,
 * 2:00 PM"), else when it was told. A clock its own words already say
 * ("Budget review starts at 2:00 PM") is not said twice, and a clock already
 * past when it was told is no deadline: those rows end with when they were
 * told. The told time names its day only when that is not the day of the
 * heading the row sits under (`day`; today for what waits), so a heading's
 * day is never said again on its rows.
 */
export function rowWhen(row: Pick<TellRow, "by" | "at" | "title" | "detail">, now: number, locale?: string, day: string = localDay(now)): string {
  const ahead = row.by !== undefined && row.by > row.at;
  // Spaces compare as spaces: a formatter may write a narrow no-break space before AM and PM where the host's words have a plain one.
  const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, " ");
  if (ahead && !plain(`${row.title} ${row.detail ?? ""}`).includes(plain(clockTime(row.by!, locale)))) return `by ${dayTime(row.by!, now, locale)}`;
  return localDay(row.at) === day ? clockTime(row.at, locale) : dayTime(row.at, now, locale);
}

/** The list's one empty line: since when Work has had nothing to tell him (the ledger keeps 30 days). */
export function emptyLine(now: number, locale?: string): string {
  const since = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(now - 30 * 24 * 3_600_000);
  return `Nothing since ${since}`;
}

const named = (names: readonly string[]): string => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** "The Mac did not answer", "The Mac and the box did not answer". */
export function unansweredLine(names: readonly string[]): string {
  return names.length === 0 ? "" : `${named(names)} did not answer`;
}

/** A setting some hosts would not take: "The Mac did not take it". */
export function refusedLine(names: readonly string[]): string {
  return names.length === 0 ? "" : `${named(names)} did not take it`;
}
