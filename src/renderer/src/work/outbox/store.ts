import { useSyncExternalStore } from "react";
import type { OutboxGrant, OutboxItem } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { registry } from "../../lib/connection";
import { setOutboxFailed, setOutboxWaiting, workSwitch } from "../../lib/workSwitch";
import { applyResult, reloadResults, resetResults } from "./results";

/**
 * The Outbox as the screens read it (docs/agents/work-outbox.md): one list
 * per host (`work.outbox.list`, which already holds that host's LifeOS-held
 * items), merged here as the rail merges threads. Every row carries its
 * host. Nothing reads LifeOS's `outbox` itself; every press goes through the
 * host that holds the item.
 *
 * The rail's count is kept from the `work.outbox` push of each host with
 * Work on, from boot (the work-shell chunk imports this file).
 */

/** An item with the host that holds it. */
export type HostItem = OutboxItem & { environmentId: string };
export type HostGrant = OutboxGrant & { environmentId: string };
export type { HostResult } from "./results";

type HostState = {
  waiting: HostItem[];
  sent: HostItem[];
  grants: HostGrant[];
  count: number;
  /** of `count`, the sends that failed */
  failed: number;
  loaded: boolean;
  error: string | null;
};

const hosts = new Map<string, HostState>();
const listeners = new Set<() => void>();
let snapshot: OutboxView | null = null;

export type OutboxView = {
  waiting: HostItem[];
  sent: HostItem[];
  grants: HostGrant[];
  /** every host with Work on has answered once */
  loaded: boolean;
  /** hosts whose list did not come back, with why */
  errors: { environmentId: string; error: string }[];
};

const emptyHost = (): HostState => ({ waiting: [], sent: [], grants: [], count: 0, failed: 0, loaded: false, error: null });

function changed(): void {
  snapshot = null;
  let count = 0;
  let failed = 0;
  for (const [id, state] of hosts)
    if (workSwitch.hosts().has(id)) {
      count += state.count;
      failed += state.failed;
    }
  setOutboxWaiting(count);
  setOutboxFailed(failed);
  for (const listener of listeners) listener();
}

function view(): OutboxView {
  if (snapshot) return snapshot;
  const on = [...hosts].filter(([id]) => workSwitch.hosts().has(id)).map(([, state]) => state);
  snapshot = {
    waiting: on.flatMap((h) => h.waiting).sort((a, b) => a.createdAt - b.createdAt),
    sent: on.flatMap((h) => h.sent).sort((a, b) => (b.decidedAt ?? b.updatedAt) - (a.decidedAt ?? a.updatedAt)),
    grants: on.flatMap((h) => h.grants).sort((a, b) => b.createdAt - a.createdAt),
    loaded: workSwitch.hosts().size > 0 && [...workSwitch.hosts()].every((id) => hosts.get(id)?.loaded),
    errors: [...hosts].filter(([id, h]) => workSwitch.hosts().has(id) && h.error).map(([environmentId, h]) => ({ environmentId, error: h.error! })),
  };
  return snapshot;
}

const tag = <T,>(environmentId: string, rows: T[]): (T & { environmentId: string })[] => rows.map((row) => ({ ...row, environmentId }));
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const loading = new Map<string, Promise<void>>();
/** Hosts asked for again while a load ran: what changed during it is read by one more load after it. */
const again = new Set<string>();

/** One host's whole Outbox: what waits, what was decided, the standing grants. */
export function loadHost(environmentId: string): Promise<void> {
  const inFlight = loading.get(environmentId);
  if (inFlight) {
    again.add(environmentId);
    return inFlight;
  }
  const link = registry.linkOf(environmentId);
  const load = Promise.all([
    link.request<{ items: OutboxItem[]; waiting: number }>("work.outbox.list", { show: "waiting" }),
    link.request<{ items: OutboxItem[] }>("work.outbox.list", { show: "decided", limit: 100 }),
    link.request<{ grants: OutboxGrant[] }>("work.outbox.grants", {}),
  ])
    .then(([waiting, decided, grants]) => {
      hosts.set(environmentId, {
        waiting: tag(environmentId, waiting.items),
        sent: tag(environmentId, decided.items.filter((item) => item.state === "sent")),
        grants: tag(environmentId, grants.grants),
        count: waiting.waiting,
        failed: waiting.items.filter((item) => item.state === "failed").length,
        loaded: true,
        error: null,
      });
    })
    .catch((err: unknown) => {
      hosts.set(environmentId, { ...(hosts.get(environmentId) ?? emptyHost()), loaded: true, error: errorText(err) });
    })
    .finally(() => {
      loading.delete(environmentId);
      changed();
      if (again.delete(environmentId)) void loadHost(environmentId);
    });
  loading.set(environmentId, load);
  return load;
}

/** Every host with Work on, asked again. */
export function loadOutbox(): Promise<void> {
  return Promise.all([...workSwitch.hosts()].map(loadHost)).then(() => undefined);
}

/** The merged Outbox as it stands, outside React. */
export const outboxNow = (): OutboxView => view();

export function useOutbox(): OutboxView {
  return useSyncExternalStore(subscribe, view, view);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── presses: each goes to the host that holds the item ───────────────────

/** The host's answer to a press says it went (or is going), not that another press or device decided it first. */
export const wentOut = (after: Pick<OutboxItem, "state">): boolean => after.state === "sent" || after.state === "sending";
/** Why a press sent nothing, in his words. */
export function notSentWords(after: Pick<OutboxItem, "state" | "error">): string {
  if (after.state === "discarded") return "Already discarded";
  if (after.state === "stale") return after.error ?? "It changed since it was held; look again";
  return after.error ?? "It couldn't be sent";
}

/** Put the host's answer in place at once, so the next press reads it (an edit's new `updatedAt`). */
function putItem(environmentId: string, item: OutboxItem): void {
  const state = hosts.get(environmentId);
  if (!state) return;
  const tagged = { ...item, environmentId };
  hosts.set(environmentId, { ...state, waiting: state.waiting.map((x) => (x.ref.at === item.ref.at && x.ref.id === item.ref.id ? tagged : x)) });
  changed();
}

/**
 * Send it. A LifeOS-held item goes with the `updatedAt` it was shown with, so a draft rewritten since is refused, not sent.
 * `again`: he chose Send again on a send that may have gone; the host refuses a plain press on one.
 */
export async function sendItem(item: HostItem, opts: { again?: boolean } = {}): Promise<OutboxItem> {
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.send", { ref: item.ref, rev: item.updatedAt, ...(opts.again ? { again: true } : {}) });
  } finally {
    void loadHost(item.environmentId);
  }
}

export async function discardItem(item: HostItem): Promise<OutboxItem> {
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.discard", { ref: item.ref });
  } finally {
    void loadHost(item.environmentId);
  }
}

export async function editItem(item: HostItem, payload: unknown): Promise<OutboxItem> {
  try {
    const after = await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.edit", { ref: item.ref, payload });
    putItem(item.environmentId, after);
    return after;
  } finally {
    void loadHost(item.environmentId);
  }
}

/** The whole act, a computer act's picture included (the list leaves it out). */
export function fetchItem(environmentId: string, ref: HeldRef): Promise<OutboxItem> {
  return registry.linkOf(environmentId).request<OutboxItem>("work.outbox.get", { ref });
}

/** Let later acts like this one go, then send this one: the grant is made from the item, never on its own. */
export async function grantAndSend(item: HostItem, grant: { matcher: unknown; label: string }): Promise<OutboxItem> {
  await registry.linkOf(item.environmentId).request<OutboxGrant>("work.outbox.grant", { from: item.ref, matcher: grant.matcher, label: grant.label });
  return sendItem(item);
}

export async function removeGrant(grant: HostGrant): Promise<void> {
  try {
    await registry.linkOf(grant.environmentId).request<OutboxGrant>("work.outbox.ungrant", { id: grant.id });
  } finally {
    void loadHost(grant.environmentId);
  }
}

/** Several at once, each its own press; answers how many went and the first refusal. */
export async function sendMany(items: readonly HostItem[]): Promise<{ sent: number; failed: { item: HostItem; error: string }[] }> {
  const outcomes = await Promise.allSettled(items.map((item) => registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.send", { ref: item.ref, rev: item.updatedAt })));
  for (const id of new Set(items.map((item) => item.environmentId))) void loadHost(id);
  const failed = outcomes.flatMap((o, i) => (o.status === "rejected" ? [{ item: items[i]!, error: errorText(o.reason) }] : []));
  // A press the host answered with anything but a send (it failed, or another press or device decided it first) is not one.
  const ended = outcomes.flatMap((o, i) => (o.status === "fulfilled" && !wentOut(o.value) ? [{ item: items[i]!, error: notSentWords(o.value) }] : []));
  return { sent: items.length - failed.length - ended.length, failed: [...failed, ...ended] };
}

/** Test seam. */
export function resetOutboxStore(): void {
  hosts.clear();
  loading.clear();
  again.clear();
  resetResults();
  changed();
}

// ── pushes ────────────────────────────────────────────────────────────────

registry.onLink((link, event) => {
  if (event === "removed") {
    hosts.delete(link.environmentId);
    changed();
    return;
  }
  link.onPush((push) => {
    if (push.push === "work.outbox") {
      const state = hosts.get(link.environmentId) ?? emptyHost();
      hosts.set(link.environmentId, { ...state, count: push.waiting, failed: push.failed ?? state.failed });
      changed();
      // Something moved: an open page asks again; with none open the count is enough, and the page loads when it opens.
      if (listeners.size > 0) void loadHost(link.environmentId);
    } else if (push.push === "work.outbox.result") {
      applyResult(link.environmentId, push.result);
    }
  });
  // At boot and after a reconnect, the count is asked for whatever the push missed, and the open Results lists too.
  link.onOpen(() => {
    if (workSwitch.hosts().has(link.environmentId)) void loadHost(link.environmentId);
    reloadResults(link.environmentId);
  });
});

// A host whose Work turned on counts from then, read afresh; one turned off leaves the count and the lists.
let onBefore = new Set(workSwitch.hosts());
workSwitch.subscribe(() => {
  const now = workSwitch.hosts();
  if (now.size === onBefore.size && [...now].every((id) => onBefore.has(id))) return;
  for (const id of now) if (!onBefore.has(id)) void loadHost(id);
  onBefore = new Set(now);
  changed();
});

// The chunk loads after the links opened: count what already waits.
for (const id of workSwitch.hosts()) void loadHost(id);
