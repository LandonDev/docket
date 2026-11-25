import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { LifeosStateName } from '@shared/contract-work-lifeos'
import { UNAVAILABLE_WORDS } from '../lifeos/session'
import { DashStore, ensureDashboardsTables, viewOf, type StoredBlock } from './dash'

/**
 * A dashboard read from a LifeOS sheet while the host's LifeOS session is down (docs/agents/work-dashboards.md
 * "LifeOS down"): the view names the session's state; once it is back, the old failure is not said again.
 */

const FIGURE: StoredBlock = {
  id: 'b1',
  kind: 'figures',
  figures: [{ id: 'f1', label: 'Paid', from: { sheet: { at: 'lifeos', id: 'sh1' }, range: 'B2', agg: 'sum' }, sheetTitle: 'Invoices', counts: 'Paid', format: 'number', value: '12' }]
} as unknown as StoredBlock

function rig(failed: string | null, blocks: StoredBlock[] = [FIGURE]) {
  const db = new DatabaseSync(':memory:')
  ensureDashboardsTables(db)
  const store = new DashStore(db)
  store.create('i1', 's1', 'Money')
  const row = store.update('i1', { blocks, asOf: 1000, revs: {}, failed })
  const lifeos = { up: false, state: 'signed-out' as LifeosStateName }
  const ctx = {
    db,
    host: 'env_box',
    canvas: { get: () => null },
    log: () => {},
    push: () => {},
    service: { internal: async () => ({ rev: 0 }) },
    lifeos: { connected: () => lifeos.up, state: () => lifeos.state, owner: () => null, jwt: async () => '', subscribe: () => () => {} }
  }
  return { row, lifeos, ctx: ctx as never }
}

describe('a dashboard read from a LifeOS sheet', () => {
  it("names the host's session state while it is down, as the window words it", async () => {
    const { row, lifeos, ctx } = rig(UNAVAILABLE_WORDS['signed-out'])
    for (const [said, sent] of [['signed-out', 'signed-out'], ['pairing', 'pairing'], ['unreachable', 'unreachable'], ['refused', 'refused'], ['connecting', 'connecting'], ['connected', 'unreachable']] as const) {
      lifeos.state = said
      expect(await viewOf(ctx, row)).toMatchObject({ failed: UNAVAILABLE_WORDS['signed-out'], lifeos: sent })
    }
  })

  it('says nothing of a failure LifeOS caused once the session is back, and is out of date', async () => {
    const { row, lifeos, ctx } = rig(UNAVAILABLE_WORDS.pairing)
    lifeos.up = true
    const view = await viewOf(ctx, row)
    expect(view).toMatchObject({ failed: null, stale: true })
    expect(view.lifeos).toBeUndefined()
  })

  it('keeps a failure of its own, and sends no state while LifeOS reads', async () => {
    const { row, lifeos, ctx } = rig('B2 is not a range')
    lifeos.up = true
    const view = await viewOf(ctx, row)
    expect(view).toMatchObject({ failed: 'B2 is not a range', stale: false })
    expect(view.lifeos).toBeUndefined()
  })

  it('sends no state for a page that reads no LifeOS sheet', async () => {
    const own = { ...FIGURE, figures: [{ ...(FIGURE as { figures: object[] }).figures[0], from: { sheet: { at: 'file', host: 'env_box', path: '/w/a.tcsheet' }, range: 'B2', agg: 'sum' } }] } as unknown as StoredBlock
    const { row, ctx } = rig('the sheet host did not answer', [own])
    expect((await viewOf(ctx, row)).lifeos).toBeUndefined()
  })
})
