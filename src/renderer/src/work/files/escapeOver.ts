import { useEffect, useRef, type RefObject } from "react";

/**
 * Escape in a file's tab (docs/DESIGN.md "The Files place"): History or a second file lying over the file (no room for
 * the two side by side) is what it closes first, as a sheet over it would, and the file under it takes the focus back
 * once it is no longer inert; else it leaves the full window. A menu, a dialog or the thing holding the key that took
 * Escape first keeps it. A second file's close asks first where its edits wait (FilesView `closeSideOf`).
 */
export function useEscapeOver({ full, onTop, close, leaveFull, main }: { full: boolean; onTop: boolean; close: (() => void) | undefined; leaveFull(): void; main: RefObject<HTMLElement | null> }): void {
  const refocus = useRef(false);
  const latest = useRef({ close, leaveFull });
  useEffect(() => {
    latest.current = { close, leaveFull };
  });
  useEffect(() => {
    if (!full && !onTop) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement | null)?.closest?.('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) return;
      if (!onTop) return latest.current.leaveFull();
      event.preventDefault();
      refocus.current = true;
      latest.current.close?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, onTop]);
  useEffect(() => {
    if (onTop || !refocus.current) return;
    refocus.current = false;
    main.current?.focus();
  }, [onTop, main]);
}
