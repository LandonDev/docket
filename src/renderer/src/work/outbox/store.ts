import { useEffect, useSyncExternalStore } from "react";
import type { Decision, DecisionResult, GrantOffer, OutboxGrant, OutboxItem, WorkResult } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { registry } from "../../lib/connection";
import { setOutboxFailed, setOutboxWaiting, workSwitch } from "../../lib/workSwitch";
import { applyResult, loadResults as reloadResultsOf, reloadResults, resetResults, resultsHeld, seedResults } from "./results";
import { workErrorWords } from "../../lib/workErrorWords";
import { itemFailWords } from "./failWords";
import { subscribeOutboxWant, wantOutbox, wantedOutbox, type OutboxWant } from "../../lib/outboxWant";
import { loadRequests, resetRequests } from "./requests";

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
  /** When its last read answered, and whether that read was the page's whole one (Done, grants and offers too). */
  readAt: number;
  whole: boolean;
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

const emptyHost = (): HostState => ({ waiting: [], done: [], grants: [], offers: [], count: 0, failed: 0, loaded: false, error: null, readAt: 0, whole: false });

/**
 * The Outbox page mounted: only it reads Done, the grants and the offers. Today, Messages and Away read what waits,
 * so a push while they are open costs one ask a host, not four (docs/agents/work-outbox.md "What the store asks").
 */
let pages = 0;
/** A mount reads again only what is older than this; a push, a press and a reconnect read at once regardless. */
export const FRESH_MS = 30_000;
/** Pushes this close together are one read and one notify. */
export const JOIN_MS = 500;

function changed(): void {
  snapshot = null;
  recount();
  for (const listener of listeners) listener();
}

/** The rail's count and failed mark, from each host with Work on. The lists' readers are not told: no list moved. */
function recount(): void {
  let count = 0;
  let failed = 0;
  for (const [id, state] of hosts)
    if (workSwitch.hosts().has(id)) {
      count += state.count;
      failed += state.failed;
    }
  setOutboxWaiting(count);
  setOutboxFailed(failed);
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
const rowKey = (item: Pick<OutboxItem, "ref">): string => `${item.ref.at}:${item.ref.id}`;
/** The host's rows, each the same object as before when nothing it shows moved: a memoised row draws only when it changed. */
function keep(environmentId: string, rows: OutboxItem[], before: readonly HostItem[]): HostItem[] {
  const was = new Map(before.map((item) => [rowKey(item), item]));
  return rows.map((row) => {
    const old = was.get(rowKey(row));
    return old && old.updatedAt === row.updatedAt && old.state === row.state && old.decidedAt === row.decidedAt && old.dismissedAt === row.dismissedAt ? old : { ...row, environmentId };
  });
}
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const loading = new Map<string, Promise<void>>();
/** Hosts asked for again while a load ran: what changed during it is read by one more load after it. */
const again = new Set<string>();
const joining = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped by a reset: a read that answers after it is dropped. */
let epoch = 0;

/**
 * One host's Outbox read now: what waits, and, while the Outbox page is open (or `whole`), Done, the standing grants
 * and the offers. One notify when it lands.
 */
export function loadHost(environmentId: string, opts: { whole?: boolean } = {}): Promise<void> {
  const inFlight = loading.get(environmentId);
  if (inFlight) {
    again.add(environmentId);
    return inFlight;
  }
  clearTimeout(joining.get(environmentId));
  joining.delete(environmentId);
  const whole = !!opts.whole || pages > 0;
  const link = registry.linkOf(environmentId);
  const asked = epoch;
  const load = Promise.all([
    link.request<{ items: OutboxItem[]; waiting: number }>("work.outbox.list", { show: "waiting" }),
    whole ? link.request<{ items: OutboxItem[] }>("work.outbox.list", { show: "done", limit: 100 }) : null,
    whole ? link.request<{ grants: OutboxGrant[] }>("work.outbox.grants", {}) : null,
    // The offers are read beside the list and never in its way: a key without approve, or a host from before offers, has none.
    whole ? link.request<{ offers: GrantOffer[] }>("work.outbox.offers", {}).catch(() => ({ offers: [] as GrantOffer[] })) : null,
  ])
    .then(([waiting, decided, grants, offers]) => {
      if (asked !== epoch) return;
      const was = hosts.get(environmentId) ?? emptyHost();
      hosts.set(environmentId, {
        waiting: keep(environmentId, waiting.items, was.waiting),
        // A read of what waits alone keeps the page's lists as they were: they are read again when the page opens.
        done: decided ? keep(environmentId, decided.items.filter((item) => item.state === "sent" || item.state === "discarded" || item.state === "stale"), was.done) : was.done,
        grants: grants ? tag(environmentId, grants.grants) : was.grants,
        // A host that answers with no list (one a release behind) offers nothing.
        offers: offers ? tag(environmentId, offers.offers ?? []) : was.offers,
        count: waiting.waiting,
        failed: waiting.items.filter((item) => item.state === "failed").length,
        loaded: true,
        error: null,
        readAt: Date.now(),
        // Only a whole read stands for Done, the grants and the offers: a read of what waits after a push says nothing of them.
        whole,
      });
    })
    .catch((err: unknown) => {
      if (asked !== epoch) return;
      hosts.set(environmentId, { ...(hosts.get(environmentId) ?? emptyHost()), loaded: true, error: errorText(err), readAt: 0 });
    })
    .finally(() => {
      if (asked !== epoch) return;
      loading.delete(environmentId);
      changed();
      if (again.delete(environmentId)) void loadHost(environmentId);
    });
  loading.set(environmentId, load);
  // A thread's requests are read with its list: Asked in threads leads Waiting.
  void loadRequests(environmentId);
  return load;
}

/** A push said something moved: one read after JOIN_MS, however many pushes come in it. */
function loadSoon(environmentId: string): void {
  if (joining.has(environmentId)) return;
  joining.set(
    environmentId,
    setTimeout(() => {
      joining.delete(environmentId);
      void loadHost(environmentId);
    }, JOIN_MS),
  );
}

/** When the last reader of the lists left: from then until one comes back, the lists are kept current by no read. */
let quietSince = 0;

/**
 * Whether a host's last read is current and deep enough that a mount need not ask again: no push said it moved since
 * (a push with no reader marks it, `readAt: 0`; a reconnect reads it at once), and it was read in the last FRESH_MS or
 * a reader has listened, reading on each push, ever since.
 */
const fresh = (environmentId: string, whole: boolean): boolean => {
  const state = hosts.get(environmentId);
  if (!state || !state.loaded || state.error || !state.readAt || (whole && !state.whole)) return false;
  return Date.now() - state.readAt < FRESH_MS || state.readAt > quietSince;
};

/**
 * Every host with Work on, asked again. `ifStale`: a mount's read, which skips a host read in the last FRESH_MS (to the
 * depth the page needs), since the pushes keep what it holds current.
 */
export function loadOutbox(opts: { ifStale?: boolean } = {}): Promise<void> {
  return Promise.all([...workSwitch.hosts()].filter((id) => !opts.ifStale || !fresh(id, pages > 0)).map((id) => loadHost(id))).then(() => undefined);
}

/** The Outbox page's own read: mounted, the store reads Done, the grants and the offers too. */
export function useOutboxPage(): void {
  useEffect(() => {
    pages++;
    void loadOutbox({ ifStale: true });
    return () => void pages--;
  }, []);
}

/** The merged Outbox as it stands, outside React. */
export const outboxNow = (): OutboxView => view();

export function useOutbox(): OutboxView {
  return useSyncExternalStore(subscribe, view, view);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) quietSince = Date.now();
  };
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
    // `rev`: what he saw; a row that moved since is refused rather than put away unseen.
    return await registry
      .linkOf(item.environmentId)
      .request<OutboxItem>("work.outbox.discard", { ref: item.ref, rev: item.updatedAt, ...(reason ? { reason } : {}), ...(opts.via ? { via: opts.via } : {}) });
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
    if (item.state === "scheduled") return (await link.request<OutboxItem>("work.outbox.cancelSend", { ref: item.ref, rev: item.updatedAt })).state === "held";
    return (await link.request<{ back: boolean }>("work.mail.cancel", { id: item.ref.id })).back;
  } finally {
    void loadHost(item.environmentId);
  }
}

/** Send a timed send now, rather than at its time. */
export async function sendNow(item: HostItem): Promise<OutboxItem> {
  try {
    return await registry.linkOf(item.environmentId).request<OutboxItem>("work.outbox.sendNow", { ref: item.ref, rev: item.updatedAt });
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

/** An item's whole read as its detail asks it: the act, and a decided act's Results with it. */
type Detail = OutboxItem & { results?: WorkResult[] };
const details = new Map<string, Promise<Detail>>();
const DETAILS_AT_MOST = 16;

/** Whether a detail's read carries the act's Results: a decided act with a thread, whose way back the detail shows. */
const wantsResults = (item: Pick<HostItem, "sessionId" | "decidedAt">): boolean => !!item.sessionId && item.decidedAt != null;

/**
 * One item's detail in one ask: `work.outbox.get`, which carries a decided act's Results too (`results: true`), shared
 * by every part of the detail that needs the whole act (a mail's quote, a computer act's picture, the way back) while
 * it is out. Only while it is out: a detail mounted again reads the item afresh, as each mount always has. A host from
 * before that answer gives no `results`: they are asked on their own.
 */
export function fetchDetail(item: HostItem): Promise<Detail> {
  const key = `${item.environmentId}|${item.ref.at}|${item.ref.id}|${item.updatedAt}`;
  const out = details.get(key);
  if (out) return out;
  const withResults = wantsResults(item);
  const read = registry
    .linkOf(item.environmentId)
    .request<Detail>("work.outbox.get", { ref: item.ref, ...(withResults ? { results: true } : {}) })
    .then((whole) => {
      if (withResults && item.sessionId && Array.isArray(whole.results)) seedResults(item.environmentId, item.sessionId, whole.results);
      return whole;
    });
  // Settled, it is forgotten: a later mount or a Retry asks again.
  const settled = (): void => void (details.get(key) === read && details.delete(key));
  read.then(settled, settled);
  details.set(key, read);
  while (details.size > DETAILS_AT_MOST) details.delete(details.keys().next().value!);
  return read;
}

/**
 * A decided act's Results for its detail: held already (the right panel read them), else read by the detail's one ask.
 * A host whose answer carried none is asked for them on their own.
 */
export function readDetailResults(item: HostItem): void {
  if (!item.sessionId || resultsHeld(item.environmentId, item.sessionId)) return;
  const sessionId = item.sessionId;
  void fetchDetail(item).then(
    (whole) => {
      if (!Array.isArray(whole.results)) reloadResultsOf(item.environmentId, sessionId);
    },
    () => reloadResultsOf(item.environmentId, sessionId),
  );
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
export async function decideMany(
  items: readonly HostItem[],
  choice: DecideDo,
  opts: { via?: PressVia; onHost?: (results: Map<string, DecisionResult>) => void; /** a press that is many whatever its size (a request's retry) */ many?: boolean } = {},
): Promise<Map<string, DecisionResult>> {
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
          // A press that spans hosts is many on each host, so a part of one item earns no grant offer.
          .request<{ results: DecisionResult[] }>("work.outbox.decide", { items: list.map(decision), ...(byHost.size > 1 || opts.many ? { many: true } : {}), ...(opts.via ? { via: opts.via } : {}) });
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

/**
 * A notice's press asks the Outbox page for one item or request (lib/outboxWant.ts, the first paint's door): by the
 * page's own key (`<host>:<ref.at>:<ref.id>`, `request:<host>:<id>`) or by its host's number. The page picks it once it
 * holds it, then clears this.
 */
export function wantOutboxItem(want: OutboxWant | null): void {
  wantOutbox(want);
}
export function useWantedOutboxItem(): OutboxWant | null {
  return useSyncExternalStore(subscribeOutboxWant, wantedOutbox, wantedOutbox);
}

/** Test seam. */
export function resetOutboxStore(): void {
  wantOutbox(null);
  resetRequests();
  hosts.clear();
  loading.clear();
  again.clear();
  details.clear();
  quietSince = 0;
  epoch++;
  for (const timer of joining.values()) clearTimeout(timer);
  joining.clear();
  pages = 0;
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
      // The count is the push's own: patched in place, with no ask.
      if (state.count !== push.waiting || state.failed !== (push.failed ?? state.failed)) {
        hosts.set(link.environmentId, { ...state, count: push.waiting, failed: push.failed ?? state.failed });
        recount();
      }
      // Something moved: a reader that shows the lists reads them again, once for every push within JOIN_MS; with none
      // the count is enough, and a mount reads what is stale.
      if (listeners.size > 0) loadSoon(link.environmentId);
      else if (hosts.has(link.environmentId)) hosts.set(link.environmentId, { ...hosts.get(link.environmentId)!, readAt: 0 });
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
