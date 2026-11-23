import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { FileEntry, FolderRef } from "@shared/work/files";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { modOrCtrl } from "../../lib/keys";
import { Cloud } from "../icons";
import { stemEnd, type Picked, type PickHow, type PlaceCopy } from "./model";
import type { Busy } from "./open";

/**
 * What every shape of a folder shares for its rows (docs/DESIGN.md "The Files place"): how a press picks, a
 * name typed in place, the one state a row shows, and how a row is dragged and takes a drop.
 */

/** What a shape is given to draw a folder and hear what he does in it. */
export interface ShapeProps {
  entries: readonly FileEntry[];
  picked: Picked;
  busy: Busy;
  /** more rows wait on the host */
  more: boolean;
  loadingMore: boolean;
  /** the row whose name is being typed in place */
  renaming: string | null;
  /** `onName`: the press landed on the name itself (a slow second press there starts its rename) */
  onPick(key: string | null, how?: PickHow, onName?: boolean): void;
  onOpen(entry: FileEntry): void;
  onMore(): void;
  onParent?(): void;
  /** the name typed in place: null leaves it as it was */
  onRenamed(entry: FileEntry, name: string | null): void;
  /** dragging rows of this folder, and dropping on its folders; absent where nothing here moves */
  drag?: RowDrag;
}

/** How a press picks: Shift takes the run, ⌘ (Ctrl elsewhere) adds or takes one, a plain press takes one. */
export const howOf = (event: Parameters<typeof modOrCtrl>[0] & { shiftKey: boolean }): PickHow => (event.shiftKey ? "range" : modOrCtrl(event) ? "toggle" : "one");

/** Whether a press landed on a row's name itself. */
export const onNameOf = (event: Pick<MouseEvent, "target">): boolean => (event.target as HTMLElement | null)?.closest?.("[data-files-name]") != null;

/** How an arrow key picks: with Shift it takes the run from where the last plain pick stood. */
export const stepHow = (event: Pick<KeyboardEvent, "shiftKey">): PickHow => (event.shiftKey ? "range" : "one");

/** The one state a row shows, at most: a cloud mark, suggestions waiting, someone in it, a thread writing it. */
export function RowState({ entry }: { entry: FileEntry }) {
  const state = entry.state;
  if (!state) return null;
  if (state.is === "cloud") return <Cloud aria-label="In the cloud" className="size-3 shrink-0 text-muted-foreground" />;
  if (state.is === "suggestions") return <span className="shrink-0 text-xs text-warning tabular-nums">{state.count === 1 ? "1 suggestion" : `${state.count} suggestions`}</span>;
  if (state.is === "present") return <span className="shrink-0 truncate text-xs text-muted-foreground">{state.who} is in it</span>;
  return <Spinner aria-label="A thread is writing in it" className="size-3 shrink-0" />;
}

/**
 * A name typed in place: the field stands where the name was, with the part before the extension selected.
 * Return keeps it, Escape and a press elsewhere leave the name as it was (a press elsewhere keeps what was
 * typed, as a rename anywhere does).
 */
export function NameField({ name, className, onDone }: { name: string; className?: string; onDone(next: string | null): void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, stemEnd(name));
    // The name it started from only: this field owns the text from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (next: string | null): void => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <Input
      ref={field}
      aria-label={`Rename ${name}`}
      data-files-rename
      value={value}
      spellCheck={false}
      className={`h-6 min-w-0 flex-1 rounded-sm px-1 text-[13px] ${className ?? ""}`}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The list's own keys (the arrows, Return, Delete) are the field's while he types.
        event.stopPropagation();
        if (event.key === "Enter") finish(value);
        if (event.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}

// ── drag ──────────────────────────────────────────────────────────────

/** The type a drag of Files' own rows carries: other drops (a desktop's files, a tab) never read as one. */
export const ROWS_MIME = "application/x-tempcode-files-rows";

export interface RowDrag {
  /** rows of this folder may be dragged */
  from: boolean;
  /** the row a drag is over now, held in the `muted` fill */
  over: string | null;
  /** a drag of rows began on this row: the selection goes with it, or the row alone when it is not selected */
  onStart(entry: FileEntry, event: DragEvent): void;
  onEnd(): void;
  /** whether a folder row takes what is dragged; the label by the pointer says the verb */
  onOver(entry: FileEntry, event: DragEvent): boolean;
  onLeave(entry: FileEntry): void;
  onDrop(entry: FileEntry, event: DragEvent): void;
}

/** The props a row spreads to be dragged, and, for a folder, to take a drop. */
export function dragProps(drag: RowDrag | undefined, entry: FileEntry): Record<string, unknown> {
  if (!drag) return {};
  return {
    draggable: drag.from,
    onDragStart: (event: DragEvent) => drag.onStart(entry, event),
    onDragEnd: () => drag.onEnd(),
    ...(entry.folder
      ? {
          onDragOver: (event: DragEvent) => {
            if (drag.onOver(entry, event)) event.preventDefault();
          },
          onDragLeave: () => drag.onLeave(entry),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            drag.onDrop(entry, event);
          },
        }
      : {}),
  };
}

// ── a drag in flight ──────────────────────────────────────────────────

/** The rows being dragged and the place they come from: read by every drop target (a folder row, a place in the sidebar, a folder's tab). */
export interface DragNow {
  entries: readonly FileEntry[];
  from: PlaceCopy;
  /** the one folder the rows lie in, where a move's Undo puts them back; absent for rows of a lens or a search */
  back?: { at: FolderRef; name: string };
}
let dragNow: DragNow | null = null;
export const dragging = (): DragNow | null => dragNow;
export const setDragging = (next: DragNow | null): void => void (dragNow = next);

/**
 * Runs `done` once a drag the system carries is over. The call that starts one answers at its end on Windows and
 * Linux but at once on a Mac, and the window is told of no end when the drop lands outside it: so the rows stay the
 * rows being dragged until a drop in this window, until the pointer is seen here again with no button held, or
 * until the window loses focus: a file of the desktop's can only be dragged in after a press there, which takes the
 * focus, so what comes in then is the desktop's and uploads. A drag that leaves the window and comes back still
 * held is the same rows, and a drop then still moves them.
 */
export function whenDragEnds(done: () => void): void {
  const end = (): void => {
    window.removeEventListener("drop", end, true);
    window.removeEventListener("dragend", end, true);
    window.removeEventListener("mousemove", moved, true);
    window.removeEventListener("blur", end);
    // After the drop's own handlers, which still read what was dragged.
    setTimeout(done, 0);
  };
  const moved = (event: globalThis.MouseEvent): void => {
    if (event.buttons === 0) end();
  };
  window.addEventListener("drop", end, true);
  window.addEventListener("dragend", end, true);
  window.addEventListener("mousemove", moved, true);
  window.addEventListener("blur", end);
}

/**
 * The verb a drop asks: ⌥ copies and ⌘ (Ctrl elsewhere) moves, whatever the target; with neither, a drop inside
 * one place moves and a drop into another place copies, as a desktop does between two disks.
 */
export function dropVerb(event: { altKey: boolean } & Parameters<typeof modOrCtrl>[0], samePlace: boolean): "move" | "copy" {
  if (event.altKey) return "copy";
  if (modOrCtrl(event)) return "move";
  return samePlace ? "move" : "copy";
}

/** The small label the pointer carries while rows are dragged: the verb and where ("Move to Events"). One for the window. */
export interface DragLabelNow {
  text: string;
  x: number;
  y: number;
}
let labelNow: DragLabelNow | null = null;
const labelListeners = new Set<() => void>();
export function setDragLabel(next: DragLabelNow | null): void {
  if (next === labelNow || (next && labelNow && next.text === labelNow.text && Math.abs(next.x - labelNow.x) <= 2 && Math.abs(next.y - labelNow.y) <= 2)) return;
  labelNow = next;
  for (const listener of labelListeners) listener();
}

/** The file tab whose right half a dragged tab is over, held in the `muted` fill there until the drop: one for the window. */
let sideOver: string | null = null;
const sideListeners = new Set<() => void>();
export function setSideOver(tabId: string | null): void {
  if (tabId === sideOver) return;
  sideOver = tabId;
  for (const listener of sideListeners) listener();
}
export const useSideOver = (): string | null =>
  useSyncExternalStore(
    (listener) => (sideListeners.add(listener), () => void sideListeners.delete(listener)),
    () => sideOver,
  );

/** Drawn once in the Files place: nothing else moves while a thing is dragged. */
export function DragLabelLayer() {
  const label = useSyncExternalStore(
    (listener) => (labelListeners.add(listener), () => void labelListeners.delete(listener)),
    () => labelNow,
  );
  if (!label) return null;
  return (
    <div data-files-drag-label aria-hidden className="pointer-events-none fixed z-50 rounded-md bg-popover px-2 py-1 text-xs font-medium whitespace-nowrap text-foreground shadow-overlay ring-1 ring-border" style={{ left: label.x + 14, top: label.y + 16 }}>
      {label.text}
    </div>
  );
}
