import type { DocumentView, PageZoom } from "work-kit/editor";

/**
 * Flow or Pages as a styled document opens on the guest's page (docs/DESIGN.md
 * "Work editors: Document pages"). The app's pane holds the same rule on its
 * canvas (DocumentCanvas.tsx `openingView`, `openingZoom`); here the width is
 * the page's own, since the document has the whole of it.
 */

/** From this width a styled document opens as sheets: narrower, a sheet fitted to the screen sets 11 pt text too small to type on. */
export const PAGES_FROM = 640;
/** From this width a US Letter sheet stands at true size with the stage's 24px at each side. */
export const TRUE_SIZE_FROM = 864;

export const openingView = (width: number): DocumentView => (width >= PAGES_FROM ? "pages" : "flow");
export const openingZoom = (width: number): PageZoom => (width >= TRUE_SIZE_FROM ? 100 : "width");
