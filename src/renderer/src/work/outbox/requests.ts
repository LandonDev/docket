import { useEffect, useRef, useSyncExternalStore } from "react";
import type { HeldRef } from "@shared/work";
import type { OutboxRequest, OutboxRequestRow } from "@shared/contract-work-outbox";
import { registry } from "../../lib/connection";
import { workSwitch } from "../../lib/workSwitch";
import { summaryHead } from "./waiting";

/**
 * A thread's requests for his press (docs/agents/work-outbox.md "A thread asks
 * for his press"), as the card, the Outbox's Asked in threads, Today and the
 * return from Away read them: one map per host, filled from
 * `work.outbox.requests` (the open ones), `request.get` (one as its card draws
 * it) and the `work.outbox.request` push. Every press goes to the host that
 * holds the request; nothing here decides anything itself.
 */

export type HostRequest = OutboxRequest & { environmentId: string };

const hosts = new Map<string, Map<string, HostRequest>>();
/** A request's read that failed, by `<host>:<id>`, with why. */
const failures = new Map<string, string>();
const listeners = new Set<() => void>();
let openSnapshot: HostRequest[] | null = null;

/**
 * A request's one name, in his words, on every surface that shows it (the row in Asked in threads, Today, the return
 * from Away, the card and its detail): what it asks, by kind ("Send 3 mails to 3 people and discard 1 mail", "Echo
 * with League, 3 times"). The host's own head stands in where no row's item is known here.
 */
export function requestName(request: Pick<OutboxRequest, "rows" | "head">): string {
  const rows = request.rows.filter((r) => r.item);
  if (!rows.length) return request.head;
  return summaryHead(
    rows.filter((r) => r.do === "send").map((r) => r.item!),
    rows.filter((r) => r.do === "discard").map((r) => r.item!),
    { later: rows.filter((r) => r.do === "later").map((r) => r.item!) },
  );
}

/** A request's key across hosts: the Outbox's selection and `wantOutboxItem` use it. */
export const requestKey = (r: Pick<HostRequest, "environmentId" | "id">): string => `request:${r.environmentId}:${r.id}`;

function changed(): void {
  openSnapshot = null;
  for (const listener of listeners) listener();
}

function put(environmentId: string, request: OutboxRequest): HostRequest {
  const tagged = { ...request, environmentId };
  const map = hosts.get(environmentId) ?? new Map<string, HostRequest>();
  map.set(request.id, tagged);
  hosts.set(environmentId, map);
  failures.delete(`${environmentId}:${request.id}`);
  changed();
  return tagged;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A host's requests read out now, with the turn it was asked in: the stores that read on one event (a reconnect, the
 * boot: this file's own and the Outbox store's) ask once between them. An ask in a later turn, for a push that came
 * after the read went out, waits for it and asks again.
 */
const reading = new Map<string, { turn: number; done: Promise<void> }>();
const again = new Set<string>();
let turn = 0;
let turning = false;
function turnOf(): number {
  if (!turning) {
    turning = true;
    queueMicrotask(() => {
      turn++;
      turning = false;
    });
  }
  return turn;
}

/** One host's open requests, read again. A host from before requests answers nothing, and has none. */
export function loadRequests(environmentId: string): Promise<void> {
  const out = reading.get(environmentId);
  if (out) {
    if (out.turn !== turnOf()) again.add(environmentId);
    return out.done;
  }
  const done = readRequests(environmentId).finally(() => {
    if (reading.get(environmentId)?.done === done) reading.delete(environmentId);
    if (again.delete(environmentId)) void loadRequests(environmentId);
  });
  reading.set(environmentId, { turn: turnOf(), done });
  return done;
}

async function readRequests(environmentId: string): Promise<void> {
  try {
    const { requests } = await registry.linkOf(environmentId).request<{ requests: OutboxRequest[] }>("work.outbox.requests", {});
    const map = new Map<string, HostRequest>();
    // What this host already holds that is not open stays (a card drawn answered keeps its results).
    for (const [id, r] of hosts.get(environmentId) ?? []) if (r.state !== "open") map.set(id, r);
    for (const r of requests ?? []) map.set(r.id, { ...r, environmentId });
    hosts.set(environmentId, map);
    changed();
  } catch {
    // Not known is not none: the open ones it had stay until it answers.
  }
}

/** One request whole, as its card draws it, with a receipt for each row he may press as drawn. */
export async function getRequest(environmentId: string, id: string): Promise<HostRequest> {
  try {
    return put(environmentId, await registry.linkOf(environmentId).request<OutboxRequest>("work.outbox.request.get", { id }));
  } catch (err) {
    failures.set(`${environmentId}:${id}`, errorText(err));
    changed();
    throw err;
  }
}

/** He opened a row that changed since the ask: its fresh receipt, at what he now sees (he ticks it himself). */
export async function viewRow(environmentId: string, id: string, ref: HeldRef): Promise<OutboxRequestRow> {
  const row = await registry.linkOf(environmentId).request<OutboxRequestRow>("work.outbox.request.view", { id, ref });
  const request = hosts.get(environmentId)?.get(id);
  if (request) put(environmentId, { ...request, rows: request.rows.map((r) => (r.ref.at === ref.at && r.ref.id === ref.id ? row : r)) });
  return row;
}

/** His Send on the card: exactly the ticked rows' receipts. The host answers the request as it stands after. */
export async function answerRequest(environmentId: string, id: string, receipts: readonly string[]): Promise<HostRequest> {
  const { request } = await registry.linkOf(environmentId).request<{ request: OutboxRequest }>("work.outbox.decide", { request: id, receipts });
  return put(environmentId, request);
}

/** Not now: nothing goes; the items still wait in his Outbox. */
export async function declineRequest(environmentId: string, id: string): Promise<HostRequest> {
  return put(environmentId, await registry.linkOf(environmentId).request<OutboxRequest>("work.outbox.decline", { request: id }));
}

/** One request, read from its host once it mounts (and again for a Retry); the push keeps it current after. */
export function useRequest(environmentId: string, id: string): { request: HostRequest | null; error: string | null; retry(): void } {
  const request = useSyncExternalStore(subscribe, () => hosts.get(environmentId)?.get(id) ?? null);
  const error = useSyncExternalStore(subscribe, () => failures.get(`${environmentId}:${id}`) ?? null);
  useEffect(() => {
    void getRequest(environmentId, id).catch(() => undefined);
  }, [environmentId, id]);
  // A pushed or listed copy may carry no receipts: while it waits and a row it lists unchanged has none, the card asks
  // `request.get` again for them, once a copy, never trusting the copy to stand for what he may press.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!request || request.state !== "open") return;
    if (!request.rows.some((r) => r.open && !r.changed && !r.receipt)) return;
    const copy = JSON.stringify(request.rows.map((r) => [r.ref, r.open, r.changed, r.receipt ?? null, r.item?.updatedAt ?? null]));
    if (asked.current === copy) return;
    asked.current = copy;
    void getRequest(environmentId, id).catch(() => undefined);
  }, [environmentId, id, request]);
  return { request, error: request ? null : error, retry: () => void getRequest(environmentId, id).catch(() => undefined) };
}

/** Every host's open requests, oldest first: Asked in threads, Today's rows, the return from Away. */
export function openRequestsNow(): HostRequest[] {
  if (openSnapshot) return openSnapshot;
  openSnapshot = [...hosts]
    .filter(([env]) => workSwitch.hosts().has(env))
    .flatMap(([, map]) => [...map.values()])
    .filter((r) => r.state === "open")
    .sort((a, b) => a.createdAt - b.createdAt);
  return openSnapshot;
}

export function useOpenRequests(): HostRequest[] {
  return useSyncExternalStore(subscribe, openRequestsNow, openRequestsNow);
}

/** The keys (`<host>:<at>:<id>`) of the items an open request lists: each is listed under its request, not again. */
export function askedItemKeys(requests: readonly HostRequest[]): Set<string> {
  return new Set(requests.flatMap((r) => r.rows.filter((row) => row.open).map((row) => `${r.environmentId}:${row.ref.at}:${row.ref.id}`)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetRequests(): void {
  hosts.clear();
  failures.clear();
  reading.clear();
  again.clear();
  changed();
}

// ── pushes: an approve key hears every request's change ───────────────────

registry.onLink((link, event) => {
  if (event === "removed") {
    hosts.delete(link.environmentId);
    changed();
    return;
  }
  link.onPush((push) => {
    if (push.push === "work.outbox.request") put(link.environmentId, push.request);
  });
  link.onOpen(() => {
    if (workSwitch.hosts().has(link.environmentId)) void loadRequests(link.environmentId);
  });
});

for (const id of workSwitch.hosts()) void loadRequests(id);
