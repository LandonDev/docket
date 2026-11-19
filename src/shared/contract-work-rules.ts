import type { CapsOf, RelayOf } from './work/wire'

/**
 * The rules pillar's wire (docs/agents/work-rules.md). Its methods are
 * `work.rules.<verb>` and its pushes `work.rules`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const RulesRequestSchemas = [] as const
export type RulesPush = never
export const RULES_CAPS = {} satisfies CapsOf<typeof RulesRequestSchemas>
export const RULES_RELAY = {} satisfies RelayOf<typeof RulesRequestSchemas>
