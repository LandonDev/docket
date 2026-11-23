import type { SheetCellJson, SheetChange as ProposedChange, SheetSuggestion, SheetView } from "@shared/contract-work-sheets";
import type { Principal } from "@shared/work";
import { changeRuns, type ChangeRun, type SuggestionCell } from "work-kit/sheet/suggest";

/**
 * What the sheet canvas works out from a view, with no grid and no host:
 * the changes the stepper walks, a cell in words, a chart's bars.
 */

/** One change the stepper walks: a run of neighbouring cells, a change set whose cells are gone, or a format or a rule said in words. */
export type SheetChange =
  | { kind: "cells"; run: ChangeRun; changeSet: string; ids: string[] }
  | { kind: "orphaned"; changeSet: string; ids: string[] }
  | { kind: "said"; said: ProposedChange; changeSet: string; ids: string[] };

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
export function sheetChanges(suggestions: readonly SheetSuggestion[], sheetOrder: readonly string[] = [], proposed: readonly ProposedChange[] = []): SheetChanges {
  const runs = changeRuns(suggestions.map(toCell), sheetOrder);
  const changes: SheetChange[] = runs.map((run) => ({ kind: "cells", run, changeSet: run.changeSet, ids: run.cells.map((c) => c.id) }));
  const orphaned = new Map<string, string[]>();
  for (const s of suggestions) if (s.state === "orphaned") orphaned.set(s.changeSet, [...(orphaned.get(s.changeSet) ?? []), s.id]);
  for (const [changeSet, ids] of orphaned) changes.push({ kind: "orphaned", changeSet, ids });
  // A format or a rule changes no cell's value, so it has no cell to sit in: it is stepped after the cells, in the order it was made.
  for (const said of proposed) changes.push({ kind: "said", said, changeSet: said.changeSet, ids: [said.id] });

  const groups: SheetChanges["groups"] = [];
  for (const change of changes) {
    let group = groups.find((g) => g.id === change.changeSet);
    if (!group) {
      const first = suggestions.find((s) => s.changeSet === change.changeSet);
      // A format or a rule is its own group, named by what it does.
      group = change.kind === "said" ? { id: change.changeSet, label: change.said.words, by: change.said.by, count: 0 } : { id: change.changeSet, label: first?.reason ?? "Suggested changes", by: first?.by ?? "owner", count: 0 };
      groups.push(group);
    }
    group.count++;
  }
  return { changes, runs, groups };
}

/** What the formula bar says while the stepper is on a format or a rule: its words, the agent's reason, and why it can only be dropped when it can. */
export function saidLine(said: ProposedChange): string {
  const why = said.reason ? ` (${said.reason})` : "";
  return said.state === "orphaned" ? `${said.words}${why}. Rows or columns changed since: reject it` : `Suggested: ${said.words}${why}`;
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
