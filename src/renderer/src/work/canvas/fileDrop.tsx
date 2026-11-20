import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getPathForFile } from "../../lib/native";
import { filePlaceOf, sessionFilePlace, storeFileLook, type FileLook, type FilePlace } from "../../lib/openFilePlace";
import { rightPanel } from "../../lib/rightPanel";
import { claimFileDrop, workFilePort, workViewNow } from "../../lib/workSwitch";

/**
 * Files dropped on Work to open them (docs/agents/work-canvas.md "Opening a file from
 * outside"). One listener on the document, mounted while Work is on (WorkRailHost),
 * finds where a file drop means "open": a Work thread's pane or a Work draft's, anywhere
 * but the composer's box, and a Work view (`[data-file-opens]`). It marks such a drop in
 * the capture phase (`claimFileDrop`), so the composer, which takes a drop anywhere else
 * in its pane, lets it pass; and acts in the bubble phase, after every surface inside has
 * had its say: one that took the file (Mail's composer, an empty meeting, a document's
 * surface) keeps it. It fills the File menu's Open File… (`workFilePort`) for the same
 * places.
 */

const listeners = new Set<() => void>();
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A file a thread is opening from outside: its name, the bytes sent of its upload, and the cancel. */
export interface Opening {
  name: string;
  sent: number;
  total: number;
  cancel(): void;
}

/** What each thread is opening now, one entry per open in flight: its pane shows the newest until the item lands. */
const opening = new Map<string, Map<object, Opening>>();
export function setOpening(sessionId: string, token: object, next: Opening | null): void {
  const mine = opening.get(sessionId) ?? new Map<object, Opening>();
  if (next === null) mine.delete(token);
  else mine.set(token, next);
  if (mine.size === 0) opening.delete(sessionId);
  else opening.set(sessionId, mine);
  for (const l of listeners) l();
}
const newest = (sessionId: string): Opening | null => {
  const mine = opening.get(sessionId);
  return mine ? ([...mine.values()].at(-1) ?? null) : null;
};
export const useOpening = (sessionId: string): Opening | null => useSyncExternalStore(subscribe, () => newest(sessionId), () => null);

/** No dragover for this long and the drag is over: one from the desktop that leaves the window sends nothing else. */
export const DRAG_QUIET_MS = 350;

const carriesFiles = (data: DataTransfer | null): boolean => !!data && Array.from(data.types).includes("Files");

/** Where a drop on `target` opens, and the element its wash covers; null where a drop keeps its old meaning. */
export function dropPlaceOf(target: Element | null, look: FileLook): { place: FilePlace; zone: HTMLElement } | null {
  if (!target || target.closest("[data-composer-box]")) return null;
  const view = target.closest<HTMLElement>("[data-file-opens]");
  if (view) return { place: { at: "new" }, zone: view };
  const pane = target.closest<HTMLElement>("[data-session-drop]");
  const id = pane?.dataset.sessionDrop;
  const place = pane && id ? sessionFilePlace(id, look) : null;
  if (!pane || !place) return null;
  // The wash goes where the file will show: a Work thread's canvas when it has one, else the pane.
  const board = place.at === "thread" ? pane.querySelector<HTMLElement>("[data-board]") : null;
  return { place, zone: board ?? pane };
}

function pathOf(file: File): string | undefined {
  try {
    return getPathForFile(file).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The document's file drops, routed; the wash over the zone a drop would open in. */
export function FileDrops({ look = storeFileLook }: { look?: FileLook }) {
  const [zone, setZone] = useState<DOMRect | null>(null);
  useEffect(() => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const end = (): void => {
      if (quiet) clearTimeout(quiet);
      quiet = null;
      setZone(null);
    };
    const placeOf = (event: DragEvent) => (carriesFiles(event.dataTransfer) ? dropPlaceOf(event.target as Element | null, look) : null);
    // Capture: marked before the composer hears of it.
    const claim = (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) return;
      if (event.type === "dragover") {
        // A drag that leaves the window, or is let go outside it, may say nothing more: a quiet spell ends it.
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(end, DRAG_QUIET_MS);
      }
      if (placeOf(event)) claimFileDrop(event);
    };
    // Bubble: a surface inside that took the file keeps it.
    const onOver = (event: DragEvent): void => {
      const hit = placeOf(event);
      if (!hit || event.defaultPrevented) return setZone(null);
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      const rect = hit.zone.getBoundingClientRect();
      setZone((prev) => (prev && prev.x === rect.x && prev.y === rect.y && prev.width === rect.width && prev.height === rect.height ? prev : rect));
    };
    const onDrop = (event: DragEvent): void => {
      end();
      const hit = placeOf(event);
      if (!hit || event.defaultPrevented) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer!.files);
      void import("./openOutside").then(({ openOutside, outsideOf }) => openOutside(hit.place, files.map((f) => outsideOf(f, pathOf(f)))));
    };
    // The File menu's Open File…: the same places, through the system's open dialog.
    const menuPlace = (): FilePlace | null => filePlaceOf(rightPanel.focused(), !!workViewNow(), look);
    workFilePort.set({
      can: () => menuPlace() !== null,
      open: () => {
        const place = menuPlace();
        if (place) void import("./openOutside").then(({ pickAndOpen }) => pickAndOpen(place));
      },
    });
    document.addEventListener("dragover", claim, true);
    document.addEventListener("drop", claim, true);
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", end, true);
    return () => {
      document.removeEventListener("dragover", claim, true);
      document.removeEventListener("drop", claim, true);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragend", end, true);
      workFilePort.set(null);
      end();
    };
  }, [look]);
  return zone ? createPortal(<DropWash rect={zone} />, document.body) : null;
}

/** The document surface's wash (work/formats/Import.tsx), 12px inside the zone, over it on the page. */
function DropWash({ rect }: { rect: DOMRect }) {
  return (
    <div
      data-file-wash
      aria-live="polite"
      style={{ left: rect.x + 12, top: rect.y + 12, width: Math.max(0, rect.width - 24), height: Math.max(0, rect.height - 24) }}
      className="pointer-events-none fixed z-(--layer-dialog) grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
    >
      <span className="text-[13px] text-muted-foreground">Drop to open</span>
    </div>
  );
}
