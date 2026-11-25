import { canvasFlushPort } from "./canvasFlushPort";
import { flushFocusedEditor } from "./editorFlush";

/**
 * ⌘S (decision 11, docs/DESIGN.md "Keys"): what holds the focus saves now, and nothing else does. A code editor with
 * the focus writes its buffer (lib/editorFlush.ts); a Work file sends the edits its kind still holds (the same send a
 * close and quit make, lib/canvasFlushPort.ts), and its save line says Saved only once that send's receipt is in. A
 * file whose save is his own press (a Teams Word file that asks) sends its edits and says that it waits for the press:
 * it registers its own save here (`saveKeyPort`). First-paint code: no editor and no Work import.
 */

/** A file's own ⌘S, in the place of its kind's send. */
const own = new Map<string, () => Promise<unknown>>();

export const saveKeyPort = {
  /** Returns its off, which leaves a newer one in place. */
  set(itemId: string, save: () => Promise<unknown>): () => void {
    own.set(itemId, save);
    return () => {
      if (own.get(itemId) === save) own.delete(itemId);
    };
  },
};

/** The marker every Work file's pane carries (work/canvas/CanvasPane.tsx), with its item's id. */
export const ITEM_ATTR = "data-canvas-item";

type Closest = { closest?: (selector: string) => { getAttribute(name: string): string | null } | null };

/**
 * The Work file ⌘S is for: the pane that holds the focus; with the focus on nothing (a click on the empty part of a
 * view), the one file a Files tab shows. Null for anywhere else (a thread, the composer, a list).
 */
export function itemOf(target: unknown, doc: Pick<Document, "body" | "querySelector"> | null = typeof document === "undefined" ? null : document): string | null {
  const el = target as Closest | null;
  const pane = typeof el?.closest === "function" ? el.closest(`[${ITEM_ATTR}]`) : null;
  if (pane) return pane.getAttribute(ITEM_ATTR);
  if (!doc || (target && target !== doc.body)) return null;
  return doc.querySelector(`[data-files-main]:not([inert]) [${ITEM_ATTR}]`)?.getAttribute(ITEM_ATTR) ?? null;
}

/** What ⌘S did: a code editor saved, a Work file sent its edits, or nothing held the focus. */
export type Saved = "editor" | "item" | "none";

export async function saveFocused(target: unknown = typeof document === "undefined" ? null : document.activeElement): Promise<Saved> {
  if ((await flushFocusedEditor()) !== null) return "editor";
  const id = itemOf(target);
  const save = id ? (own.get(id) ?? canvasFlushPort.get(id)) : undefined;
  if (!id) return "none";
  // A send that fails is said by the file's own save line, as any failed save is.
  await save?.().catch(() => undefined);
  return "item";
}
