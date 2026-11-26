import { useEffect, useState, type RefObject } from "react";

/**
 * Whether an element is on screen, or within half a screen of it, in its own
 * scroller: what a clock or a loop asks before it runs for text no one can
 * see. One IntersectionObserver per scroller (the nearest ancestor that
 * scrolls, else the viewport) for every element inside it; the margin starts
 * a clock before its line scrolls in, so the line never shows a stale time.
 * True from the mount until the observer says otherwise, and where there is
 * no observer (tests), always.
 */
const MARGIN = "50%";

type Watch = { observer: IntersectionObserver; told: Map<Element, (on: boolean) => void> };
const watches = new Map<Element | null, Watch>();

function scrollerOf(el: Element): Element | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
}

function watchFor(root: Element | null): Watch {
  let watch = watches.get(root);
  if (watch) return watch;
  const told = new Map<Element, (on: boolean) => void>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) told.get(entry.target)?.(entry.isIntersecting);
    },
    { root, rootMargin: MARGIN },
  );
  watch = { observer, told };
  watches.set(root, watch);
  return watch;
}

/** Elements watched now, by every scroller: tests count them. */
export function watchedForTest(): number {
  let n = 0;
  for (const watch of watches.values()) n += watch.told.size;
  return n;
}

export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return undefined;
    const root = scrollerOf(el);
    const watch = watchFor(root);
    watch.told.set(el, setOn);
    watch.observer.observe(el);
    return () => {
      watch.observer.unobserve(el);
      watch.told.delete(el);
      if (watch.told.size === 0) {
        watch.observer.disconnect();
        watches.delete(root);
      }
    };
  }, [ref]);
  return on;
}
