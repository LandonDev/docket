import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useState } from "react";
import type { ToastApi } from "../../components/ui/toaster";

const get = makeFunctionReference<"query">("calendarOps:get");

/** LifeOS's own row for a calendar change: `queued` and `sending` until Google has it, then `done` or `failed`. */
type Op = { status?: string; error?: string } | null | undefined;
/** What of LifeOS's client the watch needs. */
export interface OpWatcher {
  watchQuery(query: typeof get, args: { id: string }): { onUpdate(cb: () => void): () => void; localQueryResult(): unknown };
}

/** Where LifeOS's row says the change stands: on its way (or not read yet), done, or refused with its reason. */
export type OpOutcome = { status: "pending" } | { status: "done" } | { status: "failed"; reason: string };

/** The row's status as an outcome, read the same by the toast and a mail chat card. */
export function outcomeOf(row: Op): OpOutcome {
  if (row?.status === "done") return { status: "done" };
  if (row?.status === "failed") return { status: "failed", reason: row.error || "Google refused it." };
  return { status: "pending" };
}

const sameOutcome = (a: OpOutcome, b: OpOutcome): boolean => a.status === b.status && (a.status !== "failed" || a.reason === (b as { reason: string }).reason);

/**
 * The calendar change `id` as LifeOS's row says it stands now, read through the Convex client around it; null for no
 * id. A row that cannot be read keeps the last outcome read (pending at first): nothing is said done before LifeOS
 * says so.
 */
export function useOpOutcome(id: string | null): OpOutcome | null {
  const client = useConvex() as unknown as OpWatcher | undefined;
  const [read, setRead] = useState<{ id: string; outcome: OpOutcome } | null>(null);
  useEffect(() => {
    if (!id || !client) return;
    const watch = client.watchQuery(get, { id });
    const take = (): void => {
      try {
        const outcome = outcomeOf(watch.localQueryResult() as Op);
        setRead((was) => (was?.id === id && sameOutcome(was.outcome, outcome) ? was : { id, outcome }));
      } catch {
        // LifeOS refused the query: the last outcome read stands.
      }
    };
    const off = watch.onUpdate(take);
    take();
    return off;
  }, [id, client]);
  if (!id) return null;
  return read?.id === id ? read.outcome : { status: "pending" };
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
    const outcome = outcomeOf(row);
    if (outcome.status === "done") {
      stop();
      toast.success(op.invites ? `Invites sent: ${op.title}` : `Added ${op.title}`, { id });
    } else if (outcome.status === "failed") {
      stop();
      toast.error(`${op.title} was not added`, { id, description: outcome.reason });
    }
  };
  off = watch.onUpdate(read);
  read();
  return stop;
}
