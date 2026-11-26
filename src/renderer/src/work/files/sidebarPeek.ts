import { useEffect, type RefObject } from "react";

/** The tab row's Show Sidebar press: a press on it toggles the peek itself, so it is no press outside. */
export const SIDEBAR_TOGGLE = "data-files-sidebar-toggle";

/**
 * The narrow sidebar that lies over the list (docs/DESIGN.md "The Files place") closes as a layer does: on Escape
 * (one no menu or field took first) and on a press elsewhere in the view. Escape from inside it gives the focus to
 * the toggle that opened it. Only the view's own presses and keys count: a menu the sidebar opened lies in a portal
 * outside the view, and its press or Escape is the menu's.
 */
export function usePeekClose(open: boolean, view: RefObject<HTMLElement | null>, over: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const doc = view.current?.ownerDocument ?? document;
    const within = (el: RefObject<HTMLElement | null>, target: EventTarget | null): boolean => target instanceof Node && !!el.current?.contains(target);
    const onPointer = (event: PointerEvent): void => {
      if (!within(view, event.target) || within(over, event.target)) return;
      if (event.target instanceof Element && event.target.closest(`[${SIDEBAR_TOGGLE}]`)) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target !== doc.body && !within(view, event.target)) return;
      const fromInside = within(over, event.target);
      close();
      if (fromInside) view.current?.querySelector<HTMLElement>(`[${SIDEBAR_TOGGLE}]`)?.focus();
    };
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("pointerdown", onPointer, true);
      doc.removeEventListener("keydown", onKey);
    };
  }, [open, view, over, close]);
}
