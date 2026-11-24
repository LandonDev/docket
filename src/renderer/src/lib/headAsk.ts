import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * A press in a Work view's header that the view's body answers (New routine, New play). The header is drawn apart
 * from the body, which loads behind its own Suspense (work/shell/WorkViewPage.tsx), so a press can come before the
 * body has mounted: it waits here and the body answers it when it mounts. A press no body answered goes with the
 * header, so it never opens a form on a later visit.
 */
export function headAsk(): { ask(): void; useHead(): void; useAnswer(open: () => void): void } {
  const listeners = new Set<() => void>();
  let asked = 0;
  let answered = 0;
  const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
  return {
    ask() {
      asked++;
      for (const fn of listeners) fn();
    },
    /** The header: its going drops a press nothing answered. */
    useHead() {
      useEffect(() => () => void (answered = asked), []);
    },
    /** The body: `open` runs once a press, one made before the body mounted too. */
    useAnswer(open) {
      const count = useSyncExternalStore(subscribe, () => asked);
      const run = useRef(open);
      run.current = open;
      useEffect(() => {
        if (count === answered) return;
        answered = count;
        run.current();
      }, [count]);
    },
  };
}
