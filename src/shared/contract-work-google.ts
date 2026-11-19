import type { CapsOf, RelayOf } from './work/wire'

/**
 * The google pillar's wire (docs/agents/work-google.md). Its methods are
 * `work.google.<verb>` and its pushes `work.google`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const GoogleRequestSchemas = [] as const
export type GooglePush = never
export const GOOGLE_CAPS = {} satisfies CapsOf<typeof GoogleRequestSchemas>
export const GOOGLE_RELAY = {} satisfies RelayOf<typeof GoogleRequestSchemas>
