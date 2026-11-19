import type { CapsOf, RelayOf } from './work/wire'

/**
 * The history pillar's wire (docs/agents/work-history.md). Its methods are
 * `work.history.<verb>` and its pushes `work.history`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const HistoryRequestSchemas = [] as const
export type HistoryPush = never
export const HISTORY_CAPS = {} satisfies CapsOf<typeof HistoryRequestSchemas>
export const HISTORY_RELAY = {} satisfies RelayOf<typeof HistoryRequestSchemas>
