import { makeFunctionReference } from "convex/server";
import type { ToastApi } from "../../components/ui/toaster";

const get = makeFunctionReference<"query">("calendarOps:get");

/** LifeOS's own row for a calendar change: `queued` and `sending` until Google has it, then `done` or `failed`. */
type Op = { status?: string; error?: string } | null | undefined;
/** What of LifeOS's client the watch needs. */
export interface OpWatcher {
  watchQuery(query: typeof get, args: { id: string }): { onUpdate(cb: () => void): () => void; localQueryResult(): unknown };
}

/** How long the toast waits on LifeOS before it says where the event stands instead. */
export const ADD_WAIT_MS = 45_000;

/**
 * One toast for a new event, saying only what is true when it is said. His Add queues the change in LifeOS; Google
 * writes it a moment later, or refuses it. The toast once read "Invites sent" at the queue, and a refusal after was
 * told nowhere. It reads "Adding …" until LifeOS's row is `done` ("Added …", "Invites sent: …") or `failed` (the
 * reason), and "Queued in LifeOS" if no answer comes in `ADD_WAIT_MS`. Returns the stop.
 */
export function tellAdded(client: OpWatcher, toast: ToastApi, op: { id: string; title: string; invites: boolean }, waitMs = ADD_WAIT_MS): () => void {
  const id = `event-added:${op.id}`;
  toast.loading(op.invites ? `Sending invites: ${op.title}` : `Adding ${op.title}`, { id });
  const watch = client.watchQuery(get, { id: op.id });
  let off: () => void = () => undefined;
  const stop = (): void => {
    clearTimeout(timer);
    off();
  };
  const timer = setTimeout(() => {
    stop();
    toast.message(`${op.title} is queued in LifeOS`, { id, description: "It shows on Agenda once Google has it." });
  }, waitMs);
  const read = (): void => {
    let row: Op;
    try {
      row = watch.localQueryResult() as Op;
    } catch {
      // The row could not be read (LifeOS refused the query): the wait's own line says where the event stands.
      return;
    }
    if (row?.status === "done") {
      stop();
      toast.success(op.invites ? `Invites sent: ${op.title}` : `Added ${op.title}`, { id });
    } else if (row?.status === "failed") {
      stop();
      toast.error(`${op.title} was not added`, { id, description: row.error || "Google refused it." });
    }
  };
  off = watch.onUpdate(read);
  read();
  return stop;
}
