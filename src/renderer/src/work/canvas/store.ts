import { useSyncExternalStore } from "react";
import type { CanvasItem, CanvasKind, CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The renderer's copy of each thread's canvas items (the host's
 * `work_canvas_items`, src/main/server/work/canvas): the open items in tab
 * order, fetched once per thread on first use and kept current by the
 * `work.canvas` push, which carries the whole list. Beside them, what only
 * this window knows: which tab is shown, whether the thread is folded away,
 * and the view state a kind keeps for an item while its body is unmounted.
 * The shown tab and the fold persist per thread across launches.
 */

export interface CanvasView {
  /** The open items in tab order; empty until the first answer. */
  items: readonly CanvasItem[];
  /** The first answer has come (or failed). */
  loaded: boolean;
  /** The item shown; null with no items. */
  selected: string | null;
  /** The thread is folded away and the item takes the pane. */
  folded: boolean;
}

interface Entry extends CanvasView {
  environmentId: string | null;
}

type Listener = () => void;

const EMPTY: CanvasView = { items: [], loaded: false, selected: null, folded: false };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<Listener>>();
/** A kind's view state per item id: memory only, gone with the window. */
const kept = new Map<string, unknown>();

const STORAGE_KEY = "work.canvas.view.v1";
/** Threads whose shown tab and fold are remembered; the oldest go first. */
const REMEMBERED = 200;
type Remembered = Record<string, { selected?: string; folded?: boolean }>;

function remembered(): Remembered {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

function remember(sessionId: string, entry: Entry): void {
  try {
    const all = remembered();
    delete all[sessionId];
    if (entry.selected || entry.folded) all[sessionId] = { ...(entry.selected ? { selected: entry.selected } : {}), ...(entry.folded ? { folded: true } : {}) };
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - REMEMBERED))) delete all[id];
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* a full or absent store costs only the memory */
  }
}

function entryOf(sessionId: string): Entry {
  let entry = entries.get(sessionId);
  if (!entry) {
    const was = remembered()[sessionId];
    entry = { ...EMPTY, environmentId: null, selected: was?.selected ?? null, folded: was?.folded === true };
    entries.set(sessionId, entry);
  }
  return entry;
}

function write(sessionId: string, patch: Partial<Entry>): void {
  const prev = entryOf(sessionId);
  const next = { ...prev, ...patch };
  entries.set(sessionId, next);
  if (next.selected !== prev.selected || next.folded !== prev.folded) remember(sessionId, next);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** The tab to show after the list changed: the one shown if it is still open, else its old neighbour, else the first. */
export function selectedAfter(prev: readonly CanvasItem[], next: readonly CanvasItem[], selected: string | null): string | null {
  if (next.length === 0) return null;
  if (selected && next.some((item) => item.id === selected)) return selected;
  const at = prev.findIndex((item) => item.id === selected);
  if (at < 0) return next[0].id;
  const after = prev.slice(at + 1).find((item) => next.some((n) => n.id === item.id));
  const before = prev.slice(0, at).reverse().find((item) => next.some((n) => n.id === item.id));
  return (after ?? before ?? next[0]).id;
}

/** `confirmed`: the list is the host's own word (an answer or a push), not this window's guess ahead of it. */
function putItems(sessionId: string, items: readonly CanvasItem[], opened?: string, confirmed = true): void {
  const prev = entryOf(sessionId);
  // With nothing left open the thread takes the pane back, so the fold has nothing to fold.
  const folded = items.length === 0 ? false : prev.folded;
  // Until the first answer the remembered tab is kept: a closed tab is found out when the list comes.
  const selected = opened && items.some((item) => item.id === opened) ? opened : selectedAfter(prev.items, items, prev.selected);
  // A kind's kept state goes only once the host says the item closed: a close it refuses puts the tab back as it was.
  if (confirmed) for (const id of [...kept.keys()]) if (prev.items.some((item) => item.id === id) && !items.some((item) => item.id === id)) kept.delete(id);
  write(sessionId, { items, loaded: true, selected, folded });
}

/** What is known now of a thread's canvas. */
export function canvasOf(sessionId: string): CanvasView {
  return entries.get(sessionId) ?? EMPTY;
}

/** Fetch (or fetch again) a thread's open items from its host. A failure reads as none: the thread still shows. */
export function loadCanvas(environmentId: string, sessionId: string): Promise<void> {
  const inFlight = pending.get(sessionId);
  if (inFlight) return inFlight;
  entryOf(sessionId).environmentId = environmentId;
  const load = registry
    .linkOf(environmentId)
    .request<{ items: CanvasItem[] }>("work.canvas.list", { sessionId })
    .then(
      (answer) => putItems(sessionId, answer.items),
      () => write(sessionId, { loaded: true }),
    )
    .finally(() => pending.delete(sessionId));
  pending.set(sessionId, load);
  return load;
}

/** The `work.canvas` push, and a test's seam for it. */
export function applyCanvasPush(push: { sessionId: string; items: CanvasItem[]; opened?: string }): void {
  putItems(push.sessionId, push.items, push.opened);
}

export function selectItem(sessionId: string, itemId: string): void {
  if (entryOf(sessionId).items.some((item) => item.id === itemId)) write(sessionId, { selected: itemId });
}

export function setFolded(sessionId: string, folded: boolean): void {
  write(sessionId, { folded: folded && entryOf(sessionId).items.length > 0 });
}

/** Opens an item beside the thread, or reopens one by its id; the push that follows shows it. */
export async function openItem(
  environmentId: string,
  sessionId: string,
  what: { itemId: string } | { kind: CanvasKind; source: CanvasSource; title: string },
): Promise<CanvasItem> {
  const item = await registry.linkOf(environmentId).request<CanvasItem>("work.canvas.open", { sessionId, ...what });
  const view = entryOf(sessionId);
  // The push may not have come yet (or this socket missed it): show the item now.
  putItems(sessionId, view.items.some((i) => i.id === item.id) ? view.items : [...view.items, item], item.id);
  return item;
}

/** Closes a tab at once; a host that refuses puts it back. */
export async function closeItem(environmentId: string, sessionId: string, itemId: string): Promise<void> {
  const before = entryOf(sessionId).items;
  putItems(sessionId, before.filter((item) => item.id !== itemId), undefined, false);
  try {
    await registry.linkOf(environmentId).request("work.canvas.close", { itemId });
    kept.delete(itemId);
  } catch (error) {
    await loadCanvas(environmentId, sessionId);
    throw error;
  }
}

/** The tab order as dragged; the host's answer is the order kept. */
export async function reorderItems(environmentId: string, sessionId: string, order: readonly string[]): Promise<void> {
  const view = entryOf(sessionId);
  const byId = new Map(view.items.map((item) => [item.id, item]));
  const listed = order.flatMap((id) => byId.get(id) ?? []);
  write(sessionId, { items: [...listed, ...view.items.filter((item) => !order.includes(item.id))] });
  try {
    const answer = await registry.linkOf(environmentId).request<{ items: CanvasItem[] }>("work.canvas.reorder", { sessionId, order: [...order] });
    putItems(sessionId, answer.items);
  } catch (error) {
    await loadCanvas(environmentId, sessionId);
    throw error;
  }
}

function listen(map: Map<string, Set<Listener>>, key: string, listener: Listener): () => void {
  const set = map.get(key) ?? new Set<Listener>();
  map.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}

const subscribe = (sessionId: string, listener: Listener): (() => void) => listen(listeners, sessionId, listener);

const keptListeners = new Map<string, Set<Listener>>();
/** A kind's view state for an item: kept while its body is unmounted, and one value for its body, its bar and its tab row slot. */
export const keptState = (itemId: string): unknown => kept.get(itemId);
export function keepState(itemId: string, state: unknown): void {
  kept.set(itemId, state);
  for (const listener of keptListeners.get(itemId) ?? []) listener();
}
export function useKeptState(itemId: string): [unknown, (next: unknown) => void] {
  const state = useSyncExternalStore(
    (listener) => listen(keptListeners, itemId, listener),
    () => kept.get(itemId),
  );
  return [state, (next) => keepState(itemId, next)];
}

/** A thread's canvas, live. Fetches on first use. */
export function useCanvas(environmentId: string, sessionId: string): CanvasView {
  const view = useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => canvasOf(sessionId),
  );
  // Asked once per thread and host: a thread that moved is asked again of the host it is on now, so a
  // reconnect of the host it left never answers for it.
  if ((!view.loaded || entries.get(sessionId)?.environmentId !== environmentId) && !pending.has(sessionId)) void loadCanvas(environmentId, sessionId);
  return view;
}

/** Test seam: forget everything (a module-level store). */
export function resetCanvasStore(): void {
  entries.clear();
  pending.clear();
  kept.clear();
}

registry.onLink((link, event) => {
  if (event === "removed") return;
  link.onPush((push) => {
    if (push.push === "work.canvas") applyCanvasPush(push);
  });
  // A socket that came back may have missed a push: the threads on screen ask again.
  link.onOpen(() => {
    for (const [sessionId, entry] of entries) if (entry.environmentId === link.environmentId && listeners.has(sessionId)) void loadCanvas(link.environmentId, sessionId);
  });
});
