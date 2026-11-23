import type { MoneyRead } from "@shared/contract-work-money";
import { byCategory, byMonth, categoriesFor, owedOf, sumsOf, type LedgerRow, type Period } from "@shared/work/money";

/**
 * A made-up referee's books for the preview and the tests: a November of
 * game fees in, fuel and gear out, and a year behind it. No real names.
 */

let n = 1;
export const ledgerRow = (date: string, who: string, category: string, amount: number, over: Partial<LedgerRow> = {}): LedgerRow => ({
  row: ++n,
  ref: `r${n}`,
  date,
  who,
  what: "",
  category,
  in: amount > 0 ? amount : 0,
  out: amount < 0 ? -amount : 0,
  status: "Paid",
  paidOn: null,
  receipt: "",
  ...over,
});

export const NOVEMBER: LedgerRow[] = [
  ledgerRow("2026-11-21", "Harlan Valley Officials", "Game fees", 7500, { what: "Varsity at Harrison", status: "Unpaid" }),
  ledgerRow("2026-11-20", "Corner Fuel", "Mileage", -4210, { receipt: "Receipts/2026/2026-11-20 Corner Fuel 42.10.jpg" }),
  ledgerRow("2026-11-18", "Ridgeline Conference", "Game fees", 6500, { what: "JV doubleheader" }),
  ledgerRow("2026-11-16", "Stripe & Whistle Supply", "Uniform and gear", -8995, { what: "Winter jacket", receipt: "Receipts/2026/2026-11-16 Stripe Whistle 89.95.pdf" }),
  ledgerRow("2026-11-14", "Harlan Valley Officials", "Game fees", 7500, { what: "Varsity at Millbrook" }),
  ledgerRow("2026-11-13", "Corner Fuel", "Mileage", -3880),
  ledgerRow("2026-11-11", "Ridgeline Conference", "Game fees", 6000),
  ledgerRow("2026-11-09", "Diner on 9th", "Meals", -1625, { what: "Crew meal before the game", status: "To reimburse" }),
  ledgerRow("2026-11-07", "Harlan Valley Officials", "Game fees", 7500),
  ledgerRow("2026-11-05", "State Officials Assn", "Dues and registration", -4500, { status: "Unpaid", what: "Second-half dues" }),
  ledgerRow("2026-11-03", "Corner Fuel", "Mileage", -4415, { receipt: "Receipts/2026/2026-11-03 Corner Fuel 44.15.jpg" }),
  ledgerRow("2026-11-01", "Ridgeline Conference", "Game fees", 6500),
];

const EARLIER: LedgerRow[] = [
  ["2026-01", 9000, 2400], ["2026-02", 12000, 3100], ["2026-03", 15500, 5200], ["2026-04", 6000, 1900],
  ["2026-05", 4500, 1200], ["2026-06", 0, 800], ["2026-07", 0, 0], ["2026-08", 13500, 9800],
  ["2026-09", 30500, 6200], ["2026-10", 34000, 7400],
].flatMap(([month, fees, fuel]) => [
  ...(fees ? [ledgerRow(`${month}-12`, "Ridgeline Conference", "Game fees", fees as number)] : []),
  ...(fuel ? [ledgerRow(`${month}-14`, "Corner Fuel", "Mileage", -(fuel as number))] : []),
]);

export const ALL_ROWS = [...NOVEMBER, ...EARLIER];

/** What the host would answer for a period of these rows. */
export function readOf(period: Period, rows: readonly LedgerRow[] = ALL_ROWS, over: Partial<MoneyRead> = {}): MoneyRead {
  const year = Number(period.from.slice(0, 4));
  const inside = rows.filter((r) => r.date && r.date >= period.from && r.date < period.to).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return {
    made: true,
    root: { at: "file", host: "box", path: "/home/ref/Refereeing/Money" },
    period,
    rows: inside,
    sums: sumsOf(rows, period),
    byCategory: byCategory(rows, period),
    byMonth: byMonth(rows, year),
    owed: owedOf(rows),
    miles: inside.length ? { miles: 412, value: 28840, rate: 0.7 } : { miles: 0, value: 0, rate: null },
    categories: categoriesFor("ref", rows.map((r) => r.category)),
    sellers: [...new Set(rows.map((r) => r.who))],
    toConfirm: [],
    calendar: [],
    rate: { year, rate: 0.7, own: false },
    problems: [],
    ...over,
  };
}

export const EMPTY_READ = (period: Period): MoneyRead => readOf(period, [], { made: false });
