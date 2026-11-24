/**
 * What each Work item still holds in the window, and its kind's send for it (work/canvas/flush.ts is the door a tab's
 * close uses). First-paint code: the registry alone, so quit and window close (lib/appLifecycle.ts) send every item's
 * without loading Work.
 */
const flushers = new Map<string, () => Promise<unknown>>();

export const canvasFlushPort = {
  /** The kind's own send for its item while its body is drawn. Returns its off, which leaves a newer body's in place. */
  set(itemId: string, flush: () => Promise<unknown>): () => void {
    flushers.set(itemId, flush);
    return () => {
      if (flushers.get(itemId) === flush) flushers.delete(itemId);
    };
  },
  get: (itemId: string): (() => Promise<unknown>) | undefined => flushers.get(itemId),
};

/** The longest quit and window close wait for the items' sends: under the 2 s main gives each window but the first to persist (src/main/windows.ts `PERSIST_TIMEOUT_MS`). */
export const QUIT_FLUSH_MS = 1500;

/** The items whose send failed (a refusal too), and those still on their way when the wait ran out. */
export interface Unsent {
  failed: string[];
  late: string[];
}

/** Every item's send at once, within one wait. Never throws: what did not land is named. */
export async function flushAll(waitMs = QUIT_FLUSH_MS): Promise<Unsent> {
  const items = [...flushers];
  const failed: string[] = [];
  const ended = new Set<string>();
  const sends = items.map(([id, flush]) =>
    Promise.resolve()
      .then(flush)
      .catch(() => void failed.push(id))
      .finally(() => void ended.add(id)),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(sends), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  return { failed, late: items.map(([id]) => id).filter((id) => !ended.has(id)) };
}
