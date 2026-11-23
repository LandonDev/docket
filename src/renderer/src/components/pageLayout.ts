/** A page's scroller and column caps, apart from components/page.tsx so the
 *  first paint's skeleton (surfaces/SurfaceSkeleton.tsx) draws a page's frame
 *  without carrying the page's components; page.tsx re-exports both. */

/** The scroller a page sits in (Settings, Accounts, Stats, and their
 *  skeletons): the stable gutter keeps the column still when the page
 *  gains a scrollbar, so a skeleton and its page land in one place. */
export const PAGE_SCROLLER = "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]";

/** The column's cap: 672px for a page of settings, 1,152px for a page that
 *  is a table (Accounts), which reads across the pane's width. */
export const PAGE_WIDTH = { column: "max-w-2xl", table: "max-w-6xl" } as const;
