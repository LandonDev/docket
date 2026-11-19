import type { CapsOf, RelayOf } from './work/wire'

/**
 * The docs pillar's wire (docs/agents/work-docs.md). Its methods are
 * `work.docs.<verb>` and its pushes `work.docs`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const DocsRequestSchemas = [] as const
export type DocsPush = never
export const DOCS_CAPS = {} satisfies CapsOf<typeof DocsRequestSchemas>
export const DOCS_RELAY = {} satisfies RelayOf<typeof DocsRequestSchemas>
