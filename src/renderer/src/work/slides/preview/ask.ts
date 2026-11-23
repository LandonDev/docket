import { createContext } from "react";

/**
 * How Preview is asked for on a deck from outside its Body (docs/agents/work-slides.md "Preview and export"): the
 * Present menu's row lives in the bar, and in the format row, which the Body does not own. Each deck item hears its
 * own asks; a menu reads who opens Preview from `PreviewOpener`, given by the deck's Body and bar.
 */

export type PreviewOn = "last" | "print";

const listeners = new Map<string, Set<(on: PreviewOn) => void>>();

/** Opens Preview on the deck item `itemId`: on the format he last used, or on Print. */
export function askPreview(itemId: string, on: PreviewOn = "last"): void {
  for (const fn of listeners.get(itemId) ?? []) fn(on);
}

/** Hears the asks for one item; answers its off. */
export function onPreviewAsk(itemId: string, fn: (on: PreviewOn) => void): () => void {
  let set = listeners.get(itemId);
  if (!set) listeners.set(itemId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(itemId);
  };
}

/** Who opens the deck's Preview, for a menu that offers it (Present's); null where nothing does. */
export const PreviewOpener = createContext<(() => void) | null>(null);
