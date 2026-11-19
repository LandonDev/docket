import type { CapsOf, RelayOf } from './work/wire'

/**
 * The sheets pillar's wire (docs/agents/work-sheets.md). Its methods are
 * `work.sheets.<verb>` and its pushes `work.sheets`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const SheetsRequestSchemas = [] as const
export type SheetsPush = never
export const SHEETS_CAPS = {} satisfies CapsOf<typeof SheetsRequestSchemas>
export const SHEETS_RELAY = {} satisfies RelayOf<typeof SheetsRequestSchemas>
