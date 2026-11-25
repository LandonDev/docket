import { canvasFlushPort } from "../../lib/canvasFlushPort";

/**
 * What an item still holds in the window, sent before its tab closes (docs/agents/work-files.md "A copy saves back"):
 * a deck's words in an open box, a text file's words waiting for their save. A kind registers how its item sends what
 * it holds while its body is drawn; closing a tab awaits it first, so the host has the edit before the item goes. A
 * body that unmounts with no close (another tab chosen) sends on its own, as it always has. Quit and window close send
 * every item's (`flushAll`, from lib/appLifecycle.ts); the registry is first-paint code (lib/canvasFlushPort.ts).
 */
export { flushAll, QUIT_FLUSH_MS, type Unsent } from "../../lib/canvasFlushPort";

/** The kind's own send for its item while its body is drawn; `keeps`: what fails to go is kept on this computer (a draft). Returns its off. */
export const registerFlush = (itemId: string, flush: () => Promise<unknown>, o: { keeps?: boolean } = {}): (() => void) => canvasFlushPort.set(itemId, flush, o.keeps === true);

/** The longest a close waits before it asks him (canvas/closeDoor.ts); the send still on its way may yet land. */
export const FLUSH_WAIT_MS = 8000;

/**
 * A kind's refusal of its tab's close: what the item holds did not go in and would be lost with the tab (a deck's
 * words the host would not write). The tab stays, and the reason is said; no ask lets it go.
 */
export class CloseRefused extends Error {}

/** How an item's send ended: it went (or nothing was held), it failed, or it was still on its way at the wait's end. */
export type Sent = "sent" | "failed" | "late";

/**
 * Sends what the item holds, if its kind holds anything, and answers how that went. One the kind refuses the close for
 * (`CloseRefused`) is thrown on, so the tab stays open with what it holds.
 */
export async function flushItem(itemId: string | null | undefined, waitMs = FLUSH_WAIT_MS): Promise<Sent> {
  const flush = itemId ? canvasFlushPort.get(itemId) : undefined;
  if (!flush) return "sent";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = flush().then(
    (): Sent => "sent",
    (err: unknown): Sent => {
      if (err instanceof CloseRefused) throw err;
      return "failed";
    },
  );
  try {
    return await Promise.race([sent, new Promise<Sent>((resolve) => (timer = setTimeout(() => resolve("late"), waitMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The same send, answered: true once the kind sent what it held (or held nothing), false when its send failed or ran past `waitMs`. A switch that would replace the item stops on false. */
export async function flushedItem(itemId: string | null | undefined, waitMs = FLUSH_WAIT_MS): Promise<boolean> {
  return flushItem(itemId, waitMs).then(
    (sent) => sent === "sent",
    () => false,
  );
}
