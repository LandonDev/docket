/**
 * Computer use's plain numbers, with no zod in them: first paint reads them
 * (the status mark, the Computer section's history), and contract-computer.ts
 * (zod, 10 kB) must not come with them (scripts/check-bundle-size.ts).
 */

/** Crashes in two minutes that put the service down for five (computer/service.ts). */
export const COMPUTER_CRASHES_TO_DOWN = 5

/** The keys one `computer.history.read` may name, and one read's calls per key (computer/history.ts HISTORY_PAGE). */
export const HISTORY_READ_MAX_KEYS = 64
