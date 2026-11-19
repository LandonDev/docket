import type { CapsOf, RelayOf } from './work/wire'

/**
 * The formats pillar's wire (docs/agents/work-formats.md). Its methods are
 * `work.formats.<verb>` and its pushes `work.formats`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const FormatsRequestSchemas = [] as const
export type FormatsPush = never
export const FORMATS_CAPS = {} satisfies CapsOf<typeof FormatsRequestSchemas>
export const FORMATS_RELAY = {} satisfies RelayOf<typeof FormatsRequestSchemas>
