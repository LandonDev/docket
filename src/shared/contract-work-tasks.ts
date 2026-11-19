import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The tasks pillar's wire (docs/agents/work-tasks.md). The Tasks view reads
 * LifeOS itself, through the workspace's narrowed session; the host acts only
 * where a thread is involved. `work.tasks.done` is the owner accepting a
 * task's work: LifeOS marks it done with the reason and a link to the thread
 * on this host that worked it, or plainly when no thread did. A task of
 * another sector than the workspace's is refused.
 */
export const TasksRequestSchemas = [
  request('work.tasks.done', z.object({ workspaceId: z.string().min(1).max(200), taskId: z.string().min(1).max(200) }))
] as const

/** What `work.tasks.done` did: the thread it named, if any, and the task's next copy for a repeating one. */
export interface TasksDone {
  threadId: string | null
  nextId: string | null
}

export type TasksPush = never
export const TASKS_CAPS = {
  'work.tasks.done': 'approve'
} satisfies CapsOf<typeof TasksRequestSchemas>
export const TASKS_RELAY = {} satisfies RelayOf<typeof TasksRequestSchemas>
