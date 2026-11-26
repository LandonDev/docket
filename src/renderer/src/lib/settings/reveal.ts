import { useEffect } from "react";
import { SETTINGS_ROW_EVENT, takeSettingsRow } from "../monaco/debugTab";

/** How long a row that was asked for keeps its fill. */
export const FOUND_HOLD_MS = 900;
/** How long a page may take to draw the row (a lazy chunk, a host's answer) before the ask is dropped. */
export const FOUND_WAIT_MS = 4_000;

/** A fold asked to open, sent to the fold's own element by the row inside it that was asked for (parts/Fold.tsx). */
export const FOLD_OPEN_EVENT = "docket:settings-fold-open";

/**
 * The fill a row holds while it is the one asked for (`data-found`): a `muted` box 8px past its words each side, drawn
 * behind them so nothing in the row moves, gone on a fade. A row with an open control (`data-opens`) already has that
 * box: its own item takes the fill.
 */
export const FOUND_ROW =
  "relative isolate before:pointer-events-none before:absolute before:-inset-x-2 before:inset-y-0 before:-z-10 before:rounded-md before:bg-muted before:opacity-0 before:transition-opacity before:duration-(--dur-base) before:ease-(--ease-out) data-[found]:before:opacity-100 data-[opens]:before:inset-y-1";

/** The reveal's id for one computer's row of Settings → Work's "Work is on for" (`requestSettings("work", workOnRow(id))`). */
export const workOnRow = (environmentId: string): string => `work.on:${environmentId}`;

/** A map row by its id, or one row of a list by its own (`data-setting-row`, e.g. `work.on:<computer>`): the map names
 *  the list, the reveal can still land on one of its rows. */
const rowOf = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"], [data-setting-row="${CSS.escape(id)}"]`);

/** Scrolls a drawn row into the middle of its page and marks it found for `FOUND_HOLD_MS`; opens the fold it sits in. */
export function showFound(row: HTMLElement): () => void {
  row.closest("[data-fold]")?.dispatchEvent(new CustomEvent(FOLD_OPEN_EVENT));
  // After the fold's own render, so the row has its place.
  const frame = requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
  row.setAttribute("data-found", "");
  const timer = window.setTimeout(() => row.removeAttribute("data-found"), FOUND_HOLD_MS);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    row.removeAttribute("data-found");
  };
}

/**
 * The page's side of `requestSettings(section, row)`: when a row was asked for, waits for the page to draw it (its
 * chunk, its host's answer), then shows it. `page` keys the wait, so a row asked for on one page is never looked for
 * on the next; `root` is the scroller the page is drawn in.
 */
export function useFoundRow(root: HTMLElement | null, page: string): void {
  useEffect(() => {
    if (!root) return;
    let clear: (() => void) | undefined;
    let observer: MutationObserver | undefined;
    let deadline: number | undefined;
    const stop = (): void => {
      observer?.disconnect();
      observer = undefined;
      if (deadline !== undefined) window.clearTimeout(deadline);
    };
    const look = (): void => {
      const id = takeSettingsRow();
      if (!id) return;
      stop();
      clear?.();
      const show = (): boolean => {
        const row = rowOf(root, id);
        if (!row) return false;
        stop();
        clear = showFound(row);
        return true;
      };
      if (show()) return;
      observer = new MutationObserver(() => void show());
      observer.observe(root, { childList: true, subtree: true });
      deadline = window.setTimeout(stop, FOUND_WAIT_MS);
    };
    look();
    window.addEventListener(SETTINGS_ROW_EVENT, look);
    return () => {
      window.removeEventListener(SETTINGS_ROW_EVENT, look);
      stop();
      clear?.();
    };
  }, [root, page]);
}
