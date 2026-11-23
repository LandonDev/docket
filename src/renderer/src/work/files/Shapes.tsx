import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileCrumb, FilePage } from "@shared/contract-work-files";
import type { FileEntry, FileSort, FolderRef } from "@shared/work/files";
import { ChevronRight } from "../../chrome/icons";
import { VirtualRows } from "../../chrome/railVirtualRows";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { dayTime } from "../../lib/duration";
import { chordKey, modOrCtrl } from "../../lib/keys";
import { KindGlyph } from "./KindGlyph";
import { factOf, gridStep, samePage, tilesAcross, type Picked, type PickHow, type TileSize } from "./model";
import type { Busy } from "./open";
import { dragProps, howOf, NameField, onNameOf, stepHow, type RowDrag, type ShapeProps } from "./rowParts";
import { DetailsPane, Thumb } from "./Looks";
import type { PictureFrom } from "./previews";
import { useListing, type ListFrom } from "./store";

/**
 * A folder's other shapes (docs/DESIGN.md "The Files place"): Grid, tiles in three sizes with the name under
 * each and one muted fact, the file's own picture where its host draws one; and Columns, a 216px column a folder
 * from the place's top down, the last one the selected file's picture and facts. Both keep the list's rules: a click selects, a second opens, the arrows walk, Return
 * opens, and only what is on screen is mounted once a folder is long.
 */

/** Up to this many tiles a grid is drawn whole. */
const GRID_PLAIN_MOST = 120;
const TILE_GAP = 4;
/** Around a tile's picture: its padding, and the name and fact under it. */
const TILE_PAD = 8;
const TILE_TEXT = 58;
const GLYPH: Record<TileSize, string> = { 96: "size-7", 144: "size-9", 208: "size-12" };

/** A tile: the kind's glyph large where there is no picture of the file to show, its name, one fact. */
function Tile({
  entry,
  index,
  size,
  from,
  on,
  busy,
  renaming,
  drag,
  onPick,
  onOpen,
  onRenamed,
}: {
  entry: FileEntry;
  index: number;
  size: TileSize;
  /** where its picture is asked; null where there is no host to ask */
  from: PictureFrom | null;
  on: boolean;
  busy: Busy;
  renaming: boolean;
  drag?: RowDrag;
  onPick(key: string, how: PickHow, onName?: boolean): void;
  onOpen(entry: FileEntry): void;
  onRenamed(entry: FileEntry, name: string | null): void;
}) {
  const mine = busy?.key === entry.key;
  const over = drag?.over === entry.key;
  const fact = mine ? busy!.word : factOf(entry, dayTime);
  return (
    <div
      id={`files-tile-${index}`}
      role="option"
      aria-selected={on}
      data-files-row={entry.key}
      data-menu-id={entry.key}
      data-kind={entry.kind}
      data-drop-over={over || undefined}
      style={{ width: size + TILE_PAD * 2 }}
      className={`flex shrink-0 cursor-default flex-col gap-1.5 rounded-lg p-2 select-none ${on || over ? "bg-muted" : "hover:bg-foreground/5"}`}
      onClick={(event) => onPick(entry.key, howOf(event), onNameOf(event))}
      onDoubleClick={() => onOpen(entry)}
      {...dragProps(drag, entry)}
    >
      <div className="grid place-items-center overflow-hidden rounded-md bg-(--stage) p-1 outline-1 -outline-offset-1 outline-(--image-outline)" style={{ width: size, height: Math.round(size * 0.75) }}>
        {mine ? <Spinner className="size-4" /> : <Thumb from={from} entry={entry} tile={size} glyph={GLYPH[size]} />}
      </div>
      {/* The fact stands right under the name, one line or two; the room a second line would take is left under it, so rows keep one height. */}
      <div className="flex h-[52px] min-w-0 flex-col">
        {renaming ? (
          <span className="flex items-start">
            <NameField name={entry.name} className="text-center" onDone={(next) => onRenamed(entry, next)} />
          </span>
        ) : (
          <span data-files-name className={`line-clamp-2 text-center text-[13px] leading-[18px] break-words text-foreground ${entry.fresh ? "font-semibold" : ""}`}>
            {entry.name}
          </span>
        )}
        <span className={`truncate text-center text-xs leading-4 tabular-nums ${entry.state?.is === "suggestions" ? "text-warning" : "text-muted-foreground"}`}>{fact || " "}</span>
      </div>
    </div>
  );
}

export function FileGrid({ entries, picked, size, from, busy, more, loadingMore, renaming, onPick, onOpen, onMore, onParent, onRenamed, drag }: ShapeProps & { size: TileSize; from: PictureFrom | null }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // How many tiles a row holds follows the list's own width; four until it is measured (a page drawn with no layout).
  const [across, setAcross] = useState(4);
  useEffect(() => {
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const width = scroller.clientWidth - 16;
      if (width > 0) setAcross(tilesAcross(width, size + TILE_PAD * 2, TILE_GAP));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, size]);
  const rowPx = Math.round(size * 0.75) + TILE_PAD * 2 + TILE_TEXT + TILE_GAP;
  useEffect(() => {
    if (!scroller || !more) return;
    const near = (): void => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < rowPx * 3) onMore();
    };
    near();
    scroller.addEventListener("scroll", near, { passive: true });
    return () => scroller.removeEventListener("scroll", near);
    // `onMore` is the caller's newest each render; the scroller and the count decide when to listen again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, more, entries.length, rowPx]);
  const at = entries.findIndex((e) => e.key === picked.cursor);
  const [reveal, setReveal] = useState<{ index: number } | null>(null);
  const move = (to: number, event: KeyboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (to < 0 || !entries[to]) return;
    onPick(entries[to].key, stepHow(event));
    setReveal({ index: Math.floor(to / across) });
    scroller?.querySelector<HTMLElement>(`#files-tile-${to}`)?.scrollIntoView?.({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp" && modOrCtrl(event) && !event.altKey && !event.shiftKey) return void (event.preventDefault(), onParent?.());
    if (chordKey(event)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") return move(gridStep(at, entries.length, across, event.key), event);
    if (event.key === "Home") return move(0, event);
    if (event.key === "End") return move(entries.length - 1, event);
    if (event.key === "Enter" && at >= 0) return void (event.preventDefault(), onOpen(entries[at]!));
    if (event.key === "Escape" && picked.keys.size) return void (event.preventDefault(), onPick(null));
  };
  const rows = Math.ceil(entries.length / across);
  const row = (r: number): ReactNode => (
    <div key={r} role="presentation" className="flex" style={{ gap: TILE_GAP, height: rowPx - TILE_GAP }}>
      {entries.slice(r * across, (r + 1) * across).map((entry, i) => (
        <Tile key={entry.key} entry={entry} index={r * across + i} size={size} from={from} on={picked.keys.has(entry.key)} busy={busy} renaming={renaming === entry.key} drag={drag} onPick={onPick} onOpen={onOpen} onRenamed={onRenamed} />
      ))}
    </div>
  );
  return (
    <div
      ref={setScroller}
      role="listbox"
      aria-label="Files"
      aria-multiselectable
      aria-orientation="horizontal"
      aria-activedescendant={at >= 0 ? `files-tile-${at}` : undefined}
      tabIndex={0}
      data-files-grid
      className="focus-ring flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-2 outline-none"
      style={{ gap: TILE_GAP }}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onPick(null);
      }}
    >
      {entries.length <= GRID_PLAIN_MOST ? (
        Array.from({ length: rows }, (_, r) => row(r))
      ) : (
        <VirtualRows count={rows} scroller={scroller} scrollMargin={8} estimateSize={() => rowPx - TILE_GAP} getItemKey={(r) => entries[r * across]!.key} gap={TILE_GAP} reveal={reveal} sizeKey="work-files-grid" render={row} />
      )}
      {loadingMore ? (
        <div aria-busy className="flex h-7 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Loading more
        </div>
      ) : null}
    </div>
  );
}

// ── Columns ───────────────────────────────────────────────────────────

const COLUMN_PX = 216;
const COLUMN_ROW_PX = 28;

/** One folder as a column: its rows, the one on the way to the folder shown held in the `muted` fill. */
function Column({
  from,
  at,
  name,
  sort,
  held,
  picked,
  renaming,
  drag,
  active,
  onPick,
  onOpen,
  onRenamed,
  registerRows,
}: {
  from: ListFrom;
  at: FolderRef;
  name: string;
  sort: FileSort;
  /** the folder of this column that the next column shows */
  held: FolderRef | null;
  /** what is selected, in the last folder's column; null in the columns above it */
  picked: Picked | null;
  renaming: string | null;
  drag?: RowDrag;
  /** the last folder's column, which the keys walk */
  active: boolean;
  onPick(entry: FileEntry, how: PickHow): void;
  onOpen(entry: FileEntry): void;
  onRenamed(entry: FileEntry, name: string | null): void;
  registerRows?(rows: readonly FileEntry[]): void;
}) {
  const listing = useListing(from, at, sort);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (active) registerRows?.(listing.entries);
    // The rows are the listing's own array, new only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listing.entries]);
  useEffect(() => {
    if (!scroller || !listing.more) return;
    const near = (): void => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < COLUMN_ROW_PX * 12) listing.loadMore();
    };
    near();
    scroller.addEventListener("scroll", near, { passive: true });
    return () => scroller.removeEventListener("scroll", near);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, listing.more, listing.entries.length]);
  const row = (index: number): ReactNode => {
    const entry = listing.entries[index]!;
    const on = !!picked?.keys.has(entry.key) || (!!held && !!entry.folder && samePage(entry.folder, held));
    const over = active && drag?.over === entry.key;
    return (
      <div
        key={entry.key}
        role="option"
        aria-selected={on}
        data-files-row={entry.key}
        {...(active ? { "data-menu-id": entry.key } : {})}
        data-kind={entry.kind}
        style={{ height: COLUMN_ROW_PX }}
        className={`flex cursor-default items-center gap-2 rounded-md px-2 text-[13px] select-none ${on || over ? "bg-muted" : "hover:bg-foreground/5"}`}
        onClick={(event) => onPick(entry, howOf(event))}
        onDoubleClick={() => (entry.folder ? undefined : onOpen(entry))}
        {...(active ? dragProps(drag, entry) : {})}
      >
        <KindGlyph kind={entry.kind} />
        {active && renaming === entry.key ? (
          <NameField name={entry.name} onDone={(next) => onRenamed(entry, next)} />
        ) : (
          <span className={`min-w-0 flex-1 truncate text-foreground ${entry.fresh ? "font-semibold" : ""}`}>{entry.name}</span>
        )}
        {entry.folder ? <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" /> : null}
      </div>
    );
  };
  let body: ReactNode;
  if (!listing.loaded)
    body = (
      <div role="status" aria-label="Loading" aria-busy className="px-2 pt-1">
        {["w-[60%]", "w-[44%]", "w-[52%]"].map((w, i) => (
          <div key={i} className="flex items-center gap-2 px-2" style={{ height: COLUMN_ROW_PX }}>
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className={`h-3 ${w}`} />
          </div>
        ))}
      </div>
    );
  else if (listing.error && !listing.entries.length)
    body = (
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-muted-foreground">
        <span>This folder did not load.</span>
        <Button variant="ghost" size="xs" onClick={listing.retry}>
          Retry
        </Button>
      </div>
    );
  else if (!listing.entries.length) body = <p className="p-3 text-xs text-muted-foreground">Empty</p>;
  else
    body =
      listing.entries.length <= 80 ? (
        listing.entries.map((_, index) => row(index))
      ) : (
        <VirtualRows count={listing.entries.length} scroller={scroller} scrollMargin={4} estimateSize={() => COLUMN_ROW_PX} getItemKey={(index) => listing.entries[index]!.key} gap={0} reveal={null} sizeKey="work-files-column" render={row} />
      );
  return (
    <div ref={setScroller} role="listbox" aria-label={name} data-files-column={name} className="h-full shrink-0 overflow-x-hidden overflow-y-auto border-e border-border px-1 pt-1 pb-2" style={{ width: COLUMN_PX }}>
      {body}
    </div>
  );
}

export function FileColumns({
  from,
  page,
  trail,
  sort,
  picked,
  renaming,
  drag,
  onPick,
  onRenamed,
  onGo,
  onOpen,
}: {
  from: ListFrom;
  page: FilePage;
  /** the folders from the place's top down to the one shown */
  trail: readonly FileCrumb[];
  sort: FileSort;
  picked: Picked;
  renaming: string | null;
  drag?: RowDrag;
  onPick(key: string | null, how?: PickHow): void;
  onRenamed(entry: FileEntry, name: string | null): void;
  onGo(page: FilePage): void;
  onOpen(entry: FileEntry): void;
}) {
  const steps = trail.length ? trail.filter((c) => !(c.at.at === "place" && c.at.id.startsWith("team:"))) : [{ name: page.name, at: page.at }];
  const box = useRef<HTMLDivElement | null>(null);
  const rows = useRef<readonly FileEntry[]>([]);
  const [, bump] = useState(0);
  // One file selected shows its facts last; several, or a folder, show none.
  const shown = picked.keys.size === 1 ? (rows.current.find((e) => picked.keys.has(e.key) && !e.folder) ?? null) : null;
  // The newest column is the one he is in: it stays in view as columns are added.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [steps.length, shown?.key]);
  const press = (entry: FileEntry, how: PickHow): void => {
    // A folder is walked into on a plain press: its column is added. A file is selected: its facts are the last column.
    if (entry.folder && how === "one") return void onGo({ at: entry.folder, name: entry.name });
    onPick(entry.key, how);
  };
  const last = steps[steps.length - 1]!;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (chordKey(event)) return;
    const list = rows.current;
    const at = list.findIndex((e) => e.key === picked.cursor);
    const to = (index: number): void => {
      const next = list[Math.max(0, Math.min(list.length - 1, index))];
      if (next) onPick(next.key, stepHow(event));
    };
    if (event.key === "ArrowDown") return void (event.preventDefault(), to(at < 0 ? 0 : at + 1));
    if (event.key === "ArrowUp") return void (event.preventDefault(), to(at < 0 ? list.length - 1 : at - 1));
    if (event.key === "ArrowLeft" && steps.length > 1) return void (event.preventDefault(), onGo({ at: steps[steps.length - 2]!.at, name: steps[steps.length - 2]!.name }));
    if ((event.key === "ArrowRight" || event.key === "Enter") && at >= 0) {
      event.preventDefault();
      const entry = list[at]!;
      return entry.folder ? onGo({ at: entry.folder, name: entry.name }) : event.key === "Enter" ? onOpen(entry) : undefined;
    }
    if (event.key === "Escape" && picked.keys.size) return void (event.preventDefault(), onPick(null));
  };
  return (
    <div ref={box} tabIndex={0} data-files-columns className="focus-ring flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden outline-none" onKeyDown={onKeyDown}>
      {steps.map((crumb, i) => (
        <Column
          key={`${i}:${crumb.name}`}
          from={from}
          at={crumb.at}
          name={crumb.name}
          sort={sort}
          held={steps[i + 1]?.at ?? null}
          picked={crumb === last ? picked : null}
          renaming={renaming}
          drag={drag}
          active={crumb === last}
          onPick={press}
          onOpen={onOpen}
          onRenamed={onRenamed}
          registerRows={(list) => {
            rows.current = list;
            bump((n) => n + 1);
          }}
        />
      ))}
      {shown ? <DetailsPane from={from} entry={shown} onOpen={onOpen} className="h-full min-w-64 flex-1" /> : <div className="min-w-0 flex-1" />}
    </div>
  );
}
