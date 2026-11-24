import { useSyncExternalStore } from "react";
import type { SaveAsFormat } from "@shared/work/saveAs";

/**
 * Which document's Save As… is open, by its item (docs/agents/work-files.md "Save As…"): the header's Save As…, the
 * document's More, a Files tab's ⋯ and File → Save As… (⇧⌘S) all ask here, and the document's body draws the sheet.
 * Also what each open document says its formats drop, counted from the editor as Preview counts it (`docDrops`).
 */

export interface SaveAsAsk {
  itemId: string;
  /** the format the sheet opens on; null: the one he used last */
  format: SaveAsFormat | null;
}

let asked: SaveAsAsk | null = null;
const listeners = new Set<() => void>();
const say = (): void => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function openSaveAs(itemId: string, format: SaveAsFormat | null = null): void {
  asked = { itemId, format };
  say();
}

export function closeSaveAs(): void {
  if (!asked) return;
  asked = null;
  say();
}

/** The ask for this document's sheet while it is open, else null. */
export function useSaveAsAsk(itemId: string): SaveAsAsk | null {
  return useSyncExternalStore(subscribe, () => (asked?.itemId === itemId ? asked : null));
}

const drops = new Map<string, (format: SaveAsFormat) => string[]>();

/** An open document tells how to count what each format drops; null when it goes. */
export function tellDrops(itemId: string, count: ((format: SaveAsFormat) => string[]) | null): void {
  if (count) drops.set(itemId, count);
  else drops.delete(itemId);
}

export const dropsOf = (itemId: string, format: SaveAsFormat): string[] => drops.get(itemId)?.(format) ?? [];

const LAST = "tc.saveAs.format";
/** The format he saved in last, kept in this window. */
export function lastFormat(): SaveAsFormat | null {
  try {
    return (localStorage.getItem(LAST) as SaveAsFormat | null) ?? null;
  } catch {
    return null;
  }
}
export function keepFormat(format: SaveAsFormat): void {
  try {
    localStorage.setItem(LAST, format);
  } catch {
    // A window that keeps nothing opens on Word next time.
  }
}
