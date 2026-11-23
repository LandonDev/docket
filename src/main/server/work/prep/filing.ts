import type { PrepSuggestion } from '@shared/contract-work-prep'
import type { SectorKey } from '@shared/work'
import type { WorkCtx } from '../modules'
import type { PageRow } from './store'

/** File one accepted suggestion in the page’s sector, with a key that survives a retry. */
export async function fileTask(ctx: WorkCtx, sector: SectorKey, page: Pick<PageRow, 'id' | 'title' | 'startsAt'>, task: PrepSuggestion): Promise<string> {
  const day = new Date(page.startsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(/,/g, '')
  const where = `From “${page.title}”, ${day}.`
  const id = await ctx.lifeos.owner().mutation<string>('tasks:create', {
    sector,
    title: task.title,
    description: task.quote ? `${where}\n“${task.quote}”` : where,
    ...(task.due !== undefined ? { dueAt: task.due } : {}),
    key: `prep:${page.id}:${task.id}`
  })
  if (typeof id !== 'string' || !id) throw new Error('LifeOS did not answer with the task it made.')
  return id
}
