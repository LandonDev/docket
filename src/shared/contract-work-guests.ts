import type { CapsOf, RelayOf } from './work/wire'

/**
 * The guests pillar's wire (docs/agents/work-guests.md). Its methods are
 * `work.guests.<verb>` and its pushes `work.guests`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const GuestsRequestSchemas = [] as const
export type GuestsPush = never
export const GUESTS_CAPS = {} satisfies CapsOf<typeof GuestsRequestSchemas>
export const GUESTS_RELAY = {} satisfies RelayOf<typeof GuestsRequestSchemas>
