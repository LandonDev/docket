import type { CapsOf, RelayOf } from './work/wire'

/**
 * The outbox pillar's wire (docs/agents/work-outbox.md). Its methods are
 * `work.outbox.<verb>` and its pushes `work.outbox`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const OutboxRequestSchemas = [] as const
export type OutboxPush = never
export const OUTBOX_CAPS = {} satisfies CapsOf<typeof OutboxRequestSchemas>
export const OUTBOX_RELAY = {} satisfies RelayOf<typeof OutboxRequestSchemas>
