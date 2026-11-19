import type { CapsOf, RelayOf } from './work/wire'

/**
 * The dashboards pillar's wire (docs/agents/work-dashboards.md). Its methods are
 * `work.dashboards.<verb>` and its pushes `work.dashboards`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const DashboardsRequestSchemas = [] as const
export type DashboardsPush = never
export const DASHBOARDS_CAPS = {} satisfies CapsOf<typeof DashboardsRequestSchemas>
export const DASHBOARDS_RELAY = {} satisfies RelayOf<typeof DashboardsRequestSchemas>
