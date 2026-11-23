// Fixtures for `bun run ui:preview src/renderer/src/work/sheets/SheetBody.preview.tsx#SheetPreview --width 864`,
// and the preview's workbooks: the prototype's nationals budget, a spend summary for the chart, and his invoices.
import type { SheetSuggestion } from "@shared/contract-work-sheets";
import { suggestion, workbookOf } from "./testkit";
import type { Workbook } from "./sync";

export default [
  { name: "Suggestions in the cells, the first in hand; the switch offered", props: { moment: "suggestions" } },
  { name: "Stepped to the third change", props: { moment: "stepped" } },
  { name: "His own sheet: the agent wrote, with Undo", props: { moment: "own" } },
  { name: "A sheet TempCode keeps: the format row", props: { moment: "format" } },
  { name: "An agent proposed a format: said in the formula bar, its range marked", props: { moment: "proposed" } },
  { name: "A chart over the cells", props: { moment: "chart" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "Read only", props: { moment: "readonly" } },
  { name: "An Excel file with what only Excel does: the bar says what waits there", props: { moment: "waits" } },
];

const usd = (v: number) => ({ v, s: "usd" });
const head = (v: string) => ({ v, s: "head" });

export const BUDGET: Workbook = workbookOf([
  {
    id: "budget",
    name: "Budget",
    widths: [132, 52, 52, 68, 88, 72, 72, 72],
    rows: [
      [{ v: "Nationals travel budget", s: "title" }],
      [],
      [head("Item"), head("Qty"), head("Days"), head("Rate"), head("Total")],
      ["Flights", 14, null, usd(412), { ...usd(5768), f: "=B4*D4" }],
      ["Hotel", 7, 3, usd(189), { ...usd(3969), f: "=B5*C5*D5" }],
      ["Ground", null, null, null, usd(1240)],
      ["Meals", 14, 3, usd(55), { ...usd(2310), f: "=B7*C7*D7" }],
      ["Registration", 12, null, usd(150), { ...usd(1800), f: "=B8*D8" }],
      ["Subtotal", null, null, null, { ...usd(15087), f: "=SUM(E4:E8)" }],
      ["Contingency", null, null, { v: 0.08, s: "pct" }, { ...usd(1207), f: "=E9*D10" }],
      ["Total", null, null, null, { ...usd(16294), f: "=E9+E10" }],
      ["Budget", null, null, null, usd(16500)],
      ["Left", null, null, null, { ...usd(206), f: "=E12-E11" }],
    ],
  },
  { id: "roster", name: "Roster", rows: [] },
  { id: "quotes", name: "Quotes", rows: [] },
]);

const change = (id: string, row: number, col: number, from: Record<string, unknown>, to: Record<string, unknown>): SheetSuggestion =>
  suggestion(id, row, col, { changeSet: "turn1", base: from, proposed: to, reason: "New quotes for nationals" });

export const BUDGET_CHANGES: SheetSuggestion[] = [
  change("fl", 3, 3, usd(412), usd(438)),
  change("ho", 4, 3, usd(189), usd(172)),
  change("gr", 5, 4, usd(1240), usd(1380)),
  change("me", 6, 3, usd(55), usd(50)),
  change("ct", 9, 3, { v: 0.08, s: "pct" }, { v: 0.06, s: "pct" }),
];

export const SPEND: Workbook = workbookOf([
  {
    id: "budget",
    name: "Budget",
    widths: [132, 88, 72, 72, 72, 72],
    rows: [[head("Category"), head("Planned")], ["Flights", usd(5768)], ["Hotel", usd(3969)], ["Ground", usd(1240)], ["Meals", usd(2310)], ["Registration", usd(1800)]],
  },
  { id: "quotes", name: "Quotes", rows: [] },
]);

export const INVOICES: Workbook = workbookOf([
  {
    id: "y2026",
    name: "2026",
    widths: [52, 112, 64, 64, 80, 80],
    rows: [
      [head("Invoice"), head("Client"), head("Sent"), head("Due"), head("Amount"), head("Status")],
      [1040, "Northside PT", "Oct 1", "Oct 15", usd(2400), "Paid"],
      [1041, "Rivera Dental", "Oct 6", "Oct 20", usd(1850), "Paid"],
      [1042, "Rivera Dental", "Oct 21", "Nov 4", usd(1850), "Overdue"],
      [1043, "Northside PT", "Oct 27", "Nov 10", usd(2400), "Overdue"],
      [1044, "Harbor Vet", "Nov 2", "Nov 16", usd(1920), "Overdue"],
      [1045, "Northside PT", "Nov 3", "Nov 17", usd(1200), "Paid"],
      [1046, "Lakeview Ortho", "Nov 9", "Nov 23", usd(1250), "Sent"],
    ],
  },
  { id: "y2025", name: "2025", rows: [] },
  { id: "clients", name: "Clients", rows: [] },
]);
