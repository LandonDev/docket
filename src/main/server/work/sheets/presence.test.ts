import { describe, expect, it } from 'vitest'
import type { CanvasItem } from '@shared/work'
import { desktopPresenceId, sayPresence, sheetPresent } from './presence'

/** A host's canvas items, the pushes it sent and what it asked the Work service. */
function host(items: Partial<CanvasItem>[]) {
  const pushes: { push: unknown; opts: unknown }[] = []
  const asked: { route: string; body: unknown }[] = []
  const ctx = {
    db: {},
    canvas: { get: (id: string) => (items.find((i) => i.id === id) as CanvasItem | undefined) ?? null },
    push: (push: unknown, opts?: unknown) => void pushes.push({ push, opts }),
    service: { internal: async (route: string, body: unknown) => (asked.push({ route, body }), { people: [dana] }) }
  }
  return { ctx: ctx as never, pushes, asked }
}
const range = { startRow: 2, endRow: 2, startColumn: 1, endColumn: 3 }
const dana = { id: 'p1', name: 'Dana Lee', hue: 2, sheet: 'sheet1', range }
const item = (id: string, state = 'open') => ({ id, sessionId: `t-${id}`, state, source: { at: 'file', host: 'env_box', path: '/work/Budget.tcsheet' } }) as CanvasItem
const REF = { tcsheet: '/work/Budget.tcsheet' }

describe("who is on a sheet, for the desktop grid", () => {
  it('says his selection to the service under the item\'s own id, takes it away, or only reads; and is answered who else is there', async () => {
    const { ctx, asked } = host([item('i1')])
    expect(await sayPresence(ctx, item('i1'), REF, { sheet: 'sheet1', range })).toEqual({ people: [dana] })
    await sayPresence(ctx, item('i1'), REF, { range: null })
    await sayPresence(ctx, item('i1'), REF, {})
    // A range with no tab says nothing: it only reads.
    await sayPresence(ctx, item('i1'), REF, { range })
    expect(asked).toEqual([
      { route: '/internal/sheet/presence', body: { sheet: REF, id: 'desktop:i1', at: { sheet: 'sheet1', range } } },
      { route: '/internal/sheet/presence', body: { sheet: REF, id: 'desktop:i1', at: null } },
      { route: '/internal/sheet/presence', body: { sheet: REF, id: 'desktop:i1' } },
      { route: '/internal/sheet/presence', body: { sheet: REF, id: 'desktop:i1' } }
    ])
  })

  it('each open canvas on the sheet is pushed everyone but itself, fenced by the file\'s path; a closed one is told nothing', async () => {
    const items = [item('i1'), item('i2'), item('i3', 'closed')]
    const { ctx, pushes } = host(items)
    // Asking is what makes a canvas hear: each of the three asked once.
    for (const i of items) await sayPresence(ctx, i, REF, {})
    const mine = { ...dana, id: desktopPresenceId(items[0]!), name: 'Landon Hale', hue: 1 }
    expect(sheetPresent(ctx, { key: 'tcsheet:/work/Budget.tcsheet', people: [dana, mine] })).toBe(2)
    expect(pushes).toEqual([
      { push: { push: 'work.sheets', sessionId: 't-i1', itemId: 'i1', rev: 0, presence: [dana] }, opts: { path: '/work/Budget.tcsheet' } },
      { push: { push: 'work.sheets', sessionId: 't-i2', itemId: 'i2', rev: 0, presence: [dana, mine] }, opts: { path: '/work/Budget.tcsheet' } }
    ])
    expect(sheetPresent(ctx, { key: 'lifeos:other', people: [dana] })).toBe(0)
  })
})
