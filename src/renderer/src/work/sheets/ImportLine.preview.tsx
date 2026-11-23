// A preview frame for `bun run ui:preview src/renderer/src/work/sheets/ImportLine.preview.tsx#ImportLinePreview --width 864 --shot`:
// the quiet line over the grid of a sheet opened as an Excel copy (docs/agents/work-sheets.md "Other formats in"), in each
// state the host can answer, over a stand-in for the grid. `--width 420` shows the words taking a second line.
import type { SheetImported } from "@shared/work/sheetFormats";
import { ImportLine } from "./ImportLine";

export type ImportMoment = "xls" | "ods" | "tsv" | "shared" | "stale" | "macros";

const MOMENTS: Record<ImportMoment, { imported: SheetImported; shared: boolean }> = {
  xls: { imported: { format: "xls", name: "Ledger.xls" }, shared: false },
  ods: { imported: { format: "ods", name: "Ledger.ods" }, shared: false },
  tsv: { imported: { format: "tsv", name: "Scores.tsv" }, shared: false },
  shared: { imported: { format: "xls", name: "Ledger.xls" }, shared: true },
  stale: { imported: { format: "xls", name: "Ledger.xls", stale: true }, shared: false },
  macros: { imported: { format: "xls", name: "Ledger.xls", noBack: "This file holds macros, which an Excel copy does not keep" }, shared: false },
};

const ROWS = [
  ["Item", "Vendor", "Cost"],
  ["Tables, 40", "Union events", "1,200.00"],
  ["Power drops, 12", "Union facilities", "540.00"],
  ["Prizes", "Store", "750.00"],
];

export function ImportLinePreview({ moment = "xls" }: { moment?: ImportMoment }) {
  const { imported, shared } = MOMENTS[moment];
  return (
    <div className="flex h-56 flex-col bg-background">
      <ImportLine imported={imported} shared={shared} run={() => new Promise((done) => setTimeout(done, 1200))} />
      <div className="min-h-0 flex-1 text-[13px] text-foreground">
        {ROWS.map((row, r) => (
          <div key={r} className="grid grid-cols-3 border-b border-border">
            {row.map((cell, c) => (
              <div key={c} className={`border-r border-border px-2 py-1 ${r === 0 ? "font-medium" : ""}`}>
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
