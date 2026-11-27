import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { bodyFailureWords } from "../canvas/CanvasPane";
import { OpenFailed, progressWords, useFailedWords } from "../canvas/FetchState";
import type { SheetView } from "@shared/contract-work-sheets";
import type { SheetImportAct, SheetImportDone } from "@shared/work/sheetFormats";
import { IMPORT_REFUSED } from "@shared/work/sheets";
import { patternProblem, reviewMarks, RulesSheet, SheetToolbar, type ChartSpec, type GridSelection, type RuleKind, type RulesView, type SheetControl, type SheetHandle, type SheetMark } from "work-kit/sheet";
import { ChartBar, Eye } from "../../chrome/icons";
import { loadToast } from "../../components/ui/toaster";
import { BusyLabel } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { FormatRowBone, SheetBones } from "./bones";
import { Bones } from "../../components/bones";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { confirmAction, DialogFooter } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Tip } from "../../components/tip";
import { Input } from "../../components/ui/input";
import { chordKey, ctrlOnly } from "../../lib/keys";
import { IS_MAC } from "../../lib/platform";
import { sayError } from "../canvas/frame";
import { Export, Share } from "../icons";
import type { CanvasBodyProps, CanvasShell, MoreEntry, ReviewAdapter } from "../canvas/kind";
import { univerGrid, type SheetGrid } from "./grid";
import { linkSheetHost, type SheetHost } from "./host";
import { ImportLine } from "./ImportLine";
import { importRows, nameOf, runImport, savedTo } from "./imported";
import { MOVED, reviewBatches, saidLine, savedLine, sheetChanges } from "./model";
import { EDIT_WAIT, SheetSync, syncOf, useSheetSync, type SheetSyncState } from "./sync";
import { useSaving } from "../canvas/useCalm";
import { copyText } from "../../lib/clipboard";
import { itemJournal } from "../canvas/drafts";
import { whenWords } from "../files/fileText";
import { shareTargetOf } from "../guests/api";
import { openShare } from "../guests/sharePort";
import { useWorkspaceOf } from "../files/workspaceOf";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkCommands } from "../formats/command";
import { Preview } from "../formats/PreviewFrame";
import { sheetPreviewSource } from "./preview";
import { useSheetPresence } from "./presence";
import { ExcelWaits } from "./excelWaits";
import { reachHere } from "./fullHere";
import { useSaveToGoogle } from "./toGoogle";
import { ShareButton } from "../guests/Share";
import { registerFlush } from "../canvas/flush";
import { KitWaits } from "../kitWaits";

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
  const pictureInput = useRef<HTMLInputElement>(null);

  // His edits the host has not answered are kept on this computer and offered when the file opens again (canvas/drafts.ts).
  useEffect(() => sync.journalTo(itemJournal(props.env, item)), [sync]);
  useEffect(() => sync.start(), [sync]);
  // A tab's close sends what waits and waits for the host's answer before the item goes (canvas/flush.ts); an edit that
  // did not save rejects it, so a switch that would replace the item (`flushedItem`) stops.
  useEffect(() => registerFlush(item.id, () => sync.written()), [item.id, sync]);
  useEffect(() => {
    let live = true;
    setPrepared(null);
    grid.prepare().then(
      () => live && setPrepared(true),
      // The grid's code that did not load is said in his words, never as the loader's line with its asset address.
      (error: unknown) => live && setPrepared(bodyFailureWords(error) || "The grid did not load"),
    );
    return () => {
      live = false;
    };
  }, [grid, tries]);
  useEffect(() => (handle ? sync.attach(grid.link(handle)) : undefined), [sync, grid, handle]);
  // Who else is on the sheet, where the Work service holds it live (a LifeOS sheet, a .tcsheet): their cells on the grid, their faces in the bar.
  const others = useSheetPresence(sync.host, !!handle && (view?.store === "lifeos" || view?.store === "tcsheet"), shell);
  const onSelection = useCallback(
    (next: GridSelection | null) => {
      setSelection(next);
      others.onSelection(next);
    },
    [others.onSelection],
  );
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
  const act = useCallback((work: Promise<SheetView>, fallback: string): Promise<void> => work.then((next) => sync.view(next), (error: unknown) => sayError(error, fallback, props.env)), [sync, props.env]);

  // A workbook the host's importer refused: its cause said in Work's words, naming the computer (workErrorWords), on the
  // read-only line and, where the grid could not read it either, in the body's failure; never the importer's own reason.
  const refused = view?.readOnly?.startsWith(IMPORT_REFUSED) ? view.readOnly : null;
  const refusal = useFailedWords(refused);
  const shown = view && refused ? { ...view, readOnly: refusal || "This workbook could not be read here" } : view;
  const failed = (state.failed && refused) || state.failed || (typeof prepared === "string" ? prepared : null);
  // Opened once the grid has drawn the book: until then History stays out of the bar and no Accept or Reject is offered for
  // cells he cannot see; a sheet that did not open stays unopened. Before paint, as the document says it.
  const ready = !failed && !!view && !!book && prepared === true && !!handle;
  useLayoutEffect(() => {
    shell.ready?.(ready);
  }, [shell, ready]);
  useFeeds(shell, sync, failed ? null : shown, state.sendError, changes, current, handle, locked, act, ready, props.env);
  // Saving… only once a send has been out a while, or his edits waited past the grid's pause (canvas/calm.ts): every cell no longer blinks the line.
  const saving = useSaving({ edited: state.editedAt, pause: EDIT_WAIT, sent: state.sentAt }) && state.saving;
  useSavedLine(shell, sync, failed ? null : shown, state.sendError, saving, state.savedAt, state.offer ?? null, props.env);
  // Preview is a state of the item: the frame over the grid, which stays mounted under it, out of reach, its place kept.
  // Each ask is counted: Print… pressed while Preview shows another format opens it on Print anew.
  const [previewing, setPreviewing] = useState<false | "last" | "print">(false);
  const [asked, setAsked] = useState(0);
  const showPreview = useCallback((on: "last" | "print") => {
    setPreviewing(on);
    setAsked((n) => n + 1);
  }, []);
  // Save to Google Sheets: offered on the host's word, once the workbook has opened; a file that reads only here, or moved, is not sent.
  const written = useCallback(() => sync.written(), [sync]);
  const google = useSaveToGoogle({ env: props.env, itemId: item.id, offered: ready && !locked && view?.canUpload === true, written });
  const showFolder = useShowFolder(props.env, item.workspaceId);
  useSelectionFeed(props, sync, grid, handle, selection, locked, pointer, frame, showPreview, google.row, showFolder);
  // File → Export… and ⇧⌘E open Preview on the format he last used; File → Print… and ⌘P on Print. Answered once the grid is
  // up, when the root they are offered for is there.
  // Edit → Find… and ⌘F: the grid's own find bar (`handle.find`); a grid with none leaves ⌘F the app's.
  const finder = handle?.find?.available ? handle.find : null;
  useWorkCommands(frame, ready ? { export: () => showPreview("last"), print: () => showPreview("print"), ...(shareTargetOf(props.source, "sheet") ? { share: () => openShare(item.id) } : {}), ...(finder ? { find: () => finder.open() } : {}) } : {});
  // What Preview draws: one source for as long as the item shows the same workbook.
  const previewStore = view?.store;
  const previewName = view?.name;
  const source = useMemo(() => (previewStore && previewName !== undefined ? sheetPreviewSource({ env: props.env, itemId: item.id, store: previewStore, name: previewName, written }) : null), [props.env, item.id, previewStore, previewName, written]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useWidth(box);
  const frameRef = useCallback((node: HTMLDivElement | null) => {
    frame.current = node;
    setBox(node);
  }, []);

  // A change this sheet's store cannot keep was taken back as he made it: said once, in a few words.
  // In Work's words, naming the computer (`useFailedWords`): a host's raw refusal never reaches the toast.
  const stopped = state.stopped;
  const stoppedSaid = useFailedWords(stopped?.why);
  useEffect(() => {
    if (stopped) void loadToast().then((toast) => toast.message(stoppedSaid || "That change was not saved."));
  }, [stopped, stoppedSaid]);

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
  useObjectKeys(handle, controls.includes("objects"), frame);
  useLegacyCharts(handle, view?.legacyCharts);
  // Beside the grid; under it where the canvas is too narrow to give up 320px.
  const stacked = width > 0 && width < SIDE_STACKS_UNDER;

  // The cell in hand, when a suggestion is laid in it: what the value replaces. Read on every render, which each laying causes.
  // While the stepper is on a format or a rule, which sits in no cell, the bar says that change in words.
  // A format or a rule sits in no cell and takes nothing away: the bar says it in muted ink, not on the removed tint (`said`).
  const cellWas = selection ? sync.was(selection.sheet, selection.row, selection.column) : undefined;
  const said = cellWas === undefined && change?.kind === "said" ? saidLine(change.said) : undefined;

  // A sheet that did not open says so once, in the body: the bar keeps no line about it.
  // Retry tries again what failed: the grid's own code (fetched afresh), the host's open, or both.
  const retry = (): Promise<void> | undefined => {
    if (typeof prepared === "string") setTries((n) => n + 1);
    // The host's open again is handed back, so Retry spins with the failure kept until it answers.
    return state.failed ? sync.open() : undefined;
  };
  if (failed) return <OpenFailed kind="sheet" why={failed} onRetry={retry} />;
  // Until the view names its controls the row is kept: a sheet is his to edit far more often than not.
  if (!view || !book || prepared !== true || faces !== book.key) return <SheetSkeleton loading={book ? null : state.loading} name={view?.name ?? item.title} row={view ? controls.length > 0 : true} />;
  const Canvas = grid.Canvas;
  return (
    <KitWaits>
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
            // Insert → Picture opens the system's file picker; the grid seats what he picks at the cell in hand.
            {...(controls.includes("picture") ? { onPicture: () => pictureInput.current?.click() } : {})}
            // The row ends in Preview, as a document's does: every way out of the sheet, drawn as it will be.
            {...(source ? { out: { label: "Preview", icon: <Eye />, onPress: () => showPreview("last") } } : {})}
          />
        ) : controls.length > 0 ? (
          // Until the grid hands its handle the row keeps its 36px, so the grid does not drop when the row lands.
          <FormatRowBone />
        ) : null}
        {/* A sheet that is the Excel copy of an .xls, .ods or .tsv says so in one quiet line, with its one press. */}
        {view.imported ? <ImportLine imported={view.imported} shared={view.shared} run={(act) => runImport(importAsk(sync), view.imported!, act, showFolder)} /> : null}
        {handle && controls.includes("picture") ? <PictureInput ref={pictureInput} handle={handle} /> : null}
        {handle && customFormat !== null ? <CustomFormat current={customFormat} onClose={() => setCustomFormat(null)} onApply={(pattern) => handle.format({ pattern })} /> : null}
        {google.dialog}
        <div className={stacked ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1"}>
          <Canvas
            key={book.key}
            snapshot={book.workbook as never}
            worker={grid.worker}
            // Locked too while the book is read again after a stop: an edit made then would be in neither the grid nor the file.
            readOnly={locked || state.reloading || !!state.offer}
            styleKeys={controls.length > 0}
            // The filter's header buttons and menu only where the host keeps a filter (a workbook Excel or Google holds keeps none).
            filter={controls.includes("filter")}
            // The sort dialog, the filter's menu, a list's drop-down and a validation's refusal are work-kit's own, not Univer's.
            dataChrome
            // A sheet's page set-up is kept by the grid only where the host keeps it (read once, as the grid is made).
            pages={controls.includes("page")}
            pageBreaks={pageView && controls.includes("pageBreaks")}
            // What a note's pop-over offers: what this store keeps, as its host says (`view.notes`); none on a sheet he cannot edit.
            {...(view.notes?.length && !locked && !state.reloading ? { noteControls: view.notes } : {})}
            marks={marks}
            presence={others.presence}
            was={cellWas}
            said={said}
            // The sheet's charts and pictures, drawn where Excel draws them; each change goes to its store as the tab's list. A
            // sheet that has none yet still gets the layer where its store keeps them, so Insert → Chart draws what it makes.
            objects={book.objects ?? (controls.includes("objects") || view.legacyCharts?.length ? NO_OBJECTS : undefined)}
            media={sync.media}
            onObjects={(change) => sync.object(change)}
            onReady={setHandle}
            onSelection={onSelection}
            labels={LABELS}
            // Find and Replace in the grid, a reader's too (Replace only where he may edit).
            find
            // Freeze, Hide and Unhide, tabs in order: what this store keeps, as its host says (`view.layout`); none on a sheet he cannot edit.
            {...(view.layout?.length && !locked && !state.reloading ? { layout: view.layout } : {})}
            className="min-h-0 min-w-0 flex-1"
          />
          {siding ? (
            <div data-sheet-rules="" className={stacked ? "h-[344px] shrink-0" : "w-80 shrink-0"}>
              <RulesSheet sheet={handle} open={siding} onOpen={setRules} onClose={() => setRules(null)} kinds={kinds} stacked={stacked} className="size-full" />
            </div>
          ) : null}
        </div>
        </div>
        {previewing && source ? (
          <div data-sheet-preview="" className="absolute inset-0 z-10">
            {/* Print… asked for while it is up on another format moves it to Print: a new frame on that format. */}
            <Preview key={asked} source={source} title={item.title} kind="sheet" {...(previewing === "print" ? { initial: "print" } : {})} readOnly={locked} onClose={() => setPreviewing(false)} />
          </div>
        ) : null}
      </div>
    </KitWaits>
  );
}

/**
 * A press on a copy's way out: his last edit reaches the copy first (Discard edits and read again drops them, so it waits
 * on none), and Save as Excel, which hands the tab to the .xlsx, takes no edit until it is answered.
 */
const importAsk =
  (sync: SheetSync) =>
  async (act: SheetImportAct): Promise<SheetImportDone> => {
    if (act === "xlsx") return sync.handOver(() => sync.host.imported(act));
    if (act !== "again") await sync.written();
    return sync.host.imported(act);
  };


const LABELS = { failed: "Couldn't draw this sheet." };
const NO_OBJECTS = { charts: [], pictures: [], warnings: [] };
/** The picture formats an Excel file takes (sheets/patch/pictures.ts): the picker offers these alone. */
const PICTURE_TYPES = "image/png,image/jpeg,image/gif,image/bmp";

/** The system's file picker for Insert → Picture: what he picks goes on the grid at the cell in hand, or is refused in words. */
function PictureInput({ ref, handle }: { ref: React.Ref<HTMLInputElement>; handle: SheetHandle }) {
  return (
    <input
      ref={ref}
      type="file"
      accept={PICTURE_TYPES}
      hidden
      data-sheet-picture-input=""
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        void file.arrayBuffer().then(
          (bytes) => {
            if (!handle.objects.add({ picture: { bytes: new Uint8Array(bytes), type: file.type, name: file.name.replace(/\.[^.]+$/, "") } })) void loadToast().then((toast) => toast.message(`${file.name} is not a picture this sheet can show`));
          },
          (error: unknown) => sayError(error, "Couldn't read the picture"),
        );
      }}
    />
  );
}

/**
 * Our old charts, kept beside a sheet before it kept charts of its own, as the charts they become (held.ts): laid on
 * the grid as from elsewhere, not told back, so they are drawn, and where the store keeps charts the next change to
 * their tab's charts keeps them with the sheet. Nothing is written before that. On a workbook desktop Excel or Google
 * holds the row lists no object control, so they are there to see only.
 */
function useLegacyCharts(handle: SheetHandle | null, legacy: readonly ChartSpec[] | undefined): void {
  useEffect(() => {
    if (!handle || !legacy?.length) return;
    const have = new Set(handle.objects.list().charts.map((c) => c.id));
    // (a row whose tab the workbook no longer has is left out)
    const tabs = new Set(handle.store.get().sheets.map((x) => x.name));
    const add = legacy.filter((chart) => !have.has(chart.id) && tabs.has(chart.sheet)).map((chart) => ({ kind: "add" as const, object: { chart } }));
    if (add.length) handle.objects.apply(add);
  }, [handle, legacy]);
}

/**
 * Excel's keys for the objects over the grid: ⌃⌥5 takes the first chart or picture in hand, and while one is,
 * Tab and ⇧Tab go to the next and the one before. Only where he may change objects, and only from this sheet.
 */
function useObjectKeys(handle: SheetHandle | null, on: boolean, frame: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    if (!handle || !on) return;
    const onKey = (event: KeyboardEvent): void => {
      const inHand = handle.objects.state().selected !== null;
      const here = !!frame.current && frame.current.contains(document.activeElement);
      // Control itself with Alt on every platform, as Excel has it; Tab with no command key down (Shift goes back).
      const enter = ctrlOnly(event) && event.altKey && event.code === "Digit5";
      const next = event.key === "Tab" && !chordKey(event) && inHand;
      if ((!enter || !(here || inHand)) && !next) return;
      if (handle.objects.selectNext(next && event.shiftKey ? -1 : 1) === null) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handle, on, frame]);
}
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
function useSavedLine(shell: CanvasShell, sync: SheetSync, view: SheetView | null, sendError: string | null, saving: boolean, savedAt: number | null, offer: SheetSyncState["offer"], env: string): void {
  const facts = view ? savedLine(view, sendError, saving, savedAt) : null;
  // A failed save's reason is the host's: said in Work's words, naming the computer, else the line's own word. A moved
  // file's line is the app's own sentence.
  const failure = facts && (facts.state === "conflict" || facts.state === "offline") && facts.again !== "Keep Both" ? (facts.detail ?? null) : null;
  const said = useFailedWords(failure);
  const line = facts && failure ? { ...facts, detail: said || "Couldn't save" } : facts;
  const key = line ? JSON.stringify([line, offer]) : "";
  useEffect(() => {
    if (!shell.saved || !line) return;
    if (offer) {
      // Edits kept from before: the same revision sends them as a live edit; a newer file is never written over.
      const when = whenWords(offer.at);
      shell.saved({
        state: "conflict",
        detail: offer.same ? `Edits from ${when} were not saved` : `Edits from ${when} were not saved. The file changed since`,
        actions: [
          offer.same ? { id: "restore", label: "Restore", run: () => sync.restoreDraft() } : { id: "copy", label: "Copy Edits", run: () => void copyText(offer.cells.join("\n")) },
          { id: "discard", label: "Discard", run: () => sync.discardDraft() },
        ],
      });
      return () => shell.saved?.(null);
    }
    const { again, ...rest } = line;
    const run = again === "Keep Both" ? () => keepBoth(sync, env) : () => sync.retry();
    shell.saved({ ...rest, ...(again && (again !== "Keep Both" || sync.host.restore) ? { actions: [{ id: again === "Keep Both" ? "keep" : "again", label: again, run }] } : {}) });
    return () => shell.saved?.(null);
    // `key` is the line by value: a view pushed again with the same facts says nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, sync, key, env]);
}

/**
 * Keep Both on an Excel file moved or deleted outside TempCode: the copy the sheet stands on is made again where the file
 * was (the host never writes over anything there), and the moved file is left alone. The sheet goes on in the file put back.
 */
function keepBoth(sync: SheetSync, env: string): Promise<void> {
  const view = sync.state.view;
  if (!view || !sync.host.restore) return Promise.resolve();
  return sync.host.restore(view.rev).then(
    (next) => sync.view(next),
    (error: unknown) => sayError(error, "Couldn't keep both", env),
  );
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
  env: string,
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

  const missing = view?.missing;
  const readOnly = view?.readOnly;
  const saveError = view ? (sendError ?? view.saveError) : undefined;
  const store = view?.store;
  useEffect(() => {
    // Read only asks nothing of him: one muted line, as on a deck; amber is for a line that needs him. Its reason says
    // what to do ("Save it as .xlsx in Excel to edit it here"), so it wraps under the word, never cut.
    // A file moved or deleted outside TempCode: what the sheet holds goes back where it was with Keep Both, as every kind's moved line offers.
    // The save line says it too (`savedLine`): in a Files tab it is said there alone, here only where there is no save line.
    // A sheet he cannot edit has no tools in the bar: History ends its line, so the item has one row above the grid.
    if (missing) shell.statusLine({ tone: "quiet", word: MOVED, ...(sync.host.restore ? { action: { label: "Keep Both", run: () => keepBoth(sync, env) } } : {}), saving: true, history: true });
    else if (readOnly !== undefined) shell.statusLine({ tone: "quiet", word: "Read only", detail: readOnly, wrap: true, history: true });
    else if (saveError) shell.statusLine({ tone: "failed", word: "Couldn't save", detail: saveError, action: { label: store === "package" ? "Reload" : "Retry", run: () => sync.retry() }, saving: true });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
  }, [shell, sync, missing, readOnly, saveError, store, env]);

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
    // Each batch of the ids on screen in turn; the view the last one answers is the sheet as it stands.
    // A batch that fails after others landed still shows what they took: the last view answered is laid before the words.
    const decide = async (w: number | { group: string } | "all", verdict: "accept" | "reject"): Promise<SheetView> => {
      let view: SheetView | null = null;
      try {
        for (const which of reviewBatches(list, w, verdict)) view = await host.review(which, verdict);
      } catch (error) {
        // (a first batch that took part of the press and failed answers no view: the sheet is read again)
        if (view) sync.view(view);
        else void host.open().then((next) => sync.view(next), () => undefined);
        throw error;
      }
      return view ?? Promise.reject(new Error(verdict === "accept" ? "Nothing here can be accepted: reject these" : "Nothing on screen to decide."));
    };
    const review: ReviewAdapter = {
      groups: changes.groups,
      index: current,
      count: list.length,
      step,
      accept: (w) => act(decide(w, "accept"), "Couldn't accept the change"),
      reject: (w) => act(decide(w, "reject"), "Couldn't reject the change"),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, sync, host, ready, changes, current, handle, act]);
}

/** A selection of more than one cell: Ask over it with the range named, and More's Chart while it spans two columns. */
function useSelectionFeed(
  { item, source, shell, env }: Props,
  sync: SheetSync,
  grid: SheetGrid,
  handle: SheetHandle | null,
  selection: GridSelection | null,
  locked: boolean,
  pointer: { current: { x: number; y: number } | null },
  frame: { current: HTMLDivElement | null },
  showPreview: (on: "last") => void,
  googleRow: MoreEntry | null,
  showFolder: ShowFolder | undefined,
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
  const shareGone = useSyncExternalStore(way.subscribe, way.gone, way.gone) && !!shareTargetOf(source, "sheet");
  const charts = !!sync.state.view?.row?.includes("chart");
  // The sheet in hand, by its tab name: the one a CSV takes.
  const activeName = useCallback((): string | undefined => {
    if (!handle) return undefined;
    const { sheets, active } = handle.store.get() as { sheets: { id: string; name: string }[]; active?: string };
    return sheets.find((x) => x.id === active)?.name ?? sheets[0]?.name;
  }, [handle]);
  useEffect(() => {
    if (!shell.more) return;
    shell.more([
      // A chart from the selection's block, as Insert → Chart makes it: only where the sheet's store keeps charts.
      ...(charts
        ? [
            {
              id: "chart",
              label: "Chart",
              icon: ChartBar,
              disabled: !wide,
              run: () => {
                if (!handle) return;
                const refusal = handle.objects.refusal();
                if (refusal || !handle.objects.add({ chart: "selection" })) void loadToast().then((toast) => toast.message(refusal ?? "Couldn't make the chart"));
              },
            },
          ]
        : []),
      // Every way out is in Preview: each format drawn as it will be, with what it drops. A sheet read from a .csv still
      // saves back over it.
      ...(store ? [{ id: "preview", label: "Preview…", icon: Export, run: () => showPreview("last") }] : []),
      ...(store === "csv" ? [{ id: "save-csv", label: "Save as CSV", icon: Export, run: () => saveAs(sync, env, "csv", activeName(), showFolder) }] : []),
      ...(googleRow ? [googleRow] : []),
      // The copy of an .xls, .ods or .tsv: saved back as the format it was, or out as Excel.
      ...importRows(imported, (act) => (imported ? runImport(importAsk(sync), imported, act, showFolder) : Promise.resolve())),
      ...(shareGone ? [{ id: "share", label: "Share…", icon: Share, run: () => openShare(item.id) }] : []),
    ]);
    return () => shell.more?.(null);
  }, [shell, sync, env, wide, handle, charts, store, imported, activeName, shareGone, way, showPreview, googleRow, showFolder]);
}

const letters = (column: number): string => {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const cellRef = (row: number, column: number): string => `${letters(column)}${row + 1}`;

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

// ── loading ──────────────────────────────────────────────────────────

/**
 * Loading: the sheet's own shape (`SheetBones`, sheets/bones.tsx, shared with the guest's page), the format row where the
 * sheet will have one (`row`: the view names its controls before the grid's code and fonts are ready, so nothing drops
 * 36px when the row lands). A book of more than one piece on its way (`loading`) puts a 4px bar with how much has come
 * in the formula bar's bone, as a fetched attachment's first line does.
 */
export function SheetSkeleton({ loading = null, name, row = false }: { loading?: { at: number; size: number } | null; name?: string; row?: boolean } = {}) {
  return (
    <SheetBones
      row={row}
      formula={
        loading ? (
          <div className="flex h-3 w-1/2 min-w-48 items-center gap-2">
            <Progress aria-label={name ? `Getting ${name}` : "Getting the sheet"} value={loading.at} max={loading.size} className="flex-1" />
            <span className="shrink-0 text-xs leading-none text-muted-foreground tabular-nums">{progressWords(loading.at, loading.size)}</span>
          </div>
        ) : null
      }
    />
  );
}

/** Per sheet: whether the bar's Share has given way (the narrow bar hides it whole); More offers Share… only then. */
class ShareWay {
  private hidden = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  gone = (): boolean => this.hidden;
  set(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.listeners.forEach((listener) => listener());
  }
}
const shareWays = new WeakMap<SheetSync, ShareWay>();
function shareWayOf(sync: SheetSync): ShareWay {
  let way = shareWays.get(sync);
  if (!way) shareWays.set(sync, (way = new ShareWay()));
  return way;
}

/** While the sheet loads the bar holds bones where the mode will be; after, the pane's own parts fill it, and Share on a LifeOS sheet (milestone 31). */
export function Bar(props: Props) {
  const sync = syncFor(props);
  const { view, book, failed } = useSheetSync(sync);
  if (failed) return null;
  // Share is whole or gone, hidden in the narrow bar before it could be cut. An opened Excel file says what waits in
  // Excel, in words that give way before any control does; its Share says how to share it instead.
  const target = shareTargetOf(props.source, "sheet");
  if (view && book)
    return (
      <>
        {target && "source" in target ? null : <ExcelWaits reach={view.reach} store={view.store} env={props.env} />}
        <BarShare {...props} way={shareWayOf(sync)} />
      </>
    );
  // The mode's place in the bar while the sheet comes, as words of its length.
  return (
    <Bones label="" inline>
      <span className="text-xs">Opening the sheet</span>
    </Bones>
  );
}

/**
 * Share in the bar, and its way back once the narrow bar hides it: the bar tells More it has gone, and More's Share…
 * asks the same button for its sheet (`openShare`), which stays mounted while the bar hides it.
 */
function BarShare(props: Props & { way: ShareWay }) {
  const { way } = props;
  const whole = useRef<HTMLSpanElement>(null);
  const purdue = useWorkspaceOf(props.env, props.item.workspaceId)?.sector === "purdue";
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
  return (
    <span ref={whole} data-narrow-hide className="ms-auto flex shrink-0 @max-[560px]/bar:hidden">
      <ShareButton env={props.env} source={props.source} kind="sheet" title={props.item.title} itemId={props.item.id} workspaceId={props.item.workspaceId} purdue={purdue} />
    </span>
  );
}

/**
 * The switch to the file's own app, in the tab row beside More: offered
 * while the file holds what our grid cannot reach (a pivot table, macros).
 * Our side stays chosen; the other opens the file there.
 */
export function TabEnd(props: Props) {
  const sync = syncFor(props);
  const reach = reachHere(useSheetSync(sync).view?.reach, props.env);
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
          .catch((error: unknown) => sayError(error, `Couldn't open ${app}`, props.env))
          .finally(() => setOpening(false));
      }}
      className="mx-1 shrink-0 gap-0"
    >
      <TabsList aria-label="Open in" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
        <TabsIndicator />
        <TabsTrigger value="tempcode" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          Docket
        </TabsTrigger>
        <TabsTrigger value="app" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          <BusyLabel busy={opening} label={app} />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** Show on the toast of a file he wrote out: the folder it landed in, as a Files tab of the sheet's workspace. */
type ShowFolder = (folder: string) => void;

/** None outside a Work workspace, which has no Files place to show it in. A refusal (a place the workspace may not use) is one toast. */
function useShowFolder(env: string, workspaceId: string | null | undefined): ShowFolder | undefined {
  const workspace = useWorkspaceOf(env, workspaceId);
  return useMemo(() => (workspace ? (folder: string) => showFolderIn(workspace, env, folder) : undefined), [workspace, env]);
}

/** Opens a folder in a Files tab of the workspace; the Files place rides its own chunk. */
function showFolderIn(workspace: Pick<WorkspaceMeta, "id" | "environmentId">, env: string, folder: string): void {
  void import("../files/openFrom")
    .then(({ openInFiles }) => openInFiles(workspace, { page: { at: { at: "file", host: env, path: folder }, name: nameOf(folder) } }))
    .catch((error: unknown) => sayError(error, "Couldn't show the folder", env));
}

/**
 * Writes the sheet out once his last edit is in it (`written`): an edit that did not save stops it, in words. Says where it
 * went, by the file's name and its folder's, with Show where the folder is one of his (the host names it).
 */
export async function saveAs(sync: Pick<SheetSync, "written" | "host">, env: string, format: "xlsx" | "csv", sheet?: string, show?: ShowFolder): Promise<void> {
  try {
    await sync.written();
    const { path, folder, left } = await sync.host.exportAs(format, sheet);
    const toast = await loadToast();
    const saved = savedTo(path, folder);
    const options = saved.folder && show ? { action: { label: "Show", onClick: () => show(saved.folder!) } } : undefined;
    // What the file could not hold is said with the save, not after it.
    if (left?.length) toast.message(`${saved.title} without ${left.join(" and ")}`, options);
    else toast.success(saved.title, options);
  } catch (error) {
    sayError(error, "Couldn't save the sheet", env);
  }
}
