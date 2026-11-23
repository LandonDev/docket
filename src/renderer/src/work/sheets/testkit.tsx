import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { SheetCellJson, SheetChart, SheetMutationJson, SheetSuggestion, SheetView } from "@shared/contract-work-sheets";
import { TEMPCODE_THEME } from "work-kit/format/theme";
import type { GridSelection, GridState, ObjectAdd, ObjectChange, ObjectAnchor, ObjectsState, SheetCanvasProps, SheetFormat, SheetHandle, SheetObject, SheetObjects, SheetObjectsAccess } from "work-kit/sheet";
import { readFormat, styleOf } from "work-kit/sheet/format";
import type { SheetGrid } from "./grid";
import type { ObjectIds } from "@shared/work/sheets";
import type { ReviewWhich, SheetHost, SheetOp, SheetPushed } from "./host";
import type { Workbook } from "./sync";

/**
 * A sheet without Univer, for the DOM tests and the preview: a host that
 * keeps one item's view and op log the way the host would, and a grid that
 * draws the workbook as a table in the grid's measures (28px rows, 24px
 * letters on `sidebar`, numbers right and tabular) and keeps what is laid
 * into it. The real grid paints on a canvas jsdom does not have.
 */

export function sheetView(over: Partial<SheetView> = {}): SheetView {
  return { itemId: "s1", sessionId: "t1", name: "Nationals travel budget.xlsx", store: "package", rev: 3, shared: false, mode: "suggests", suggestions: [], charts: [], ...over };
}

export function suggestion(id: string, row: number, col: number, over: Partial<SheetSuggestion> = {}): SheetSuggestion {
  return { id, changeSet: "cs1", by: "agent:local:t1", sheet: "budget", row, col, base: null, proposed: { v: 1 }, state: "pending", ...over };
}

/** One sheet's cells as a workbook: `rows[r][c]` a value, a cell, or nothing. */
export function workbookOf(sheets: Array<{ id: string; name: string; rows: Array<Array<SheetCellJson | string | number | null>>; widths?: number[] }>): Workbook {
  return {
    id: "book",
    sheetOrder: sheets.map((s) => s.id),
    sheets: Object.fromEntries(
      sheets.map((s) => {
        const cellData: Record<number, Record<number, SheetCellJson>> = {};
        s.rows.forEach((row, r) =>
          row.forEach((cell, c) => {
            if (cell === null || cell === undefined || cell === "") return;
            (cellData[r] ??= {})[c] = typeof cell === "object" ? cell : { v: cell };
          }),
        );
        const columnData = Object.fromEntries((s.widths ?? []).map((w, c) => [c, { w }]));
        return [s.id, { id: s.id, name: s.name, cellData, columnData }];
      }),
    ),
  };
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
};

export type FakeSheetHost = SheetHost & {
  calls: Array<[string, unknown]>;
  view: SheetView;
  rev: number;
  ops: SheetOp[];
  /** Another person's op lands: kept in the log and pushed. */
  land(mutations: SheetMutationJson[], by?: string): void;
  push(push: SheetPushed): void;
  /** The next edit is refused as a conflict once, as if an op landed first. */
  conflictNext: boolean;
  /** Set: the switch is refused with it. */
  switchRefusal: string | null;
  /** a switch the host is still answering (the full editor starting) */
  switchWait: Promise<void> | null;
  /** what an export says the file could not hold; a test sets it */
  exportLeft?: string[];
  /** what `imported` answers for a copy of another format: a refusal in the host's words, or what the format left behind */
  importRefusal?: string;
  importDrops?: string[];
  /** Set: open never answers (the loading state). */
  hold: boolean;
  /** Set: the next edit answers these ids (a save that named charts or pictures anew), or is refused in these words. */
  nextEdit: { ids: ObjectIds } | { refuse: string } | null;
};

export function fakeSheetHost(initial: SheetView, workbook: Workbook | { workbook: Workbook; objects: SheetObjects }): FakeSheetHost {
  const listeners = new Set<(push: SheetPushed) => void>();
  const text = JSON.stringify(workbook);
  const pick = (which: ReviewWhich) => (s: SheetSuggestion) => which === "all" || ("ids" in which ? which.ids.includes(s.id) : s.changeSet === which.changeSet);
  const host: FakeSheetHost = {
    calls: [],
    view: initial,
    rev: initial.rev,
    ops: [],
    conflictNext: false,
    switchRefusal: null,
    switchWait: null,
    hold: false,
    nextEdit: null,
    land(mutations, by = "person:dana") {
      host.rev++;
      host.ops.push({ rev: host.rev, by, mutations });
      host.push({ rev: host.rev });
    },
    push(push) {
      for (const listener of listeners) listener(push);
    },
    async open() {
      host.calls.push(["open", null]);
      if (host.hold) return new Promise<SheetView>(() => undefined);
      return { ...host.view, rev: host.rev };
    },
    async load(rev, offset, length) {
      host.calls.push(["load", { rev, offset, length }]);
      return { data: toBase64(text.slice(offset, offset + length)), size: text.length, rev, format: "snapshot" as const };
    },
    async since(rev) {
      host.calls.push(["since", rev]);
      return { rev: host.rev, ops: host.ops.filter((op) => op.rev > rev) };
    },
    async edit(baseRev, mutations) {
      host.calls.push(["edit", { baseRev, mutations }]);
      if (host.conflictNext || baseRev < host.rev) {
        if (host.conflictNext) {
          host.conflictNext = false;
          host.rev++;
          host.ops.push({ rev: host.rev, by: "person:dana", mutations: [{ id: "sheet.mutation.set-range-values", params: { subUnitId: "budget", cellValue: { 0: { 5: { v: "Dana" } } } } }] });
        }
        return { conflict: true, rev: host.rev };
      }
      const next = host.nextEdit;
      host.nextEdit = null;
      if (next && "refuse" in next) throw new Error(next.refuse);
      host.rev++;
      host.ops.push({ rev: host.rev, by: "owner", mutations });
      return next ? { rev: host.rev, ids: next.ids } : { rev: host.rev };
    },
    async review(which, verdict) {
      host.calls.push(["review", { which, verdict }]);
      host.view = { ...host.view, suggestions: host.view.suggestions.filter((s) => !pick(which)(s)) };
      return host.view;
    },
    async mode(mode) {
      host.calls.push(["mode", mode]);
      host.view = { ...host.view, mode };
      return host.view;
    },
    async undo(writeId) {
      host.calls.push(["undo", writeId]);
      host.view = { ...host.view, written: undefined };
      return host.view;
    },
    async chart(chart, remove = false) {
      host.calls.push(["chart", { chart, remove }]);
      host.view = { ...host.view, charts: remove ? host.view.charts.filter((c) => c.id !== chart.id) : [...host.view.charts.filter((c) => c.id !== chart.id), chart] };
      return host.view;
    },
    async exportAs(format: "xlsx" | "csv", sheet?: string) {
      host.calls.push(["export", { format, sheet }]);
      return { path: `/host/files/${host.view.name.replace(/\.[^.]+$/, "")}.${format}`, ...(host.exportLeft ? { left: host.exportLeft } : {}) };
    },
    async imported(act) {
      host.calls.push(["imported", { act }]);
      if (host.importRefusal) throw new Error(host.importRefusal);
      return act === "again" ? {} : { path: `/host/files/${act === "back" ? host.view.name : host.view.name.replace(/\.[^.]+$/, ".xlsx")}`, ...(host.importDrops ? { drops: host.importDrops } : {}) };
    },
    async switchApp() {
      host.calls.push(["switch", null]);
      if (host.switchWait) await host.switchWait;
      if (host.switchRefusal) throw new Error(host.switchRefusal);
    },
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}

// ── the stand-in grid ────────────────────────────────────────────────

type Cells = Map<string, SheetCellJson>;
const at = (sheet: string, row: number, col: number): string => `${sheet}!${row}:${col}`;
const letters = (column: number): string => {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const ref = (row: number, col: number): string => `${letters(col)}${row + 1}`;
function parseA1(a1: string): { startRow: number; endRow: number; startColumn: number; endColumn: number } {
  const one = (part: string): [number, number] => {
    const m = /^([A-Z]+)(\d+)$/.exec(part.replace(/\$/g, "").split("!").pop()!.toUpperCase());
    if (!m) return [0, 0];
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return [Number(m[2]) - 1, col - 1];
  };
  const [a, b = a] = a1.split(":");
  const [r0, c0] = one(a);
  const [r1, c1] = one(b);
  return { startRow: Math.min(r0, r1), endRow: Math.max(r0, r1), startColumn: Math.min(c0, c1), endColumn: Math.max(c0, c1) };
}

/** A number as the fixture's style names it: `usd` "$1,240", `pct` "8%", else as it is. */
function shown(cell: SheetCellJson | undefined): string {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  if (typeof cell.v === "number" && cell.s === "usd") return `${cell.v < 0 ? "-$" : "$"}${Math.abs(Math.round(cell.v)).toLocaleString("en-US")}`;
  if (typeof cell.v === "number" && cell.s === "pct") return `${Math.round(cell.v * 100)}%`;
  return String(cell.v);
}

export interface FakeGrid extends SheetGrid {
  /** Set while a grid is up. */
  handle: SheetHandle | null;
  /** The person edits: the mutation is reported, and laid into the cells. */
  edit(mutation: SheetMutationJson): void;
  /** What came in through `apply`, call by call. */
  applied: SheetMutationJson[][];
  /** every change the format row asked of the grid */
  formats: SheetFormat[];
  /** The person runs a command in the grid (a grid made with `commands: true` says each one, as Univer's does). */
  command(id: string): void;
  /** styles the grid knows by its own ids, for a cell that names one */
  styles: Map<string, Record<string, unknown>>;
  /** each workbook whose fonts the body asked for before it drew */
  fontsAsked: unknown[];
  /** how many times the body took the grid's last change back (a change its store cannot keep) */
  undone: number;
  /** how many cells a merge of the selection would empty; a test sets it */
  drops: number;
  /** whether the canvas was last told to take no edit (`readOnly`) */
  readOnly: boolean;
  /** whether it was ever told so */
  lockedOnce: boolean;
  /** whether the canvas was told the grid's own style keys act (`styleKeys`) */
  styleKeys: boolean | undefined;
  /** whether the canvas was told to offer the filter's buttons and menu (`filter`) */
  filter: boolean | undefined;
  /** whether the canvas was told to draw work-kit's own Data chrome (`dataChrome`) */
  dataChrome: boolean | undefined;
  /** what the canvas was last told a note's pop-over offers (`noteControls`) */
  noteControls: SheetCanvasProps["noteControls"];
  /** formula text the grid holds, by `sheet!row:col`, for a fill's cells */
  formulas: Map<string, string>;
  /** The person selects a range, A1. */
  select(a1: string): void;
  /** Whether something listens for the person's edits: the body has attached. */
  listening(): boolean;
  /** The sheet's rules as the grid holds them (`handle.rules` reads and writes these); each change is reported as the grid's own mutation. */
  rules: FakeRules;
  /** What the canvas was given for its charts and pictures at its last mount: `objects` (undefined: none drawn), `media`, `onObjects`. */
  /** Set: called as ops from elsewhere are laid on the grid (the kit follows rows with its objects then). */
  onApply: ((mutations: SheetMutationJson[]) => void) | null;
  objectsGiven: { objects: SheetObjects | undefined; media: ((part: string) => Promise<Blob | string>) | undefined; onObjects: ((change: ObjectChange) => void) | undefined } | null;
}

/** A grid's rules kept in memory: lists by sheet id, the names, a filter by sheet id. */
export interface FakeRules {
  conditional: Record<string, { cfId: string }[]>;
  validation: Record<string, { uid: string }[]>;
  names: { id: string; name: string }[];
  filter: Record<string, { ref: unknown } | undefined>;
}

interface Live {
  cells: Cells;
  setSelection(selection: GridSelection | null): void;
  redraw(): void;
  slots: Map<string, { chart: SheetChart; onSlot: (slot: HTMLElement | null) => void }>;
  sheet: string;
}

/**
 * `handle.rules` over a kept store: each change edits the lists and is reported as the mutation the real grid's
 * plugin would emit, so a body under test sees what Univer would tell it.
 */
function rulesOver(held: FakeRules, active: () => string, emit: (id: string, params: Record<string, unknown>) => void) {
  const listeners = new Set<(kind: string) => void>();
  const told = (kind: string): void => {
    for (const listener of listeners) listener(kind);
  };
  let n = 0;
  return {
    conditional: {
      list: (sheet = active()) => held.conditional[sheet] ?? [],
      add(rule: { cfId?: string }, sheet = active()) {
        const made = { ...rule, cfId: rule.cfId ?? `cf${++n}` };
        held.conditional[sheet] = [made, ...(held.conditional[sheet] ?? [])];
        emit("sheet.mutation.add-conditional-rule", { subUnitId: sheet, rule: made });
        told("conditional");
        return made.cfId;
      },
      set(id: string, rule: { cfId: string }, sheet = active()) {
        held.conditional[sheet] = (held.conditional[sheet] ?? []).map((r) => (r.cfId === id ? rule : r));
        emit("sheet.mutation.set-conditional-rule", { subUnitId: sheet, cfId: id, rule });
        told("conditional");
        return true;
      },
      remove(id: string, sheet = active()) {
        held.conditional[sheet] = (held.conditional[sheet] ?? []).filter((r) => r.cfId !== id);
        emit("sheet.mutation.delete-conditional-rule", { subUnitId: sheet, cfId: id });
        told("conditional");
        return true;
      },
      move: () => false,
    },
    validation: {
      list: (sheet = active()) => held.validation[sheet] ?? [],
      add(rule: { uid?: string }, sheet = active()) {
        const made = { ...rule, uid: rule.uid ?? `dv${++n}` };
        held.validation[sheet] = [...(held.validation[sheet] ?? []), made];
        emit("data-validation.mutation.addRule", { subUnitId: sheet, rule: made });
        told("validation");
        return made.uid;
      },
      set: () => false,
      remove(id: string, sheet = active()) {
        held.validation[sheet] = (held.validation[sheet] ?? []).filter((r) => r.uid !== id);
        emit("data-validation.mutation.removeRule", { subUnitId: sheet, ruleId: id });
        told("validation");
        return true;
      },
    },
    names: {
      list: () => held.names,
      add(name: { id?: string; name: string }) {
        const made = { ...name, id: name.id ?? `n${++n}` };
        held.names.push(made);
        emit("formula.mutation.set-defined-name", made);
        told("names");
        return made.id;
      },
      set: () => false,
      remove(id: string) {
        const gone = held.names.find((x) => x.id === id);
        held.names = held.names.filter((x) => x.id !== id);
        if (gone) emit("formula.mutation.remove-defined-name", gone);
        told("names");
        return !!gone;
      },
      problem: () => null,
    },
    filter: {
      get: (sheet = active()) => held.filter[sheet] ?? null,
      set(range?: unknown, sheet = active()) {
        if (range === null) {
          delete held.filter[sheet];
          emit("sheet.mutation.remove-filter", { subUnitId: sheet });
          emit("sheet.mutation.mark-dirty-filter-change", { subUnitId: sheet });
        } else {
          held.filter[sheet] = { ref: range ?? { startRow: 0, endRow: 4, startColumn: 0, endColumn: 4 } };
          emit("sheet.mutation.set-filter-range", { subUnitId: sheet, range: held.filter[sheet]!.ref });
        }
        told("filter");
        return true;
      },
      criteria: () => false,
      values: () => [],
    },
    sort: () => false,
    onChange: (listener: (kind: string) => void) => (listeners.add(listener), () => listeners.delete(listener)),
  };
}

export function fakeGrid(options: { selection?: string; rows?: number; columns?: number; commands?: boolean } = {}): FakeGrid {
  const commandListeners = new Set<(id: string) => void>();
  let live: Live | null = null;
  const listeners = new Set<(m: SheetMutationJson) => void>();
  const write = (cells: Cells, mutation: SheetMutationJson): void => {
    if (mutation.id !== "sheet.mutation.set-range-values") return;
    const { subUnitId, cellValue } = mutation.params as { subUnitId: string; cellValue: Record<string, Record<string, SheetCellJson | null>> };
    for (const [r, cols] of Object.entries(cellValue))
      for (const [c, value] of Object.entries(cols)) {
        const key = at(subUnitId, Number(r), Number(c));
        if (value === null) {
          cells.delete(key);
          continue;
        }
        const next: Record<string, unknown> = { ...cells.get(key) };
        for (const [k, v] of Object.entries(value)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        if (Object.keys(next).length === 0) cells.delete(key);
        else cells.set(key, next as SheetCellJson);
      }
  };
  const selectionOf = (sheet: string, a1: string, cells: Cells): GridSelection => {
    const range = parseA1(a1);
    const cell = cells.get(at(sheet, range.startRow, range.startColumn));
    const reference = range.startRow === range.endRow && range.startColumn === range.endColumn ? ref(range.startRow, range.startColumn) : `${ref(range.startRow, range.startColumn)}:${ref(range.endRow, range.endColumn)}`;
    // The cell's own style as the format row reads it (work-kit's `readFormat`).
    const style = (typeof cell?.s === "object" && cell.s ? cell.s : undefined) as Parameters<typeof readFormat>[0];
    return {
      sheet,
      range: range as GridSelection["range"],
      row: range.startRow,
      column: range.startColumn,
      reference,
      text: cell?.f ?? shown(cell),
      bold: false,
      italic: false,
      underline: false,
      align: null,
      pattern: "",
      format: readFormat(style, TEMPCODE_THEME),
      merged: false,
    };
  };

  function FakeCanvas({ snapshot, marks, was, styleKeys, filter, dataChrome, noteControls, readOnly, objects, media, onObjects, onReady, onSelection }: SheetCanvasProps) {
    grid.noteControls = noteControls;
    grid.objectsGiven = { objects, media, onObjects };
    grid.styleKeys = styleKeys;
    grid.filter = filter;
    grid.dataChrome = dataChrome;
    grid.readOnly = !!readOnly;
    if (readOnly) grid.lockedOnce = true;
    const book = snapshot as unknown as Workbook & { sheets: Record<string, { name: string; cellData?: Record<string, Record<string, SheetCellJson>>; columnData?: Record<string, { w?: number }> }> };
    const sheetId = book.sheetOrder?.[0] ?? "sheet";
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    const cells = useMemo(() => {
      const map: Cells = new Map();
      for (const [id, sheet] of Object.entries(book.sheets ?? {})) for (const [r, cols] of Object.entries(sheet.cellData ?? {})) for (const [c, cell] of Object.entries(cols)) map.set(at(id, Number(r), Number(c)), cell);
      return map;
    }, [book]);
    const [selection, setSelection] = useState<GridSelection | null>(() => (options.selection ? selectionOf(sheetId, options.selection, cells) : null));
    const [slots] = useState(() => new Map<string, { chart: SheetChart; onSlot: (slot: HTMLElement | null) => void }>());

    // A store hands back one object until something changes, as useSyncExternalStore needs.
    const [store] = useState(() => {
      const listeners = new Set<() => void>();
      let state: GridState = { sheets: (book.sheetOrder ?? []).map((id) => ({ id, name: book.sheets[id]?.name ?? id })), active: sheetId, selection, editing: null };
      return {
        get: () => state,
        subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
        refresh: () => undefined,
        dispose: () => undefined,
        select(next: GridSelection | null) {
          state = { ...state, selection: next };
          for (const listener of listeners) listener();
        },
      };
    });
    useEffect(() => store.select(selection), [store, selection]);

    useEffect(() => {
      live = { cells, setSelection, redraw, slots, sheet: sheetId };
      const handle = {
        api: null,
        store,
        readOnly: false,
    lockedOnce: false,
        theme: TEMPCODE_THEME,
        defaults: { family: "Calibri", size: 11 },
        undo: () => undefined,
        redo: () => undefined,
        // A press from the format row: kept for a test to read, and laid on the cells as the grid's own style mutation would be.
        mergeDrops: () => grid.drops,
        within: () => false,
        rowKeys: () => undefined,
        format: (change: SheetFormat) => {
          grid.formats.push(change);
          const picked = store.get().selection;
          const s = styleOf(change, TEMPCODE_THEME, "");
          if (!picked || !s) return true;
          const cellValue: Record<string, Record<string, SheetCellJson>> = {};
          for (let r = picked.range.startRow; r <= picked.range.endRow; r++) for (let c = picked.range.startColumn; c <= picked.range.endColumn; c++) (cellValue[r] ??= {})[c] = { s: { ...((cells.get(at(picked.sheet, r, c))?.s as object) ?? {}), ...s } };
          const mutation = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: picked.sheet, cellValue } };
          write(cells, mutation);
          for (const listener of listeners) listener(mutation);
          setSelection(selectionOf(picked.sheet, picked.reference, cells));
          redraw();
          return true;
        },
        size: () => undefined,
        rules: rulesOver(grid.rules, () => store.get().selection?.sheet ?? sheetId, (id, params) => {
          const mutation = { id, params: { unitId: "book", ...params } };
          for (const listener of listeners) listener(mutation);
        }),
        reveal: (range: { sheet: string; startRow: number; endRow: number; startColumn: number; endColumn: number }) => setSelection(selectionOf(range.sheet, `${ref(range.startRow, range.startColumn)}:${ref(range.endRow, range.endColumn)}`, cells)),
        snapshot: () => book,
        apply: (mutations: SheetMutationJson[]) => {
          grid.applied.push(mutations);
          grid.onApply?.(mutations);
          for (const m of mutations) write(cells, m);
          redraw();
        },
        onMutation: (listener: (m: SheetMutationJson) => void) => (listeners.add(listener), () => listeners.delete(listener)),
        focus: () => undefined,
        objects: fakeObjects(objects, (change) => grid.objectsGiven?.onObjects?.(change)),
      } as unknown as SheetHandle;
      grid.handle = handle;
      onReady?.(handle);
      return () => {
        grid.handle = null;
        live = null;
        onReady?.(null);
      };
      // The grid is made once per mount, as the real one is.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => onSelection?.(selection), [selection, onSelection]);

    const sheet = book.sheets[sheetId];
    const widths = Array.from({ length: options.columns ?? 8 }, (_, c) => sheet?.columnData?.[c]?.w ?? 72);
    const rows = options.rows ?? 22;
    const mine = (marks ?? []).filter((m) => m.range.sheet === sheetId);
    const markAt = (r: number, c: number) => mine.find((m) => r >= m.range.startRow && r <= m.range.endRow && c >= m.range.startColumn && c <= m.range.endColumn);
    const sel = selection?.range;
    const inSel = (r: number, c: number) => !!sel && r >= sel.startRow && r <= sel.endRow && c >= sel.startColumn && c <= sel.endColumn;
    const current = mine.find((m) => m.kind === "current");
    const left = (c: number) => 40 + widths.slice(0, c).reduce((a, b) => a + b, 0);
    const box = (range: { startRow: number; endRow: number; startColumn: number; endColumn: number }) => ({
      top: 24 + range.startRow * 28,
      left: left(range.startColumn),
      width: left(range.endColumn + 1) - left(range.startColumn) + 1,
      height: (range.endRow - range.startRow + 1) * 28 + 1,
    });
    const active = selection ? cells.get(at(sheetId, selection.row, selection.column)) : undefined;
    const many = !!sel && (sel.endRow > sel.startRow || sel.endColumn > sel.startColumn);

    return (
      <div data-slot="sheet-canvas" data-fake-grid className="relative flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
        <div data-slot="sheet-formula-bar" className="flex h-8 min-w-0 flex-none items-center gap-2 border-b border-border pr-3 pl-2">
          <span className="flex h-6 w-18 flex-none items-center overflow-hidden rounded-md border border-input px-2 text-xs whitespace-nowrap tabular-nums">{selection?.reference}</span>
          <span aria-hidden className="w-3.5 flex-none text-center font-serif text-[13px] text-muted-foreground italic">fx</span>
          {was !== undefined ? <span data-sheet-was className="flex-none rounded-sm bg-(--del-bg) px-1 text-[13px] leading-5">{was}</span> : null}
          <span data-sheet-formula className="min-w-0 flex-1 truncate text-[13px] leading-5 tabular-nums">{active?.f ?? (active ? String(active.v ?? "") : "")}</span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <table className="border-separate border-spacing-0 text-[13px] leading-5" style={{ tableLayout: "fixed", width: left(widths.length) }}>
            <colgroup>
              <col style={{ width: 40 }} />
              {widths.map((w, c) => (
                <col key={c} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="h-6 border-r border-b border-border bg-sidebar" />
                {widths.map((_, c) => (
                  <th key={c} className={`h-6 border-r border-b border-border px-1 text-center text-xs font-normal tabular-nums ${sel && c >= sel.startColumn && c <= sel.endColumn ? "bg-muted text-foreground" : "bg-sidebar text-muted-foreground"}`}>
                    {letters(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                <tr key={r}>
                  <th className={`h-7 border-r border-b border-border px-1 text-center text-xs font-normal tabular-nums ${sel && r >= sel.startRow && r <= sel.endRow ? "bg-muted text-foreground" : "bg-sidebar text-muted-foreground"}`}>{r + 1}</th>
                  {widths.map((_, c) => {
                    const cell = cells.get(at(sheetId, r, c));
                    const mark = markAt(r, c);
                    const number = typeof cell?.v === "number";
                    const tint = mark ? "bg-(--add-bg)" : many && inSel(r, c) ? "bg-(--sel-bg)" : "";
                    const weight = cell?.s === "head" || cell?.s === "title" ? "font-medium" : "";
                    const spill = cell?.s === "title" ? "overflow-visible" : "overflow-hidden text-ellipsis";
                    return (
                      <td key={c} data-cell={ref(r, c)} data-mark={mark?.kind} className={`h-7 border-r border-b border-border px-2 whitespace-nowrap ${spill} ${number ? "text-right tabular-nums" : ""} ${tint} ${weight}`}>
                        {shown(cell)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {current ? <span aria-hidden className="pointer-events-none absolute border-2 border-(--accent)" style={box(current.range)} /> : sel && !current ? <span aria-hidden className="pointer-events-none absolute border-2 border-(--accent)" style={box(sel)} /> : null}
          {[...slots.values()].map(({ chart, onSlot }) => (
            <div key={chart.id} ref={onSlot} className="absolute" style={{ top: 24 + chart.row * 28 + 4, left: left(chart.col) }} />
          ))}
        </div>
        <SheetTabsRow names={(book.sheetOrder ?? []).map((id) => book.sheets[id]?.name ?? id)} />
      </div>
    );
  }

  const grid: FakeGrid = {
    handle: null,
    applied: [],
    formats: [],
    command: (id) => {
      for (const listener of commandListeners) listener(id);
    },
    styles: new Map(),
    fontsAsked: [],
    undone: 0,
    drops: 0,
    styleKeys: undefined,
    filter: undefined,
    dataChrome: undefined,
    noteControls: undefined,
    readOnly: false,
    lockedOnce: false,
    rules: { conditional: {}, validation: {}, names: [], filter: {} },
    objectsGiven: null,
    onApply: null,
    formulas: new Map(),
    Canvas: FakeCanvas,
    fonts: async (workbook) => void grid.fontsAsked.push(workbook),
    font: async () => undefined,
    prepare: async () => undefined,
    link: () => ({
      unitId: "book",
      apply: (mutations) => grid.handle?.apply(mutations),
      onMutation: (listener) => grid.handle!.onMutation(listener),
      read: (sheet, row, col) => live?.cells.get(at(sheet, row, col)) ?? null,
      formula: (sheet, row, col) => grid.formulas.get(at(sheet, row, col)) ?? null,
      undo: () => void grid.undone++,
      ...(options.commands ? { onCommand: (listener: (id: string) => void) => (commandListeners.add(listener), () => commandListeners.delete(listener)) } : {}),
      style: (id) => grid.styles.get(id) ?? null,
      // (the fake keeps no tables: a test of a table's save drives the store itself)
      rules: (kind, sheet) => (kind === "names" ? grid.rules.names : kind === "filter" ? (grid.rules.filter[sheet ?? ""] ?? null) : kind === "tables" || kind === "charts" || kind === "pictures" ? [] : kind === "pages" ? null : (grid.rules[kind][sheet ?? ""] ?? [])),
      objects: {
        list: () => grid.handle!.objects.list(),
        sheetId: (name) => grid.handle!.store.get().sheets.find((x) => x.name === name)?.id,
        sheetName: (id) => grid.handle!.store.get().sheets.find((x) => x.id === id)?.name,
        apply: (changes) => grid.handle!.objects.apply(changes),
      },
    }),
    values(_handle, sheet, a1) {
      const r = parseA1(a1);
      const out: unknown[][] = [];
      for (let row = r.startRow; row <= r.endRow; row++) {
        const line: unknown[] = [];
        for (let col = r.startColumn; col <= r.endColumn; col++) line.push(live?.cells.get(at(sheet, row, col))?.v ?? null);
        out.push(line);
      }
      return out;
    },
    place(_handle, chart, _size, onSlot) {
      const target = live;
      target?.slots.set(chart.id, { chart, onSlot });
      target?.redraw();
      return () => {
        target?.slots.delete(chart.id);
        target?.redraw();
        onSlot(null);
      };
    },
    // A fixture's book is its snapshot, or `{ workbook, objects }` for one that has charts and pictures.
    decode: async (bytes) => {
      const got = JSON.parse(new TextDecoder().decode(bytes)) as Workbook & { workbook?: Workbook; objects?: SheetObjects };
      return got.workbook ? { workbook: got.workbook, ...(got.objects ? { objects: got.objects } : {}) } : { workbook: got };
    },
    edit(mutation) {
      if (live) write(live.cells, mutation);
      live?.redraw();
      for (const listener of listeners) listener(mutation);
    },
    select(a1) {
      if (live) live.setSelection(selectionOf(live.sheet, a1, live.cells));
    },
    listening: () => listeners.size > 0,
  };
  return grid;
}

/**
 * The grid's charts and pictures without Univer: the lists, select, add, move, set and remove, each told as the
 * grid tells them (`onObjects`), and `apply` laying changes from elsewhere without telling them back.
 */
function fakeObjects(initial: SheetObjects | undefined, tell: (change: ObjectChange) => void): SheetObjectsAccess {
  let objects: SheetObjects = initial ?? { charts: [], pictures: [], warnings: [] };
  let selected: string | null = null;
  let n = 0;
  const listeners = new Set<() => void>();
  const state = (): ObjectsState => ({ objects, selected, series: 0, edits: true, held: false });
  let shown = state();
  const emit = (): void => {
    shown = state();
    for (const listener of listeners) listener();
  };
  const find = (id: string): SheetObject | null => {
    const chart = objects.charts.find((c) => c.id === id);
    if (chart) return { chart };
    const picture = objects.pictures.find((p) => p.id === id);
    return picture ? { picture } : null;
  };
  // (in place, as the kit keeps the order objects are drawn in; a new one goes last)
  const put = <T extends { id: string }>(list: T[], item: T, gone: boolean): T[] => (gone ? list.filter((x) => x.id !== item.id) : list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);
  const lay = (change: ObjectChange): void => {
    const o = change.object;
    if ("chart" in o) objects = { ...objects, charts: put(objects.charts, o.chart, change.kind === "remove") };
    else objects = { ...objects, pictures: put(objects.pictures, o.picture, change.kind === "remove") };
    if (selected && !find(selected)) selected = null;
  };
  const made = (change: ObjectChange): void => {
    lay(change);
    emit();
    tell(change);
  };
  const moved = (id: string, anchor: ObjectAnchor): boolean => {
    const o = find(id);
    if (!o) return false;
    made({ kind: "set", object: "chart" in o ? { chart: { ...o.chart, anchor } } : { picture: { ...o.picture, anchor } } });
    return true;
  };
  return {
    list: () => objects,
    get: find,
    state: () => shown,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    select: (id) => ((selected = id && find(id) ? id : null), emit(), selected === id),
    selectNext: (step = 1) => {
      const ids = [...objects.charts.map((c) => c.id), ...objects.pictures.map((p) => p.id)];
      if (!ids.length) return null;
      const at = selected ? ids.indexOf(selected) : -1;
      selected = ids[at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length] ?? null;
      emit();
      return selected;
    },
    pickSeries: () => undefined,
    move: (id, anchor) => moved(id, anchor),
    size: (id, anchor) => moved(id, anchor),
    set: (id, change) => {
      const o = find(id);
      if (!o || !("chart" in o)) return false;
      made({ kind: "set", object: { chart: typeof change === "function" ? change(o.chart) : { ...o.chart, ...change } } });
      return true;
    },
    remove: (id) => {
      const o = find(id);
      if (!o) return false;
      made({ kind: "remove", object: o });
      return true;
    },
    add: (what: ObjectAdd) => {
      const anchor = { kind: "oneCell" as const, from: { column: 1, row: 1, columnOffset: 0, rowOffset: 0 }, width: 1905000, height: 952500 };
      const sheet = objects.charts[0]?.sheet ?? objects.pictures[0]?.sheet ?? "Budget";
      if ("picture" in what) {
        const id = `picture-${++n}`;
        made({ kind: "add", object: { picture: { id, sheet, anchor, part: `media:${n}`, contentType: what.picture.type, ...(what.picture.name ? { name: what.picture.name } : {}) } }, media: what.picture });
        selected = id;
        emit();
        return id;
      }
      if (what.chart === "selection") return null;
      made({ kind: "add", object: { chart: what.chart } });
      return what.chart.id;
    },
    refusal: () => null,
    cells: { values: () => [] } as unknown as SheetObjectsAccess["cells"],
    apply: (changes) => {
      for (const change of changes) lay(change);
      emit();
    },
    onChange: () => () => undefined,
    edits: () => undefined,
    hold: () => undefined,
    media: async () => null,
  };
}

function SheetTabsRow({ names }: { names: string[] }): ReactNode {
  return (
    <div className="flex h-7 flex-none items-center gap-0.5 border-t border-border bg-sidebar px-1.5">
      {names.map((name, i) => (
        <span key={name} className={`flex h-5 items-center rounded-md px-2.5 text-xs ${i === 0 ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
          {name}
        </span>
      ))}
    </div>
  );
}
