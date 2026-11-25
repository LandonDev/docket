import { describe, expect, it } from 'vitest'
import type { CanvasItem } from '@shared/work'
import { hostKey, sheetCommitted, watchSheet } from './commits'
import { refKey } from './host/host'

/** A host's canvas items and the pushes it sent. */
function host(items: Partial<CanvasItem>[]) {
  const pushes: { push: unknown; opts: unknown }[] = []
  const ctx = {
    db: {},
    canvas: { get: (id: string) => (items.find((i) => i.id === id) as CanvasItem | undefined) ?? null },
    push: (push: unknown, opts?: unknown) => void pushes.push({ push, opts })
  }
  return { ctx: ctx as never, pushes }
}
const lifeosItem = (id: string, state = 'open') => ({ id, sessionId: `t-${id}`, state, source: { at: 'lifeos', table: 'sheets', id: 'ksheet1' } }) as Partial<CanvasItem>

describe("the desktop grid hears every op that lands on its sheet", () => {
  it('names a sheet as the service does', () => {
    for (const ref of [{ lifeos: 'ksheet1' }, { tcsheet: '/work/Budget.tcsheet' }]) expect(hostKey(ref)).toBe(refKey(ref))
  })

  it("a guest's op on a sheet reaches each open canvas on it as a push of its revision, with no edit of the owner's", () => {
    const { ctx, pushes } = host([lifeosItem('i1'), lifeosItem('i2'), { id: 'i3', sessionId: 't3', state: 'open', source: { at: 'file', host: 'env_box', path: '/work/Budget.tcsheet' } }])
    watchSheet(ctx, { id: 'i1' }, { lifeos: 'ksheet1' })
    watchSheet(ctx, { id: 'i2' }, { lifeos: 'ksheet1' })
    watchSheet(ctx, { id: 'i3' }, { tcsheet: '/work/Budget.tcsheet' })
    expect(sheetCommitted(ctx, { key: 'lifeos:ksheet1', rev: 7 })).toBe(2)
    expect(pushes.map((p) => p.push)).toEqual([
      { push: 'work.sheets', sessionId: 't-i1', itemId: 'i1', rev: 7 },
      { push: 'work.sheets', sessionId: 't-i2', itemId: 'i2', rev: 7 }
    ])
    // A file's push is fenced by its path, as every push about a file is.
    expect(sheetCommitted(ctx, { key: 'tcsheet:/work/Budget.tcsheet', rev: 3 })).toBe(1)
    expect(pushes.at(-1)).toEqual({ push: { push: 'work.sheets', sessionId: 't3', itemId: 'i3', rev: 3 }, opts: { path: '/work/Budget.tcsheet' } })
  })

  it('a sheet no canvas has open is told to nobody, and an item that closed is let go', () => {
    const items = [lifeosItem('i1')]
    const { ctx, pushes } = host(items)
    expect(sheetCommitted(ctx, { key: 'lifeos:ksheet1', rev: 1 })).toBe(0)
    watchSheet(ctx, { id: 'i1' }, { lifeos: 'ksheet1' })
    expect(sheetCommitted(ctx, { key: 'lifeos:other', rev: 1 })).toBe(0)
    items[0]!.state = 'closed'
    expect(sheetCommitted(ctx, { key: 'lifeos:ksheet1', rev: 2 })).toBe(0)
    items[0]!.state = 'open'
    // Let go: it is told again only once its canvas asks again.
    expect(sheetCommitted(ctx, { key: 'lifeos:ksheet1', rev: 3 })).toBe(0)
    expect(pushes).toEqual([])
  })
})
