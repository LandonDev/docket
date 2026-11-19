import type { CapsOf, RelayOf } from './work/wire'

/**
 * The tasks pillar's wire (docs/agents/work-tasks.md). Its methods are
 * `work.tasks.<verb>` and its pushes `work.tasks`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const TasksRequestSchemas = [] as const
export type TasksPush = never
export const TASKS_CAPS = {} satisfies CapsOf<typeof TasksRequestSchemas>
export const TASKS_RELAY = {} satisfies RelayOf<typeof TasksRequestSchemas>
