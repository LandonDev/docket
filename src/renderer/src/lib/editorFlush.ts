/**
 * A seam between the app shell and the editor panes: each mounted pane
 * registers how to flush its buffer, and closing a dirty tab with autosave
 * on flushes through here instead of confirming, and ⌘S flushes the pane
 * that holds the focus (`flushFocusedEditor`), never the others. No editor imports, so the shell never pulls an
 * editor chunk in.
 */

/** `explicit`: the person asked to save (⌘S): the focused
 *  editor's conflict bar takes it as Keep mine. Otherwise a bar holds the
 *  write. */
type Flusher = (explicit: boolean) => Promise<boolean>;

const flushers = new Map<string, Flusher>();
/** Whether each path's editor holds the focus now: ⌘S saves that one alone (decision 11, docs/DESIGN.md "Keys"). */
const focus = new Map<Flusher, () => boolean>();

export function registerEditorFlusher(path: string, flush: Flusher, focused?: () => boolean): () => void {
  flushers.set(path, flush);
  if (focused) focus.set(flush, focused);
  return () => {
    focus.delete(flush);
    if (flushers.get(path) === flush) flushers.delete(path);
  };
}

/**
 * ⌘S in a code editor: the one that holds the focus writes its buffer as his explicit save (its conflict bar takes it
 * as Keep mine), and no other editor is touched. Null when no editor holds the focus; else whether the disk has it.
 */
export async function flushFocusedEditor(): Promise<boolean | null> {
  for (const [path, flush] of flushers) {
    const focused = focus.get(flush);
    if (focused?.()) return flushEditor(path, true);
  }
  return null;
}

/** Write `path`'s buffer now; true when the disk holds it afterwards
 *  (no open editor counts as nothing to do). */
export async function flushEditor(path: string, explicit = false): Promise<boolean> {
  const flush = flushers.get(path);
  if (!flush) return true;
  try {
    return await flush(explicit);
  } catch {
    return false;
  }
}

/** Paths with a registered editor, for tests and the dev facade. */
export function registeredEditorPaths(): string[] {
  return [...flushers.keys()];
}
