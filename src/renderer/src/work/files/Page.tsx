import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { FileCrumb, FilePage, FileTab } from "@shared/contract-work-files";
import { matchesName, nameWords } from "@shared/work/fileSearch";
import { canDo, DEFAULT_SORT, MAKE_WORDS, refusal, type FileEntry, type FilePlace, type FileSort, type FileSortBy, type FolderRef, type MakeKind } from "@shared/work/files";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CornerDownRight, FileText, Layers, ListChecks, MoreHorizontal, Plus, Search, type IconComponent } from "../../chrome/icons";
import { FORM_KIND_WORDS, type FormKind } from "../msforms/newForm";
import { RowsContextMenu, RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { VirtualRows } from "../../chrome/railVirtualRows";
import { Tip, TruncateTip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { ROW_PRESS } from "../../components/ui/press";
import { Spinner } from "../../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { clockTime, dayTime } from "../../lib/duration";
import { chordKey, modOrCtrl } from "../../lib/keys";
import { IS_MAC } from "../../lib/platform";
import { shortcutFor } from "../../lib/settings";
import { claimFileDrop } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { BesideShape, ColumnsShape, Doc, FolderAdd, GalleryShape, GridShape, ListShape, Slides, Table, Upload } from "../icons";
import { ViewStateLine } from "../views/ViewStateLine";
import { DownEmpty } from "../shell/DownEmpty";
import { HostLine } from "../shell/DownLine";
import { useHostLive, useLiveDown } from "../shell/lifeosLive";
import { refreshLifeos } from "../shell/lifeos";
import { readsLifeos, readsSession, useLifeosPlace } from "./lifeosPlace";
import type { UploadProgress } from "./acts";
import { GoToField, SearchField, type GoToRow } from "./GoTo";
import { KindGlyph } from "./KindGlyph";
import { DetailsPane, FileBeside, FileGallery, type BesideSeatOf } from "./Looks";
import {
  actsFor,
  carryRefusal,
  DEFAULT_TILE,
  GROUP_WORDS,
  groupEntries,
  groupHeads,
  NOTHING_PICKED,
  PAGE_SHAPES,
  pick,
  pickAll,
  pickedAmong,
  folderGone,
  readRefused,
  placeNote,
  vmSleepNote,
  searchingNote,
  searchGap,
  SHAPE_WORDS,
  TILE_SIZES,
  TILE_WORDS,
  whereWords,
  answersWords,
  formEntryOf,
  type ActRow,
  type EntryAct,
  type FilesNote,
  type PageGroup,
  type PageLook,
  type PageShape,
  type Picked,
  type PickHow,
  type PlaceCopy,
} from "./model";
import { busyOf, type Busy, type RowBusy } from "./busy";
import { dragging, dragProps, dropVerb, heldRow, howOf, NameField, onNameOf, ROWS_MIME, RowState, RowWords, setDragging, setDragLabel, stepHow, whenDragEnds, WhereWords, type RowDrag, type ShapeProps } from "./rowParts";
import type { PictureFrom } from "./previews";
import { QuickLook } from "./QuickLook";
import { FileColumns, FileGrid } from "./Shapes";
import { keepPageLook, pageLookOf, usePageLook, type ListFrom, type Listing } from "./store";

/**
 * One page of the Files place (docs/DESIGN.md "The Files place"): a folder or a lens in a tab. Its bar is 44px:
 * Back and Forward for this tab, then the trail (the place, then each folder; the last step medium), then the
 * view switch (List, Grid, Columns, Gallery, Beside) and the page's own options. Under it the folder in its shape.
 * The list: 36px rows (28px compact), only the ones on screen mounted, a kind's glyph in its tint, the name, one
 * state at most, who last changed it and when; columns leave from the right as the list narrows. A click selects,
 * a second opens; the arrows walk, Return opens and Space is Quick Look. Grid and Columns are Shapes.tsx, Gallery
 * and Beside Looks.tsx.
 */

export const ROW_PX = 36;
export const ROW_COMPACT_PX = 28;
/** Up to this many rows a list is drawn whole: the virtual list earns its keep only past it. */
export const PLAIN_MOST = 80;

const SHAPE_GLYPH = { list: ListShape, grid: GridShape, columns: ColumnsShape, gallery: GalleryShape, beside: BesideShape } as const;

/** What a note's press does; the view gives the handlers. */
export interface NoteFixes {
  busy: boolean;
  /** his press: a Retry's answer settles what it returns */
  run(fix: NonNullable<FilesNote["fix"]>): void | Promise<void>;
  /** Who can, for a fix this window's key may not make (`managedElsewhere`): said in the press's place. */
  elsewhere?(fix: NonNullable<FilesNote["fix"]>): string | null;
}
const FIX_LABEL = { allow: "Allow", retry: "Retry", "sign-in": "Sign in to OneDrive", "open-vm": "Open the Windows VM", settings: "Open Settings", wake: "Wake it" } as const;

/** A note with nothing listed under it: the one cause and its press, centred where the list would be. A stage under way leads with its spinner. */
export function NoteEmpty({ note, fixes }: { note: FilesNote; fixes: NoteFixes }) {
  const elsewhere = note.fix ? (fixes.elsewhere?.(note.fix) ?? null) : null;
  const line = elsewhere ?? note.line;
  return (
    <Empty {...(note.busy ? { role: "status", "aria-busy": true } : {})}>
      {note.busy ? (
        <EmptyMedia>
          <Spinner className="size-4" />
        </EmptyMedia>
      ) : null}
      <EmptyHeader>
        <EmptyTitle>{note.title}</EmptyTitle>
        {line ? <EmptyDescription>{line}</EmptyDescription> : null}
      </EmptyHeader>
      {note.fix && !elsewhere ? (
        <Button size="sm" variant="secondary" disabled={fixes.busy} onClick={() => fixes.run(note.fix!)}>
          <BusyLabel busy={fixes.busy} label={FIX_LABEL[note.fix.kind]} />
        </Button>
      ) : null}
    </Empty>
  );
}

/**
 * An empty page's one state with its one press (`EmptyState`'s shape), whose press spins while it is out: his Retry on
 * "This folder did not load" keeps the failure and its words until the answer replaces them.
 */
function FailedEmpty({ title, line, action, busy }: { title: string; line?: string | undefined; action?: { label: string; onClick(): void }; busy: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {line ? <EmptyDescription>{line}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={action.onClick}>
          <BusyLabel busy={busy} label={action.label} />
        </Button>
      ) : null}
    </Empty>
  );
}

/** A note over a list that is still shown: the state line's shape, in the note's own tone, with its one press. */
function NoteLine({ note, fixes }: { note: FilesNote; fixes: NoteFixes }) {
  if (note.away && note.fix?.kind === "retry") return <ViewStateLine word={note.title} detail={note.line} onRetry={() => fixes.run({ kind: "retry" })} />;
  const elsewhere = note.fix ? (fixes.elsewhere?.(note.fix) ?? null) : null;
  const line = elsewhere ?? note.line;
  // A note with nothing to do and nothing more to say is a fact about the list, muted, never a heading over it.
  const quiet = !line && !(note.fix && !elsewhere);
  return (
    <div data-files-note role="status" aria-busy={note.busy || undefined} className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      {note.busy ? <Spinner className="size-3 shrink-0" /> : null}
      <span className={`min-w-0 truncate ${quiet ? "text-muted-foreground" : "font-medium text-foreground"}`}>{note.title}</span>
      {line ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{line}</span> : <span className="flex-1" />}
      {note.fix && !elsewhere ? (
        <Button variant="ghost" size="xs" disabled={fixes.busy} onClick={() => fixes.run(note.fix!)}>
          <BusyLabel busy={fixes.busy} label={FIX_LABEL[note.fix.kind]} />
        </Button>
      ) : null}
    </div>
  );
}

/** The list's own bones: rows in its shape, so nothing moves when the names land. */
export function ListBones({ compact = false }: { compact?: boolean }) {
  const widths = ["w-[34%]", "w-[52%]", "w-[41%]", "w-[60%]", "w-[38%]", "w-[47%]"];
  return (
    <div role="status" aria-label="Loading" aria-busy className="select-none px-2 pt-1">
      {widths.map((width, i) => (
        <div key={i} className="flex items-center gap-2 px-2" style={{ height: compact ? ROW_COMPACT_PX : ROW_PX }}>
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={`h-3 ${width}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * The page bar's bones while a place loads: Back and Forward where the bar draws them and a bone where the trail
 * will name the folder, 44px like the bar, so the list under it does not move when the bar lands.
 */
export function BarBones() {
  return (
    <div aria-hidden data-files-bar-bones className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button variant="ghost" size="icon-sm" disabled tabIndex={-1} className="shrink-0 text-muted-foreground">
        <ChevronLeft />
      </Button>
      <Button variant="ghost" size="icon-sm" disabled tabIndex={-1} className="shrink-0 text-muted-foreground">
        <ChevronRight />
      </Button>
      <Skeleton className="ms-2 h-3 w-24" />
    </div>
  );
}

/** The trail over a folder: each step above it a press, the folder itself the medium last step. */
function Trail({ trail, name, onGo, onEmpty }: { trail: readonly FileCrumb[]; name: string; onGo(page: FilePage): void; onEmpty?(): void }) {
  const steps = trail.length ? trail : [{ name, at: null as FolderRef | null }];
  // The folder never shrinks (an ellipsis shows at any part of a pixel lost): it may take all the bar but the room
  // the steps above keep at their least, a letter or two and an ellipsis each, with their chevrons and gaps.
  const above = steps.length - 1;
  const aboveLeast = above ? 36 + 52 * (above - 1) + 2 * above : 0;
  return (
    <nav
      aria-label="Folder"
      className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      // A press on the trail's empty part turns it into Go to's field.
      onClick={(event) => {
        if (event.target === event.currentTarget) onEmpty?.();
      }}
    >
      {steps.map((crumb, i) => (
        // The steps above the folder give way first, each to a letter or two and its ellipsis, before the folder's
        // own name is cut; under 520px of bar the folder alone is named, cut only where it alone is wider than the bar.
        <span
          key={i}
          data-trail-step={i === steps.length - 1 ? "folder" : "above"}
          className={`items-center gap-0.5 ${i === steps.length - 1 ? "flex max-w-full shrink-0 @[520px]/files-bar:max-w-[calc(100%-var(--trail-above))]" : `hidden overflow-hidden @[520px]/files-bar:flex ${i > 0 ? "min-w-13" : "min-w-9"}`}`}
          style={i === steps.length - 1 ? ({ "--trail-above": `${aboveLeast}px` } as CSSProperties) : undefined}
        >
          {i > 0 ? <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-muted-foreground ${i === steps.length - 1 ? "hidden @[520px]/files-bar:block" : ""}`} /> : null}
          {i === steps.length - 1 || !crumb.at ? (
            // Cut in a narrow bar, the folder's whole name is in its tooltip.
            <TruncateTip text={crumb.name}>
              <span aria-current="page" className="truncate px-2 text-[13px] font-medium text-foreground">
                {crumb.name}
              </span>
            </TruncateTip>
          ) : (
            <Button variant="ghost" size="xs" className="min-w-0 shrink text-[13px] text-muted-foreground" onClick={() => onGo({ at: crumb.at!, name: crumb.name })}>
              <span className="truncate">{crumb.name}</span>
            </Button>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The columns' widths, shared by the heads and the rows. Who changed it is the first to go as the list narrows; when it changed stays beside the name longest. */
const COL_BY = "hidden w-40 shrink-0 @[560px]/files-list:block";
const COL_CHANGED = "hidden w-32 shrink-0 text-end @[360px]/files-list:block";

/** A column's head that sorts: a press sorts by it, a second press turns the order round. */
function SortHead({ by, label, sort, onSort, className }: { by: FileSortBy; label: string; sort: FileSort; onSort(next: FileSort): void; className: string }) {
  const active = sort.by === by;
  // Names start A to Z; times start newest first.
  const first = by === "changed" ? "desc" : "asc";
  const Arrow = sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <span role="columnheader" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <Button
        variant="ghost"
        size="xs"
        data-files-sort={by}
        className={`-mx-2 max-w-full gap-1 font-normal ${active ? "text-foreground" : "text-muted-foreground"}`}
        onClick={() => onSort({ by, dir: active ? (sort.dir === "asc" ? "desc" : "asc") : first })}
      >
        <span className="truncate">{label}</span>
        {active ? <Arrow aria-hidden /> : null}
      </Button>
    </span>
  );
}

/** The list's heads. "Last change by" is a fact of each file, not an order the host keeps: its head only names the column. */
function Head({ sort, second, onSort }: { sort: FileSort; second: string; onSort(next: FileSort): void }) {
  return (
    // The head keeps the room the list's bar takes (`scrollbar-gutter`), so Changed ends on its dates' edge.
    <div role="row" className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-4 text-xs text-muted-foreground [scrollbar-gutter:stable]">
      <span aria-hidden className="w-4 shrink-0" />
      <SortHead by="name" label="Name" sort={sort} onSort={onSort} className="min-w-0 flex-1" />
      <span role="columnheader" className={COL_BY}>
        {second}
      </span>
      <SortHead by="changed" label="Changed" sort={sort} onSort={onSort} className={COL_CHANGED} />
    </div>
  );
}

/** What a row calls when pressed, as the list has it now. */
interface RowLive {
  onPick: ShapeProps["onPick"];
  onOpen: ShapeProps["onOpen"];
  onRenamed: ShapeProps["onRenamed"];
  drag?: RowDrag;
}

/**
 * One row of the list: its kind's glyph, the name with its one state, who changed it, when. Drawn again only when its
 * entry (kept as the same object while it says the same), its selection, the drag over it, its progress or its
 * rename changes: a push that changed one file draws one row, a press that moves the selection draws two.
 */
const FileRow = memo(function FileRow({
  entry,
  index,
  on,
  over,
  height,
  busy,
  renaming,
  head,
  drag,
  dragFrom,
  shut,
  live,
}: {
  entry: FileEntry;
  index: number;
  on: boolean;
  over: boolean;
  height: number;
  /** his act on this row while the host works: its word, and the name a rename typed */
  busy: RowBusy | null;
  /** only a LifeOS session that is down opens it (`heldRow`) */
  shut: boolean;
  renaming: boolean;
  head: string | undefined;
  drag: RowDrag | undefined;
  /** whether rows may be dragged now: only so the row draws again when it changes */
  dragFrom: boolean;
  live: RefObject<RowLive>;
}) {
  const line = (
    <div
      key={entry.key}
      id={`files-row-${index}`}
      role="option"
      aria-selected={on}
      data-files-row={entry.key}
      data-menu-id={entry.key}
      data-kind={entry.kind}
      data-drop-over={over || undefined}
      {...heldRow(shut)}
      style={{ height }}
      className={`flex cursor-default items-center gap-2 rounded-md px-2 text-[13px] select-none ${on || over ? "bg-muted" : ROW_PRESS} ${shut ? "opacity-50" : ""}`}
      onClick={(event) => live.current.onPick(entry.key, howOf(event), onNameOf(event))}
      onDoubleClick={() => live.current.onOpen(entry)}
      {...dragProps(drag, entry)}
      // Whether it may be dragged is this render's, not the handlers' (which are the list's after it commits).
      {...(drag ? { draggable: dragFrom && entry.kind !== "form" } : {})}
    >
      <KindGlyph kind={entry.kind} />
      {/* The state is a detail of the name: 4px after it, on its baseline (a glyph keeps the centre line). */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        {renaming ? (
          <NameField name={entry.name} onDone={(next) => live.current.onRenamed(entry, next)} />
        ) : (
          <TruncateTip text={busy?.name ?? entry.name}>
            <span data-files-name className={`min-w-0 truncate text-foreground ${entry.fresh ? "font-semibold" : ""}`}>
              {busy?.name ?? entry.name}
            </span>
          </TruncateTip>
        )}
        {busy !== null ? (
          // The name has first claim on the row: the progress gives way first, its words cut at the width of the By
          // column, and under 360px of list they go from sight (still read out) as Changed does, the spinner staying.
          // The whole of it on hover.
          <RowWords data-files-busy="" busy words={busy.word} cut="max-w-0 @[360px]/files-list:max-w-40" />
        ) : (
          <RowState entry={entry} />
        )}
      </span>
      <span className={`${COL_BY} truncate text-xs text-muted-foreground`}>{entry.where ? <WhereWords where={entry.where} /> : entry.answersTo ? answersWords(entry.answersTo) : (entry.madeBy ?? entry.by ?? "")}</span>
      <span className={`${COL_CHANGED} text-xs text-muted-foreground tabular-nums`}>{entry.changed ? dayTime(entry.changed) : ""}</span>
    </div>
  );
  if (head === undefined) return line;
  // A group's heading stands over its first row on its rows' title edge, and scrolls with it.
  return (
    <div role="presentation">
      <div role="presentation" data-files-group={head} className={`flex h-7 items-end ps-8 pe-2 pb-1 text-xs font-medium text-muted-foreground ${index ? "mt-2" : ""}`}>
        {head}
      </div>
      {line}
    </div>
  );
});

export function FileList({
  entries,
  picked,
  compact,
  heads,
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
  sessionHeld,
  bulk = false,
}: ShapeProps & {
  compact: boolean;
  /** where each heading stands: the index of a group's first row, and its words */
  heads?: ReadonlyMap<number, string> | null;
  /** the bar for many floats over the list's foot: the last row is kept clear of it */
  bulk?: boolean;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const height = compact ? ROW_COMPACT_PX : ROW_PX;
  const [reveal, setReveal] = useState<{ index: number } | null>(null);
  const at = entries.findIndex((e) => e.key === picked.cursor);
  // The next page is asked for as the list nears its end.
  useEffect(() => {
    if (!scroller || !more) return;
    const near = (): void => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < height * 12) onMore();
    };
    near();
    scroller.addEventListener("scroll", near, { passive: true });
    return () => scroller.removeEventListener("scroll", near);
    // `onMore` is the caller's newest each render; the scroller and the count decide when to listen again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, more, entries.length, height]);
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
    if (event.key === "Enter" && at >= 0) return void (event.preventDefault(), onOpen(entries[at]!));
    if (event.key === "Escape" && picked.keys.size) return void (event.preventDefault(), onPick(null));
  };
  // The handlers a row calls, read when it is pressed: a row draws again only when what it shows changes.
  const live = useRef<RowLive>({ onPick, onOpen, onRenamed, drag });
  useLayoutEffect(() => {
    live.current = { onPick, onOpen, onRenamed, drag };
  });
  const liveDrag = useMemo<RowDrag>(
    () => ({
      get from() {
        return live.current.drag?.from ?? false;
      },
      get over() {
        return live.current.drag?.over ?? null;
      },
      onStart: (entry, event) => live.current.drag?.onStart(entry, event),
      onEnd: () => live.current.drag?.onEnd(),
      onOver: (entry, event) => live.current.drag?.onOver(entry, event) ?? false,
      onLeave: (entry) => live.current.drag?.onLeave(entry),
      onDrop: (entry, event) => live.current.drag?.onDrop(entry, event),
    }),
    [],
  );
  const row = (index: number): ReactNode => {
    const entry = entries[index]!;
    return (
      <FileRow
        key={entry.key}
        entry={entry}
        index={index}
        on={picked.keys.has(entry.key)}
        over={drag?.over === entry.key}
        height={height}
        busy={busyOf(busy, entry.key)}
        renaming={renaming === entry.key}
        head={heads?.get(index)}
        drag={drag ? liveDrag : undefined}
        dragFrom={!!drag?.from}
        shut={!!sessionHeld?.has(entry.key)}
        live={live}
      />
    );
  };
  return (
    <div
      ref={setScroller}
      role="listbox"
      aria-label="Files"
      aria-multiselectable
      aria-activedescendant={at >= 0 ? `files-row-${at}` : undefined}
      tabIndex={0}
      data-files-list
      className={`focus-ring min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-1 outline-none [scrollbar-gutter:stable] ${bulk ? "pb-14" : "pb-2"}`}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // A press on the list's own ground lets go of the selection.
        if (event.target === event.currentTarget) onPick(null);
      }}
    >
      {/* A short list is drawn whole; a long one mounts only the rows on screen. */}
      {entries.length <= PLAIN_MOST ? (
        entries.map((_, index) => row(index))
      ) : (
        <VirtualRows count={entries.length} scroller={scroller} scrollMargin={4} estimateSize={() => height} getItemKey={(index) => entries[index]!.key} gap={0} reveal={reveal} sizeKey="work-files-list" render={row} />
      )}
      {loadingMore ? (
        <div aria-busy className="flex items-center gap-2 px-2 text-xs text-muted-foreground" style={{ height }}>
          <Spinner className="size-3" />
          Loading more
        </div>
      ) : null}
    </div>
  );
}

/**
 * A page's bar, 44px: Back and Forward for the tab, then the trail, or Go to's or Search's field in its place,
 * then the page's own controls. Home has the same bar with no controls of its own.
 */
export function PageBar({
  name,
  trail,
  canBack,
  canForward,
  onBack,
  onForward,
  onGo,
  find,
  filter = "",
  onFilter = () => undefined,
  children,
}: {
  name: string;
  trail: readonly FileCrumb[];
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onGo(page: FilePage): void;
  find: PageFind | null;
  /** what Search's field holds, where the page filters its rows by it */
  filter?: string;
  onFilter?(text: string): void;
  children?: ReactNode;
}) {
  return (
    <div data-files-bar className="@container/files-bar flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <Tip label="Back" shortcut={shortcutFor("Files (Work)", "Back")}>
        <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!canBack} className="shrink-0 text-muted-foreground" onClick={onBack}>
          <ChevronLeft />
        </Button>
      </Tip>
      <Tip label="Forward" shortcut={shortcutFor("Files (Work)", "Forward")}>
        <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!canForward} className="shrink-0 text-muted-foreground" onClick={onForward}>
          <ChevronRight />
        </Button>
      </Tip>
      {find?.mode === "goto" ? (
        <GoToField link={find.link} workspaceId={find.workspaceId} tabs={find.tabs} onPick={find.onGoTo} onClose={() => find.setMode(null)} />
      ) : find?.mode === "search" ? (
        <SearchField
          start={filter}
          onFilter={onFilter}
          onSearch={(text) => {
            onFilter("");
            find.setMode(null);
            find.onSearch(text);
          }}
          onClose={() => find.setMode(null)}
        />
      ) : (
        <Trail trail={trail} name={name} onGo={onGo} {...(find ? { onEmpty: () => find.setMode("goto") } : {})} />
      )}
      {find && find.mode === null ? (
        <>
          <Tip label="Go to" shortcut={shortcutFor("Files (Work)", "Go to")}>
            <Button variant="ghost" size="icon-sm" aria-label="Go to" className="shrink-0 text-muted-foreground" onClick={() => find.setMode("goto")}>
              <CornerDownRight />
            </Button>
          </Tip>
          <Tip label="Search" shortcut={shortcutFor("Files (Work)", "Search")}>
            <Button variant="ghost" size="icon-sm" aria-label="Search" className="shrink-0 text-muted-foreground" onClick={() => find.setMode("search")}>
              <Search />
            </Button>
          </Tip>
        </>
      ) : null}
      {children}
    </div>
  );
}

/** Go to and Search, in a page's bar: which of them stands in the trail's place, and what each takes. */
export interface PageFind {
  /** the workspace's own host, which keeps the names */
  link: string;
  workspaceId: string;
  tabs: readonly FileTab[];
  mode: "goto" | "search" | null;
  setMode(mode: "goto" | "search" | null): void;
  onGoTo(row: GoToRow): void;
  /** his words, searched in every place: a page of results */
  onSearch(text: string): void;
}

/**
 * What a page can do to what is in it (docs/agents/work-files.md): the view gives these, each asking the file's
 * own host. Absent on a page that only shows (a host a release behind, a team's own page), where the rows open
 * and nothing more.
 */
export interface PageActs {
  /** the place the folder lies in, as its host said it; the grammar's refusals are read from it */
  place: FilePlace;
  /** that place's copy the page reads from: where a drag of its rows comes from */
  from: PlaceCopy;
  /** the workspace's host keeps tabs and his marks */
  tabs: boolean;
  /** the place's computer is reached only through another host: its greyed verbs say so (`farWhy`) */
  far?: { computer: string; via: string };
  /** New: makes a thing of the kind here; answers it, to select and name */
  make(kind: MakeKind): Promise<FileEntry | null>;
  /** New → Form: the kinds this place offers and the make, which opens the form in a tab (work/msforms/newForm.ts) */
  forms?: { kinds: readonly FormKind[]; /** a Microsoft form cannot be made here: the off row's line */ refused?: string; make(kind: FormKind): Promise<void>; /** a Microsoft form is being made in Forms */ making: boolean; /** where that make stands, in words */ stage?: string | null };
  rename(entry: FileEntry, name: string): Promise<FileEntry | null>;
  /** Move to… and Copy to…: the dialog that picks the folder */
  carry(verb: "move" | "copy", entries: readonly FileEntry[]): void;
  trash(entries: readonly FileEntry[]): void;
  /** Put Back; absent where this window's key may not */
  restore?(entries: readonly FileEntry[]): void;
  /** Delete for good: these rows of Trash, or with none given all of it; absent where this window's key may not */
  purge?(entries?: readonly FileEntry[]): void;
  star(entries: readonly FileEntry[], on: boolean): void;
  openTab(entry: FileEntry): void;
  /** Ask about what is selected: a new chat whose first message holds the files, eight at most; absent where a thread cannot start here */
  ask?(entries: readonly FileEntry[]): void;
  /** Keep: a mail's files copied into the workspace's folder (the From mail lens) */
  keep?(entries: readonly FileEntry[]): void;
  /** the sector's projects a file can be added to, and the change; absent where the workspace has none */
  projects?: readonly { id: string; name: string }[];
  project?(entry: FileEntry, project: { id: string; name: string }, on: boolean): void;
  /** Open to the Side: the file goes at the side of the file tab he was last in; absent where there is none to take it */
  openSide?(entry: FileEntry): void;
  /** Open in its app: absent where the place's computer cannot open it for this window (`appOpens`) */
  openApp?(entry: FileEntry): void;
  /** Download: the files' bytes to this computer, one after another, by the route a tab's own file takes; absent where this window cannot be given them (`placeDownloads`) */
  download?(entries: readonly FileEntry[]): void;
  /** Share…: a document's or a sheet's Share sheet; absent where nothing of this place can be shared from this window */
  share?(entry: FileEntry): void;
  /**
   * A place others open (a library, his OneDrive): Share in Teams opens the file's own page, as the workspace's host knows
   * it; `pageOf` is undefined until asked, null where it knows none. Present, no guest link is offered here.
   */
  shareIn?: { home: "Teams" | "OneDrive"; pageOf(entry: FileEntry): string | null | undefined; ask(entry: FileEntry): void; open(url: string): void };
  /** Add from Drive…: Google's Picker, for a Drive place; what he picks is what the place may list */
  addFromDrive?(): void;
  /** From a Template…: the templates pillar's own dialog, the file kept in this folder; absent where that pillar is not there */
  fromTemplate?(): void;
  /** Upload files…: the system's picker, then the upload into this folder */
  pickUpload(): void;
  /** files dropped from the desktop onto this folder, or onto a folder row of it */
  upload(files: readonly File[], into?: FileEntry): void;
  /** rows dragged onto a folder row of this page, from this page or another place's; `back` the one folder they lie in, for a move's Undo */
  drop(verb: "move" | "copy", entries: readonly FileEntry[], into: FileEntry, from: PlaceCopy, back?: { at: FolderRef; name: string }): void;
  /**
   * Rows dragged out to the desktop: where every one of them is a file that lies on this computer, the system
   * carries them and this answers when the drag ends; null where they cannot go (a folder among them, a file kept
   * in the cloud, another computer's), and the drag stays the window's own.
   */
  dragOut?(entries: readonly FileEntry[]): Promise<void> | null;
  /** an upload under way into this folder */
  uploading: UploadProgress | null;
  cancelUpload(): void;
}

const MAKE_GLYPH: Record<MakeKind, IconComponent> = { document: Doc, sheet: Table, deck: Slides, text: FileText, folder: FolderAdd };

/** New: the page's one primary button, a menu of what its place makes, then Upload files…, and where it is kept. */
function NewMenu({ acts, name, onMade }: { acts: PageActs; name: string; onMade(entry: FileEntry): void }) {
  const [busy, setBusy] = useState(false);
  const makes = acts.place.makes ?? [];
  const upload = canDo(acts.place, "upload");
  const forms = acts.forms?.kinds ?? [];
  const refused = acts.forms?.refused;
  // Two kinds of form are one Form row with a line each; one kind is the row itself; a refused Microsoft form is an off row with its reason as its line, asked of no one.
  const formRow: MenuRow[] = refused && !forms.length
    ? [{ kind: "item", id: "form:refused", label: FORM_KIND_WORDS.microsoft.label, icon: ListChecks, description: refused, disabled: true }]
    : forms.length > 1
      ? [{ kind: "sub", id: "form", label: "Form", icon: ListChecks, items: forms.map((f): MenuRow => ({ kind: "item", id: `form:${f}`, label: FORM_KIND_WORDS[f].label, description: FORM_KIND_WORDS[f].line })) }]
      : forms.length === 1
        ? [{ kind: "item", id: `form:${forms[0]}`, label: "Form", icon: ListChecks }]
        : [];
  const rows: MenuRow[] = [
    ...makes.map((kind): MenuRow => ({ kind: "item", id: `make:${kind}`, label: MAKE_WORDS[kind], icon: MAKE_GLYPH[kind], ...(kind === "folder" ? { shortcut: shortcutFor("Files (Work)", "New Folder") } : {}) })),
    ...formRow,
    ...(acts.fromTemplate || acts.addFromDrive || upload ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    ...(acts.fromTemplate ? ([{ kind: "item", id: "template", label: "From a Template…", icon: Layers }] satisfies MenuRow[]) : []),
    ...(acts.addFromDrive ? ([{ kind: "item", id: "drive", label: "Add from Drive…" }] satisfies MenuRow[]) : []),
    ...(upload ? ([{ kind: "item", id: "upload", label: "Upload Files…", icon: Upload }] satisfies MenuRow[]) : []),
    { kind: "sep" },
    // On the rows' own leading edge, as the menu's note row draws it: no inset of its own.
    { kind: "note", id: "where", content: <span className="min-w-0 truncate">Kept in {name}</span> },
  ];
  // A place that makes nothing and takes no upload offers no New: its rows' own menus say why.
  if (!makes.length && !forms.length && !refused && !upload && !acts.addFromDrive) return null;
  return (
    <RowsMenu
      label="New"
      align="end"
      rows={rows}
      onPick={(id) => {
        if (id === "upload") return acts.pickUpload();
        if (id === "template") return acts.fromTemplate?.();
        if (id === "drive") return acts.addFromDrive?.();
        const form = forms.find((f) => id === `form:${f}`);
        if (form && acts.forms && !busy) {
          setBusy(true);
          void acts.forms.make(form).finally(() => setBusy(false));
          return;
        }
        const kind = makes.find((k) => id === `make:${k}`);
        if (!kind || busy) return;
        setBusy(true);
        void acts
          .make(kind)
          .then((made) => made && onMade(made))
          .finally(() => setBusy(false));
      }}
      trigger={
        <Button size="sm" data-files-new className="ms-1 shrink-0" disabled={busy}>
          <Plus />
          <BusyLabel busy={busy} label="New" />
        </Button>
      }
    />
  );
}

/** The bar's own words for a verb, where they are shorter than the menu's: "Move", not "Move to…". */
/** The verbs a row's LifeOS session runs: none is offered for a row that session shuts. */
const SESSION_ACTS: ReadonlySet<EntryAct> = new Set<EntryAct>(["open", "open-form", "open-side", "open-app", "share"]);
const BULK_WORDS: Partial<Record<EntryAct, string>> = { move: "Move", copy: "Copy" };
/** Share in Teams for one row of a place others open: live once the host names its page, else greyed with where to share it. */
const shareInOf = (acts: PageActs, on: readonly FileEntry[]): { shareIn?: { home: string; refused?: string } } =>
  acts.shareIn && on.length === 1 ? { shareIn: { home: acts.shareIn.home, ...(acts.shareIn.pageOf(on[0]!) ? {} : { refused: `Share it from ${acts.shareIn.home}.` }) } } : {};
/** The key a row's verb answers to, shown at its row's end (a PC's Delete key alone deletes, so it is not shown there). */
const ROW_KEYS: Partial<Record<EntryAct, string>> = { "quick-look": "Quick Look", rename: "Rename", delete: "Delete" };

/** With two or more selected, one bar floats at the foot of the list: how many, the verbs for them all, and Clear. */
function BulkBar({ count, rows, onAsk, onAct, onClear }: { count: number; rows: readonly ActRow[]; onAsk?(): void; onAct(act: EntryAct): void; onClear(): void }) {
  const shown = rows.filter((row) => row.act === "download" || row.act === "move" || row.act === "copy" || row.act === "keep" || row.act === "delete" || row.act === "restore" || row.act === "purge");
  return (
    <div data-files-bulk role="toolbar" aria-label={`${count} selected`} className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      <div className="pointer-events-auto flex h-10 max-w-full items-center gap-1 rounded-xl bg-popover px-2 shadow-overlay ring-1 ring-border">
        <span className="px-2 text-[13px] font-medium whitespace-nowrap text-foreground tabular-nums">{count} selected</span>
        {onAsk ? (
          <Button variant="ghost" size="sm" data-files-bulk-ask onClick={onAsk}>
            Ask
          </Button>
        ) : null}
        {shown.map((row) => (
          <Tip key={row.act} label={row.refused ?? row.label} disabled={!row.refused}>
            <span className="inline-flex">
              <Button variant="ghost" size="sm" disabled={!!row.refused} className={row.danger ? "text-destructive" : ""} onClick={() => onAct(row.act)}>
                {BULK_WORDS[row.act] ?? row.label.replace("…", "")}
              </Button>
            </span>
          </Tip>
        ))}
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** A Microsoft form being made in Forms on the box browser, in the state line's place: the stage it is at. */
function MakingLine({ stage }: { stage: string }) {
  return (
    <div data-files-making role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <Spinner className="size-3 shrink-0" />
      <span className="min-w-0 truncate text-foreground">{stage}</span>
    </div>
  );
}

/** An upload under way: the file now going and how far, with Cancel, in the state line's place. */
function UploadLine({ progress, onCancel }: { progress: UploadProgress; onCancel(): void }) {
  const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0;
  return (
    <div data-files-upload role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <Spinner className="size-3 shrink-0" />
      <span className="min-w-0 truncate font-medium text-foreground">Uploading {progress.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground tabular-nums">
        {progress.count > 1 ? `${progress.index + 1} of ${progress.count}, ` : ""}
        {percent}%
      </span>
      <Button variant="ghost" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** The shown page's answer to the Files commands that act on a folder (⌘⇧N, New Folder), held while it is drawn. */
export type PageCommands = { current: ((command: "new-folder") => void) | null };

export function PageView({
  page,
  panelId,
  listing,
  copy,
  from = null,
  trail,
  canBack,
  canForward,
  busy,
  commands,
  note,
  fixes,
  acts = null,
  find = null,
  under,
  results = false,
  lifeosHost = null,
  drawn,
  seat = null,
  pictures = null,
  onFetch,
  onReveal,
  onBack,
  onForward,
  onGo,
  onOpen,
}: {
  page: FilePage;
  panelId: string;
  /** the folder's rows; null while its place is not known yet */
  listing: (Listing & { loadMore(): void; retry(): void | Promise<void>; retryRest?(): Promise<void> }) | null;
  /** the copy of the place the folder is read from */
  copy: PlaceCopy | null;
  /** where the folder's rows are asked, for the shapes that list more than this folder (Columns); null where there is no host to ask */
  from?: ListFrom | null;
  trail: readonly FileCrumb[];
  canBack: boolean;
  canForward: boolean;
  busy: Busy;
  /** where this page answers the Files commands that act on its folder; absent, it answers none */
  commands?: PageCommands;
  /** in the list's place, when there is no place to list (no Teams files, and why) */
  note?: FilesNote | null;
  fixes: NoteFixes;
  /** what can be done to what is in the page; absent, its rows open and nothing more */
  acts?: PageActs | null;
  /** Go to and Search in the trail's place; absent where the workspace's host keeps no names (a release behind) */
  find?: PageFind | null;
  /** a bar of the page's own under its bar (a search's filters) */
  under?: ReactNode;
  /** the rows are a search's results from many places: the second column says where each lives */
  results?: boolean;
  /** a search's: the host whose LifeOS rows it reads (the workspace's, with LifeOS among the places searched); a lens of his
   * marks: the host that opens its LifeOS rows (the workspace's, for a job with a sector); null where it reads none */
  lifeosHost?: string | null;
  /** the shape and order to draw with, in place of the ones this window keeps for the folder (a preview page) */
  drawn?: PageLook & { picked?: readonly string[]; renaming?: string; quick?: boolean };
  /** the window's Beside seat, where a file of the workspace's own host opens as itself beside the list */
  seat?: BesideSeatOf | null;
  /** where the rows' pictures are asked, on a page with no one folder to list from (a search's results) */
  pictures?: PictureFrom | null;
  /** Show in Its Folder, for a row of a lens or of a search's results: goes to the folder it lives in */
  onReveal?(entry: FileEntry): void;
  /** brings a file kept in the cloud onto its computer (Download and look) */
  onFetch?(entry: FileEntry): Promise<void>;
  onBack(): void;
  onForward(): void;
  onGo(page: FilePage): void;
  onOpen(entry: FileEntry): void;
}) {
  const [kept, setLook] = usePageLook(page.at);
  // Under 600px of page the view switch gives its room to the trail: the shapes are rows of View options instead.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [tight, setTight] = useState(false);
  useEffect(() => {
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setTight(root.clientWidth > 0 && root.clientWidth < 600);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    return () => watch.disconnect();
  }, [root]);
  const look = drawn ?? kept;
  const sort = look.sort ?? DEFAULT_SORT;
  const compact = look.compact === true;
  // Search's field filters the folder shown as he types: only the names that hold every word stay.
  const [filter, setFilter] = useState("");
  const listed = listing?.entries ?? NO_ENTRIES;
  const named = useMemo(() => {
    const words = nameWords(filter);
    return words.length ? listed.filter((e) => matchesName(e.name, words)) : listed;
  }, [listed, filter]);
  // Under headings (the list alone draws them), the rows stand group by group: the arrows walk them in that order.
  const grouping = (look.shape ?? "list") === "list" ? (look.group ?? null) : null;
  const [entries, heads] = useMemo((): [readonly FileEntry[], ReadonlyMap<number, string> | null] => {
    if (!grouping) return [named, null];
    const groups = groupEntries(named, grouping, Date.now());
    return [groups.flatMap((g) => g.entries), groupHeads(groups)];
  }, [named, grouping]);
  const order = useMemo(() => entries.map((e) => e.key), [entries]);
  const [state, setPicked] = useState<Picked>(() => (drawn?.picked?.length ? { keys: new Set(drawn.picked), cursor: drawn.picked[0]!, anchor: drawn.picked[0]! } : NOTHING_PICKED));
  const [renaming, setRenaming] = useState<string | null>(drawn?.renaming ?? null);
  /** a thing New just made, named as soon as its row is listed */
  const [fresh, setFresh] = useState<string | null>(null);
  // Another folder starts with nothing selected; a selection is held to the rows that are still there.
  const at = useRef(page.at);
  if (at.current !== page.at) {
    at.current = page.at;
    if (state !== NOTHING_PICKED) setPicked(NOTHING_PICKED);
    if (renaming !== null) setRenaming(null);
    if (filter) setFilter("");
  }
  const picked = pickedAmong(state, order);
  useEffect(() => {
    if (fresh === null || !order.includes(fresh)) return;
    setPicked({ keys: new Set([fresh]), cursor: fresh, anchor: fresh });
    setRenaming(fresh);
    setFresh(null);
  }, [fresh, order]);
  const chosen = useMemo(() => entries.filter((e) => picked.keys.has(e.key)), [entries, picked]);
  const inTrash = acts?.place.kind === "trash";
  const pics: PictureFrom | null = from ?? pictures;
  // Quick Look: Space on the row the arrows rest on; it follows the list until Space or Escape.
  const [quick, setQuick] = useState(drawn?.quick === true);
  // Opened by a press (the row's Quick Look) it plays its entrance; by Space it appears at once.
  const [lookPressed, setLookPressed] = useState(false);
  const cursor = picked.cursor ? (entries.find((e) => e.key === picked.cursor) ?? null) : null;
  const looked = quick && cursor && !inTrash ? cursor : null;
  if (quick && !cursor) setQuick(false);

  // Columns lists each folder from its place's top, so it needs a host to ask; a page with none is drawn as the list.
  const shape: PageShape = look.shape === "columns" && !from ? "list" : (look.shape ?? "list");
  const tile = look.tile ?? DEFAULT_TILE;
  // A lens and a page of results list files from many places: there the rows can stand under where each lives.
  const manyPlaces = results || listed.some((e) => e.where);
  const group = look.group ?? null;
  const details = look.details === true && (shape === "list" || shape === "grid");
  const rows: MenuRow[] = useMemo(
    () => [
      ...(tight
        ? ([{ kind: "label", label: "View" }, ...PAGE_SHAPES.map((id): MenuRow => ({ kind: "item", id: `shape:${id}`, label: SHAPE_WORDS[id], checked: shape === id, disabled: id === "columns" && !from })), { kind: "sep" }] satisfies MenuRow[])
        : []),
      ...(shape === "list"
        ? ([
            { kind: "item", id: "rows:roomy", label: "Comfortable rows", checked: !compact },
            { kind: "item", id: "rows:compact", label: "Compact rows", checked: compact },
            { kind: "sep" },
          ] satisfies MenuRow[])
        : []),
      ...(shape === "grid" ? ([...TILE_SIZES.map((size) => ({ kind: "item" as const, id: `tile:${size}`, label: TILE_WORDS[size], checked: tile === size })), { kind: "sep" }] satisfies MenuRow[]) : []),
      { kind: "label", label: "Sort by" },
      ...SORTS.map(([by, label]): MenuRow => ({ kind: "item", id: `sort:${by}`, label, checked: sort.by === by, ...(sort.by === by ? { hint: SORT_DIR[by][sort.dir] } : {}) })),
      ...(shape === "list"
        ? ([
            { kind: "sep" },
            { kind: "label", label: "Group by" },
            { kind: "item", id: "group:none", label: "None", checked: group === null },
            { kind: "item", id: "group:kind", label: GROUP_WORDS.kind, checked: group === "kind" },
            { kind: "item", id: "group:date", label: GROUP_WORDS.date, checked: group === "date" },
            ...(manyPlaces ? ([{ kind: "item", id: "group:place", label: GROUP_WORDS.place, checked: group === "place" }] satisfies MenuRow[]) : []),
          ] satisfies MenuRow[])
        : []),
      ...(shape === "list" || shape === "grid" ? ([{ kind: "sep" }, { kind: "item", id: "details", label: "Show Details", checked: details }] satisfies MenuRow[]) : []),
    ],
    [compact, shape, sort.by, sort.dir, tile, group, manyPlaces, details, tight, from],
  );
  const pickOption = (id: string): void => {
    const picked = PAGE_SHAPES.find((name) => id === `shape:${name}`);
    if (picked) return setLook({ ...look, shape: picked });
    if (id === "rows:roomy") return setLook({ ...look, compact: false });
    if (id === "rows:compact") return setLook({ ...look, compact: true });
    if (id === "details") return setLook({ ...look, details: !details });
    if (id.startsWith("group:")) {
      const next = id.slice(6);
      const { group: _was, ...rest } = look;
      return setLook(next === "none" ? rest : { ...rest, group: next as PageGroup });
    }
    // A press on the order it already has turns it round.
    const by = SORTS.find(([name]) => id === `sort:${name}`)?.[0];
    if (by) return setLook({ ...look, sort: { by, dir: sort.by === by ? (sort.dir === "asc" ? "desc" : "asc") : by === "changed" || by === "size" ? "desc" : "asc" } });
    const size = TILE_SIZES.find((n) => id === `tile:${n}`);
    if (size) setLook({ ...look, tile: size });
  };
  // A row of Trash is no file to open: Put back is its verb.
  // A search that reads LifeOS while its host's LifeOS is down or on its way leaves LifeOS's rows out: one line over
  // the results says why, by the rule, and the search runs again once LifeOS is back. A lens of his marks keeps its
  // LifeOS rows, greyed and shut, as Home does, under the same one line; each opens again once LifeOS is back.
  const searchHost = results ? lifeosHost : null;
  const hostLive = useHostLive(lifeosHost ?? "");
  const hostSays = !!lifeosHost && (!!hostLive.down || hostLive.waits);
  const sessionHeld = useMemo(() => (!results && hostSays ? new Set(listed.filter(readsSession).map((e) => e.key)) : null), [results, hostSays, listed]);
  const lineSays = hostSays && (results || !!sessionHeld?.size);
  // A row only a LifeOS session that is down opens is shut (`sessionHeld`): the line over the list says why.
  const open = (entry: FileEntry): void => (inTrash || sessionHeld?.has(entry.key) ? undefined : entry.folder ? onGo({ at: entry.folder, name: entry.name }) : onOpen(entry));
  const pickedAt = useRef(0);
  const onPick = (key: string | null, how: PickHow = "one", onName = false): void => {
    if (key === null) return setPicked(NOTHING_PICKED);
    // A slow second press on the name of the one thing selected starts its rename; a quick one is a double click, which opens.
    const again = onName && how === "one" && picked.keys.size === 1 && picked.keys.has(key);
    if (again && Date.now() - pickedAt.current > RENAME_AFTER_MS && acts && !inTrash && !refusal(acts.place, "rename", entries.find((e) => e.key === key))) return setRenaming(key);
    pickedAt.current = Date.now();
    setPicked(pick(picked, order, key, acts ? how : "one"));
  };

  // The verbs for what is selected: one table for a row's menu, the bar and the keys.
  // A page that only shows (a search's results) still opens a row and shows the folder it lives in.
  const plain = (on: readonly FileEntry[]): ActRow[] => (on.length === 1 ? [{ act: "open", label: "Open" }, ...(onReveal && on[0]!.where ? ([{ act: "reveal", label: "Show in Its Folder" }] satisfies ActRow[]) : [])] : []);
  // A row shut by its LifeOS session offers no verb that session runs: it can still be starred, or shown in its folder.
  const unshut = (list: ActRow[], on: readonly FileEntry[]): ActRow[] => (on.some((e) => sessionHeld?.has(e.key)) ? list.filter((row) => !SESSION_ACTS.has(row.act)) : list);
  const verbs = unshut(acts ? actsFor(chosen, acts.place, { tabs: acts.tabs, side: !!acts.openSide, reveal: !!onReveal, projects: !!acts.projects?.length, restore: !!acts.restore, purge: !!acts.purge, app: !!acts.openApp, share: !!acts.share, look: !inTrash, download: !!acts.download, ...shareInOf(acts, chosen), ...(acts.far ? { far: acts.far } : {}) }) : plain(chosen), chosen);
  const run = (act: EntryAct, on: readonly FileEntry[] = chosen): void => {
    const one = on[0];
    if (!one) return;
    if (act === "open") return open(one);
    if (act === "quick-look") {
      setPicked({ keys: new Set([one.key]), cursor: one.key, anchor: one.key });
      setLookPressed(true);
      return setQuick(true);
    }
    if (act === "open-form") return one.answersTo ? open(formEntryOf(one.answersTo)) : undefined;
    if (act === "reveal") return onReveal?.(one);
    if (!acts) return;
    if (act === "open-tab") return acts.openTab(one);
    if (act === "open-side") return acts.openSide?.(one);
    if (act === "keep") return acts.keep?.(on);
    if (act === "project-out") return one.project ? acts.project?.(one, one.project, false) : undefined;
    if (act === "open-app") return acts.openApp?.(one);
    if (act === "share") {
      const page = acts.shareIn?.pageOf(one);
      return acts.shareIn ? (page ? acts.shareIn.open(page) : undefined) : acts.share?.(one);
    }
    if (act === "download") return acts.download?.(on);
    if (act === "rename") return setRenaming(one.key);
    if (act === "move" || act === "copy") return acts.carry(act, on);
    if (act === "star" || act === "unstar") return acts.star(on, act === "star");
    if (act === "delete") return acts.trash(on);
    if (act === "restore") return acts.restore?.(on);
    if (act === "purge") return acts.purge?.(on);
  };
  const menuFor = (id: string | null): MenuRow[] | null => {
    const on = id !== null && !picked.keys.has(id) ? entries.filter((e) => e.key === id) : chosen;
    const list = unshut(acts ? actsFor(on, acts.place, { tabs: acts.tabs, side: !!acts.openSide, reveal: !!onReveal, projects: !!acts.projects?.length, restore: !!acts.restore, purge: !!acts.purge, app: !!acts.openApp, share: !!acts.share, look: !inTrash, download: !!acts.download, ...shareInOf(acts, on), ...(acts.far ? { far: acts.far } : {}) }) : plain(on), on);
    if (!list.length) return null;
    // Add to a Project lists the sector's projects, less the one the file is in, before Delete.
    const one = on.length === 1 && !on[0]!.folder ? on[0]! : null;
    const adds = one && acts?.projects && acts.place.kind !== "mail" && acts.place.kind !== "trash" ? acts.projects.filter((p) => p.id !== one.project?.id) : [];
    const add: MenuRow[] = adds.length ? [{ kind: "sub", id: "project-add", label: "Add to a Project", items: adds.map((p): MenuRow => ({ kind: "item", id: `project-add:${p.id}`, label: p.name })) }] : [];
    return list.flatMap((row): MenuRow[] => [
      ...(row.act === "delete" ? add : []),
      ...(row.rule ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
      { kind: "item", id: row.act, label: row.label, ...(row.refused ? { disabled: true, reason: row.refused } : {}), ...(row.danger ? { danger: true } : {}), ...(ROW_KEYS[row.act] && (row.act !== "delete" || IS_MAC) ? { shortcut: shortcutFor("Files (Work)", ROW_KEYS[row.act]!) } : {}) },
    ]);
  };
  // ⌘⇧N makes a folder here where New would offer one, named in place as New's are (decision 2 of the files pass).
  const makesFolder = !!acts && !inTrash && (acts.place.makes ?? []).includes("folder") && !(listing?.error && !listed.length);
  useEffect(() => {
    if (!commands) return;
    commands.current = (command) => {
      if (command === "new-folder" && makesFolder) void acts!.make("folder").then((made) => made && setFresh(made.key));
    };
    return () => {
      commands.current = null;
    };
  });
  // The keys for what is selected, heard from anywhere in the page but a field he is typing in.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
    const can = (act: EntryAct): boolean => verbs.some((row) => row.act === act && !row.refused);
    if (event.key === "a" && modOrCtrl(event) && !event.shiftKey && !event.altKey && acts && order.length) return void (event.preventDefault(), setPicked(pickAll(order)));
    // ⌘⌫ moves the selection to Trash, as in Finder (in Trash, deletes it for good, asked first); a bare ⌫ does
    // nothing, so a stray press while he thinks a field has focus moves no file. A PC's bare Delete does as Explorer's.
    const deleteKey = event.key === "Backspace" || event.key === "Delete";
    if (deleteKey && chosen.length && !event.altKey && !event.shiftKey && (modOrCtrl(event) || (!IS_MAC && event.key === "Delete" && !chordKey(event)))) {
      if (can("delete")) return void (event.preventDefault(), run("delete"));
      if (can("purge")) return void (event.preventDefault(), run("purge"));
      return;
    }
    if (chordKey(event)) return;
    if (event.key === "/" && find) return void (event.preventDefault(), find.setMode("search"));
    // Space is Quick Look for the row the arrows rest on, from the folder itself (a button keeps its own Space).
    if (event.key === " " && cursor && !inTrash && renaming === null && (event.target as HTMLElement).closest("[data-files-body]") && !(event.target as HTMLElement).closest("button, a, video, audio")) return void (event.preventDefault(), setLookPressed(false), setQuick(!quick));
    if (event.key === "F2" && can("rename")) return void (event.preventDefault(), run("rename"));
  };

  const drag = useRowDrag(acts && !inTrash ? acts : null, entries, picked, page);
  // A place read through the host's LifeOS session while that session is down says its state in the body's place, by
  // the host's live status, and lists again by itself once it is back; nothing that needs the session is offered.
  const lifeos = useLifeosPlace(copy, listing);
  const lifeosDown = readsLifeos(copy) && (!!lifeos.down || lifeos.waits);
  // Back since its last read failed, and listing again: the list's bones, never the old cause.
  const lifeosAgain = readsLifeos(copy) && !!lifeos.again;
  const newestListing = useRef(listing);
  newestListing.current = listing;
  useLiveDown(null, searchHost, () => newestListing.current?.retry());
  const shapeProps: ShapeProps = {
    entries,
    picked,
    busy,
    // A page that failed waits for Retry on its line, rather than being asked again on every scroll.
    more: !!listing?.more && !listing.error,
    // A later page on its way (the places still searched are said on the page's line, not at its foot).
    loadingMore: !!listing && entries.length > 0 && listing.loading && listing.more && !listing.retrying,
    renaming,
    onPick,
    onOpen: open,
    onMore: () => listing?.loadMore(),
    onRenamed: (entry, name) => {
      setRenaming(null);
      if (name !== null && acts) void acts.rename(entry, name).then((made) => made && setPicked({ keys: new Set([made.key]), cursor: made.key, anchor: made.key }));
    },
    ...(drag ? { drag } : {}),
    ...(sessionHeld?.size ? { sessionHeld } : {}),
  };
  // A folder in the VM says what its own answer said of the machine; rows it read live (no kept time: a host a release
  // behind says one for a kept list) put the place's older "asleep" away.
  const slept = copy && listing ? vmSleepNote(copy, listing, clockTime) : null;
  const placeSaid = copy ? placeNote(copy, clockTime) : null;
  const vmLive = !!copy?.place.vm && !!listing?.loaded && !listing.loading && !listing.sleeping && !listing.asOf && !listing.error;
  const down = slept ?? (vmLive && placeSaid?.fix?.kind === "wake" ? null : placeSaid);
  // Wake it over a VM folder is his press for that folder: it is listed again, and the wake goes on behind the answer.
  const noteFixes: NoteFixes = copy?.place.vm && listing ? { ...fixes, busy: fixes.busy || !!listing.retrying, run: (fix) => (fix.kind === "wake" ? listing.retry() : fixes.run(fix)) } : fixes;
  const parent = trail.length > 1 ? trail[trail.length - 2]! : null;
  const toParent = parent ? () => onGo({ at: parent.at, name: parent.name }) : undefined;
  // A search that left a place out says so, with Retry, whether or not anything came back.
  const gap = results && listing?.loaded && !listing.error ? searchGap(listing) : null;
  // A folder that is gone, or one he may not read, cannot come back on Retry: the folder above it is the way on, else
  // Back, else nothing to press. Retry is for a host that did not answer.
  const refused = !!listing?.error && readRefused(listing.error);
  const gone = refused || (!!listing?.error && folderGone(listing.error));
  const way = gone && parent ? { label: `Open ${parent.name}`, onClick: toParent! } : gone && canBack ? { label: "Back", onClick: onBack } : refused ? undefined : { label: "Retry", onClick: () => void listing?.retry() };
  // His Retry (or Wake it) keeps the state it was pressed on, spinning; any other read with no rows draws the bones, and
  // so does a search with none while LifeOS, which it also reads, is on its way.
  const retrying = !!listing?.retrying;
  const pressedOn = !!listing?.error || !!gap?.fix || !!down?.fix;
  const reading = !!listing && ((listing.loading && !(retrying && pressedOn)) || (!!searchHost && hostSays && hostLive.waits));
  let body: ReactNode;
  if (note) body = <NoteEmpty note={note} fixes={fixes} />;
  else if (lifeosDown)
    body = (
      <DownEmpty
        live={lifeos}
        environmentId={copy!.link}
        // Retry is for silence: it asks the host's LifeOS status again, then the folder.
        onRetry={() => refreshLifeos(copy!.link).catch(() => undefined).then(() => listing?.retry())}
      />
    );
  else if (!listing || !listing.loaded || (!entries.length && (lifeosAgain || listing.searching || !!listing.pending?.length || reading))) body = <ListBones compact={compact} />;
  else if (listing.error && !entries.length) body = listing.away ? null : <FailedEmpty title="This folder did not load" line={listing.error} {...(way ? { action: way } : {})} busy={retrying && way?.label === "Retry"} />;
  else if (!entries.length && filter) body = (
      // Clear filters puts the whole folder and its trail back; Return in the field still searches every place.
      <EmptyState
        title="Nothing here by that name"
        line="Return searches every place."
        action={{
          label: "Clear filters",
          onClick: () => {
            setFilter("");
            find?.setMode(null);
          },
        }}
      />
    );
  else if (!entries.length && results) body = <FailedEmpty title="Nothing found" line={gap ? `${gap.title}.` : listing.more ? "Some places are still being searched." : undefined} {...(gap?.fix ? { action: { label: "Retry", onClick: () => void listing.retry() } } : {})} busy={retrying} />;
  else if (!entries.length)
    body =
      down && (down.fix?.kind !== "wake" || !!slept) ? (
        <NoteEmpty note={down} fixes={noteFixes} />
      ) : inTrash ? (
        <EmptyState title="Trash is empty" line="What you delete waits here for 30 days." />
      ) : (
        <EmptyState title="This folder is empty" />
      );
  else if (shape === "columns" && from)
    body = (
      <FileColumns
        from={from}
        page={page}
        trail={trail}
        sort={sort}
        rows={entries}
        picked={picked}
        renaming={renaming}
        onPick={onPick}
        onRenamed={shapeProps.onRenamed}
        drag={shapeProps.drag}
        // A folder walked to through the columns is drawn in columns too: the shape goes with him down and back up.
        onGo={(next) => {
          if (!drawn) keepPageLook(next.at, { ...pageLookOf(next.at), shape: "columns", sort: look.sort });
          onGo(next);
        }}
        onOpen={open}
        {...(sessionHeld?.size ? { sessionHeld } : {})}
      />
    );
  else if (shape === "gallery") body = <FileGallery {...shapeProps} from={pics} {...(onFetch ? { onFetch } : {})} />;
  else if (shape === "beside") body = <FileBeside {...shapeProps} from={pics} seat={inTrash ? null : sessionHeld?.size && seat ? { ...seat, can: (entry) => !sessionHeld.has(entry.key) && seat.can(entry) } : seat} onParent={toParent} {...(onFetch ? { onFetch } : {})} />;
  else {
    const folder =
      shape === "grid" ? (
        <FileGrid {...shapeProps} size={tile} from={pics} onParent={toParent} />
      ) : (
        // The list's columns leave by the list's own width, with the details pane beside it or not.
        <div className="@container/files-list flex min-h-0 min-w-0 flex-1 flex-col">
          <Head sort={sort} second={inTrash ? "Was in" : manyPlaces && acts?.place.kind !== "made" ? "Where" : "Last change by"} onSort={(next) => setLook({ ...look, sort: next })} />
          <FileList {...shapeProps} compact={compact} heads={heads} onParent={toParent} bulk={!!acts && chosen.length >= 2} />
        </div>
      );
    // Show Details: the selected file's picture and facts beside the folder, where there is room for both.
    body = details ? (
      <div className="flex min-h-0 flex-1">
        {folder}
        <DetailsPane from={pics} entry={chosen.length === 1 ? chosen[0]! : null} onOpen={open} className="hidden h-full w-72 shrink-0 border-s border-border @[640px]/files-body:block" />
      </div>
    ) : (
      folder
    );
  }
  // One line over the list at most: an upload under way, the folder that did not load on a machine that is away, else what its place says.
  const line = lifeosDown || lifeosAgain ? null : lineSays ? (
    <div data-files-note className="flex min-h-8 min-w-0 shrink-0 items-center border-b border-border bg-background px-3 py-1">
      <HostLine live={hostLive} className="min-h-6 flex-1" />
    </div>
  ) : acts?.uploading ? (
    <UploadLine progress={acts.uploading} onCancel={acts.cancelUpload} />
  ) : acts?.forms?.making ? (
    <MakingLine stage={acts.forms.stage ?? "Making the form…"} />
  ) : listing?.error && listing.away ? (
    // The word says it did not answer; the detail says what is still shown, as the asleep line does, never the same again.
    <ViewStateLine word={`${copy?.host ?? "The host"} did not answer`} {...(entries.length && listing.asOf ? { detail: `This is the list from ${clockTime(listing.asOf)}.` } : {})} onRetry={listing.lostPage ? (listing.retryRest ?? listing.loadMore) : listing.retry} />
  ) : listing?.error && entries.length ? (
    // The rows it has stay; a later page that failed is asked again from where it stopped.
    <ViewStateLine word={listing.lostPage ? "The rest did not load" : "This folder did not load"} detail={listing.error} onRetry={listing.lostPage ? (listing.retryRest ?? listing.loadMore) : listing.retry} />
  ) : results && listing?.pending?.length ? (
    // A place still being searched: its rows join below as it answers, and the line says which.
    <NoteLine note={searchingNote(listing.pending)!} fixes={noteFixes} />
  ) : gap && entries.length ? (
    <NoteLine note={gap} fixes={{ busy: listing!.loading, run: () => listing!.retry() }} />
  ) : down && !note && entries.length ? (
    <NoteLine note={down.fix?.kind === "wake" && listing?.asOf ? { ...down, line: `This is the list from ${clockTime(listing.asOf)}.` } : down} fixes={noteFixes} />
  ) : null;
  // Files dropped from the desktop on the page land in its folder; on a folder row, in that folder (the row takes the drop first).
  const takesFiles = !!acts && !inTrash && canDo(acts.place, "upload");
  const [filesOver, setFilesOver] = useState(false);
  const fromDesktop = (event: DragEvent): boolean => takesFiles && !dragging() && [...event.dataTransfer.types].includes("Files");
  return (
    <div
      ref={setRoot}
      role="tabpanel"
      id={panelId}
      data-files-page
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      onKeyDown={onKeyDown}
      // Escape closes Quick Look before the list under it hears the key.
      onKeyDownCapture={(event) => {
        if (!looked || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        setQuick(false);
      }}
    >
      <PageBar name={page.name} trail={trail} canBack={canBack} canForward={canForward} onBack={onBack} onForward={onForward} onGo={onGo} find={find} filter={filter} onFilter={setFilter}>
        {tight ? null : (
        <ToggleGroup
          size="sm"
          spacing={0}
          aria-label="View"
          className="shrink-0"
          value={[shape]}
          onValueChange={(value) => {
            const next = value[0] as PageShape | undefined;
            if (next) setLook({ ...look, shape: next });
          }}
        >
          {PAGE_SHAPES.map((id) => {
            const Glyph = SHAPE_GLYPH[id];
            return (
              <Tip key={id} label={SHAPE_WORDS[id]}>
                <ToggleGroupItem value={id} aria-label={SHAPE_WORDS[id]} data-files-shape={id} disabled={id === "columns" && !from}>
                  <Glyph />
                </ToggleGroupItem>
              </Tip>
            );
          })}
        </ToggleGroup>
        )}
        <RowsMenu
          label="View options"
          align="end"
          rows={rows}
          onPick={pickOption}
          tip={{ label: "View options" }}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="View options" className="shrink-0 text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
        />
        {inTrash && acts?.purge && entries.length ? (
          // Quiet in the bar beside its glyphs, red only under the pointer: the confirm it asks is the red verb.
          <Button variant="ghost" size="sm" data-files-empty-trash className="ms-1 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => acts.purge?.()}>
            Empty Trash
          </Button>
        ) : null}
        {/* New makes a file in this folder: not while its session is away, nor in a folder whose read failed with nothing listed. */}
        {acts && !inTrash && !lifeosDown && !lifeosAgain && !(listing?.error && !listed.length) ? <NewMenu acts={acts} name={page.name} onMade={(made) => setFresh(made.key)} /> : null}
      </PageBar>
      {under}
      {line}
      <RowsContextMenu label="File" lazyMount rowsFor={menuFor} onPick={(pickId, id) => {
        const on = id !== null && !picked.keys.has(id) ? entries.filter((e) => e.key === id) : chosen;
        const project = pickId.startsWith("project-add:") ? acts?.projects?.find((p) => p.id === pickId.slice("project-add:".length)) : undefined;
        if (project && on[0]) return acts?.project?.(on[0], project, true);
        run(pickId as EntryAct, on);
      }} onOpenChange={(opened, id) => {
        // A right-click on a row that is not selected selects it alone, so the menu is plainly about it.
        if (opened && id !== null && !picked.keys.has(id)) setPicked(pick(NOTHING_PICKED, order, id, "one"));
        // Share in Teams asks the host for the file's page as the menu opens: greyed until it answers.
        const shown = opened ? (id !== null && !picked.keys.has(id) ? entries.filter((e) => e.key === id) : chosen) : [];
        if (shown.length === 1) acts?.shareIn?.ask(shown[0]!);
      }}>
        <div
          data-files-body
          data-files-over={filesOver || undefined}
          className={`@container/files-body relative flex min-h-0 flex-1 flex-col ${filesOver ? "bg-muted/60" : ""}`}
          onDragOver={(event) => {
            if (!fromDesktop(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!filesOver) setFilesOver(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setFilesOver(false);
          }}
          onDrop={(event) => {
            setFilesOver(false);
            if (!fromDesktop(event) || !acts) return;
            event.preventDefault();
            // Files claims the drop: the canvas's own rule for a drop on a thread is not asked.
            claimFileDrop(event.nativeEvent);
            acts.upload([...event.dataTransfer.files]);
          }}
        >
          {body}
          {acts && chosen.length >= 2 ? <BulkBar count={chosen.length} rows={verbs} {...(acts.ask && !inTrash ? { onAsk: () => acts.ask!(chosen) } : {})} onAct={(act) => run(act)} onClear={() => setPicked(NOTHING_PICKED)} /> : null}
        </div>
      </RowsContextMenu>
      {looked ? (
        <QuickLook
          entry={looked}
          where={looked.where ? whereWords(looked.where) : page.name}
          from={pics}
          onOpen={(entry) => {
            setQuick(false);
            open(entry);
          }}
          onClose={() => setQuick(false)}
          pressed={lookPressed}
          still={drawn?.quick === true}
          {...(onFetch ? { onFetch } : {})}
        />
      ) : null}
    </div>
  );
}

const NO_ENTRIES: readonly FileEntry[] = [];
/** The orders a folder can be listed in, as the host sorts them, and what each direction is called. */
const SORTS: readonly (readonly [FileSortBy, string])[] = [
  ["name", "Name"],
  ["changed", "When Changed"],
  ["size", "Size"],
  ["kind", "Kind"],
];
const SORT_DIR: Record<FileSortBy, Record<"asc" | "desc", string>> = {
  name: { asc: "A to Z", desc: "Z to A" },
  changed: { asc: "Oldest first", desc: "Newest first" },
  size: { asc: "Smallest first", desc: "Largest first" },
  kind: { asc: "A to Z", desc: "Z to A" },
};
/** A second press on a selected name is a rename only after this long: sooner, it is the second half of a double click. */
export const RENAME_AFTER_MS = 500;

/**
 * Rows dragged within a page: onto a folder row is a move inside one place; ⌥ copies. The target takes the
 * `muted` fill and the pointer carries the verb; nothing moves until the drop.
 */
function useRowDrag(acts: PageActs | null, entries: readonly FileEntry[], picked: Picked, page: FilePage): RowDrag | null {
  const [over, setOver] = useState<string | null>(null);
  if (!acts) return null;
  const takes = (into: FileEntry, event: DragEvent): { verb: "move" | "copy"; files: boolean } | null => {
    const types = [...event.dataTransfer.types];
    const drag = dragging();
    // Rows the system carries (a drag that can leave the window) read as files: they are still the rows being dragged.
    if (!drag && types.includes("Files")) return canDo(acts.place, "upload") ? { verb: "copy", files: true } : null;
    if (!drag || !(types.includes(ROWS_MIME) || types.includes("Files"))) return null;
    const verb = dropVerb(event, drag.from.place.id === acts.place.id);
    // Never onto itself, and only where the place the rows come from takes the verb for every row dragged.
    if (drag.entries.some((e) => e.key === into.key) || drag.entries.some((e) => carryRefusal(drag.from.place, verb, e, acts.place) !== null)) return null;
    return { verb, files: false };
  };
  const clear = (): void => {
    setOver(null);
    setDragLabel(null);
  };
  return {
    from: canDo(acts.place, "move") || canDo(acts.place, "copy"),
    over,
    onStart(entry, event) {
      const rows = picked.keys.has(entry.key) ? entries.filter((e) => picked.keys.has(e.key)) : [entry];
      // Rows of one folder (not a lens's, which say where each lives) can be moved back there by Undo.
      setDragging({ entries: rows, from: acts.from, ...(rows.some((e) => e.where) ? {} : { back: { at: page.at, name: page.name } }) });
      // Files that lie on this computer go with the system's own drag, so they can be dropped on the desktop; a drop
      // in the Files place still reads what is being dragged from here.
      const out = acts.dragOut?.(rows) ?? null;
      if (out) {
        event.preventDefault();
        void out.finally(() =>
          whenDragEnds(() => {
            setDragging(null);
            clear();
          }),
        );
        return;
      }
      event.dataTransfer.setData(ROWS_MIME, JSON.stringify(rows.map((e) => e.key)));
      event.dataTransfer.effectAllowed = "copyMove";
    },
    onEnd() {
      setDragging(null);
      clear();
    },
    onOver(entry, event) {
      const how = takes(entry, event);
      if (!how) return false;
      event.stopPropagation();
      event.dataTransfer.dropEffect = how.verb;
      if (over !== entry.key) setOver(entry.key);
      setDragLabel({ text: how.files ? `Upload to ${entry.name}` : `${how.verb === "copy" ? "Copy" : "Move"} to ${entry.name}`, x: event.clientX, y: event.clientY });
      return true;
    },
    onLeave(entry) {
      if (over === entry.key) clear();
    },
    onDrop(entry, event) {
      const how = takes(entry, event);
      clear();
      if (!how) return;
      event.stopPropagation();
      if (how.files) {
        claimFileDrop(event.nativeEvent);
        return acts.upload([...event.dataTransfer.files], entry);
      }
      const drag = dragging();
      setDragging(null);
      if (drag?.entries.length) acts.drop(how.verb, drag.entries, entry, drag.from, drag.back);
    },
  };
}
