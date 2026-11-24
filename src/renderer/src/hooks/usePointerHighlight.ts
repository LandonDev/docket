import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * A keyboard list's highlight that follows the pointer only when the pointer
 * moves (Search, Go to File, Go to Symbol). The arrows move the highlight and
 * scroll it into view; the list then slides under a pointer that never
 * moved, and the `mouseenter` that fires on the row now under it must not
 * take the highlight back. So a row's enter counts only after a real
 * `mousemove` over the list, and a keyboard move (or new rows) waits for the
 * next one. The browser sends a row's `mouseenter` before the `mousemove`
 * that re-arms the pointer, so the move that re-arms it also lights the row
 * it is over (the list's options, in order, are the indexes).
 *
 * Spread `onMouseMove` on the list, put `activeRef` on the highlighted row
 * and call `onRowEnter(index)` from each row's `onMouseEnter`.
 */
/**
 * How far a list must scroll for a row to stand `clear` px inside its box's edges, where there is more list
 * past that edge: positive is down. `scrollIntoView({ block: "nearest" })` leaves a row that is already wholly
 * in view where it is, whatever its scroll margin, so the row one arrow below a row that stood clear would end
 * in the list's faded edge. Both boxes are as drawn on screen; a box with no height (nothing laid out) asks nothing.
 */
export function clearBy(row: { top: number; bottom: number }, box: { top: number; bottom: number }, clear: number, more: { above: boolean; below: boolean }): number {
  if (box.bottom - box.top <= 0) return 0;
  const under = row.bottom - (box.bottom - clear);
  if (under > 0 && more.below) return under;
  const over = box.top + clear - row.top;
  if (over > 0 && more.above) return -over;
  return 0;
}

export function usePointerHighlight<T extends HTMLElement>({
  active,
  activeKey,
  items,
  onActive,
  clear,
}: {
  /** The highlighted index. */
  active: number;
  /** The highlighted row's own name, where rows can land above it: the same row at a new index is no move, and is not scrolled to. */
  activeKey?: string | null;
  /** The rows; a new list waits for the pointer to move again. */
  items: unknown;
  onActive: (index: number) => void;
  /** A list whose cut edges fade: a row the arrows move to stops this many px clear of them (its listbox is the scroller). */
  clear?: number;
}) {
  const activeRef = useRef<T>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [items]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    const row = activeRef.current;
    row?.scrollIntoView({ block: "nearest" });
    const box = clear ? row?.closest<HTMLElement>('[role="listbox"]') : null;
    if (!row || !box || !clear) return;
    const by = clearBy(row.getBoundingClientRect(), box.getBoundingClientRect(), clear, { above: box.scrollTop > 0, below: box.scrollTop + box.clientHeight < box.scrollHeight - 1 });
    if (by) box.scrollTop += by;
  }, [activeKey === undefined ? active : activeKey]);

  const onMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.clientX === pointer.current.x && event.clientY === pointer.current.y) return;
    const armed = pointer.current.allow;
    pointer.current = { x: event.clientX, y: event.clientY, allow: true };
    if (armed) return;
    const row = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (!row || !event.currentTarget.contains(row)) return;
    const index = [...event.currentTarget.querySelectorAll('[role="option"]')].indexOf(row);
    if (index >= 0) onRowEnter(index);
  };

  const onRowEnter = (index: number) => {
    // The row already lit changes nothing, so it must not mark the next
    // (keyboard) move as the pointer's and skip that move's scroll.
    if (!pointer.current.allow || index === active) return;
    fromPointer.current = true;
    onActive(index);
  };

  /** The pointer's choice by another road (a right-click on a row): the highlight goes there and the list is not scrolled under it. */
  const pointAt = (index: number) => {
    if (index === active) return;
    fromPointer.current = true;
    onActive(index);
  };

  return { activeRef, onMouseMove, onRowEnter, pointAt };
}
