import type { CapsOf, RelayOf } from './work/wire'

/**
 * The agenda pillar's wire (docs/agents/work-agenda.md). Its methods are
 * `work.agenda.<verb>` and its pushes `work.agenda`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const AgendaRequestSchemas = [] as const
export type AgendaPush = never
export const AGENDA_CAPS = {} satisfies CapsOf<typeof AgendaRequestSchemas>
export const AGENDA_RELAY = {} satisfies RelayOf<typeof AgendaRequestSchemas>
