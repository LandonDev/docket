import { handled, NOT_HANDLED } from '@shared/work'
import type { TasksDone } from '@shared/contract-work-tasks'
import type { WorkCtx, WorkModule } from '../modules'

/**
 * The tasks pillar's server module (docs/agents/work-tasks.md). The Tasks
 * view reads and writes LifeOS on its own narrowed session; this module
 * carries the one act that needs the host: Done on a task a thread here
 * worked, which is the owner accepting that work. LifeOS records the reason
 * and the thread's link with the completion, as a send's completion does.
 */

interface LinkRow {
  host: string
  threadId: string
  title: string
}

/** Done on a task, as the owner: with the newest of this host's threads that worked it, else plainly. */
export async function taskDone(ctx: WorkCtx, taskId: string): Promise<TasksDone> {
  const owner = ctx.lifeos.owner()
  const [links, detail] = await Promise.all([
    owner.query<LinkRow[]>('workLinks:byEntity', { entity: { table: 'tasks', id: taskId } }),
    owner.query<{ task: { sector: string } } | null>('tasks:get', { id: taskId })
  ])
  const sector = detail?.task.sector
  // A link another host made, to a thread this host no longer has, or to a thread of another sector names no work accepted here.
  const link = [...links].reverse().find((l) => l.host === ctx.host && sector !== undefined && ctx.scopeOf(l.threadId)?.sector === sector) ?? null
  const args = link
    ? { id: taskId, reason: `Accepted the work of "${link.title}"`.slice(0, 300), threadLink: { host: link.host, threadId: link.threadId, title: link.title } }
    : { id: taskId }
  const answer = await owner.mutation<{ nextId?: string } | null>('tasks:complete', args)
  return { threadId: link?.threadId ?? null, nextId: answer?.nextId ?? null }
}

export const tasks: WorkModule = {
  id: 'tasks',
  ensure() {},
  async handle(req, ctx) {
    if (req.method !== 'work.tasks.done') return NOT_HANDLED
    return handled(await taskDone(ctx, req.params.taskId))
  }
}
