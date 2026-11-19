import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SheetChart, SheetView } from "@shared/contract-work-sheets";
import { reviewMarks, useGridState, type GridSelection, type SheetHandle } from "work-kit/sheet";
import { ChartBar, MoreHorizontal, Trash2 } from "../../chrome/icons";
import { loadToast } from "../../components/ui/toaster";
import { RowsMenu } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import { Export } from "../icons";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { univerGrid, type SheetGrid } from "./grid";
import { linkSheetHost, type ReviewWhich, type SheetHost } from "./host";
import { chartBars, chartFrom, chartTicks, sheetChanges, tickText, type ChartBar as Bars } from "./model";
import { SheetSync, syncOf, useSheetSync } from "./sync";

/**
 * The sheet kind (docs/agents/work-sheets.md; the approved page is
 * .temp-code/prototypes/work-workspaces-2/sheet.html, "In the cells"):
 * work-kit's grid under the pane's bars. Each change an agent suggests sits
 * in its own cell, tinted, holding the value it would leave; the formula
 * bar says what the cell in hand replaces, and the stepper walks the
 * changes, a run of neighbouring cells as one.
 */

export type SheetState = undefined;

/** A test or a preview hands in its own host and grid; the app uses the link and Univer. */
export interface SheetDeps {
  host?: SheetHost;
  grid?: SheetGrid;
}

type Props = CanvasBodyProps<SheetState> & SheetDeps;

function syncFor({ env, item, host, grid }: Props): SheetSync {
  return syncOf(`${env}\n${item.id}`, () => new SheetSync(host ?? linkSheetHost(env, item.id), (grid ?? univerGrid).decode));
}

const SHARED_NOTE = "Others can edit this, so changes wait for you";
/** The most of a selection Ask quotes into the thread. */
const QUOTE_ROWS = 200;
const QUOTE_COLUMNS = 26;

export function Body(props: Props) {
  const { item, shell } = props;
  const grid = props.grid ?? univerGrid;
  const sync = syncFor(props);
  const state = useSheetSync(sync);
  const { view, book } = state;
  const [prepared, setPrepared] = useState<true | string | null>(null);
  const [handle, setHandle] = useState<SheetHandle | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => sync.start(), [sync]);
  useEffect(() => {
    let live = true;
    grid.prepare().then(
      () => live && setPrepared(true),
      (error: unknown) => live && setPrepared(error instanceof Error && error.message ? error.message : "The grid did not load"),
    );
    return () => {
      live = false;
    };
  }, [grid]);
  useEffect(() => (handle ? sync.attach(grid.link(handle)) : undefined), [sync, grid, handle]);

  const changes = useMemo(() => sheetChanges(view?.suggestions ?? [], book?.workbook.sheetOrder), [view?.suggestions, book]);
  const current = Math.max(0, Math.min(state.current, changes.changes.length - 1));
  const change = changes.changes[current];
  const marks = useMemo(() => reviewMarks(changes.runs, change?.kind === "cells" ? changes.runs.indexOf(change.run) : -1), [changes, change]);
  const locked = !!view && (view.readOnly !== undefined || !!view.missing);
  // A sheet that opens with changes waiting opens on the one the stepper is on, so the formula bar says what it replaces.
  const opening = useRef<SheetHandle | null>(null);
  useEffect(() => {
    if (!handle || opening.current === handle || change?.kind !== "cells") return;
    opening.current = handle;
    handle.reveal({ sheet: change.run.sheet, ...change.run.range });
  }, [handle, change]);
  const act = useCallback((work: Promise<SheetView>, fallback: string): Promise<void> => work.then((next) => sync.view(next), (error: unknown) => sayError(error, fallback)), [sync]);

  useFeeds(shell, sync, view, state.sendError, state.dropped, changes, current, handle, locked, act);
  useSelectionFeed(props, sync, grid, handle, selection, locked, pointer, frame, act);

  // The cell in hand, when a suggestion is laid in it: what the value replaces. Read on every render, which each laying causes.
  const was = selection ? sync.was(selection.sheet, selection.row, selection.column) : undefined;

  const failed = state.failed ?? (typeof prepared === "string" ? prepared : null);
  if (failed) return <EmptyState title="Couldn't open this sheet" line={failed} action={{ label: "Retry", onClick: () => void sync.open() }} />;
  if (!view || !book || prepared !== true) return <SheetSkeleton />;
  const Canvas = grid.Canvas;
  return (
    <div
      ref={frame}
      data-sheet-item={item.id}
      className="relative flex min-h-0 flex-1 flex-col"
      onPointerUp={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <Canvas
        key={book.key}
        snapshot={book.workbook as never}
        worker={grid.worker}
        readOnly={locked}
        marks={marks}
        was={was}
        onReady={setHandle}
        onSelection={setSelection}
        labels={LABELS}
        className="min-h-0 flex-1"
      />
      {handle ? <Charts charts={view.charts} grid={grid} handle={handle} tick={state.tick} locked={locked} remove={(chart) => act(sync.host.chart(chart, true), "Couldn't remove the chart")} /> : null}
    </div>
  );
}

const LABELS = { failed: "Couldn't draw this sheet." };

/** What the body tells the pane: the mode, the one state line, the line after a direct write, the stepper, More's Chart. */
function useFeeds(
  shell: CanvasShell,
  sync: SheetSync,
  view: SheetView | null,
  sendError: string | null,
  dropped: boolean,
  changes: ReturnType<typeof sheetChanges>,
  current: number,
  handle: SheetHandle | null,
  locked: boolean,
  act: (work: Promise<SheetView>, fallback: string) => Promise<void>,
): void {
  const host = sync.host;
  const mode = view?.mode;
  const shared = view?.shared;
  useEffect(() => {
    if (!mode || locked) return shell.mode(null);
    if (shared) shell.mode({ value: "suggests", note: SHARED_NOTE });
    else shell.mode({ value: mode, set: (next) => void act(host.mode(next), "Couldn't change what the agent does") });
    return () => shell.mode(null);
  }, [shell, host, mode, shared, locked, act]);

  const name = view?.name;
  const missing = view?.missing;
  const readOnly = view?.readOnly;
  const saveError = sendError ?? view?.saveError;
  const store = view?.store;
  useEffect(() => {
    if (missing) shell.statusLine({ tone: "needs", word: `${name} moved`, detail: "Read only" });
    else if (readOnly !== undefined) shell.statusLine({ tone: "failed", word: "Read only", detail: readOnly });
    else if (saveError) shell.statusLine({ tone: "failed", word: "Couldn't save", detail: saveError, action: { label: store === "package" ? "Reload" : "Retry", run: () => sync.retry() } });
    else if (dropped) shell.statusLine({ tone: "failed", word: "Not saved", detail: "Formatting and moved cells stay out of an opened Excel file", action: { label: "Reload", run: () => sync.retry() } });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
  }, [shell, sync, name, missing, readOnly, saveError, dropped, store]);

  const written = view?.written;
  const count = changes.changes.length;
  useEffect(() => {
    if (!written || count > 0) return shell.written(null);
    // Only an opened Excel file takes a write back here; a LifeOS sheet or a .tcsheet does it with the sheet's own Undo or History.
    const undo = store === "package" ? () => act(host.undo(written.id), "Couldn't undo") : undefined;
    shell.written({ text: `${written.text}, ${dayTime(written.at)}`, ...(undo ? { undo } : {}) });
    return () => shell.written(null);
  }, [shell, host, written, count, store, act]);

  useEffect(() => {
    const list = changes.changes;
    if (list.length === 0) return shell.review(null);
    const step = (to: number): void => {
      const next = list[to];
      if (!next) return;
      sync.step(to);
      if (next.kind === "cells") handle?.reveal({ sheet: next.run.sheet, ...next.run.range });
    };
    const which = (w: number | { group: string } | "all"): ReviewWhich => (w === "all" ? "all" : typeof w === "number" ? { ids: list[w]?.ids ?? [] } : { changeSet: w.group });
    const review: ReviewAdapter = {
      groups: changes.groups,
      index: current,
      count: list.length,
      step,
      accept: (w) => act(host.review(which(w), "accept"), "Couldn't accept the change"),
      reject: (w) => act(host.review(which(w), "reject"), "Couldn't reject the change"),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, sync, host, changes, current, handle, act]);
}

/** A selection of more than one cell: Ask over it with the range named, and More's Chart while it spans two columns. */
function useSelectionFeed(
  { source, shell }: Props,
  sync: SheetSync,
  grid: SheetGrid,
  handle: SheetHandle | null,
  selection: GridSelection | null,
  locked: boolean,
  pointer: { current: { x: number; y: number } | null },
  frame: { current: HTMLDivElement | null },
  act: (work: Promise<SheetView>, fallback: string) => Promise<void>,
): void {
  const range = selection?.range;
  const many = !!range && (range.endRow > range.startRow || range.endColumn > range.startColumn);
  const key = selection ? `${selection.sheet}!${selection.reference}` : "";
  // The selection's identity is new on every read of the grid; its place is what matters, so `key` stands for it.
  const held = useRef(selection);
  held.current = selection;
  useEffect(() => {
    const picked = held.current;
    if (!picked || !handle || !many) return shell.selection(null);
    const sheetName = handle.store.get().sheets.find((s) => s.id === picked.sheet)?.name ?? "";
    const r = picked.range;
    const clipped = `${cellRef(r.startRow, r.startColumn)}:${cellRef(Math.min(r.endRow, r.startRow + QUOTE_ROWS - 1), Math.min(r.endColumn, r.startColumn + QUOTE_COLUMNS - 1))}`;
    const quote = grid
      .values(handle, picked.sheet, clipped)
      .map((row) => row.map((v) => (v === null || v === undefined ? "" : String(v))).join("\t"))
      .join("\n");
    // Over where the pointer let go; a selection made with the keys floats near the grid's top.
    const at = pointer.current;
    const box = frame.current?.getBoundingClientRect();
    const rect = at ? new DOMRect(at.x, at.y, 0, 0) : new DOMRect(box?.left ?? 0, (box?.top ?? 0) + 40, box?.width ?? 0, 0);
    shell.selection({ chip: { kind: "selection", label: sheetName ? `${picked.reference}, ${sheetName}` : picked.reference, ref: source, quote }, rect });
    return () => shell.selection(null);
  }, [shell, handle, grid, key, many, source, pointer, frame]);

  const wide = !!range && range.endColumn > range.startColumn && !locked && !!handle;
  const store = sync.state.view?.store;
  // The sheet in hand, by its tab name: the one a CSV takes.
  const activeName = useCallback((): string | undefined => {
    if (!handle) return undefined;
    const { sheets, active } = handle.store.get() as { sheets: { id: string; name: string }[]; active?: string };
    return sheets.find((x) => x.id === active)?.name ?? sheets[0]?.name;
  }, [handle]);
  useEffect(() => {
    if (!shell.more) return;
    shell.more([
      {
        id: "chart",
        label: "Chart",
        icon: ChartBar,
        disabled: !wide,
        run: async () => {
          const picked = held.current;
          if (!picked || !handle) return;
          const chart = chartFrom(picked, grid.values(handle, picked.sheet, picked.reference), `chart-${Date.now().toString(36)}`);
          await act(sync.host.chart(chart), "Couldn't make the chart");
        },
      },
      // An opened Excel file is saved as it is edited; anything else is written out on request.
      ...(store && store !== "package"
        ? [{ id: "export-xlsx", label: "Export as Excel", icon: Export, run: () => saveAs(sync.host, "xlsx") }]
        : []),
      ...(store
        ? [{ id: "export-csv", label: store === "csv" ? "Save as CSV" : "Export sheet as CSV", icon: Export, run: () => saveAs(sync.host, "csv", activeName()) }]
        : []),
    ]);
    return () => shell.more?.(null);
  }, [shell, sync, wide, handle, grid, act, store, activeName]);
}

const letters = (column: number): string => {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const cellRef = (row: number, column: number): string => `${letters(column)}${row + 1}`;

// ── charts ───────────────────────────────────────────────────────────

const CHART_WIDTH = 380;
/** The chart's height for its bars: its padding, the title row, 22px a bar, the axis. */
const chartHeight = (bars: number): number => 12 + 20 + 8 + Math.max(1, bars) * 22 + 8 + 16 + 12 + 2;

function Charts({ charts, grid, handle, tick, locked, remove }: { charts: SheetChart[]; grid: SheetGrid; handle: SheetHandle; tick: number; locked: boolean; remove(chart: SheetChart): Promise<void> }) {
  const { active } = useGridState(handle.store);
  return (
    <>
      {charts
        .filter((chart) => chart.sheet === active)
        .map((chart) => (
          <PlacedChart key={chart.id} chart={chart} grid={grid} handle={handle} tick={tick} locked={locked} remove={remove} />
        ))}
    </>
  );
}

function PlacedChart({ chart, grid, handle, tick, locked, remove }: { chart: SheetChart; grid: SheetGrid; handle: SheetHandle; tick: number; locked: boolean; remove(chart: SheetChart): Promise<void> }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The values as the cells hold them now, suggestions laid in: a chart over a change shows what it would leave.
  const bars = useMemo(() => chartBars(grid.values(handle, chart.sheet, chart.range)), [grid, handle, chart.sheet, chart.range, tick]);
  const height = chartHeight(bars.length);
  useEffect(() => grid.place(handle, chart, { width: CHART_WIDTH, height }, setSlot), [grid, handle, chart, height]);
  if (!slot) return null;
  return createPortal(<ChartObject chart={chart} bars={bars} locked={locked} remove={() => void remove(chart)} />, slot);
}

/** One of our charts: plain bars on the neutral, named by the range's first column, one series, no legend. */
export function ChartObject({ chart, bars, locked, remove }: { chart: SheetChart; bars: Bars[]; locked: boolean; remove(): void }) {
  const { top, ticks } = chartTicks(bars.reduce((m, b) => Math.max(m, b.value), 0));
  const pct = (n: number): string => `${Math.max(0, Math.min(100, (n / top) * 100)).toFixed(1)}%`;
  return (
    <div data-sheet-chart={chart.id} className="flex w-[380px] max-w-full flex-col gap-2 rounded-lg border border-border bg-background p-3" style={{ width: CHART_WIDTH }}>
      <div className="flex h-5 min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{chart.title}</span>
        {locked ? null : (
          <RowsMenu
            label="Chart"
            align="end"
            rows={[{ kind: "item", id: "remove", label: "Remove chart", icon: Trash2 }]}
            onPick={(id) => id === "remove" && remove()}
            trigger={
              <Button variant="ghost" size="icon-xs" className="-me-1 size-5" aria-label="Chart actions">
                <MoreHorizontal />
              </Button>
            }
          />
        )}
      </div>
      {bars.length === 0 ? (
        <div className="flex h-[22px] items-center text-xs text-muted-foreground">No numbers in {chart.range}</div>
      ) : (
        <div>
          {bars.map((bar, i) => (
            <div key={i} className="flex h-[22px] items-center gap-2 text-xs text-muted-foreground">
              <span className="w-[76px] flex-none truncate">{bar.label}</span>
              <span className="min-w-0 flex-1">
                <span data-sheet-bar className="block h-1.5 rounded-[2px] bg-(--chart-neutral)" style={{ width: pct(bar.value) }} />
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="relative ms-[84px] h-4 text-xs leading-4 text-muted-foreground tabular-nums">
        {ticks.map((t, i) => (
          <span key={t} className={i === 0 ? "absolute top-0" : "absolute top-0 -translate-x-1/2"} style={{ left: pct(t) }}>
            {tickText(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── loading ──────────────────────────────────────────────────────────

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

/** Loading: the sheet's own shape, the formula bar, the lettered grid and the sheet tabs, with bones where the words will be. */
export function SheetSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-8 flex-none items-center gap-2 border-b border-border pr-3 pl-2">
        <span className="h-6 w-18 flex-none rounded-md border border-input" />
        <Skeleton className="h-3 w-24" />
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

/** While the sheet loads the bar holds one bone where the mode will be; after, the pane's own parts fill it. */
export function Bar(props: Props) {
  const { view, book, failed } = useSheetSync(syncFor(props));
  if (failed || (view && book)) return null;
  return <Skeleton className="h-3 w-30" />;
}

/**
 * The switch to the file's own app, in the tab row beside More: offered
 * while the file holds what our grid cannot reach (a pivot table, macros).
 * Our side stays chosen; the other opens the file there.
 */
export function TabEnd(props: Props) {
  const sync = syncFor(props);
  const reach = useSheetSync(sync).view?.reach;
  // The host may start the full editor before it answers: the pressed side spins until then.
  const [opening, setOpening] = useState(false);
  if (!reach) return null;
  const app = reach.to === "excel" ? "Excel" : "Full editor";
  return (
    <Tabs
      value="tempcode"
      onValueChange={(next) => {
        if (next !== "app" || opening) return;
        setOpening(true);
        sync.host
          .switchApp()
          .catch((error: unknown) => sayError(error, `Couldn't open ${app}`))
          .finally(() => setOpening(false));
      }}
      className="mx-1 shrink-0 gap-0"
    >
      <TabsList aria-label="Open in" className="h-6 p-0.5">
        <TabsIndicator />
        <TabsTrigger value="tempcode" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          TempCode
        </TabsTrigger>
        <TabsTrigger value="app" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          <BusyLabel busy={opening} label={app} />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** Writes the sheet out on the host and says where, by the file's name: the folder is the host's. */
async function saveAs(host: SheetHost, format: "xlsx" | "csv", sheet?: string): Promise<void> {
  try {
    const { path } = await host.exportAs(format, sheet);
    const toast = await loadToast();
    toast.success(`Saved ${path.split(/[\\/]/).pop()}`);
  } catch (error) {
    sayError(error, "Couldn't save the sheet");
  }
}
