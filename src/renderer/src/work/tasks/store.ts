import { useSyncExternalStore } from "react";

/**
 * A value a view's header and its body share: the header's verb opens the
 * body's dialog, the Agenda's segment picks its view. One per view, outside
 * React, as the Routines view does it. Read it with `useShared`: a hook by
 * name, so the React Compiler never caches the read.
 */
export type Shared<T> = { get(): T; set(next: T): void; subscribe(fn: () => void): () => void };

export function shared<T>(initial: T): Shared<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export function useShared<T>(store: Shared<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
