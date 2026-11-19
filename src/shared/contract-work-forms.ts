import type { CapsOf, RelayOf } from './work/wire'

/**
 * The forms pillar's wire (docs/agents/work-forms.md). Its methods are
 * `work.forms.<verb>` and its pushes `work.forms`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const FormsRequestSchemas = [] as const
export type FormsPush = never
export const FORMS_CAPS = {} satisfies CapsOf<typeof FormsRequestSchemas>
export const FORMS_RELAY = {} satisfies RelayOf<typeof FormsRequestSchemas>
