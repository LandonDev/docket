/**
 * What the Files window keeps of the folders it listed (docs/agents/work-files.md "What the window keeps"): one file
 * for the life and the bound, so they can be changed in one place. A kept listing is names, sizes, times and marks,
 * in memory; the host fences every ask again.
 */

/** A listing no one has shown for this long goes (also one whose last reader left that long ago). */
export const LISTING_KEEP_MS = 10 * 60_000;
/** The most listings kept; past it the one shown longest ago goes first, never one on screen. */
export const LISTING_KEEP_MOST = 24;
/**
 * A listing shown again this soon after its first page landed is drawn as it is, the host not asked (Back, a tab
 * switched to and back): the host keeps its own reads this long too, and a change inside it is pushed. Never a folder
 * of a desktop reached through another host, which pushes nothing of it (store.ts `useListing`).
 */
export const LISTING_FRESH_MS = 5_000;
