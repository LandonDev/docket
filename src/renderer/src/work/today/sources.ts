import type { TodaySource } from "./types";

/**
 * What Today lists, in the order a row's key is claimed (the first source to
 * give a key keeps it). A pillar that adds to the page writes
 * `work/<slug>/today.ts` exporting `source: TodaySource` and adds one line
 * here; nothing else of Today is edited (docs/agents/work-today.md "Adding
 * to Today"). Each is loaded on its own: one that fails to load, or throws
 * while it runs, is left out and the page shows the rest.
 */
export const TODAY_SOURCES: { id: string; load: () => Promise<{ source: TodaySource }> }[] = [
  { id: "held", load: () => import("./held") },
  { id: "messages", load: () => import("../messages/today") },
  { id: "clashes", load: () => import("../clashes/today") },
  { id: "money", load: () => import("../money/today") },
  { id: "review", load: () => import("../review/today") },
  // one line per pillar that adds to Today: { id: 'clashes', load: () => import('../clashes/today') }
];
