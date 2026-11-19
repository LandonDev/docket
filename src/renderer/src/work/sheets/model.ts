import type { SheetCellJson, SheetChart, SheetSuggestion } from "@shared/contract-work-sheets";
import type { Principal } from "@shared/work";
import { changeRuns, type ChangeRun, type SuggestionCell } from "work-kit/sheet/suggest";

/**
 * What the sheet canvas works out from a view, with no grid and no host:
 * the changes the stepper walks, a cell in words, a chart's bars.
 */

/** One change the stepper walks: a run of neighbouring cells, or a change set whose cells are gone. */
export type SheetChange =
  | { kind: "cells"; run: ChangeRun; changeSet: string; ids: string[] }
  | { kind: "orphaned"; changeSet: string; ids: string[] };

export interface SheetChanges {
  changes: SheetChange[];
  /** the runs alone, for the marks */
  runs: ChangeRun[];
  groups: Array<{ id: string; label: string; by: Principal; count: number }>;
}

const toCell = (s: SheetSuggestion): SuggestionCell => ({
  id: s.id,
  changeSet: s.changeSet,
  sheet: s.sheet,
  row: s.row,
  column: s.col,
  base: s.base as SuggestionCell["base"],
  proposed: s.proposed as SuggestionCell["proposed"],
  state: s.state,
});

/**
 * The changes in sheet order: each run of pending cells and each conflict
 * as the grid shows it, then one change for each change set whose row,
 * column or sheet was deleted, which has no cell to show.
 */
export function sheetChanges(suggestions: readonly SheetSuggestion[], sheetOrder: readonly string[] = []): SheetChanges {
  const runs = changeRuns(suggestions.map(toCell), sheetOrder);
  const changes: SheetChange[] = runs.map((run) => ({ kind: "cells", run, changeSet: run.changeSet, ids: run.cells.map((c) => c.id) }));
  const orphaned = new Map<string, string[]>();
  for (const s of suggestions) if (s.state === "orphaned") orphaned.set(s.changeSet, [...(orphaned.get(s.changeSet) ?? []), s.id]);
  for (const [changeSet, ids] of orphaned) changes.push({ kind: "orphaned", changeSet, ids });

  const groups: SheetChanges["groups"] = [];
  for (const change of changes) {
    let group = groups.find((g) => g.id === change.changeSet);
    if (!group) {
      const first = suggestions.find((s) => s.changeSet === change.changeSet);
      group = { id: change.changeSet, label: first?.reason ?? "Suggested changes", by: first?.by ?? "owner", count: 0 };
      groups.push(group);
    }
    group.count++;
  }
  return { changes, runs, groups };
}

/** A cell as the formula bar would show it: its formula, else its value; "empty" for nothing. */
export function cellText(cell: SheetCellJson | null | undefined): string {
  if (!cell) return "empty";
  if (cell.f) return cell.f;
  if (cell.v === null || cell.v === undefined || cell.v === "") return "empty";
  return String(cell.v);
}

/** Whether a cell still holds what an overlay put there: its formula, else its value. */
export function holds(cell: SheetCellJson | null, put: SheetCellJson | null): boolean {
  if (!put || (put.v == null && !put.f)) return !cell || (cell.v == null && !cell.f);
  if (!cell) return false;
  if (put.f) return cell.f === put.f;
  return String(cell.v ?? "") === String(put.v ?? "");
}

export interface ChartBar {
  label: string;
  value: number;
}

/** A chart's bars from its range: the first column names them, the next holds their values; a row without a number is left out (a header). */
export function chartBars(values: ReadonlyArray<ReadonlyArray<unknown>>): ChartBar[] {
  const bars: ChartBar[] = [];
  for (const row of values) {
    const value = typeof row[1] === "number" ? row[1] : typeof row[1] === "string" && row[1].trim() !== "" ? Number(row[1]) : NaN;
    if (Number.isFinite(value)) bars.push({ label: String(row[0] ?? ""), value });
  }
  return bars;
}

/** Round steps for the axis under the bars: 0 and up to three more, past the largest bar. */
export function chartTicks(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

/** "$2k", "40", "1.5M": a tick's words. */
export function tickText(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(+n.toFixed(2));
}

/** A new chart from a selection of two columns or more: bars named by its first column and sized by its second, set to the right of it. */
export function chartFrom(
  selection: { sheet: string; reference: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } },
  values: ReadonlyArray<ReadonlyArray<unknown>>,
  id: string,
): SheetChart {
  const head = values[0]?.[1];
  const title = typeof head === "string" && head.trim() ? head.trim() : "Chart";
  return { id, sheet: selection.sheet, range: selection.reference, title, row: selection.range.startRow, col: selection.range.endColumn + 2 };
}
