import type { MoneyRead } from "@shared/contract-work-money";
import type { LedgerRow } from "@shared/work/money";

/*
 * What Money's loading bones are drawn from (docs/agents/loading-bones.md "Samples"): the ledger's own pieces given
 * a month of six rows. Nobody reads the words; their lengths give the bones their shape. No part whose presence is
 * unknown: no category sums, nothing owed, no miles, no receipt's paperclip.
 */

const row = (n: number, date: string, who: string, category: string, cents: number): LedgerRow => ({
  row: n,
  ref: `sample:${n}`,
  date,
  who,
  what: "",
  category,
  in: cents > 0 ? cents : 0,
  out: cents < 0 ? -cents : 0,
  status: "Paid",
  paidOn: null,
  receipt: "",
});

export const SAMPLE_MONEY: MoneyRead = {
  made: true,
  any: true,
  root: { at: "file", host: "sample:host", path: "/sample/Money" },
  period: { from: "2026-11-01", to: "2026-12-01" },
  rows: [
    row(2, "2026-11-21", "Harlan Valley Officials", "Game fees", 7500),
    row(3, "2026-11-20", "Corner Fuel", "Travel", -4210),
    row(4, "2026-11-18", "Ridgeline Conference", "Game fees", 6500),
    row(5, "2026-11-16", "Stripe and Whistle", "Uniform and gear", -8995),
    row(6, "2026-11-13", "Corner Fuel", "Travel", -3880),
    row(7, "2026-11-09", "Diner on 9th", "Meals", -1625),
  ],
  sums: { in: 14000, out: 18710, net: -4710, owedToHim: 0, heOwes: 0 },
  byCategory: [],
  byMonth: [],
  owed: [],
  miles: { miles: 0, value: 0, rate: null },
  categories: [],
  sellers: [],
  toConfirm: [],
  calendar: [],
  rate: { year: 2026, rate: 0.7, own: false },
  problems: [],
};
