import type { EntryFields } from "@shared/contract-work-money";
import { centsOf, daysBetween, formatMoney, monthPeriod, today, yearPeriod, type LedgerRow, type Period, type Status } from "@shared/work/money";
import { compactTick } from "@aliax/lib/viz";

/**
 * The Money view's pure rules (docs/agents/work-money.md): the period the
 * header stands on, the words it shows, and the entry dialog's form as it
 * goes to the wire and comes back from a row.
 */

// ── the period ───────────────────────────────────────────────────────

export type Span = "month" | "year";
export interface PeriodState {
  span: Span;
  year: number;
  /** 1 to 12; kept while the year is shown, so Month comes back to it */
  month: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function periodNow(now: Date = new Date()): PeriodState {
  return { span: "month", year: now.getFullYear(), month: now.getMonth() + 1 };
}

export const periodOf = (p: PeriodState): Period => (p.span === "month" ? monthPeriod(p.year, p.month) : yearPeriod(p.year));

/** "November 2026", or "2026". */
export const periodLabel = (p: PeriodState): string => (p.span === "month" ? `${MONTHS[p.month - 1]} ${p.year}` : String(p.year));

/** A month or a year before (-1) or after (1). */
export function stepPeriod(p: PeriodState, by: -1 | 1): PeriodState {
  if (p.span === "year") return { ...p, year: p.year + by };
  const index = p.year * 12 + (p.month - 1) + by;
  return { ...p, year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// ── words ────────────────────────────────────────────────────────────

/** "+$75.00" for money in, "$42.10" for money out: never a colour. */
export const signedMoney = (cents: number): string => (cents > 0 ? `+${formatMoney(cents)}` : formatMoney(-cents));

/** A row's amount as the table shows it. */
export const rowMoney = (row: Pick<LedgerRow, "in" | "out">): string => (row.in ? `+${formatMoney(row.in)}` : formatMoney(row.out));

/** "$1.2k" from a thousand up, "$450", or "$2.50" where the dollars are not whole: the chart's axis, from cents, so neighbouring ticks never read the same. */
export function shortMoney(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) return `$${compactTick(dollars)}`;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** How long something has been open: "Today", "1 day", "32 days". */
export function sinceWords(since: string | null, now: string = today()): string | null {
  if (!since) return null;
  const days = Math.max(0, daysBetween(since, now));
  return days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
}

/** "Sat Nov 21": a calendar offer's day. */
export function offerDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return day;
  return `${date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

// ── the entry dialog's form ──────────────────────────────────────────

export interface EntryForm {
  /** as typed: "42.10", "$1,204.50" */
  amount: string;
  date: string;
  who: string;
  category: string;
  way: "in" | "out";
  /** the Status field; while `reimburse` is on it is not shown and "To reimburse" is written */
  status: Status;
  /** money spent that is to be paid back */
  reimburse: boolean;
  what: string;
  /** the job it goes to: a workspace id */
  job: string;
}

/** Whole cents from what he typed, or null when it is not an amount above nothing. */
export function parseAmount(text: string): number | null {
  const cents = centsOf(text.trim().replace(/^\$\s*/, "$"));
  return cents > 0 ? cents : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Save is on once Amount reads as more than nothing and Date is set. */
export const canSave = (form: Pick<EntryForm, "amount" | "date">): boolean => parseAmount(form.amount) !== null && DAY.test(form.date);

export const amountText = (cents: number | null | undefined): string => (cents ? (cents / 100).toFixed(2) : "");

export function blankForm(job: string, day: string = today()): EntryForm {
  return { amount: "", date: day, who: "", category: "", way: "out", status: "Paid", reimburse: false, what: "", job };
}

/** A row of the ledger as the dialog's form. */
export function formOfRow(row: LedgerRow, job: string): EntryForm {
  const way = row.in && !row.out ? "in" : "out";
  const reimburse = way === "out" && row.status === "To reimburse";
  return {
    amount: amountText(way === "in" ? row.in : row.out),
    date: row.date ?? "",
    who: row.who,
    category: row.category,
    way,
    status: reimburse ? "Paid" : row.status,
    reimburse,
    what: row.what,
    job,
  };
}

/** The Status field's choices: Paid and Unpaid, and a status the row already holds that is neither, so an edit keeps it. */
export function statusChoices(form: Pick<EntryForm, "status">): Status[] {
  return form.status === "Paid" || form.status === "Unpaid" || form.status === "To reimburse" ? ["Paid", "Unpaid"] : ["Paid", "Unpaid", form.status];
}

/** What the form writes; null while it cannot be saved. `was` is the row being edited. */
export function fieldsOfForm(form: EntryForm, was?: Pick<LedgerRow, "status" | "paidOn"> | null): EntryFields | null {
  const amount = parseAmount(form.amount);
  if (amount === null || !DAY.test(form.date)) return null;
  const status: Status = form.way === "out" && form.reimburse ? "To reimburse" : form.way === "in" && form.status === "To reimburse" ? "Paid" : form.status;
  const paid = status === "Paid" || status === "Reimbursed";
  return {
    date: form.date,
    who: form.who.trim(),
    what: form.what.trim(),
    category: form.category.trim(),
    way: form.way,
    amount,
    status,
    // A paid row keeps the day it was paid on; one that is not paid has none.
    ...(paid ? (was?.paidOn && was.status === status ? { paidOn: was.paidOn } : {}) : { paidOn: null }),
  };
}

/** The dialog's form from what was read off a receipt: empty where nothing was read. */
export function formOfReceipt(fields: { amount: number | null; date: string | null; who: string | null; category: string | null; way?: "in" | "out"; what?: string }, job: string): EntryForm {
  return {
    ...blankForm(job, fields.date ?? ""),
    amount: amountText(fields.amount),
    who: fields.who ?? "",
    category: fields.category ?? "",
    way: fields.way ?? "out",
    what: fields.what ?? "",
  };
}
