import type { SearchReach } from '@shared/work/search'
import type { WorkCtx } from '../modules'

/**
 * Where a search may look (docs/agents/work-search.md "The fence"). His
 * window reads every job of this host and Work Chats, or the one job it
 * names. A thread reads what its `@` reads (`ctx.mentionReach`, the rule the
 * fence already keeps): its own job, or for a Work Chat every job. A code
 * thread, and a Work thread with no Work home, read nothing.
 */

type Job = SearchReach['workspaces'][number]

const jobs = (ctx: Pick<WorkCtx, 'db'>): Job[] =>
  (ctx.db.prepare(`SELECT id, name, sector FROM workspaces WHERE kind = 'work' ORDER BY created_at, id`).all() as unknown as Job[]).map((w) => ({ id: w.id, name: w.name, sector: w.sector ?? null }))

/** His window's reach: every job and Work Chats, or one job alone (an id that is no job of this host reads nothing). */
export function windowReach(ctx: Pick<WorkCtx, 'db'>, workspaceId?: string): SearchReach {
  const all = jobs(ctx)
  if (workspaceId === undefined) return { workspaces: all, chats: true, sessionId: null }
  return { workspaces: all.filter((w) => w.id === workspaceId), chats: false, sessionId: null }
}

/** A thread's reach; null: nothing to search. */
export function threadReach(ctx: Pick<WorkCtx, 'db' | 'mentionReach'>, sessionId: string): SearchReach | null {
  const reach = ctx.mentionReach(sessionId)
  if (!reach || !reach.work) return null
  if (reach.workspaceId === null) return { workspaces: jobs(ctx), chats: true, sessionId }
  const own = jobs(ctx).filter((w) => w.id === reach.workspaceId)
  return own.length ? { workspaces: own, chats: false, sessionId } : null
}

export const emptyReach = (reach: SearchReach): boolean => reach.workspaces.length === 0 && !reach.chats
