// A preview frame for `bun run ui:preview src/renderer/src/work/sheets/preview.preview.tsx#SheetPreview --width 864 --shot`:
// the Preview frame over the sheet's own formats (docs/agents/work-sheets.md "Preview and export"), with a source that
// answers at once and paper drawn in place of pdf.js.
import { fakeDoc, fakeEngine, type FakePage } from "../pdf/testkit";
import { Preview } from "../formats/PreviewFrame";
import type { Drawn, PreviewBytes, PreviewSource } from "../formats/preview";
import { sheetFormats } from "./preview";

export type SheetMoment = "excel" | "long" | "xls" | "csv";

const bytes = (rev: string): PreviewBytes => ({ rev, size: 1, read: async () => new Uint8Array(1) });
const ROWS = [
  ["Item", "Vendor", "Cost", "Paid"],
  ["Tables, 40", "Union events", "1,200.00", "Yes"],
  ["Power drops, 12", "Union facilities", "540.00", "Yes"],
  ["Network switch rental", "Campus IT", "310.00", "No"],
  ["Prizes", "Store", "750.00", "No"],
  ["Total", "", "2,800.00", ""],
];

const PT = 1 / 792;
const COLUMNS = [0.08, 0.36, 0.6, 0.76];
/** A printed sheet as lines on US letter paper: each row's cells at their columns, as pdf.js would read them back. */
function sheetPage(rows: string[][], from = 0): FakePage {
  const lines: NonNullable<FakePage["lines"]> = [];
  rows.forEach((row, r) =>
    row.forEach((text, c) => {
      const y = 0.06 + r * 15 * PT;
      if (text) lines.push({ text, box: [COLUMNS[c]!, y, COLUMNS[c + 1] ?? 0.92, y + 11 * PT], size: 9, bold: from + r === 0 });
    }),
  );
  return { lines, runs: lines.map((l) => ({ str: l.text, box: l.box })) };
}
/** A long sheet's print: 46 rows a page, the header on the first. */
const longPages = (count: number): FakePage[] =>
  Array.from({ length: count }, (_, p) => sheetPage(Array.from({ length: 46 }, (_, r) => (p + r === 0 ? ROWS[0]! : [`Seat ${p * 46 + r}`, "Union events", "30.00", (p + r) % 3 ? "Yes" : "No"])), p * 46));

function setUp(moment: SheetMoment): { source: PreviewSource; initial: string; paper: FakePage[]; tight: boolean } {
  const formats = sheetFormats({ store: "package", name: "Spring LAN budget.xlsx" });
  const paged = (pages: number, drops: string[], shown?: { from: number; to: number; of: number }): Drawn => ({ picture: { kind: "paged", pdf: bytes(moment), pages, drawnBy: "libreoffice", ...(shown ? { shown } : {}) }, drops });
  const source = (draw: () => Promise<Drawn>): PreviewSource => ({ formats, draw, export: async (format) => ({ name: `Spring LAN budget.${format}` }) });
  const short = [sheetPage(ROWS), sheetPage([["Flight", "Fare"], ["IND to LAS", "412.00"], ["LAS to IND", "388.00"]])];
  switch (moment) {
    case "long":
      return { source: source(async () => paged(24, ["Prints on more than 24 pages"], { from: 1, to: 24, of: 25 })), initial: "pdf", paper: longPages(24), tight: true };
    case "xls":
      return { source: source(async () => paged(2, ["3 colour scales stay behind", "2 tables become plain ranges", "4 formulas use functions Excel 97-2003 does not have"])), initial: "xls", paper: short, tight: false };
    case "csv":
      return { source: source(async () => ({ picture: { kind: "table", name: "Budget", rows: ROWS, sheets: ["Budget", "Flights", "Hotel"] }, drops: ["Flights and Hotel stay behind", "1 formula becomes its value", "Formatting stays behind"] })), initial: "csv", paper: [], tight: false };
    default:
      // Eight formats and "Save a copy" do not fit 864px (nor do they beside a count of 25): the format is the menu the bar falls back to.
      return { source: source(async () => paged(2, [])), initial: "xlsx", paper: short, tight: true };
  }
}

export function SheetPreview({ moment = "excel" }: { moment?: SheetMoment }) {
  const { source, initial, paper, tight } = setUp(moment);
  return (
    <div className="flex h-[620px] overflow-hidden rounded-xl border border-border" style={{ width: 864 }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Preview source={source} title="Spring LAN budget" kind={`sheet-preview-${moment}`} initial={initial} onClose={() => undefined} engine={fakeEngine(fakeDoc(paper))} width={864} height={584} tight={tight} />
      </div>
    </div>
  );
}
