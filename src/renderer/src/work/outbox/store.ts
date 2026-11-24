import { useSyncExternalStore } from "react";
import type { Decision, DecisionResult, GrantOffer, OutboxGrant, OutboxItem, WorkResult } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { registry } from "../../lib/connection";
import { setOutboxFailed, setOutboxWaiting, workSwitch } from "../../lib/workSwitch";
import { applyResult, reloadResults, resetResults } from "./results";
import { workErrorWords } from "../../lib/workErrorWords";
import { itemFailWords } from "./failWords";

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
export type HostOffer = GrantOffer & { environmentId: string };
export type { HostResult } from "./results";

type HostState = {
  waiting: HostItem[];
  /** what went, what he discarded, and what went out of date that he put away */
  done: HostItem[];
  grants: HostGrant[];
  offers: HostOffer[];
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
  /** Done: sent, discarded, and out of date put away, newest first */
  done: HostItem[];
  grants: HostGrant[];
  /** grants he has earned and not yet decided, each beside the item that completed its run */
  offers: HostOffer[];
  /** every host with Work on has answered once, or failed to */
  loaded: boolean;
  /** every host with Work on has answered, none failed: only then is an empty list known to be clear */
  complete: boolean;
  /** hosts whose list did not come back, with why */
  errors: { environmentId: string; error: string }[];
};

const emptyHost = (): HostState => ({ waiting: [], done: [], grants: [], offers: [], count: 0, failed: 0, loaded: false, error: null });

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
    done: on.flatMap((h) => h.done).sort((a, b) => (b.dismissedAt ?? b.decidedAt ?? b.updatedAt) - (a.dismissedAt ?? a.decidedAt ?? a.updatedAt)),
    grants: on.flatMap((h) => h.grants).sort((a, b) => b.createdAt - a.createdAt),
    offers: on.flatMap((h) => h.offers),
    loaded: workSwitch.hosts().size > 0 && [...workSwitch.hosts()].every((id) => hosts.get(id)?.loaded),
    complete: workSwitch.hosts().size > 0 && [...workSwitch.hosts()].every((id) => hosts.get(id)?.loaded && !hosts.get(id)?.error),
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
    link.request<{ items: OutboxItem[] }>("work.outbox.list", { show: "done", limit: 100 }),
    link.request<{ grants: OutboxGrant[] }>("work.outbox.grants", {}),
  ])
    .then(([waiting, decided, grants]) => {
      hosts.set(environmentId, {
        waiting: tag(environmentId, waiting.items),
        done: tag(environmentId, decided.items.filter((item) => item.state === "sent" || item.state === "discarded" || item.state === "stale")),
        grants: tag(environmentId, grants.grants),
        offers: hosts.get(environmentId)?.offers ?? [],
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
  loadOffers(environmentId);
  return load;
}

/**
 * The grants a host offers, read beside its list and never in its way: a key
 * without approve, or a host from before offers, has none to show.
 */
function loadOffers(environmentId: string): void {
  void registry
    .linkOf(environmentId)
    .request<{ offers: GrantOffer[] }>("work.outbox.offers", {})
    .catch(() => ({ offers: [] as GrantOffer[] }))
    .then(({ offers }) => {
      // A host that answers with no list (one a release behind) offers nothing.
      hosts.set(environmentId, { ...(hosts.get(environmentId) ?? emptyHost()), offers: tag(environmentId, offers ?? []) });
      changed();
    });
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
export function notSentWords(after: Pick<OutboxItem, "state" | "error" | "outcomeUnknown">): string {
  if (after.state === "discarded") return "Already discarded";
  if (after.state === "stale") return workErrorWords(after.error ?? "") || "It changed since it was held; look again";
  return itemFailWords(after);
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
export async function sendItem(item: HostItem, opts: { again?: boolean; via?: PressVia } = {}): Promise<OutboxItem> {
  try {
    return await registry
      .linkOf(item.environmentId)
      .request<OutboxItem>("work.outbox.send", { ref: item.ref, rev: item.updatedAt, ...(opts.again ? { again: true } : {}), ...(opts.via ? { via: opts.via } : {}) });
  } finally {
    void loadHost(item.environmentId);
  }
}

/** Where a press was made, as Done says it. */
export type PressVia = "outbox" | "today" | "phone" | "mail";

/** It will never go. `reason`: his words for the thread (500 characters at most). */
export async function discardItem(item: HostItem, opts: { reason?: string; via?: PressVia } = {}): Promise<OutboxItem> {
  const reason = opts.reason?.trim().slice(0, 500);
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.discard", { ref: item.ref, ...(reason ? { reason } : {}), ...(opts.via ? { via: opts.via } : {}) });
  } finally {
    void loadHost(item.environmentId);
  }
}

/** An item that went out of date, put away, and its thread asked to draft it again from what is true now. */
export async function askAgain(item: HostItem): Promise<OutboxItem> {
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.askAgain", { ref: item.ref });
  } finally {
    void loadHost(item.environmentId);
  }
}

/**
 * Cancel send on a send he timed: the host's own (`work.outbox.cancelSend`, back to held) or a LifeOS mail Mail
 * scheduled (`work.mail.cancel`, back to a draft that waits on him again). False when it is already on its way.
 */
export async function cancelScheduled(item: HostItem): Promise<boolean> {
  try {
    const link = registry.linkOf(item.environmentId);
    if (item.state === "scheduled") return (await link.request<OutboxItem>("work.outbox.cancelSend", { ref: item.ref })).state === "held";
    return (await link.request<{ back: boolean }>("work.mail.cancel", { id: item.ref.id })).back;
  } finally {
    void loadHost(item.environmentId);
  }
}

/** Send a timed send now, rather than at its time. */
export async function sendNow(item: HostItem): Promise<OutboxItem> {
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.sendNow", { ref: item.ref });
  } finally {
    void loadHost(item.environmentId);
  }
}

/** Take a LifeOS mail back while LifeOS still holds it in its undo time: true when it is back as held. */
export async function undoSend(item: Pick<HostItem, "environmentId" | "ref">): Promise<boolean> {
  try {
    return (await registry.linkOf(item.environmentId).request<{ back: boolean }>("work.outbox.undoSend", { ref: item.ref })).back;
  } finally {
    void loadHost(item.environmentId);
  }
}

/** Whether a press's toast may take it back through `undoSend`: a LifeOS mail LifeOS still holds in its undo time. */
export const mayUndoSend = (item: Pick<HostItem, "kind">, after: Pick<OutboxItem, "state" | "lifeos">): boolean => item.kind === "mail.send" && after.state === "sent" && after.lifeos === "queued";

/** The Result a press left with a way back, read from its thread's Results: null when it left none (a mail), or none came. */
export async function resultOf(item: Pick<HostItem, "environmentId" | "sessionId" | "ref">): Promise<(WorkResult & { environmentId: string }) | null> {
  if (!item.sessionId) return null;
  try {
    const { results } = await registry.linkOf(item.environmentId).request<{ results: WorkResult[] }>("work.outbox.results", { sessionId: item.sessionId, limit: 20 });
    const row = results.find((r) => {
      const held = (r.ref as { held?: { at: string; id: string } } | null)?.held;
      return held?.at === item.ref.at && held.id === item.ref.id;
    });
    return row && row.undo && !row.undoneAt ? { ...row, environmentId: item.environmentId } : null;
  } catch {
    return null;
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

/** The offer whose run this item completed, if one is open. */
export const offerFrom = (offers: readonly HostOffer[], item: Pick<HostItem, "environmentId" | "ref">): HostOffer | null =>
  offers.find((o) => o.environmentId === item.environmentId && o.from.at === item.ref.at && o.from.id === item.ref.id) ?? null;

/** Whether the press just made completed a run: read from the host, which makes the offer before the press answers. */
export async function offerAfterPress(item: HostItem): Promise<HostOffer | null> {
  try {
    const { offers } = await registry.linkOf(item.environmentId).request<{ offers: GrantOffer[] }>("work.outbox.offers", {});
    return offerFrom(tag(item.environmentId, offers), item);
  } catch {
    return null;
  }
}

/** Make the grant he earned. The host makes it from the offer's item with the matcher it worked out: only the offer is named. */
export async function takeOffer(offer: HostOffer): Promise<HostGrant> {
  try {
    const grant = await registry.linkOf(offer.environmentId).request<OutboxGrant>("work.outbox.takeOffer", { id: offer.id });
    return { ...grant, environmentId: offer.environmentId };
  } finally {
    void loadHost(offer.environmentId);
  }
}

/** Never offered again. */
export async function dismissOffer(offer: HostOffer): Promise<void> {
  try {
    await registry.linkOf(offer.environmentId).request<GrantOffer>("work.outbox.dismissOffer", { id: offer.id });
  } finally {
    void loadHost(offer.environmentId);
  }
}

export async function removeGrant(grant: HostGrant): Promise<void> {
  try {
    await registry.linkOf(grant.environmentId).request<OutboxGrant>("work.outbox.ungrant", { id: grant.id });
  } finally {
    void loadHost(grant.environmentId);
  }
}

/** One press's choice for every item it takes. */
export type DecideDo = { do: "send" } | { do: "discard"; reason?: string } | { do: "later"; at: number; zone: string };

/**
 * One press on many items (ticked rows, a group's Select N): one `work.outbox.decide` per host, in parallel,
 * each item with the revision it was shown with. The host judges each (one out of date, a live screen's act, a
 * computer act and a LifeOS reply that quotes its mail are refused inside a press on many) and answers each in
 * the order asked. `onHost` hears each host's answers as they land, so rows show their results as they come.
 * A host that did not answer fails each of its items with why.
 */
export async function decideMany(items: readonly HostItem[], choice: DecideDo, opts: { via?: PressVia; onHost?: (results: Map<string, DecisionResult>) => void } = {}): Promise<Map<string, DecisionResult>> {
  const byHost = new Map<string, HostItem[]>();
  for (const item of items) byHost.set(item.environmentId, [...(byHost.get(item.environmentId) ?? []), item]);
  const all = new Map<string, DecisionResult>();
  const decision = (item: HostItem): Decision => ({
    ref: item.ref,
    do: choice.do,
    rev: item.updatedAt,
    ...(choice.do === "discard" && choice.reason?.trim() ? { reason: choice.reason.trim().slice(0, 500) } : {}),
    ...(choice.do === "later" ? { at: choice.at, zone: choice.zone } : {}),
  });
  await Promise.all(
    [...byHost].map(async ([environmentId, list]) => {
      const mine = new Map<string, DecisionResult>();
      try {
        const { results } = await registry
          .linkOf(environmentId)
          .request<{ results: DecisionResult[] }>("work.outbox.decide", { items: list.map(decision), ...(opts.via ? { via: opts.via } : {}) });
        list.forEach((item, i) => mine.set(`${environmentId}:${item.ref.at}:${item.ref.id}`, results[i] ?? { ref: item.ref, ok: false, error: "No answer for it" }));
      } catch (err) {
        for (const item of list) mine.set(`${environmentId}:${item.ref.at}:${item.ref.id}`, { ref: item.ref, ok: false, error: errorText(err) });
      } finally {
        void loadHost(environmentId);
      }
      for (const [k, v] of mine) all.set(k, v);
      opts.onHost?.(mine);
    }),
  );
  return all;
}

// ── an item asked for from outside ───────────────────────────────────────

let wanted: string | null = null;
const wantedListeners = new Set<() => void>();
/** A notice's press asks the Outbox page for one item, by the page's own key (`<host>:<ref.at>:<ref.id>`); the page picks it once it holds it, then clears this. */
export function wantOutboxItem(key: string | null): void {
  if (wanted === key) return;
  wanted = key;
  for (const listener of wantedListeners) listener();
}
export function useWantedOutboxItem(): string | null {
  return useSyncExternalStore(
    (listener) => {
      wantedListeners.add(listener);
      return () => void wantedListeners.delete(listener);
    },
    () => wanted,
    () => wanted,
  );
}

/** Test seam. */
export function resetOutboxStore(): void {
  wanted = null;
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
