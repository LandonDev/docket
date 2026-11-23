import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { SheetChart, SheetView } from "@shared/contract-work-sheets";
import { patternProblem, reviewMarks, RulesSheet, SheetToolbar, useGridState, type GridSelection, type RuleKind, type RulesView, type SheetControl, type SheetHandle, type SheetMark } from "work-kit/sheet";
import { ChartBar, MoreHorizontal, Trash2 } from "../../chrome/icons";
import { loadToast } from "../../components/ui/toaster";
import { RowsMenu } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { confirmAction, DialogFooter } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Tip } from "../../components/tip";
import { Input } from "../../components/ui/input";
import { IS_MAC } from "../../lib/platform";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import { Export, Share } from "../icons";
import type { CanvasBodyProps, CanvasShell, MoreEntry, ReviewAdapter } from "../canvas/kind";
import { univerGrid, type SheetGrid } from "./grid";
import { linkSheetHost, type ReviewWhich, type SheetHost } from "./host";
import { ImportLine } from "./ImportLine";
import { importRows, runImport } from "./imported";
import { chartBars, chartFrom, chartTicks, saidLine, savedLine, sheetChanges, tickText, type ChartBar as Bars } from "./model";
import { SheetSync, syncOf, useSheetSync } from "./sync";
import { guestSource } from "../guests/api";
import { useWorkCommands } from "../formats/command";
import { Preview } from "../formats/PreviewFrame";
import { sheetPreviewSource } from "./preview";
import { ExcelWaits } from "./excelWaits";
import { useSaveToGoogle } from "./toGoogle";
import { ShareButton } from "../guests/Share";

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
  // Each try at the grid's own code: Retry after a failed load fetches it again.
  const [tries, setTries] = useState(0);
  const [handle, setHandle] = useState<SheetHandle | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => sync.start(), [sync]);
  useEffect(() => {
    let live = true;
    setPrepared(null);
    grid.prepare().then(
      () => live && setPrepared(true),
      (error: unknown) => live && setPrepared(error instanceof Error && error.message ? error.message : "The grid did not load"),
    );
    return () => {
      live = false;
    };
  }, [grid, tries]);
  useEffect(() => (handle ? sync.attach(grid.link(handle)) : undefined), [sync, grid, handle]);
  // The book's fonts are read before the grid draws it: `faces` is the book they were read for.
  const [faces, setFaces] = useState<number | null>(null);
  useEffect(() => {
    if (!book) return;
    let live = true;
    void grid.fonts(book.workbook).then(() => live && setFaces(book.key));
    return () => {
      live = false;
    };
  }, [grid, book]);

  const changes = useMemo(() => sheetChanges(view?.suggestions ?? [], book?.workbook.sheetOrder, view?.changes), [view?.suggestions, view?.changes, book]);
  const current = Math.max(0, Math.min(state.current, changes.changes.length - 1));
  const change = changes.changes[current];
  const marks = useMemo((): SheetMark[] => {
    const cells = reviewMarks(changes.runs, change?.kind === "cells" ? changes.runs.indexOf(change.run) : -1);
    // A format or a rule waiting marks the cells it is about, as a cell's change marks its own.
    const said = changes.changes.flatMap((c): SheetMark[] => (c.kind === "said" && c.said.range ? [{ id: `said-${c.said.id}`, range: { sheet: c.said.sheet, ...c.said.range }, kind: c === change ? "current" : "pending" }] : []));
    return [...cells, ...said];
  }, [changes, change]);
  const locked = !!view && (view.readOnly !== undefined || !!view.missing);
  // A sheet that opens with changes waiting opens on the one the stepper is on, so the formula bar says what it replaces.
  const opening = useRef<SheetHandle | null>(null);
  useEffect(() => {
    const at = whereOf(change);
    if (!handle || opening.current === handle || !at) return;
    opening.current = handle;
    handle.reveal(at);
  }, [handle, change]);
  const act = useCallback((work: Promise<SheetView>, fallback: string): Promise<void> => work.then((next) => sync.view(next), (error: unknown) => sayError(error, fallback)), [sync]);

  const failed = state.failed ?? (typeof prepared === "string" ? prepared : null);
  // Opened once the grid has drawn the book: until then History stays out of the bar and no Accept or Reject is offered for
  // cells he cannot see; a sheet that did not open stays unopened. Before paint, as the document says it.
  const ready = !failed && !!view && !!book && prepared === true && !!handle;
  useLayoutEffect(() => {
    shell.ready?.(ready);
  }, [shell, ready]);
  useFeeds(shell, sync, failed ? null : view, state.sendError, changes, current, handle, locked, act, ready);
  useSavedLine(shell, sync, failed ? null : view, state.sendError, state.saving, state.savedAt);
  // Preview is a state of the item: the frame over the grid, which stays mounted under it, out of reach, its place kept.
  // Each ask is counted: Print… pressed while Preview shows another format opens it on Print anew.
  const [previewing, setPreviewing] = useState<false | "last" | "print">(false);
  const [asked, setAsked] = useState(0);
  const showPreview = useCallback((on: "last" | "print") => {
    setPreviewing(on);
    setAsked((n) => n + 1);
  }, []);
  // Save to Google Sheets: offered on the host's word, once the workbook has opened; a file that reads only here, or moved, is not sent.
  const google = useSaveToGoogle({ env: props.env, itemId: item.id, offered: ready && !locked && view?.canUpload === true });
  useSelectionFeed(props, sync, grid, handle, selection, locked, pointer, frame, act, showPreview, google.row);
  // File → Export… and ⇧⌘E open Preview on the format he last used; File → Print… and ⌘P on Print. Answered once the grid is
  // up, when the root they are offered for is there.
  useWorkCommands(frame, ready ? { export: () => showPreview("last"), print: () => showPreview("print") } : {});
  // What Preview draws: one source for as long as the item shows the same workbook.
  const previewStore = view?.store;
  const previewName = view?.name;
  const source = useMemo(() => (previewStore && previewName !== undefined ? sheetPreviewSource({ env: props.env, itemId: item.id, store: previewStore, name: previewName }) : null), [props.env, item.id, previewStore, previewName]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useWidth(box);
  const frameRef = useCallback((node: HTMLDivElement | null) => {
    frame.current = node;
    setBox(node);
  }, []);

  // A change this sheet's store cannot keep was taken back as he made it: said once, in a few words.
  const stopped = state.stopped;
  useEffect(() => {
    if (stopped) void loadToast().then((toast) => toast.message(stopped.why));
  }, [stopped]);

  // The format row: only the controls whose changes this sheet's store keeps, as its host says (`view.row`); none on a sheet he cannot edit.
  const controls = view && !locked ? (view.row ?? []) : [];
  const [customFormat, setCustomFormat] = useState<string | null>(null);
  // The rules' side sheet, opened from the row's Data menu: the lists this store keeps, in the sheet's order.
  const kinds = useMemo(() => RULE_KINDS.filter((kind) => controls.includes(kind)), [controls.join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rules, setRules] = useState<RulesView | null>(null);
  // The Page breaks view: each page's edge and number over the cells he keeps editing (the row's Page menu flips it).
  const [pageView, setPageView] = useState(false);
  // Shut while the sheet takes no edit (read-only, or reading the file again after a stop), and it stays shut after: a rule made then would be in neither the grid nor the file.
  const still = locked || state.reloading;
  useEffect(() => {
    if (still) setRules(null);
  }, [still]);
  const siding = handle && rules && kinds.length > 0 && !still ? rules : null;
  // Beside the grid; under it where the canvas is too narrow to give up 320px.
  const stacked = width > 0 && width < SIDE_STACKS_UNDER;

  // The cell in hand, when a suggestion is laid in it: what the value replaces. Read on every render, which each laying causes.
  // While the stepper is on a format or a rule, which sits in no cell, the bar says that change in words.
  const was = (selection ? sync.was(selection.sheet, selection.row, selection.column) : undefined) ?? (change?.kind === "said" ? saidLine(change.said) : undefined);

  // A sheet that did not open says so once, in the body: the bar keeps no line about it.
  // Retry tries again what failed: the grid's own code (fetched afresh), the host's open, or both.
  const retry = (): void => {
    if (typeof prepared === "string") setTries((n) => n + 1);
    if (state.failed) void sync.open();
  };
  if (failed) return <EmptyState title="Couldn't open this sheet" line={failed} action={{ label: "Retry", onClick: retry }} />;
  if (!view || !book || prepared !== true || faces !== book.key) return <SheetSkeleton />;
  const Canvas = grid.Canvas;
  return (
    <div
      ref={frameRef}
      data-sheet-item={item.id}
      // The editor's keys are the grid's while the caret is in it (work-editors.md "Who hears a key"). A sheet he can only read, and
      // one whose store keeps no formatting (no row), keep ⌘B the app's: a key never makes what the row there does not offer.
      data-editor-keys={locked || controls.length === 0 ? "read" : "sheet"}
      className="relative flex min-h-0 flex-1 flex-col"
      onPointerUp={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <div className={previewing ? "invisible contents" : "contents"} inert={previewing ? true : undefined}>
      {handle && controls.length > 0 ? (
        <SheetToolbar
          sheet={handle}
          // (the host lists them by the kit's own ids; one this build of the kit does not know draws nothing)
          controls={controls satisfies readonly SheetControl[]}
          boundary={box}
          mac={IS_MAC}
          editorKeys
          tip={rowTip}
          loadFont={grid.font}
          onCustomFormat={(current) => setCustomFormat(current)}
          confirmMerge={confirmMerge}
          // The Data menu's rules open the side sheet on their lists; a second press of the one open closes it.
          onRules={() => setRules((open) => (open ? null : { view: "lists" }))}
          pageBreaks={pageView}
          onPageBreaks={setPageView}
        />
      ) : null}
      {/* A sheet that is the Excel copy of an .xls, .ods or .tsv says so in one quiet line, with its one press. */}
      {view.imported ? <ImportLine imported={view.imported} shared={view.shared} run={(act) => runImport((a) => sync.host.imported(a), view.imported!, act)} /> : null}
      {handle && customFormat !== null ? <CustomFormat current={customFormat} onClose={() => setCustomFormat(null)} onApply={(pattern) => handle.format({ pattern })} /> : null}
      {google.dialog}
      <div className={stacked ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1"}>
        <Canvas
          key={book.key}
          snapshot={book.workbook as never}
          worker={grid.worker}
          // Locked too while the book is read again after a stop: an edit made then would be in neither the grid nor the file.
          readOnly={locked || state.reloading}
          styleKeys={controls.length > 0}
          // The filter's header buttons and menu only where the host keeps a filter (a workbook Excel or Google holds keeps none).
          filter={controls.includes("filter")}
          // The sort dialog, the filter's menu, a list's drop-down and a validation's refusal are work-kit's own, not Univer's.
          dataChrome
          // A sheet's page set-up is kept by the grid only where the host keeps it (read once, as the grid is made).
          pages={controls.includes("page")}
          pageBreaks={pageView && controls.includes("pageBreaks")}
          marks={marks}
          was={was}
          onReady={setHandle}
          onSelection={setSelection}
          labels={LABELS}
          className="min-h-0 min-w-0 flex-1"
        />
        {siding ? (
          <div data-sheet-rules="" className={stacked ? "h-[344px] shrink-0" : "w-80 shrink-0"}>
            <RulesSheet sheet={handle} open={siding} onOpen={setRules} onClose={() => setRules(null)} kinds={kinds} stacked={stacked} className="size-full" />
          </div>
        ) : null}
      </div>
      {handle ? <Charts charts={view.charts} grid={grid} handle={handle} tick={state.tick} locked={locked} width={chartWidth(width)} remove={(chart) => act(sync.host.chart(chart, true), "Couldn't remove the chart")} /> : null}
      </div>
      {previewing && source ? (
        <div data-sheet-preview="" className="absolute inset-0 z-10">
          {/* Print… asked for while it is up on another format moves it to Print: a new frame on that format. */}
          <Preview key={asked} source={source} title={item.title} kind="sheet" {...(previewing === "print" ? { initial: "print" } : {})} readOnly={locked} onClose={() => setPreviewing(false)} />
        </div>
      ) : null}
    </div>
  );
}

const LABELS = { failed: "Couldn't draw this sheet." };
/** The side sheet's lists, in its order: each shown where the host lists its control. */
const RULE_KINDS: readonly RuleKind[] = ["conditional", "validation", "names"];
/** Under this much canvas the side sheet stacks under the grid (the prototype's 560px). */
const SIDE_STACKS_UNDER = 560;

/** Where a change is on the grid, for the stepper to show it: a run's cells, a format's or a rule's range; null for one with no cell (a name, a change whose cells are gone). */
function whereOf(change: ReturnType<typeof sheetChanges>["changes"][number] | undefined): { sheet: string; startRow: number; endRow: number; startColumn: number; endColumn: number } | null {
  if (change?.kind === "cells") return { sheet: change.run.sheet, ...change.run.range };
  if (change?.kind === "said" && change.said.range) return { sheet: change.said.sheet, ...change.said.range };
  return null;
}

/** Asked before a merge empties cells: the app's own question. Undo brings them back, but the loss is said first. */
const confirmMerge = (): Promise<boolean> => confirmAction({ title: "Merge these cells?", body: "Only the top-left value is kept.", action: "Merge" });

/** The row's tips are the app's own: the control's name, and its key as a cap. */
const rowTip = (label: string, child: React.ReactElement, hint?: string) => (
  <Tip label={label} side="bottom" {...(hint ? { shortcut: hint } : {})}>
    {child}
  </Tip>
);

/** A number format of his own: one field holding Excel's pattern, as Excel's own Custom takes it. */
function CustomFormat({ current, onClose, onApply }: { current: string; onClose(): void; onApply(pattern: string): void }) {
  return (
    <Modal onClose={onClose} title="Custom number format">
      <CustomFormatBody current={current} onClose={onClose} onApply={onApply} />
    </Modal>
  );
}

function CustomFormatBody({ current, onClose, onApply }: { current: string; onClose(): void; onApply(pattern: string): void }) {
  const close = useModalClose();
  const [pattern, setPattern] = useState(current);
  // A code Excel would refuse is never laid on a cell: the file would open with a repair prompt.
  const problem = pattern.trim() ? patternProblem(pattern.trim()) : null;
  const apply = (): void => {
    if (problem) return;
    const done = () => onApply(pattern.trim());
    if (close) close(done);
    else {
      done();
      onClose();
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <ModalBody>
        <Field label="Format" {...(problem ? { error: problem } : {})}>
          <Input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder='#,##0.00 "kg"' spellCheck={false} autoComplete="off" className="font-mono" />
        </Field>
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Apply" disabled={!!problem} onConfirm={apply} />
    </form>
  );
}

/**
 * What saved means for this sheet now, for the line under a file's name (docs/agents/work-files.md "The seam with the
 * editor builds"). There is no save press: an edit is sent as he makes it, and the line says where that stands. A
 * refusal an opened Excel file gave is a file the grid no longer matches, so its press is Reload; elsewhere the edits
 * wait and the press sends them again.
 */
function useSavedLine(shell: CanvasShell, sync: SheetSync, view: SheetView | null, sendError: string | null, saving: boolean, savedAt: number | null): void {
  const line = view ? savedLine(view, sendError, saving, savedAt) : null;
  const key = line ? JSON.stringify(line) : "";
  useEffect(() => {
    if (!shell.saved || !line) return;
    const { again, ...rest } = line;
    shell.saved({ ...rest, ...(again ? { actions: [{ id: "again", label: again, run: () => sync.retry() }] } : {}) });
    return () => shell.saved?.(null);
    // `key` is the line by value: a view pushed again with the same facts says nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, sync, key]);
}

/** What the body tells the pane: the mode, the one state line, the line after a direct write, the stepper, More's Chart. */
function useFeeds(
  shell: CanvasShell,
  sync: SheetSync,
  view: SheetView | null,
  sendError: string | null,
  changes: ReturnType<typeof sheetChanges>,
  current: number,
  handle: SheetHandle | null,
  locked: boolean,
  act: (work: Promise<SheetView>, fallback: string) => Promise<void>,
  /** the grid has drawn the book, so the cells a change touches are on screen */
  ready: boolean,
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
  const saveError = view ? (sendError ?? view.saveError) : undefined;
  const store = view?.store;
  useEffect(() => {
    if (missing) shell.statusLine({ tone: "needs", word: `${name} moved`, detail: "Read only" });
    else if (readOnly !== undefined) shell.statusLine({ tone: "needs", word: "Read only", detail: readOnly });
    else if (saveError) shell.statusLine({ tone: "failed", word: "Couldn't save", detail: saveError, action: { label: store === "package" ? "Reload" : "Retry", run: () => sync.retry() } });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
  }, [shell, sync, name, missing, readOnly, saveError, store]);

  const written = view?.written;
  const count = changes.changes.length;
  useEffect(() => {
    if (!written || count > 0) return shell.written(null);
    // Only an opened Excel file takes a write back here; a LifeOS sheet or a .tcsheet does it with the sheet's own Undo or History.
    const undo = store === "package" && written.undo !== false ? () => act(host.undo(written.id), "Couldn't undo") : undefined;
    shell.written({ text: `${written.text}, ${dayTime(written.at)}`, ...(undo ? { undo } : {}) });
    return () => shell.written(null);
  }, [shell, host, written, count, store, act]);

  useEffect(() => {
    const list = changes.changes;
    if (!ready || list.length === 0) return shell.review(null);
    const step = (to: number): void => {
      const next = list[to];
      if (!next) return;
      sync.step(to);
      const at = whereOf(next);
      if (at) handle?.reveal(at);
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
  }, [shell, sync, host, ready, changes, current, handle, act]);
}

/** A selection of more than one cell: Ask over it with the range named, and More's Chart while it spans two columns. */
function useSelectionFeed(
  { item, source, shell }: Props,
  sync: SheetSync,
  grid: SheetGrid,
  handle: SheetHandle | null,
  selection: GridSelection | null,
  locked: boolean,
  pointer: { current: { x: number; y: number } | null },
  frame: { current: HTMLDivElement | null },
  act: (work: Promise<SheetView>, fallback: string) => Promise<void>,
  showPreview: (on: "last") => void,
  googleRow: MoreEntry | null,
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
    shell.selection({ chip: { kind: "selection", label: `${picked.reference}, ${item.title}`, ref: source, quote }, rect });
    return () => shell.selection(null);
  }, [shell, handle, grid, key, many, item.title, source, pointer, frame]);

  const wide = !!range && range.endColumn > range.startColumn && !locked && !!handle;
  const store = sync.state.view?.store;
  const imported = sync.state.view?.imported;
  // Share in More only while the bar's Share has given way, so it is never offered twice.
  const way = shareWayOf(sync);
  const shareGone = useSyncExternalStore(way.subscribe, way.gone, way.gone) && !!guestSource(source);
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
      // Every way out is in Preview: each format drawn as it will be, with what it drops. A sheet read from a .csv still
      // saves back over it.
      ...(store ? [{ id: "preview", label: "Preview…", icon: Export, run: () => showPreview("last") }] : []),
      ...(store === "csv" ? [{ id: "save-csv", label: "Save as CSV", icon: Export, run: () => saveAs(sync.host, "csv", activeName()) }] : []),
      ...(googleRow ? [googleRow] : []),
      // The copy of an .xls, .ods or .tsv: saved back as the format it was, or out as Excel.
      ...importRows(imported, (act) => (imported ? runImport((a) => sync.host.imported(a), imported, act) : Promise.resolve())),
      ...(shareGone ? [{ id: "share", label: "Share", icon: Share, run: () => way.ask() }] : []),
    ]);
    return () => shell.more?.(null);
  }, [shell, sync, wide, handle, grid, act, store, imported, activeName, shareGone, way, showPreview, googleRow]);
}

const letters = (column: number): string => {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const cellRef = (row: number, column: number): string => `${letters(column)}${row + 1}`;

// ── charts ───────────────────────────────────────────────────────────

const CHART_WIDTH = 380;
const CHART_MIN = 200;
/** The grid's row numbers and a margin: what a chart leaves of the body's width. */
const CHART_ROOM = 64;

/** A chart's width in a body this wide: 380px, less where the body is narrower, never under 200. Width 0 is a body not yet measured. */
export function chartWidth(body: number): number {
  return body > 0 ? Math.max(CHART_MIN, Math.min(CHART_WIDTH, body - CHART_ROOM)) : CHART_WIDTH;
}

/** An element's width, kept as it resizes. */
function useWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}
/** The chart's height for its bars: its padding, the title row, 22px a bar, the axis. */
const chartHeight = (bars: number): number => 12 + 20 + 8 + Math.max(1, bars) * 22 + 8 + 16 + 12 + 2;

function Charts({ charts, grid, handle, tick, locked, width, remove }: { charts: SheetChart[]; grid: SheetGrid; handle: SheetHandle; tick: number; locked: boolean; width: number; remove(chart: SheetChart): Promise<void> }) {
  const { active } = useGridState(handle.store);
  return (
    <>
      {charts
        .filter((chart) => chart.sheet === active)
        .map((chart) => (
          <PlacedChart key={chart.id} chart={chart} grid={grid} handle={handle} tick={tick} locked={locked} width={width} remove={remove} />
        ))}
    </>
  );
}

function PlacedChart({ chart, grid, handle, tick, locked, width, remove }: { chart: SheetChart; grid: SheetGrid; handle: SheetHandle; tick: number; locked: boolean; width: number; remove(chart: SheetChart): Promise<void> }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The values as the cells hold them now, suggestions laid in: a chart over a change shows what it would leave.
  const bars = useMemo(() => chartBars(grid.values(handle, chart.sheet, chart.range)), [grid, handle, chart.sheet, chart.range, tick]);
  const height = chartHeight(bars.length);
  useEffect(() => grid.place(handle, chart, { width, height }, setSlot), [grid, handle, chart, width, height]);
  if (!slot) return null;
  return createPortal(<ChartObject chart={chart} bars={bars} locked={locked} width={width} remove={() => void remove(chart)} />, slot);
}

/** One of our charts: plain bars on the neutral, named by the range's first column, one series, no legend. */
export function ChartObject({ chart, bars, locked, width = CHART_WIDTH, remove }: { chart: SheetChart; bars: Bars[]; locked: boolean; width?: number; remove(): void }) {
  // A signed scale: a credit runs left of the zero line by its size, never drawn as a zero.
  const { top, bottom, ticks } = chartTicks(bars.reduce((m, b) => Math.max(m, b.value), 0), bars.reduce((m, b) => Math.min(m, b.value), 0));
  const at = (n: number): number => Math.max(0, Math.min(100, ((n - bottom) / (top - bottom)) * 100));
  const pct = (n: number): string => `${at(n).toFixed(1)}%`;
  return (
    <div data-sheet-chart={chart.id} className="flex max-w-full flex-col gap-2 rounded-lg border border-border bg-background p-3" style={{ width }}>
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
        <div className="relative">
          {/* Zero is the bars' start; with a credit among them it sits inside the plot as a hairline the bars leave from. */}
          {bottom < 0 ? (
            <i aria-hidden data-sheet-zero className="pointer-events-none absolute inset-y-0 w-0 border-s border-border" style={{ left: `calc(84px + (100% - 84px) * ${(at(0) / 100).toFixed(4)})` }} />
          ) : null}
          {bars.map((bar, i) => (
            <div key={i} className="flex h-[22px] items-center gap-2 text-xs text-muted-foreground">
              <span className="w-[76px] flex-none truncate">{bar.label}</span>
              <span className="relative h-1.5 min-w-0 flex-1">
                <span
                  data-sheet-bar
                  data-sign={bar.value < 0 ? "negative" : undefined}
                  className="absolute inset-y-0 rounded-[2px] bg-(--chart-neutral)"
                  style={{ left: pct(Math.min(0, bar.value)), width: `${(at(Math.max(0, bar.value)) - at(Math.min(0, bar.value))).toFixed(1)}%` }}
                />
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

/**
 * Per sheet: whether the bar's Share has given way (the narrow bar hides it whole), and More's ask to open it then.
 * The bar says the first; More reads it and offers Share only then, and its ask opens the same popover from the bar.
 */
class ShareWay {
  private hidden = false;
  private asks = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  gone = (): boolean => this.hidden;
  asked = (): number => this.asks;
  set(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.listeners.forEach((listener) => listener());
  }
  ask(): void {
    this.asks += 1;
    this.listeners.forEach((listener) => listener());
  }
}
const shareWays = new WeakMap<SheetSync, ShareWay>();
function shareWayOf(sync: SheetSync): ShareWay {
  let way = shareWays.get(sync);
  if (!way) shareWays.set(sync, (way = new ShareWay()));
  return way;
}

/** While the sheet loads the bar holds one bone where the mode will be; after, the pane's own parts fill it, and Share on a LifeOS sheet (milestone 31). */
export function Bar(props: Props) {
  const sync = syncFor(props);
  const { view, book, failed } = useSheetSync(sync);
  if (failed) return null;
  // Only a LifeOS sheet shares; Share is whole or gone, hidden in the narrow bar before it could be cut. An opened
  // Excel file says what waits in Excel, in words that give way before any control does.
  if (view && book) return guestSource(props.source) ? <BarShare {...props} way={shareWayOf(sync)} /> : <ExcelWaits reach={view.reach} store={view.store} />;
  return <Skeleton className="h-3 w-30" />;
}

/**
 * Share in the bar, and its way back once the narrow bar hides it: the bar tells More it has gone, and More's Share
 * opens the same popover from an unseen trigger at the bar's end, where the bar's Share stood.
 */
function BarShare(props: Props & { way: ShareWay }) {
  const { way } = props;
  const whole = useRef<HTMLSpanElement>(null);
  const unseen = useRef<HTMLSpanElement>(null);
  const asked = useSyncExternalStore(way.subscribe, way.asked, way.asked);
  useLayoutEffect(() => {
    const el = whole.current;
    if (!el) return;
    const check = (): void => way.set(getComputedStyle(el).display === "none");
    check();
    if (typeof ResizeObserver === "undefined") return () => way.set(false);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      ro.disconnect();
      way.set(false);
    };
  }, [way]);
  // Each ask mounts the unseen trigger afresh and presses it, so the popover opens anchored at the bar's end.
  useEffect(() => {
    if (asked > 0) unseen.current?.querySelector("button")?.click();
  }, [asked]);
  const share = <ShareButton env={props.env} source={props.source} title={props.item.title} />;
  return (
    <>
      <span ref={whole} data-narrow-hide className="flex shrink-0 @max-[560px]/bar:hidden">
        {share}
      </span>
      {asked > 0 ? (
        <span key={asked} ref={unseen} data-share-anchor className="invisible ms-auto flex w-0 shrink-0 overflow-hidden">
          {share}
        </span>
      ) : null}
    </>
  );
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
  const app = reach.to === "excel" ? "Excel" : reach.to === "google" ? "Google" : "Full editor";
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
      <TabsList aria-label="Open in" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
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
    const { path, left } = await host.exportAs(format, sheet);
    const toast = await loadToast();
    const name = path.split(/[\\/]/).pop();
    // What the file could not hold is said with the save, not after it.
    if (left?.length) toast.message(`Saved ${name} without ${left.join(" and ")}`);
    else toast.success(`Saved ${name}`);
  } catch (error) {
    sayError(error, "Couldn't save the sheet");
  }
}
