import type { CapsOf, RelayOf } from './work/wire'

/**
 * The lifeos pillar's wire (docs/agents/work-lifeos.md). Its methods are
 * `work.lifeos.<verb>` and its pushes `work.lifeos`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const LifeosRequestSchemas = [] as const
export type LifeosPush = never
export const LIFEOS_CAPS = {} satisfies CapsOf<typeof LifeosRequestSchemas>
export const LIFEOS_RELAY = {} satisfies RelayOf<typeof LifeosRequestSchemas>
