/**
 * Stats' sections in order, each with the height its skeleton holds before
 * any bundle (Pace at two series) and whether it carries a description line:
 * numbers alone, so the first paint's fallback (SurfaceSkeleton.tsx
 * `stats`) draws the page's own wait with no chart code. stats.dom.test.tsx
 * holds them to the page's `SECTION_SKELETON` (aliax/views/stats.tsx).
 */
export const STATS_SECTIONS: readonly { title: string; height: number; description?: true }[] = [
  { title: "Pace", height: 488 },
  { title: "Daily output", height: 224 },
  { title: "Model mix", height: 224 },
  { title: "Top projects", height: 232 },
  { title: "Cache hit rate", height: 200, description: true },
  { title: "Busiest hours", height: 180, description: true },
  { title: "Tools used", height: 232 },
];
