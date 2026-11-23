import { describe, expect, it } from 'vitest'
import { capture, unsortedTell } from './capture'
import type { SourceEnv } from './index'

const env = (sectors: string[]): Pick<SourceEnv, 'workspaces' | 'day'> => ({ workspaces: () => sectors.map((s) => ({ id: `ws-${s}`, name: s, sector: s })), day: '2026-11-23' })

describe('the capture source', () => {
  it('tells nothing: the capture pillar has no read that counts what is unsorted', async () => {
    expect(await capture.read({ ...env(['life']), ctx: {} as never, modules: [], call: () => Promise.reject(new Error('unused')), since: 0 }, Date.now())).toEqual([])
    expect({ pillar: capture.pillar, every: capture.every, prefix: capture.prefix }).toEqual({ pillar: 'capture', every: 0, prefix: undefined })
  })

  it("makes one row a day, opening Tasks in this host's Life workspace", () => {
    expect(unsortedTell(env(['cosmic', 'life']), 4)).toEqual({ kind: 'capture.unsorted', workspaceId: null, title: '4 captures to sort', key: 'capture-unsorted:2026-11-23', open: { view: 'tasks', workspaceId: 'ws-life' } })
    expect(unsortedTell(env(['life']), 1)?.title).toBe('1 capture to sort')
  })

  it('opens nothing with no Life workspace here, and tells nothing for none', () => {
    expect(unsortedTell(env(['cosmic']), 2)).toEqual({ kind: 'capture.unsorted', workspaceId: null, title: '2 captures to sort', key: 'capture-unsorted:2026-11-23' })
    expect(unsortedTell(env(['life']), 0)).toBeNull()
  })

  it('says the same words for the same count', () => {
    expect(unsortedTell(env(['life']), 3)).toEqual(unsortedTell(env(['life']), 3))
  })
})
