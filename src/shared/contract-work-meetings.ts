import type { CapsOf, RelayOf } from './work/wire'

/**
 * The meetings pillar's wire (docs/agents/work-meetings.md). Its methods are
 * `work.meetings.<verb>` and its pushes `work.meetings`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const MeetingsRequestSchemas = [] as const
export type MeetingsPush = never
export const MEETINGS_CAPS = {} satisfies CapsOf<typeof MeetingsRequestSchemas>
export const MEETINGS_RELAY = {} satisfies RelayOf<typeof MeetingsRequestSchemas>
