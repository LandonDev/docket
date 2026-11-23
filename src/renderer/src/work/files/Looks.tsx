import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { besideSeatId, type FilesOpened } from "@shared/contract-work-files";
import { filesPaneOf, type CanvasItem } from "@shared/work";
import { ENTRY_KIND_WORDS, type FileEntry } from "@shared/work/files";
import { ChevronLeft } from "../../chrome/icons";
import { VirtualRows } from "../../chrome/railVirtualRows";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { formatBytes } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { chordKey, modOrCtrl } from "../../lib/keys";
import { refusalWords } from "../../lib/settingsHome";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { CanvasPane } from "../canvas/CanvasPane";
import { sayError, useFrame } from "../canvas/frame";
import { ItemSkeleton } from "../canvas/ItemBones";
import type { SavedAction } from "../canvas/kind";
import { KindGlyph } from "./KindGlyph";
import { factOf } from "./model";
import { FilePreviewPane } from "./Preview";
import { mayReadText, useTextHead, useThumb, type PictureFrom } from "./previews";
import { dragProps, howOf, NameField, onNameOf, RowState, stepHow, type ShapeProps } from "./rowParts";
import { SaveActions, SaveLine } from "./SaveLine";
import { thisWindow } from "./store";

/**
 * A folder's two shapes for reading it (docs/DESIGN.md "The Files place"): Gallery, one large read-only preview
 * over a 76px strip of the folder; and Beside, the list in two-line rows with the selected file at its right.
 * Walking either with the arrow keys shows previews only: nothing is written to a host and no editor mounts.
 * Beside opens the file as itself on a click or Tab into its right half, in the window's one Beside seat.
 */

/**
 * A file's small picture where the host has one, else its kind's glyph: a tile's, a strip cell's, the details pane's.
 * The picture fills its box and is fitted inside it, never cut. `near` false asks for none yet.
 */
export function Thumb({ from, entry, tile, glyph, near = true }: { from: PictureFrom | null; entry: FileEntry; tile: 64 | 96 | 144 | 208; glyph: string; near?: boolean }) {
  const url = useThumb(from, entry, tile, near);
  if (url) return <img src={url} alt="" draggable={false} className="size-full min-h-0 min-w-0 rounded-[3px] object-contain select-none" />;
  return <KindGlyph kind={entry.kind} className={`${glyph} shrink-0`} />;
}

/** A text file's first lines small, in the details pane's box: the file's own words, never a sketch of them. */
function TextThumb({ from, entry }: { from: PictureFrom; entry: FileEntry }) {
  const head = useTextHead(from, entry);
  if (head.is !== "text") return <KindGlyph kind={entry.kind} className="size-10 shrink-0" />;
  return <pre data-files-details-text className="size-full overflow-hidden rounded-[3px] bg-background p-2 font-mono text-xs leading-4 break-words whitespace-pre-wrap text-foreground select-none">{head.text}</pre>;
}

// ── Gallery ───────────────────────────────────────────────────────────

const STRIP_CELL = 64;
/** Cells mounted past each end of what the strip shows: a short scroll draws nothing new. */
const STRIP_EXTRA = 6;

export function FileGallery({ entries, picked, from, more, onPick, onOpen, onMore, onFetch }: ShapeProps & { from: PictureFrom | null; onFetch?(entry: FileEntry): Promise<void> }) {
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [span, setSpan] = useState({ first: 0, last: 24 });
  const at = entries.findIndex((e) => e.key === picked.cursor);
  // With nothing selected the first thing of the folder is shown; the arrows start from it.
  const shown = entries[at < 0 ? 0 : at] ?? null;
  useEffect(() => {
    if (!strip) return;
    const read = (): void => {
      const first = Math.max(0, Math.floor(strip.scrollLeft / STRIP_CELL) - STRIP_EXTRA);
      const last = Math.ceil((strip.scrollLeft + (strip.clientWidth || 1600)) / STRIP_CELL) + STRIP_EXTRA;
      setSpan((was) => (was.first === first && was.last === last ? was : { first, last }));
      if (more && strip.scrollWidth - strip.scrollLeft - strip.clientWidth < STRIP_CELL * 12) onMore();
    };
    read();
    strip.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", read);
      observer?.disconnect();
    };
    // `onMore` is the caller's newest each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip, more, entries.length]);
  const move = (to: number, event: KeyboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const next = Math.max(0, Math.min(entries.length - 1, to));
    if (!entries[next]) return;
    onPick(entries[next].key, stepHow(event));
    if (strip) {
      const left = next * STRIP_CELL;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (left + STRIP_CELL > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + STRIP_CELL - strip.clientWidth;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (chordKey(event)) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") return move(at < 0 ? 1 : at + 1, event);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") return move(at < 0 ? 0 : at - 1, event);
    if (event.key === "Home") return move(0, event);
    if (event.key === "End") return move(entries.length - 1, event);
    if (event.key === "Enter" && shown) return void (event.preventDefault(), onOpen(shown));
    if (event.key === "Escape" && picked.keys.size) return void (event.preventDefault(), onPick(null));
  };
  const cells: ReactNode[] = [];
  for (let i = span.first; i <= Math.min(entries.length - 1, span.last); i++) {
    const entry = entries[i]!;
    // The selection takes the fill, as in every shape; with nothing selected the file shown is held in it.
    const on = picked.keys.has(entry.key);
    const held = on || (!picked.keys.size && shown?.key === entry.key);
    cells.push(
      <div
        key={entry.key}
        id={`files-strip-${i}`}
        role="option"
        aria-selected={on}
        aria-label={entry.name}
        data-files-row={entry.key}
        data-menu-id={entry.key}
        className={`absolute top-2 grid size-15 cursor-default place-items-center rounded-md p-1 ${held ? "bg-muted" : "hover:bg-foreground/5"}`}
        style={{ left: i * STRIP_CELL + 2 }}
        onClick={(event) => onPick(entry.key, howOf(event))}
        onDoubleClick={() => onOpen(entry)}
      >
        <Thumb from={from} entry={entry} tile={64} glyph="size-6" />
      </div>,
    );
  }
  return (
    <div data-files-gallery className="flex min-h-0 flex-1 flex-col">
      {shown ? <FilePreviewPane from={from} entry={shown} {...(onFetch ? { onFetch } : {})} /> : <div className="flex-1 bg-(--stage)" />}
      {shown ? (
        <div className="flex h-8 shrink-0 items-center justify-center gap-2 border-t border-border px-3 text-[13px]">
          <span className="min-w-0 truncate font-medium text-foreground">{shown.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{factOf(shown, dayTime)}</span>
        </div>
      ) : null}
      <div
        ref={setStrip}
        role="listbox"
        aria-label="Files"
        aria-multiselectable
        aria-orientation="horizontal"
        aria-activedescendant={shown ? `files-strip-${at < 0 ? 0 : at}` : undefined}
        tabIndex={0}
        data-files-strip
        className="focus-ring relative h-19 shrink-0 overflow-x-auto overflow-y-hidden border-t border-border outline-none"
        onKeyDown={onKeyDown}
      >
        <div className="relative h-full" style={{ width: entries.length * STRIP_CELL + 4 }}>
          {cells}
        </div>
      </div>
    </div>
  );
}

// ── details beside a list ─────────────────────────────────────────────

/** What a file is, in rows: its kind, size, when it changed and by whom, where a lens found it. */
export function factRows(entry: FileEntry): [string, string][] {
  return [
    ["Kind", ENTRY_KIND_WORDS[entry.kind]],
    ...(entry.size !== undefined ? ([["Size", formatBytes(entry.size)]] as [string, string][]) : []),
    ...(entry.changed ? ([["Changed", dayTime(entry.changed)]] as [string, string][]) : []),
    ...(entry.by ? ([["Last change by", entry.by]] as [string, string][]) : []),
    ...(entry.madeBy ? ([["Made by", entry.madeBy]] as [string, string][]) : []),
    ...(entry.where ? ([["In", [entry.where.name, ...entry.where.trail].join(", ")]] as [string, string][]) : []),
    ...(entry.state?.is === "cloud" || entry.local === false ? ([["Kept", "In the cloud"]] as [string, string][]) : []),
  ];
}

/** The selected file's picture and facts, with Open: the last column of Columns, and the pane Show Details puts beside a list. */
export function DetailsPane({ from, entry, onOpen, className }: { from: PictureFrom | null; entry: FileEntry | null; onOpen(entry: FileEntry): void; /** the pane's own box: its size, its rule, when it shows */ className: string }) {
  // With nothing selected the pane stands empty: what it is for is plain once a file is.
  if (!entry) return <div data-files-details className={className} />;
  const text = mayReadText(entry, from);
  return (
    <div data-files-details={entry.key} className={className}>
      <div className="flex h-full flex-col items-center gap-4 overflow-x-hidden overflow-y-auto p-6">
        <div className="grid h-40 w-full max-w-64 shrink-0 place-items-center rounded-md bg-(--stage) p-2 outline-1 -outline-offset-1 outline-(--image-outline)">
          {text ? <TextThumb key={entry.key} from={from!} entry={entry} /> : <Thumb from={from} entry={entry} tile={208} glyph="size-10" />}
        </div>
        <h3 className="max-w-64 text-center text-sm leading-5 font-medium break-words text-foreground">{entry.name}</h3>
        <dl className="grid w-full max-w-64 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {factRows(entry).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate text-end text-foreground tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <Button variant="secondary" size="sm" onClick={() => onOpen(entry)}>
          {entry.folder ? "Open Folder" : "Open"}
        </Button>
      </div>
    </div>
  );
}

// ── Beside ────────────────────────────────────────────────────────────

const BESIDE_LIST_PX = 280;
/** The list gives way to the file down to this, and the file keeps at least `BESIDE_FILE_MIN` beside it; under both they take turns. */
const BESIDE_LIST_MIN = 200;
const BESIDE_FILE_MIN = 320;
/** Past this much of file beside it the list keeps its full width. */
const BESIDE_FILE_ROOM = 480;
const BESIDE_ROW_PX = 44;

/** How Beside lays out in `body` px: the list's width, or `turns` where the list and the file cannot both fit. */
export function besideShape(body: number): { list: number; turns: boolean } {
  if (body <= 0) return { list: BESIDE_LIST_PX, turns: false };
  if (body < BESIDE_LIST_MIN + BESIDE_FILE_MIN) return { list: body, turns: true };
  return { list: Math.max(BESIDE_LIST_MIN, Math.min(BESIDE_LIST_PX, body - BESIDE_FILE_ROOM)), turns: false };
}
/** The right half follows the list this long after the arrow keys rest. */
export const BESIDE_FOLLOW_MS = 120;

/** The file the window's Beside seat may show as itself: one of the workspace's own host, on its disk. */
export interface BesideSeatOf {
  workspace: Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
  /** whether this file can be seated: it lies on the workspace's host, and that host keeps tabs */
  can(entry: FileEntry): boolean;
  /** a seam for a preview page and tests: draws the seat in the app's place */
  draw?(entry: FileEntry): ReactNode;
}

/**
 * The window's one Beside seat, showing this file as itself: the host re-points the seat to it (no tab is made,
 * none is selected), and the file's kind draws its bar and body as in a tab, under one line that says where
 * saving stands. The seat is let go when the folder leaves Beside.
 */
function Seat({ seat, entry, lead, onTab }: { seat: BesideSeatOf; entry: FileEntry; /** the way back to the list, where the two take turns */ lead?: ReactNode; onTab(entry: FileEntry): void }) {
  const { workspace } = seat;
  const [got, setGot] = useState<{ key: string; item: CanvasItem | null; why?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void registry
      .linkOf(workspace.environmentId)
      .request<FilesOpened>("work.files.open", { workspaceId: workspace.id, ref: entry.ref, name: entry.name, beside: thisWindow() })
      .then(
        (opened) => live && setGot({ key: entry.key, item: opened.item ?? null, ...(opened.item ? {} : { why: "A thread has it open. Open it in a tab to see it there." }) }),
        (err: unknown) => live && setGot({ key: entry.key, item: null, why: refusalWords(err) || "It did not open." }),
      );
    return () => {
      live = false;
    };
    // The file's key is the file; its ref and name go with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.environmentId, workspace.id, entry.key]);
  const item = got?.key === entry.key ? got.item : null;
  const { feeds, shell } = useFrame(workspace.environmentId, filesPaneOf(workspace.id), item);
  const [running, setRunning] = useState<string | null>(null);
  const run = (action: SavedAction): void => {
    if (running) return;
    setRunning(action.id);
    void Promise.resolve()
      .then(() => action.run())
      .catch((err: unknown) => sayError(err, `${action.label} did not work`))
      .finally(() => setRunning(null));
  };
  if (got?.key === entry.key && !item)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-[13px] leading-5 text-muted-foreground">{got.why}</p>
        <Button variant="secondary" size="sm" onClick={() => onTab(entry)}>
          Open in a Tab
        </Button>
      </div>
    );
  return (
    <div data-files-seat={entry.key} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className={`flex h-8 shrink-0 items-center gap-2 border-b border-border pe-2 ${lead ? "ps-1" : "ps-3"}`}>
        {lead}
        <div className="min-w-0 flex-1">{feeds.saved ? <SaveLine line={feeds.saved} where={null} /> : null}</div>
        {feeds.saved?.actions?.length ? <SaveActions actions={feeds.saved.actions} busy={running} onRun={run} /> : null}
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={() => onTab(entry)}>
          Open in a Tab
        </Button>
      </div>
      {item ? (
        <CanvasPane
          key={item.id}
          item={item}
          environmentId={workspace.environmentId}
          feeds={feeds}
          shell={shell}
          // The chat docks beside a file in its own tab: Ask on a selection takes the file there.
          onAsk={() => {
            shell.selection(null);
            onTab(entry);
          }}
        />
      ) : (
        <ItemSkeleton />
      )}
    </div>
  );
}

/** Lets go of this window's Beside seat on the workspace's host: its item goes, and nothing else changes. */
export function closeBesideSeat(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): void {
  void registry
    .linkOf(workspace.environmentId)
    .request("work.files.tabClose", { workspaceId: workspace.id, tabId: besideSeatId(thisWindow()) })
    .catch(() => undefined);
}

export function FileBeside({
  entries,
  picked,
  busy,
  more,
  loadingMore,
  renaming,
  onPick,
  onOpen,
  onMore,
  onParent,
  onRenamed,
  drag,
  from,
  seat,
  onFetch,
}: ShapeProps & { from: PictureFrom | null; seat: BesideSeatOf | null; onFetch?(entry: FileEntry): Promise<void> }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [reveal, setReveal] = useState<{ index: number } | null>(null);
  const at = entries.findIndex((e) => e.key === picked.cursor);
  const cursor = at >= 0 ? entries[at]! : null;
  // The right half follows the list a moment after the arrow keys rest, so a walk through a folder asks for one preview, not thirty.
  // It holds the file's key and reads the file from the list, so a file changed under the same key is shown as it is now.
  const [shownKey, setShownKey] = useState<string | null>(cursor?.key ?? null);
  const shown = shownKey === null ? null : (entries.find((e) => e.key === shownKey) ?? null);
  useEffect(() => {
    if (cursor?.key === shownKey) return;
    const timer = setTimeout(() => setShownKey(cursor?.key ?? null), BESIDE_FOLLOW_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor?.key]);
  // The list gives way to the file as Beside narrows; where both cannot fit they take turns, the file with a way back.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [body, setBody] = useState(0);
  useEffect(() => {
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setBody(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [root]);
  const shape = besideShape(body);
  const [turn, setTurn] = useState<"list" | "file">("list");
  const toFile = (entry: FileEntry): void => {
    setShownKey(entry.key);
    setTurn("file");
  };
  const toList = (): void => {
    setTurn("list");
    requestAnimationFrame(() => root?.querySelector<HTMLElement>("[data-files-list]")?.focus());
  };
  const fileTurn = shape.turns && turn === "file" && !!shown;
  // The file he stepped into: open as itself in the seat until the list moves on.
  const [seated, setSeated] = useState<string | null>(null);
  if (seated !== null && seated !== cursor?.key) setSeated(null);
  const used = useRef(false);
  useEffect(() => {
    if (seated !== null) used.current = true;
  }, [seated]);
  // Leaving Beside lets go of the seat, if this folder ever took it.
  const workspace = seat?.workspace;
  useEffect(
    () => () => {
      if (used.current && workspace) closeBesideSeat(workspace);
    },
    // The workspace of a page never changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    if (!scroller || !more) return;
    const near = (): void => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BESIDE_ROW_PX * 10) onMore();
    };
    near();
    scroller.addEventListener("scroll", near, { passive: true });
    return () => scroller.removeEventListener("scroll", near);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, more, entries.length]);
  const move = (to: number, event: KeyboardEvent<HTMLDivElement>): void => {
    const next = Math.max(0, Math.min(entries.length - 1, to));
    if (!entries[next]) return;
    event.preventDefault();
    onPick(entries[next].key, stepHow(event));
    setReveal({ index: next });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp" && modOrCtrl(event) && !event.altKey && !event.shiftKey) return void (event.preventDefault(), onParent?.());
    if (chordKey(event)) return;
    if (event.key === "ArrowDown") return move(at < 0 ? 0 : at + 1, event);
    if (event.key === "ArrowUp") return move(at < 0 ? entries.length - 1 : at - 1, event);
    if (event.key === "Home") return move(0, event);
    if (event.key === "End") return move(entries.length - 1, event);
    if (event.key === "Enter" && cursor) return void (event.preventDefault(), onOpen(cursor));
    if (event.key === "ArrowRight" && shape.turns && cursor && !cursor.folder) return void (event.preventDefault(), toFile(cursor));
    if (event.key === "Escape" && picked.keys.size) return void (event.preventDefault(), onPick(null));
  };
  const row = (index: number): ReactNode => {
    const entry = entries[index]!;
    const on = picked.keys.has(entry.key);
    const mine = busy?.key === entry.key;
    const over = drag?.over === entry.key;
    return (
      <div
        key={entry.key}
        id={`files-row-${index}`}
        role="option"
        aria-selected={on}
        data-files-row={entry.key}
        data-menu-id={entry.key}
        data-kind={entry.kind}
        style={{ height: BESIDE_ROW_PX }}
        className={`flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-[13px] select-none ${on || over ? "bg-muted" : "hover:bg-foreground/5"}`}
        onClick={(event) => {
          const how = howOf(event);
          onPick(entry.key, how, onNameOf(event));
          // Where the list and the file take turns, a press on a file shows it.
          if (shape.turns && how === "one" && !entry.folder) toFile(entry);
        }}
        onDoubleClick={() => onOpen(entry)}
        {...dragProps(drag, entry)}
      >
        <KindGlyph kind={entry.kind} className="mt-0.5 size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            {renaming === entry.key ? (
              <NameField name={entry.name} className="h-5" onDone={(next) => onRenamed(entry, next)} />
            ) : (
              <span data-files-name className={`min-w-0 flex-1 truncate leading-4 text-foreground ${entry.fresh ? "font-semibold" : ""}`}>
                {entry.name}
              </span>
            )}
            {entry.changed ? <span className="shrink-0 text-xs leading-4 text-muted-foreground tabular-nums">{dayTime(entry.changed)}</span> : null}
          </span>
          {/* Under the name: the one state, else who changed it. */}
          <span className="flex h-4 min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            {mine ? busy!.word : entry.state?.is === "cloud" ? <span className="truncate">In the cloud</span> : entry.state ? <RowState entry={entry} /> : <span className="truncate">{entry.madeBy ?? entry.by ?? ""}</span>}
          </span>
        </span>
      </div>
    );
  };
  const canSeat = !!seat && !!shown?.ref && seat.can(shown) && shown.local !== false && shown.state?.is !== "cloud";
  const stepIn = (): void => {
    if (canSeat && shown && cursor?.key === shown.key) setSeated(shown.key);
  };
  const back = fileTurn ? (
    <Tip label="Back to the list">
      <Button variant="ghost" size="icon-xs" aria-label="Back to the list" data-files-beside-back className="shrink-0 text-muted-foreground" onClick={toList}>
        <ChevronLeft />
      </Button>
    </Tip>
  ) : null;
  let right: ReactNode;
  // With nothing selected the right half stands empty on the stage.
  if (!shown) right = shape.turns ? null : <div className="min-w-0 flex-1 bg-(--stage)" />;
  else if (shape.turns && !fileTurn) right = null;
  else if (seated === shown.key && seat) right = seat.draw ? seat.draw(shown) : <Seat seat={seat} entry={shown} onTab={onOpen} {...(back ? { lead: back } : {})} />;
  else
    right = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {back ? <div className="flex h-8 shrink-0 items-center border-b border-border ps-1">{back}</div> : null}
        {/* A click or Tab into the right half opens the file there as itself. */}
        <div data-files-beside-look tabIndex={canSeat ? 0 : -1} className="focus-ring flex min-h-0 min-w-0 flex-1 flex-col outline-none" onFocus={stepIn} onClick={stepIn}>
          <FilePreviewPane from={from} entry={shown} fetchLabel="Download and Open" {...(onFetch ? { onFetch } : {})} />
        </div>
      </div>
    );
  return (
    <div ref={setRoot} data-files-beside={shape.turns ? turn : ""} className="flex min-h-0 flex-1">
      {fileTurn ? null : (
        <div
          ref={setScroller}
          role="listbox"
          aria-label="Files"
          aria-multiselectable
          aria-activedescendant={at >= 0 ? `files-row-${at}` : undefined}
          tabIndex={0}
          data-files-list
          className={`focus-ring min-h-0 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-2 outline-none ${shape.turns ? "flex-1" : "shrink-0 border-e border-border"}`}
          style={shape.turns ? undefined : { width: shape.list }}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            if (event.target === event.currentTarget) onPick(null);
          }}
        >
          {entries.length <= 80 ? (
            entries.map((_, index) => row(index))
          ) : (
            <VirtualRows count={entries.length} scroller={scroller} scrollMargin={4} estimateSize={() => BESIDE_ROW_PX} getItemKey={(index) => entries[index]!.key} gap={0} reveal={reveal} sizeKey="work-files-beside" render={row} />
          )}
          {loadingMore ? (
            <div aria-busy className="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Loading more
            </div>
          ) : null}
        </div>
      )}
      {right}
    </div>
  );
}
