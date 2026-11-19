import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { SheetCellJson, SheetChart, SheetMutationJson, SheetSuggestion, SheetView } from "@shared/contract-work-sheets";
import type { GridSelection, GridState, SheetCanvasProps, SheetHandle } from "work-kit/sheet";
import type { SheetGrid } from "./grid";
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
  /** Set: open never answers (the loading state). */
  hold: boolean;
};

export function fakeSheetHost(initial: SheetView, workbook: Workbook): FakeSheetHost {
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
      host.rev++;
      host.ops.push({ rev: host.rev, by: "owner", mutations });
      return { rev: host.rev };
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
      return { path: `/host/files/${host.view.name.replace(/\.[^.]+$/, "")}.${format}` };
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
  /** formula text the grid holds, by `sheet!row:col`, for a fill's cells */
  formulas: Map<string, string>;
  /** The person selects a range, A1. */
  select(a1: string): void;
  /** Whether something listens for the person's edits: the body has attached. */
  listening(): boolean;
}

interface Live {
  cells: Cells;
  setSelection(selection: GridSelection | null): void;
  redraw(): void;
  slots: Map<string, { chart: SheetChart; onSlot: (slot: HTMLElement | null) => void }>;
  sheet: string;
}

export function fakeGrid(options: { selection?: string; rows?: number; columns?: number } = {}): FakeGrid {
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
    return { sheet, range: range as GridSelection["range"], row: range.startRow, column: range.startColumn, reference, text: cell?.f ?? shown(cell), bold: false, italic: false, underline: false, align: null, pattern: "" };
  };

  function FakeCanvas({ snapshot, marks, was, onReady, onSelection }: SheetCanvasProps) {
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
        undo: () => undefined,
        redo: () => undefined,
        format: () => undefined,
        reveal: (range: { sheet: string; startRow: number; endRow: number; startColumn: number; endColumn: number }) => setSelection(selectionOf(range.sheet, `${ref(range.startRow, range.startColumn)}:${ref(range.endRow, range.endColumn)}`, cells)),
        snapshot: () => book,
        apply: (mutations: SheetMutationJson[]) => {
          grid.applied.push(mutations);
          for (const m of mutations) write(cells, m);
          redraw();
        },
        onMutation: (listener: (m: SheetMutationJson) => void) => (listeners.add(listener), () => listeners.delete(listener)),
        focus: () => undefined,
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
    formulas: new Map(),
    Canvas: FakeCanvas,
    prepare: async () => undefined,
    link: () => ({
      unitId: "book",
      apply: (mutations) => grid.handle?.apply(mutations),
      onMutation: (listener) => grid.handle!.onMutation(listener),
      read: (sheet, row, col) => live?.cells.get(at(sheet, row, col)) ?? null,
      formula: (sheet, row, col) => grid.formulas.get(at(sheet, row, col)) ?? null,
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
    decode: async (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
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
