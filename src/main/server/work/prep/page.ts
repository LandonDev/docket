import type { PrepDoc } from '@shared/contract-work-prep'
import type { WorkCtx } from '../modules'
import { pageEventOf, peopleOf, startDoc, type LifeEvent } from './gather'
import { PrepStore, type PageRow, type PageWriteOptions } from './store'

/** Push IDs alone. A screen reads the page again when its revision changes. */
export function pagePushed(ctx: WorkCtx, row: Pick<PageRow, 'workspaceId' | 'eventId' | 'rev'>): void {
  ctx.push({ push: 'work.prep', workspaceId: row.workspaceId, eventId: row.eventId, rev: row.rev })
}

export function writePage(ctx: WorkCtx, workspaceId: string, event: LifeEvent, last: PageRow | null, doc: PrepDoc, now: number, options?: PageWriteOptions): PageRow {
  const row = new PrepStore(ctx.db).write(workspaceId, pageEventOf(event, peopleOf(event, doc.people)), () => startDoc(last), () => doc, now, options)
  pagePushed(ctx, row)
  return row
}
