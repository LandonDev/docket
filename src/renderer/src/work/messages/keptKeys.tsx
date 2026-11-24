import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefCallback } from "react";
import { cn } from "../../lib/cn";

/**
 * One keeper for the keys wherever a control he may have focused is swapped for another: an attachment's failed line, its
 * pending chip or skeleton and its picture, the Outbox quote across Retry, the list's and the conversation's panes across
 * Retry. A stable wrapper per thing. If the keys were inside it when its content changed and the control that held them
 * is gone, they go to the control that took its place (the first focusable inside, or the one `pick` names), or to the
 * wrapper itself, which wears the standard ring, when there is none yet; and from there to the next control when one
 * arrives. It acts only for the innermost wrapper still on the page around where the keys last went (so nested keepers
 * never fight, and one that leaves the page hands to the one around it), never takes them from elsewhere or back after he
 * dropped them himself, and goes on doing so across any number of swaps.
 */

/**
 * Where the keys last went: the element focus reached, and every keeper around it, innermost first. Moved by every focus,
 * so a focus elsewhere frees every keeper. Kept as a chain, so a keeper that leaves the page with the control inside it
 * (an attachment's whole message scrolled out of the window) leaves the keys to the keeper around it.
 */
let reached: Element | null = null;
let chain: Element[] = [];
let listening = false;
function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "focusin",
    (event) => {
      reached = event.target as Element | null;
      chain = [];
      for (let at = reached?.closest?.("[data-kept-keys]") ?? null; at; at = at.parentElement?.closest("[data-kept-keys]") ?? null) chain.push(at);
    },
    true,
  );
}

/**
 * The keeper whose keys these are to hand on, if any: the innermost still on the page around where they last went. Keys
 * that fell to the page while the control he left is still there were dropped by him (Escape out of a field, a click on
 * blank space): no keeper takes them back. Keys that fell because that control went are the keeper's.
 */
function holder(): Element | null {
  const keeper = chain.find((k) => k.isConnected) ?? null;
  if (!keeper) return null;
  const active = document.activeElement;
  const fell = !active || active === document.body;
  return !fell || (reached !== null && !reached.isConnected) ? keeper : null;
}

/** Whether a keeper inside `region` (or the region itself) holds the keys: they are its to hand on, not anyone else's. */
export const keptWithin = (region: Element): boolean => {
  const keeper = holder();
  return keeper !== null && region.contains(keeper);
};

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The keeper as a ref for a wrapper that also needs `tabIndex={-1}` and `focus-ring`; `pick` chooses the next control. */
export function useKeptKeys<T extends HTMLElement>(pick?: (wrapper: T) => HTMLElement | null): RefCallback<T> {
  const chooser = useRef(pick);
  useLayoutEffect(() => {
    chooser.current = pick;
  });
  return useCallback((el: T | null) => {
    if (!el) return;
    listen();
    el.setAttribute("data-kept-keys", "");
    const settle = (): void => {
      if (holder() !== el) return;
      const active = document.activeElement;
      const fell = !active || active === document.body;
      // The keys still on a control inside: nothing to do. On the wrapper or fallen: the next control, else the wrapper.
      if (!fell && active !== el) return;
      const next = chooser.current ? chooser.current(el) : el.querySelector<HTMLElement>(FOCUSABLE);
      if (next) next.focus({ preventScroll: true });
      else if (fell) el.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(settle);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}

/** A wrapper that keeps the keys for whatever is drawn inside it. */
export function KeptKeys({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useKeptKeys<HTMLDivElement>();
  return (
    <div ref={ref} tabIndex={-1} className={cn("focus-ring", className)}>
      {children}
    </div>
  );
}
