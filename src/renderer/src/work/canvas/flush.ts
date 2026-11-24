/**
 * What an item still holds in the window, sent before its tab closes (docs/agents/work-files.md "A copy saves back"):
 * a deck's words in an open box, a text file's words waiting for their save. A kind registers how its item sends what
 * it holds while its body is drawn; closing a tab awaits it first, so the host has the edit before the item goes. A
 * body that unmounts with no close (another tab chosen) sends on its own, as it always has.
 */
const flushers = new Map<string, () => Promise<unknown>>();

/** The kind's own send for its item while its body is drawn. Returns its off. */
export function registerFlush(itemId: string, flush: () => Promise<unknown>): () => void {
  flushers.set(itemId, flush);
  return () => {
    if (flushers.get(itemId) === flush) flushers.delete(itemId);
  };
}

/** The longest a close waits: past it the tab closes, and the host keeps the copy until the edit has landed. */
export const FLUSH_WAIT_MS = 8000;

/** Sends what the item holds, if its kind holds anything; a send that fails is the kind's to say, never a reason to keep the tab. */
export async function flushItem(itemId: string | null | undefined, waitMs = FLUSH_WAIT_MS): Promise<void> {
  const flush = itemId ? flushers.get(itemId) : undefined;
  if (!flush) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([flush().catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}

/** The same send, answered: true once the kind sent what it held (or held nothing), false when its send failed or ran past `waitMs`. A switch that would replace the item stops on false. */
export async function flushedItem(itemId: string | null | undefined, waitMs = FLUSH_WAIT_MS): Promise<boolean> {
  const flush = itemId ? flushers.get(itemId) : undefined;
  if (!flush) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = await Promise.race([flush().then(() => true, () => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)))]);
  clearTimeout(timer);
  return sent;
}
