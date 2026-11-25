import type { CanvasItem } from '@shared/work'
import type { WorkCtx } from '../modules'
import { serviceOf } from '../service/ctx'
import type { SheetCommit } from '../service/wire'
import type { SheetRef } from './host/wire'

/**
 * The desktop grid as a live client of a sheet the Work service holds (docs/agents/work-sheets.md "Live editing").
 * His canvas is not on the sheet's socket: it edits through main and learns of others' ops by asking
 * (`work.sheets.since`) after a `work.sheets` push. That push used to follow main's own writes alone, so a guest's
 * edit did not show on his open grid until he typed. Now the service tells main of every op that lands
 * (`sheet-commit`), and main pushes each open canvas item on that sheet the revision it is at; the canvas's own
 * catch-up lays it. A push at a revision the canvas already has is nothing to it.
 */

/** The host's key for a sheet (host/host.ts `refKey`, held equal by a test; said here so main does not load the engine for it). */
export const hostKey = (ref: SheetRef): string => ('lifeos' in ref ? `lifeos:${ref.lifeos}` : `tcsheet:${ref.tcsheet}`)

/** The canvas items that have asked for each service-held sheet, by the host's key for it, per host database. */
const watching = new WeakMap<object, Map<string, Set<string>>>()

const booksOf = (ctx: Pick<WorkCtx, 'db'>): Map<string, Set<string>> => {
  let books = watching.get(ctx.db)
  if (!books) watching.set(ctx.db, (books = new Map()))
  return books
}

/** An item's canvas asked for its sheet (open, load, since): it is told of what lands on it from now. */
export function watchSheet(ctx: Pick<WorkCtx, 'db'>, item: Pick<CanvasItem, 'id'>, ref: SheetRef): void {
  const books = booksOf(ctx)
  const key = hostKey(ref)
  let items = books.get(key)
  if (!items) books.set(key, (items = new Set()))
  items.add(item.id)
}

/** The open canvas items on a sheet, by the host's key for it. An item that closed is let go. */
export function itemsOn(ctx: Pick<WorkCtx, 'db' | 'canvas'>, key: string): CanvasItem[] {
  const items = booksOf(ctx).get(key)
  if (!items) return []
  const open: CanvasItem[] = []
  for (const id of [...items]) {
    const item = ctx.canvas.get(id)
    if (!item || item.state !== 'open') items.delete(id)
    else open.push(item)
  }
  if (!items.size) booksOf(ctx).delete(key)
  return open
}

/** An op landed: every open canvas item on that sheet is pushed its revision. */
export function sheetCommitted(ctx: Pick<WorkCtx, 'db' | 'canvas' | 'push'>, { key, rev }: SheetCommit): number {
  const items = itemsOn(ctx, key)
  for (const item of items) {
    const path = item.source.at === 'file' ? item.source.path : undefined
    ctx.push({ push: 'work.sheets', sessionId: item.sessionId, itemId: item.id, rev }, path ? { path } : undefined)
  }
  return items.length
}

/** Hears the service's commits while Work is on; returns its off. */
export const followCommits = (ctx: WorkCtx): (() => void) => serviceOf(ctx)?.onSheetCommit((notice) => void sheetCommitted(ctx, notice)) ?? (() => {})
