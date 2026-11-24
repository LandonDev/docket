import type { PrepDoc } from '@shared/contract-work-prep'
import type { WorkCtx } from '../modules'
import { pageEventOf, peopleOf, startDoc, type LifeEvent } from './gather'
import { PrepStore, type PageRow, type PageWriteOptions } from './store'

/** Push IDs alone. A screen reads the page again when its revision changes. */
export function pagePushed(ctx: WorkCtx, row: Pick<PageRow, 'workspaceId' | 'eventId' | 'rev'>): void {
  ctx.push({ push: 'work.prep', workspaceId: row.workspaceId, eventId: row.eventId, rev: row.rev })
}

/**
 * Keeps a change to a page. Given a function, the change is made to the row as it stands at this write, not as it
 * was read before an await: a rename Files made meanwhile (`notesDocMoved`), or any other field, is kept.
 */
export function writePage(ctx: WorkCtx, workspaceId: string, event: LifeEvent, last: PageRow | null, doc: PrepDoc | ((current: PrepDoc) => PrepDoc), now: number, options?: PageWriteOptions): PageRow {
  const store = new PrepStore(ctx.db)
  const next = typeof doc === 'function' ? doc(store.get(workspaceId, event._id)?.doc ?? startDoc(last)) : doc
  const row = store.write(workspaceId, pageEventOf(event, peopleOf(event, next.people)), () => startDoc(last), () => next, now, options)
  pagePushed(ctx, row)
  return row
}
