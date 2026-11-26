import { useMemo, useSyncExternalStore } from "react";
import { sessionStore, type MetaChanges } from "./store";
import type { SessionMeta } from "./types";

/**
 * Narrow reads of every meta, for chrome that draws a few threads of many: a
 * meta push of a thread it does not draw re-renders nothing. `useSessionMetas()`
 * hands out a new array on every meta flush (up to ten a second while threads
 * run), so a component that reads all of them renders for every push of every
 * thread on every host. Each reader here is a small selector over the store's
 * public parts (`metas`, `metaOf`, `onMetaChange`); store.ts is unchanged.
 */

type Selector<T> = { subscribe: (notify: () => void) => () => void; read: () => T };

/** The same items in the same order: what a filter that changed nothing returns. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((item, i) => item === b[i]));
}

/**
 * The selector behind `useSessionMetasWhere`: the metas `keep` holds, filtered
 * again only when a changed id was held or is now kept (the flush's `ids`), so a
 * push for any other thread costs a look at its own id and nothing else. A
 * flush that names no ids (the store cleared) filters again. Exported for tests.
 */
export function metasWhere(keep: (meta: SessionMeta) => boolean, store = sessionStore): Selector<SessionMeta[]> {
  let seen: SessionMeta[] | null = null;
  let value: SessionMeta[] = [];
  let held = new Set<string>();
  let stale = true;
  let listening = 0;
  const filter = (): void => {
    const all = store.metas();
    const next: SessionMeta[] = [];
    const ids = new Set<string>();
    for (const meta of all) {
      if (!keep(meta)) continue;
      next.push(meta);
      ids.add(meta.id);
    }
    if (!sameItems(next, value)) value = next;
    held = ids;
    seen = all;
    stale = false;
  };
  const touches = (changes: MetaChanges): boolean => {
    if (changes.ids.size === 0) return true;
    for (const id of changes.ids) {
      if (held.has(id)) return true;
      const meta = store.metaOf(id);
      if (meta && keep(meta)) return true;
    }
    return false;
  };
  return {
    subscribe: (notify) => {
      listening++;
      const off = store.onMetaChange((changes) => {
        if (stale || touches(changes)) {
          stale = true;
          notify();
        } else {
          seen = store.metas();
        }
      });
      // A change between the render that read and this subscription: read again.
      if (seen !== store.metas()) {
        stale = true;
        notify();
      }
      return () => {
        listening--;
        off();
      };
    },
    read: () => {
      if (stale || (listening === 0 && seen !== store.metas())) filter();
      return value;
    },
  };
}

/**
 * The selector behind `useSessionMetasDerived`: `derive` runs on each meta
 * flush, and the reader hears only when `same` says the result differs, so it
 * keeps the result it drew. Exported for tests.
 */
export function metasDerived<T>(derive: (metas: SessionMeta[]) => T, same: (a: T, b: T) => boolean, store = sessionStore): Selector<T> {
  let seen: SessionMeta[] | null = null;
  let value: T | undefined;
  let has = false;
  const refresh = (): boolean => {
    const all = store.metas();
    if (has && all === seen) return false;
    seen = all;
    const next = derive(all);
    if (has && same(value as T, next)) return false;
    value = next;
    has = true;
    return true;
  };
  return {
    subscribe: (notify) => {
      const off = store.onMetaChange(() => {
        if (refresh()) notify();
      });
      if (refresh()) notify();
      return off;
    },
    read: () => {
      refresh();
      return value as T;
    },
  };
}

/**
 * The metas `keep` holds, as React state: the same array until a meta it holds,
 * or one it now holds, changes. `keep` must hold every meta the caller reads
 * (a filter that leaves one out draws it stale); give it a stable identity
 * (`useCallback` with what it reads besides the meta): a new `keep` filters again.
 */
export function useSessionMetasWhere(keep: (meta: SessionMeta) => boolean): SessionMeta[] {
  const selector = useMemo(() => metasWhere(keep), [keep]);
  return useSyncExternalStore(selector.subscribe, selector.read);
}

/**
 * A value derived from every meta, as React state: derived again on each meta
 * flush, and a new value only when `same` says it differs from the one drawn.
 * Give `derive` a stable identity (`useCallback`); a new one derives again.
 */
export function useSessionMetasDerived<T>(derive: (metas: SessionMeta[]) => T, same: (a: T, b: T) => boolean): T {
  const selector = useMemo(() => metasDerived(derive, same), [derive, same]);
  return useSyncExternalStore(selector.subscribe, selector.read);
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The selector behind `useSessionTree`: the root and every thread under it,
 * walked by parent (`childrenOf`), never over every meta. It hears a flush
 * only when the flush names the root among the changed ids' ancestors
 * (`affected`), so a push of a thread outside the tree costs one set look.
 * Exported for tests.
 */
export function sessionTree(rootId: string, store = sessionStore): Selector<ReadonlySet<string>> {
  let value: ReadonlySet<string> | null = null;
  let seen: SessionMeta[] | null = null;
  let stale = true;
  let listening = 0;
  const walk = (): void => {
    const ids = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      for (const child of store.childrenOf(stack.pop()!)) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        stack.push(child.id);
      }
    }
    if (!value || !sameIds(value, ids)) value = ids;
    seen = store.metas();
    stale = false;
  };
  return {
    subscribe: (notify) => {
      listening++;
      const off = store.onMetaChange((changes) => {
        if (changes.ids.size > 0 && !changes.affected.has(rootId)) return;
        stale = true;
        notify();
      });
      if (seen !== store.metas()) {
        stale = true;
        notify();
      }
      return () => {
        listening--;
        off();
      };
    },
    read: () => {
      if (stale || !value || (listening === 0 && seen !== store.metas())) walk();
      return value!;
    },
  };
}

/** A thread and every thread under it, as React state: the same set until the tree changes. */
export function useSessionTree(rootId: string): ReadonlySet<string> {
  const selector = useMemo(() => sessionTree(rootId), [rootId]);
  return useSyncExternalStore(selector.subscribe, selector.read);
}
