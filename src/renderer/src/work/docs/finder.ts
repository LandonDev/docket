import { useSyncExternalStore } from "react";
import type { FindAnswer } from "@shared/contract-work-docs";
import type { ContextChip } from "@shared/work";
import { DEFAULT_SPEC, type FindEntry, type FindSpec } from "@shared/work/docFind";

/**
 * The Docs view's own state per workspace (docs/agents/work-docs.md
 * "Finding documents"): the search, filters, grouping, order and layout in
 * hand, the saved view they came from, and the rows picked. The header and
 * the body read the same store, so the search in the header narrows the list
 * under it. Kept for the window's life, so leaving the view and coming back
 * keeps what he had.
 */

export interface FinderState {
  spec: FindSpec;
  /** the saved view the spec came from, if any */
  viewId: string | null;
  /** picked rows, by entry key */
  selected: ReadonlySet<string>;
  /** the row a shift-click ranges from */
  anchor: string | null;
}

/** One value per workspace, read by the header and the body alike. */
function keyed<T>(initial: T) {
  const values = new Map<string, T>();
  const listeners = new Set<() => void>();
  const get = (key: string): T => values.get(key) ?? initial;
  return {
    get,
    set(key: string, patch: Partial<T> | ((v: T) => Partial<T>)): void {
      const was = get(key);
      values.set(key, { ...was, ...(typeof patch === "function" ? patch(was) : patch) });
      for (const l of listeners) l();
    },
    use(key: string): T {
      return useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => get(key),
      );
    },
    reset(): void {
      values.clear();
      for (const l of listeners) l();
    },
  };
}

const finders = keyed<FinderState>({ spec: DEFAULT_SPEC, viewId: null, selected: new Set(), anchor: null });
export const finderOf = finders.get;
export const setFinder = finders.set;
export const useFinder = finders.use;
/** The spec changed by part, keeping everything else. */
export const setSpec = (workspaceId: string, patch: Partial<FindSpec>): void => setFinder(workspaceId, (s) => ({ spec: { ...s.spec, ...patch } }));

/** What the host answered for a workspace: the list, and the text matches of the query in hand. */
export interface Found {
  answer: FindAnswer | null;
  error: string | null;
  /** text matches by entry key, for `hitsFor` */
  hits: ReadonlyMap<string, string>;
  hitsFor: string;
  /** a text search is on its way */
  searching: boolean;
}
const founds = keyed<Found>({ answer: null, error: null, hits: new Map(), hitsFor: "", searching: false });
export const foundOf = founds.get;
export const setFound = founds.set;
export const useFound = founds.use;

/** For tests: every workspace back to nothing. */
export function resetFinders(): void {
  finders.reset();
  founds.reset();
}

/** Two specs ask for the same list: a saved view counts as changed only when they do not. */
export function sameSpec(a: FindSpec, b: FindSpec): boolean {
  const norm = (s: FindSpec) => JSON.stringify({ ...s, query: s.query.trim(), filter: Object.fromEntries(Object.entries(s.filter).filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== false)).sort()) });
  return norm(a) === norm(b);
}

/** An entry the Docs view opens in its own editor: a LifeOS document, a `.tcdoc`, a Google Doc. */
export function opensHere(e: FindEntry): boolean {
  const s = e.source;
  if (e.kind !== "document") return false;
  if (s.at === "lifeos") return s.table === "docs";
  if (s.at === "file") return s.path.toLowerCase().endsWith(".tcdoc");
  return s.at === "google";
}

/** The chip a thread about the entry starts with; null for an item only its own thread can name. */
export function chipOf(e: FindEntry): ContextChip | null {
  if (e.source.at === "thread") return null;
  return { kind: "selection", label: e.title.slice(0, 500), ref: e.source };
}

/** Picking a row: alone it toggles; with shift, every row from the anchor to it takes the anchor's new state. */
export function pick(order: readonly string[], s: Pick<FinderState, "selected" | "anchor">, key: string, range: boolean): Pick<FinderState, "selected" | "anchor"> {
  const next = new Set(s.selected);
  const from = range && s.anchor ? order.indexOf(s.anchor) : -1;
  const to = order.indexOf(key);
  if (from >= 0 && to >= 0) {
    const on = s.selected.has(s.anchor!);
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) on ? next.add(order[i]!) : next.delete(order[i]!);
    return { selected: next, anchor: s.anchor };
  }
  next.has(key) ? next.delete(key) : next.add(key);
  return { selected: next, anchor: key };
}
