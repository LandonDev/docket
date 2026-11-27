import type { ReactNode } from "react";
import { Bones } from "../../components/bones";

/**
 * The sample a sheet's bones are drawn from: an opened budget's first columns (their widths) and rows, each row its
 * first column's words and the figures it has. A row of no words is an empty row. Skullet draws a bar for each word.
 */
const SAMPLE_COLUMNS = [132, 52, 52, 68, 88, 72];
const SAMPLE_ROWS: Array<[string, string?, string?]> = [
  ["League budget"],
  [""],
  ["Line"],
  ["Court rental", "1,240", "1,240"],
  ["Referees", "860", "910"],
  ["Shirts", "430", "455"],
  ["Trophies", "210", "210"],
  ["Streaming", "1,050", "980"],
  ["Subtotal", undefined, "3,795"],
  ["Food", "320", "345"],
  ["Prizes", "500", "500"],
  ["Travel", "275", "290"],
  ["Misc", undefined, "120"],
];
const SAMPLE_TABS = ["Budget", "Spring", "Notes"];
const LETTERS = "ABCDEF";
/** Where each column ends, from the grid's left edge: the row numbers' 40px, then each column's width. */
const COLUMN_EDGES = SAMPLE_COLUMNS.map((_, c) => 40 + SAMPLE_COLUMNS.slice(0, c + 1).reduce((sum, w) => sum + w, 0) - 1);

/** The format row's place while it comes: work-kit's 36px row (format/FormatRow.tsx), its frame drawn and its controls in bones. */
export function FormatRowBone() {
  return (
    <div data-format-row-bone aria-hidden className="flex h-9 flex-none items-center border-b border-border bg-background px-3">
      <Bones label="" inline>
        <span className="text-xs">Calibri, 11 pt, General</span>
      </Bones>
    </div>
  );
}

/**
 * A sheet's own shape while it comes: the format row where it will have one (`row`), the formula bar (its bones, or what
 * the caller puts there: `formula`), the lettered grid and the sheet tabs. The frame is drawn as it is (the hairlines,
 * the letters and the row numbers are the grid's own) and the words are bones from the sample. The app's sheet
 * (`SheetSkeleton`) and the guest's page draw it, so neither jumps from a list of bars to a grid. Small and leaf-only,
 * so the guest's page takes it without the sheet's body.
 */
export function SheetBones({ row = false, formula = null }: { row?: boolean; formula?: ReactNode } = {}) {
  return (
    <div data-sheet-bones aria-busy="true" aria-label="Loading" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {row ? <FormatRowBone /> : null}
      <div className="flex h-8 flex-none items-center gap-2 border-b border-border pr-3 pl-2">
        <span className="h-6 w-18 flex-none rounded-md border border-input" />
        {formula ?? (
          <Bones label="" inline>
            <span className="text-xs">=SUM(C4:C8)</span>
          </Bones>
        )}
      </div>
      <Bones label="" fill className="overflow-hidden">
        <div className="relative flex flex-col">
          {/* The column hairlines, drawn once over the whole grid as they are: a cell with words is walked, and its own
              edge would go with it. */}
          {COLUMN_EDGES.map((left, c) => (
            <span key={c} skullet-own="" aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left }} />
          ))}
          <div className="flex h-6 border-b border-border bg-sidebar" skullet-own="">
            <span className="w-10 flex-none border-r border-border" />
            {SAMPLE_COLUMNS.map((w, c) => (
              <span key={c} className="flex flex-none items-center justify-center border-r border-border text-xs text-muted-foreground" style={{ width: w }}>
                {LETTERS[c]}
              </span>
            ))}
          </div>
          {SAMPLE_ROWS.map(([words, was, now], r) => (
            <div key={r} className="flex h-7 border-b border-border">
              <span skullet-own="" className="flex w-10 flex-none items-center justify-center border-r border-border bg-sidebar text-xs text-muted-foreground">
                {r + 1}
              </span>
              {SAMPLE_COLUMNS.map((w, c) => {
                const value = c === 0 ? words : c === 3 ? was : c === 4 ? now : undefined;
                // A cell's words are a bar; the cell itself is room, its edge one of the hairlines above.
                return (
                  <span key={c} className={c === 0 ? "flex flex-none items-center overflow-hidden px-2 text-xs whitespace-nowrap" : "flex flex-none items-center justify-end px-2 text-xs whitespace-nowrap tabular-nums"} style={{ width: w }}>
                    {value || null}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </Bones>
      <div className="flex h-7 flex-none items-center gap-4 border-t border-border bg-sidebar px-4">
        <Bones label="" inline>
          <span className="inline-flex gap-4 text-xs">
            {SAMPLE_TABS.map((tab) => (
              <span key={tab}>{tab}</span>
            ))}
          </span>
        </Bones>
      </div>
    </div>
  );
}
