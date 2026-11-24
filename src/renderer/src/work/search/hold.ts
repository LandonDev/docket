/**
 * Holding the list still (docs/DESIGN.md "Work search"): once he has moved
 * the highlight, the highlighted row keeps its place on screen. Whatever
 * lands above it is taken up by the scroller in the same frame: the
 * scroller moves by what landed, and its box is no taller than the rows
 * from there down, so there is always that much to scroll.
 */
export interface Held {
  scrollTop: number;
  /** the box's height in px; null: as tall as its rows, up to its cap */
  height: number | null;
}

/**
 * Where the scroller must stand so a row that was `was` px from the box's
 * top is there again, now that it lies `rowTop` px into the list.
 */
export function holdStill(o: { rowTop: number; was: number; scrollHeight: number; cap: number }): Held {
  const scrollTop = Math.max(0, o.rowTop - o.was);
  if (scrollTop === 0) return { scrollTop, height: null };
  return { scrollTop, height: Math.max(0, Math.min(o.cap, o.scrollHeight - scrollTop)) };
}

/**
 * Whether the highlighted row is out of sight: less than half of it inside the list's box, as after a scroll by
 * the trackpad, which moves the list and not the highlight. Return then brings the row back before anything
 * opens. Both are read where they are drawn on screen (`getBoundingClientRect`), so nothing between the list
 * and the dialog (the field, the rule) shifts one against the other. A box with no height (nothing laid out)
 * hides nothing.
 */
export function outOfSight(row: { top: number; bottom: number }, box: { top: number; bottom: number }): boolean {
  if (box.bottom - box.top <= 0) return false;
  const seen = Math.min(row.bottom, box.bottom) - Math.max(row.top, box.top);
  return seen < (row.bottom - row.top) / 2;
}
