import type { CapsOf, RelayOf } from './work/wire'

/**
 * The routines pillar's wire (docs/agents/work-routines.md). Its methods are
 * `work.routines.<verb>` and its pushes `work.routines`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const RoutinesRequestSchemas = [] as const
export type RoutinesPush = never
export const ROUTINES_CAPS = {} satisfies CapsOf<typeof RoutinesRequestSchemas>
export const ROUTINES_RELAY = {} satisfies RelayOf<typeof RoutinesRequestSchemas>
