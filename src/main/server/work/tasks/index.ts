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

/**
 * Whether a thread here worked in the task's sector: a Work thread of that
 * sector, or a code thread opened on the task (Open a code thread…) in a
 * workspace linked to that sector or to none; never one outside every
 * workspace. The workspace is the project's, else the thread's own, as
 * `workspaceOfSession` reads it.
 */
function worksIn(ctx: WorkCtx, threadId: string, sector: string): boolean {
  const scope = ctx.scopeOf(threadId)
  if (scope) return scope.sector === sector
  const code = ctx.db
    .prepare(
      `SELECT w.id AS id, w.sector AS sector FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN workspaces w ON w.id = COALESCE(p.workspace_id, s.workspace_id) WHERE s.id = ? AND s.scope = 'code'`
    )
    .get(threadId) as { id: string | null; sector: string | null } | undefined
  return !!code?.id && (code.sector === null || code.sector === sector)
}

/** Done on a task, as the owner, from a workspace's view: refused unless the task is in the workspace's sector. */
export async function taskDone(ctx: WorkCtx, workspaceId: string, taskId: string): Promise<TasksDone> {
  const workspace = ctx.db.prepare('SELECT sector FROM workspaces WHERE id = ? AND kind = ?').get(workspaceId, 'work') as { sector: string | null } | undefined
  if (!workspace?.sector) throw new Error('That workspace is not linked to a LifeOS sector here.')
  const owner = ctx.lifeos.owner()
  const [links, detail] = await Promise.all([
    owner.query<LinkRow[]>('workLinks:byEntity', { entity: { table: 'tasks', id: taskId } }),
    owner.query<{ task: { sector: string } } | null>('tasks:get', { id: taskId })
  ])
  const sector = detail?.task.sector
  // The view shows only its sector's tasks; a task of another sector is not this workspace's to complete.
  if (sector !== workspace.sector) throw new Error("That task is not in this workspace's sector.")
  // A link another host made, to a thread this host no longer has, or to a thread of another sector names no work accepted here.
  const link = [...links].reverse().find((l) => l.host === ctx.host && sector !== undefined && worksIn(ctx, l.threadId, sector)) ?? null
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
    return handled(await taskDone(ctx, req.params.workspaceId, req.params.taskId))
  }
}
