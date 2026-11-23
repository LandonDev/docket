import type { ReviewDone, SlippedRow } from '@shared/work/review'
import type { LifeosClient } from '../../lifeos/ctx'
import { text, type Asked } from './common'

/**
 * Tasks, from LifeOS: the ones he finished in the week (`review:doneBetween`) and the ones past due and still open
 * (`tasks:due`). A task he put off to next week is no longer past due, so it needs no mark here.
 */

type DoneRow = { id: string; title?: string; sector: string; completedAt: number }
type TaskDoc = { _id: string; title?: string; sector: string; dueAt?: number }

export async function doneBetween(owner: LifeosClient, from: number, to: number, asked: Pick<Asked, 'only'>): Promise<ReviewDone[]> {
  const rows = await owner.query<DoneRow[]>('review:doneBetween', { from, to })
  return (rows ?? [])
    .filter((r) => asked.only === undefined || r.sector === asked.only)
    .map((r) => ({ id: r.id, title: text(r.title) || 'A task', at: r.completedAt, sector: r.sector }))
}

/** Open tasks that were due before `cut`. */
export async function pastDue(owner: LifeosClient, cut: number, asked: Pick<Asked, 'only'>): Promise<SlippedRow[]> {
  const docs = await owner.query<TaskDoc[]>('tasks:due', { before: cut })
  return (docs ?? [])
    .filter((d) => typeof d.dueAt === 'number' && (asked.only === undefined || d.sector === asked.only))
    .map((d) => ({ key: `task:${d._id}`, ref: { kind: 'task', id: d._id, dueAt: d.dueAt! }, sector: d.sector, workspaceId: null, title: text(d.title) || 'A task', at: d.dueAt!, people: [], others: 0, open: true }))
}
