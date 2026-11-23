import type { SheetCellJson, SheetChart, SheetSuggestion, SheetView } from "@shared/contract-work-sheets";
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

/**
 * Round steps for the axis under the bars, signed: zero is always on it, and a step of 1, 2 or 5 times a power of ten
 * (about three of them across the whole span) runs out past the largest bar and, when a bar is below zero (a credit),
 * past the smallest. The ticks run from the left end to the right.
 */
export function chartTicks(max: number, min = 0): { top: number; bottom: number; ticks: number[] } {
  const hi = Math.max(max, 0);
  const lo = Math.min(min, 0);
  if (!(hi > 0) && !(lo < 0)) return { top: 1, bottom: 0, ticks: [0] };
  const rough = (hi - lo) / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const top = Math.ceil(hi / step - 1e-9) * step || 0;
  const bottom = lo < 0 ? -Math.ceil(-lo / step - 1e-9) * step : 0;
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round((top - bottom) / step); i++) ticks.push(Number((bottom + i * step).toPrecision(12)) || 0);
  return { top, bottom, ticks };
}

/** "$2k", "40", "1.5M", "\u22122k": a tick's words, a credit with its minus sign. */
export function tickText(n: number): string {
  if (n < 0) return `\u2212${tickText(-n)}`;
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

/** What saved means for a sheet now, as plain facts: the state, when, why, and the word of the one press it offers. */
export interface SavedFacts {
  state: "saved" | "saving" | "offline" | "conflict" | "readonly";
  at?: number;
  detail?: string;
  /** the press that makes it right: Reload (the grid no longer matches the file) or Retry (the edits wait and go again) */
  again?: "Reload" | "Retry";
}

/**
 * The line under a file's name for a sheet. A file he cannot change says why; a save that failed says so, with its
 * press (an opened Excel file refuses for good, so its grid is loaded again; elsewhere the edits wait and are sent
 * again); edits on their way are "saving"; else everything is in the file, since his last edit when he has made one.
 */
export function savedLine(view: Pick<SheetView, "name" | "store" | "missing" | "readOnly" | "saveError">, sendError: string | null, saving: boolean, savedAt: number | null): SavedFacts {
  if (view.missing) return { state: "readonly", detail: `${view.name} moved` };
  if (view.readOnly !== undefined) return { state: "readonly", detail: view.readOnly };
  const failed = sendError ?? view.saveError;
  if (failed) return view.store === "package" ? { state: "conflict", detail: failed, again: "Reload" } : { state: "offline", detail: failed, again: "Retry" };
  if (saving) return { state: "saving" };
  return savedAt ? { state: "saved", at: savedAt } : { state: "saved" };
}
