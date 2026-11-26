import type { ReactNode } from "react";
import { Skeleton } from "../../components/ui/skeleton";

/** Column widths of the loading grid, as an opened budget's first columns. */
const BONE_COLUMNS = [132, 52, 52, 68, 88, 72];
/** Each row's bones: the first column's width in percent (0 for an empty row), and whether the figures columns have one. */
const BONE_ROWS: Array<[number, boolean]> = [
  [70, false],
  [0, false],
  [44, false],
  [52, true],
  [60, true],
  [48, true],
  [56, true],
  [66, true],
  [64, false],
  [50, true],
  [58, true],
  [46, true],
  [40, true],
];

/** The format row's place while it comes: work-kit's 36px row (format/FormatRow.tsx) with one bone, as the bar's. */
export function FormatRowBone() {
  return (
    <div data-format-row-bone aria-hidden className="flex h-9 flex-none items-center border-b border-border bg-background px-3">
      <Skeleton className="h-3 w-40" />
    </div>
  );
}

/**
 * A sheet's own shape while it comes: the format row where it will have one (`row`), the formula bar (its bone, or what
 * the caller puts there: `formula`), the lettered grid and the sheet tabs, with bones where the words will be. The app's
 * sheet (`SheetSkeleton`) and the guest's page draw it, so neither jumps from a list of bars to a grid. Small and
 * leaf-only, so the guest's page takes it without the sheet's body.
 */
export function SheetBones({ row = false, formula = null }: { row?: boolean; formula?: ReactNode } = {}) {
  return (
    <div data-sheet-bones aria-busy="true" aria-label="Loading" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {row ? <FormatRowBone /> : null}
      <div className="flex h-8 flex-none items-center gap-2 border-b border-border pr-3 pl-2">
        <span className="h-6 w-18 flex-none rounded-md border border-input" />
        {formula ?? <Skeleton className="h-3 w-24" />}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-6 border-b border-border bg-sidebar">
          <span className="w-10 flex-none border-r border-border" />
          {BONE_COLUMNS.map((w, c) => (
            <span key={c} className="flex-none border-r border-border" style={{ width: w }} />
          ))}
        </div>
        {BONE_ROWS.map(([first, figures], r) => (
          <div key={r} className="flex h-7 border-b border-border">
            <span className="w-10 flex-none border-r border-border bg-sidebar" />
            {BONE_COLUMNS.map((w, c) => (
              <span key={c} className={c === 0 ? "flex flex-none items-center border-r border-border px-2" : "flex flex-none items-center justify-end border-r border-border px-2"} style={{ width: w }}>
                {c === 0 && first ? <Skeleton className="h-3" style={{ width: `${first}%` }} /> : null}
                {c >= 3 && c <= 4 && figures && (c === 4 || r < 8) ? <Skeleton className="h-3" style={{ width: `${50 + ((r * 7) % 30)}%` }} /> : null}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="flex h-7 flex-none items-center gap-4 border-t border-border bg-sidebar px-4">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}
