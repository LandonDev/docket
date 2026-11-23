import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefCallback } from "react";
import { cn } from "../../lib/cn";

/**
 * One keeper for the keys wherever a control he may have focused is swapped for another: an attachment's failed line, its
 * pending chip or skeleton and its picture, the Outbox quote across Retry, the list's and the conversation's panes across
 * Retry. A stable wrapper per thing. If the keys were inside it when its content changed and the control that held them
 * is gone, they go to the control that took its place (the first focusable inside, or the one `pick` names), or to the
 * wrapper itself, which wears the standard ring, when there is none yet; and from there to the next control when one
 * arrives. It acts only for the wrapper that last held the keys (the innermost, so nested keepers never fight), never
 * takes them from elsewhere, and goes on doing so across any number of swaps.
 */

/** The innermost keeper the keys were last inside: moved by every focus, so a focus elsewhere frees every keeper. */
let owner: Element | null = null;
let listening = false;
function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as Element | null;
      owner = target?.closest?.("[data-kept-keys]") ?? null;
    },
    true,
  );
}

/** Whether a keeper inside `region` (or the region itself) holds the keys: they are its to hand on, not anyone else's. */
export const keptWithin = (region: Element): boolean => owner !== null && region.contains(owner);

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
      if (owner !== el) return;
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
