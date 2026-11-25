import type { CanvasItem } from '@shared/work'
import type { SheetPerson } from '@shared/contract-work-sheets'
import type { WorkCtx } from '../modules'
import { serviceOf } from '../service/ctx'
import type { SheetPresent } from '../service/wire'
import { itemsOn, watchSheet } from './commits'
import type { SheetRef } from './host/wire'

/**
 * Who is on a sheet, for the desktop grid (docs/agents/work-sheets.md "Live editing"). His canvas is on no socket of
 * the sheet: it says its selection through main (`work.sheets.presence`), which tells the Work service over an
 * internal route, and it hears everyone else's through the `work.sheets` push, which main sends each open canvas
 * item on that sheet when the service says who is on it changed. Names and hues are the service's: the link's name
 * for a guest, his own for his phone's page and for this grid.
 */

/** The id his desktop grid's selection is kept under in the service: one a canvas item, whichever of his windows shows it. */
export const desktopPresenceId = (item: Pick<CanvasItem, 'id'>): string => `desktop:${item.id}`

type Box = SheetPerson['range']

/** His selection on a sheet the service holds, said (a range), taken away (null) or only read; answers everyone else on it. */
export async function sayPresence(ctx: WorkCtx, item: CanvasItem, ref: SheetRef, said: { sheet?: string; range?: Box | null }): Promise<{ people: SheetPerson[] }> {
  watchSheet(ctx, item, ref)
  const at = said.range === null ? { at: null } : said.range && said.sheet ? { at: { sheet: said.sheet, range: said.range } } : {}
  return (await ctx.service.internal('/internal/sheet/presence', { sheet: ref, id: desktopPresenceId(item), ...at })) as { people: SheetPerson[] }
}

/** Who is on a sheet changed: every open canvas item on it is pushed everyone but itself. */
export function sheetPresent(ctx: Pick<WorkCtx, 'db' | 'canvas' | 'push'>, { key, people }: SheetPresent): number {
  const items = itemsOn(ctx, key)
  for (const item of items) {
    const path = item.source.at === 'file' ? item.source.path : undefined
    const own = desktopPresenceId(item)
    ctx.push({ push: 'work.sheets', sessionId: item.sessionId, itemId: item.id, rev: 0, presence: people.filter((p) => p.id !== own) }, path ? { path } : undefined)
  }
  return items.length
}

/** Hears the service's word of who is on each sheet while Work is on; returns its off. */
export const followPresence = (ctx: WorkCtx): (() => void) => serviceOf(ctx)?.onSheetPresence((notice) => void sheetPresent(ctx, notice)) ?? (() => {})
