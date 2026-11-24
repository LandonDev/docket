import type { TodaySource } from "./types";

/**
 * What Today lists, in the order a row's key is claimed (the first source to
 * give a key keeps it). A pillar that adds to the page writes
 * `work/<slug>/today.ts` exporting `source: TodaySource` and adds one line
 * here; nothing else of Today is edited (docs/agents/work-today.md "Adding
 * to Today"). Each is loaded on its own: one that fails to load, or throws
 * while it runs, is left out and the page shows the rest.
 */
export const TODAY_SOURCES: {
  id: string;
  /** For a source with no section of its own: what the page says it could not show, under Also, if it fails. */
  what?: string;
  load: () => Promise<{ source: TodaySource }>;
}[] = [
  { id: "held", load: () => import("./held") },
  { id: "meetings", load: () => import("./meetings") },
  { id: "due", load: () => import("./due") },
  { id: "waiting", load: () => import("./waiting") },
  { id: "messages", load: () => import("../messages/today") },
  { id: "clashes", what: "clashes", load: () => import("../clashes/today") },
  { id: "money", load: () => import("../money/today") },
  { id: "review", what: "the weekly review", load: () => import("../review/today") },
  { id: "prep", what: "meeting prep", load: () => import("../prep/today") },
  // What only the digest is told (a routine's result, a sign-in about to end, a guest's edit): rows in `also`.
  { id: "digest", what: "the digest", load: () => import("../digest/today") },
  // one line per pillar that adds to Today, after Today's own
];
