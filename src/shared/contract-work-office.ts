import type { CapsOf, RelayOf } from './work/wire'

/**
 * The office pillar's wire (docs/agents/work-office.md). Its methods are
 * `work.office.<verb>` and its pushes `work.office`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const OfficeRequestSchemas = [] as const
export type OfficePush = never
export const OFFICE_CAPS = {} satisfies CapsOf<typeof OfficeRequestSchemas>
export const OFFICE_RELAY = {} satisfies RelayOf<typeof OfficeRequestSchemas>
