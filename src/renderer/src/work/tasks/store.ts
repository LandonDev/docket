import { useSyncExternalStore } from "react";

/**
 * A value a view's header and its body share: the header's verb opens the
 * body's dialog, the Agenda's segment picks its view. One per view, outside
 * React, as the Routines view does it.
 */
export function shared<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    use(): T {
      return useSyncExternalStore(
        (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
        () => value,
      );
    },
  };
}
