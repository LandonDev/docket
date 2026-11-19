import type { Bbox } from "@shared/contract-work-pdf";
import { CSS_PER_POINT, type PageSize } from "./engine";

/**
 * Where each page sits in the column (docs/DESIGN.md "The canvas pane",
 * PDF): paper on `stage`, 12px between sheets, a 24px side inset (12px
 * narrow), fit-width zoom from 0.5 to 1.25.
 */

export const PAGE_GAP = 12;
export const COLUMN_TOP = 16;
export const COLUMN_BOTTOM = 24;
export const NARROW = 640;
/** Fit width goes under 50% where the column is that narrow (a pane beside the thread with the rail), so the page never runs past its edge. */
export const FIT_FLOOR = 0.3;
export const ZOOM_MAX = 1.25;
/** Fit width, or a fixed share of the page's size at 100%. */
export type Zoom = "fit" | 1 | 1.25 | 1.5;
export const ZOOMS: readonly Zoom[] = ["fit", 1, 1.25, 1.5];
/** Pages over this get the thumbnail rail. */
export const RAIL_FROM = 20;
export const railWidth = (width: number): number => (width < NARROW ? 60 : 76);

export const sideInset = (width: number): number => (width < NARROW ? 12 : 24);

/** The scale (CSS px a point over `CSS_PER_POINT`) at a zoom, for a column `room` px wide whose widest page is `widest` points. */
export function scaleFor(zoom: Zoom, room: number, widest: number): number {
  if (zoom !== "fit") return zoom;
  if (!(room > 0) || !(widest > 0)) return 1;
  const fit = room / (widest * CSS_PER_POINT);
  return Math.min(ZOOM_MAX, Math.max(FIT_FLOOR, fit));
}

export interface PageSlot {
  page: number;
  top: number;
  width: number;
  height: number;
}

/** Each page's place in the column at `scale`, top to bottom, and the column's height. */
export function layOut(pages: number, size: (page: number) => PageSize, scale: number): { slots: PageSlot[]; height: number } {
  const slots: PageSlot[] = [];
  let top = COLUMN_TOP;
  for (let page = 1; page <= pages; page++) {
    const s = size(page);
    const width = Math.round(s.width * CSS_PER_POINT * scale);
    const height = Math.round(s.height * CSS_PER_POINT * scale);
    slots.push({ page, top, width, height });
    top += height + PAGE_GAP;
  }
  return { slots, height: top - PAGE_GAP + COLUMN_BOTTOM };
}

/** The pages to mount for a viewport: those it shows, and one screen either side. */
export function visibleRange(slots: readonly PageSlot[], scrollTop: number, viewport: number): [number, number] {
  if (slots.length === 0) return [1, 0];
  const lo = scrollTop - viewport;
  const hi = scrollTop + viewport * 2;
  let first = slots.findIndex((slot) => slot.top + slot.height >= lo);
  if (first < 0) first = slots.length - 1;
  let last = first;
  while (last + 1 < slots.length && slots[last + 1].top <= hi) last++;
  return [slots[first].page, slots[last].page];
}

/** The page the pager shows: the last whose top is above a third of the viewport. */
export function currentPage(slots: readonly PageSlot[], scrollTop: number, viewport: number): number {
  const line = scrollTop + viewport / 3;
  let page = slots[0]?.page ?? 1;
  for (const slot of slots) {
    if (slot.top > line) break;
    page = slot.page;
  }
  return page;
}

/** Where to scroll to show a page, or a box on it a few lines below the top. */
export function scrollTarget(slot: PageSlot, box?: Bbox): number {
  if (!box) return Math.max(0, slot.top - COLUMN_TOP);
  return Math.max(0, slot.top + box[1] * slot.height - 96);
}

/** A box in shares of the page as CSS on the page. */
export const boxStyle = (box: Bbox): { left: string; top: string; width: string; height: string } => ({
  left: `${box[0] * 100}%`,
  top: `${box[1] * 100}%`,
  width: `${(box[2] - box[0]) * 100}%`,
  height: `${(box[3] - box[1]) * 100}%`,
});

/** Client rects of a selection, as boxes on a page: one a line, joined where they touch. */
export function quadsOf(rects: ArrayLike<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>, page: { left: number; top: number; width: number; height: number }): Bbox[] {
  const out: Bbox[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width < 1 || r.height < 1 || page.width <= 0 || page.height <= 0) continue;
    const box: Bbox = [
      Math.max(0, (r.left - page.left) / page.width),
      Math.max(0, (r.top - page.top) / page.height),
      Math.min(1, (r.right - page.left) / page.width),
      Math.min(1, (r.bottom - page.top) / page.height),
    ];
    if (box[2] <= box[0] || box[3] <= box[1]) continue;
    const line = out.find((q) => Math.abs(q[1] - box[1]) < 0.004 && Math.abs(q[3] - box[3]) < 0.004 && box[0] <= q[2] + 0.01 && box[2] >= q[0] - 0.01);
    if (line) {
      line[0] = Math.min(line[0], box[0]);
      line[2] = Math.max(line[2], box[2]);
    } else out.push(box);
  }
  return out.slice(0, 200);
}
