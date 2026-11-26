import type { CSSProperties } from "react";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { cn } from "@renderer/lib/cn";

/*
 * The Accounts page's bones, in a module of their own that loads nothing
 * but the skeleton: the page's own loading state (AccountsSkeleton) and the
 * window's fallback while the page's chunk loads (SurfaceSkeleton kind
 * "accounts") are one drawing, so the page never changes shape mid-load.
 */

/**
 * The page's container (accounts.tsx): from 48rem wide the rows are a table,
 * every usage column 8.5rem (a bar over "Resets Thu 12:00 PM") with the
 * account's name taking what is left; under it each row stacks its columns
 * under the name across the row's width.
 */
export const CELL = "flex min-w-0 flex-1 basis-0 flex-col gap-1 @3xl/accounts:w-34 @3xl/accounts:flex-none";
/**
 * The cells' box. Stacked under the name, the cells wrap as many to a line as
 * hold a whole column (8.5rem: two in a 400px window), so a label and its
 * reset are never cut to "We…" and "Resets 1…"; the tracks are filled, not
 * fitted, so a row with fewer cells keeps the page's column widths. From
 * 48rem they are the table's fixed columns in one line.
 */
export const CELLS = "grid grid-cols-[repeat(auto-fill,minmax(min(8.5rem,100%),1fr))] gap-3 @3xl/accounts:flex";
/** The status words of a row with no windows, over the window columns it stands in for (`--span`). */
export const SPAN = "min-w-0 flex-[var(--span)_1_0%] @3xl/accounts:flex-none @3xl/accounts:w-[calc(var(--span)*8.5rem+(var(--span)-1)*0.75rem)]";

/**
 * An empty column that keeps a row's cells on the page's columns. Stacked
 * there is no table to line up with, so one that ends a row is hidden
 * (`trailing`): it would start an empty grid line and its gap.
 */
export const spacer = (key: string, trailing = false) => (
  <span key={key} aria-hidden data-slot="usage-cell" className={cn(CELL, trailing ? "@max-3xl/accounts:hidden" : null)} />
);

/** One window's cell while its report loads: the 16px label line, the 4px bar, the 16px reset line. */
export const cellSkeleton = (key: number) => (
  <span key={key} data-slot="usage-cell" className={CELL}>
    <span className="flex h-4 items-center">
      <Skeleton className="h-3 w-full" />
    </span>
    <Skeleton className="h-1 w-full" />
    <span className="flex h-4 items-center">
      <Skeleton className="h-3 w-2/3" />
    </span>
  </span>
);

/**
 * The bars while their report loads, in the shape that lands: each cell its
 * 16px label line, the 4px bar and its 16px reset line, 4px apart, inside the
 * button's 6px above and below (none when `readOnly`: the picker's bars sit in
 * no button), so a row neither shrinks on Refresh nor grows when the report
 * arrives. A key's row lands as one line of words over the window columns
 * (Pay as you go, Key revoked), so its skeleton is that one 16px line.
 */
export function UsageCellsSkeleton({
  cells,
  keyed,
  readOnly = false,
  className,
}: {
  cells: number;
  /** A key's row: one line over `keyed.span` window columns, then Rate's column when the page has one. */
  keyed?: { span: number; rate: boolean };
  readOnly?: boolean;
  className?: string;
}) {
  if (keyed) {
    return (
      <span data-slot="usage-cells" className={cn("flex items-start gap-3", readOnly ? null : "py-1.5", className)} aria-busy="true">
        <span data-slot="usage-words-skeleton" className={cn(SPAN, "flex h-4 items-center")} style={{ "--span": keyed.span } as CSSProperties}>
          <Skeleton className="h-3 w-24 max-w-full" />
        </span>
        {keyed.rate ? spacer("rate", true) : null}
      </span>
    );
  }
  return (
    <span data-slot="usage-cells" className={cn(CELLS, readOnly ? null : "py-1.5", className)} aria-busy="true">
      {Array.from({ length: cells }, (_, i) => cellSkeleton(i))}
    </span>
  );
}

/** The page's shape while the services load: three sections of two rows, the usage columns at their table width. */
export function AccountsSkeleton() {
  return (
    <div className="@container/accounts flex flex-col gap-6">
      {[0, 1, 2].map((section) => (
        <div key={section} aria-busy="true" aria-label="Loading" className="flex flex-col">
          {/* PageSection's 20px heading line, then its 8px to the rows. */}
          <div data-slot="heading-skeleton" className="flex h-5 items-center">
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-2 flex flex-col">
            {[0, 1].map((row) => (
              // An AccountRow's shape: the dot, the 20px name over its 16px line, the bars, the switch and ⋯.
              <div key={row} data-slot="account-row-skeleton" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <Skeleton className="size-2 rounded-full" />
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="flex h-5 items-center">
                    <Skeleton className="h-3.5 w-36" />
                  </span>
                  <span className="flex h-4 items-center">
                    <Skeleton className="h-3 w-24" />
                  </span>
                </div>
                <UsageCellsSkeleton cells={3} className="order-last basis-full ps-5 @3xl/accounts:order-none @3xl/accounts:basis-auto @3xl/accounts:ps-0" />
                <span className="flex items-center gap-2">
                  {/* A Switch's box (components/ui/switch-track.ts). */}
                  <Skeleton data-skeleton-switch className="h-[18px] w-8 rounded-full" />
                  <Skeleton className="size-7 rounded-md" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
