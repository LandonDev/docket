import { describe, expect, it } from 'vitest'
import { capture, unsortedTell } from './capture'
import type { SourceEnv } from './index'

const env = (sectors: string[]): Pick<SourceEnv, 'workspaces' | 'day'> => ({ workspaces: () => sectors.map((s) => ({ id: `ws-${s}`, name: s, sector: s })), day: '2026-11-23' })

describe('the capture source', () => {
  const lifeos = (tasks: unknown[] | Error, connected = true) => {
    const asked: { fn: string; args: unknown }[] = []
    return {
      asked,
      ctx: {
        lifeos: {
          connected: () => connected,
          owner: () => ({
            query: async (fn: string, args: unknown) => {
              asked.push({ fn, args })
              if (tasks instanceof Error) throw tasks
              return tasks
            }
          })
        }
      } as never
    }
  }
  const read = (l: ReturnType<typeof lifeos>) => capture.read({ ...env(['life']), ctx: l.ctx, modules: [], call: () => Promise.reject(new Error('unused')), zone: 'America/Chicago', since: 0 }, Date.now())

  it("counts Life's open tasks that came in as Unsorted, read as the owner from LifeOS, only when a digest is made", async () => {
    const l = lifeos([{ source: { channel: 'Unsorted' } }, { source: { channel: 'Capture' } }, { source: { channel: 'Unsorted' } }, { source: null }, {}])
    expect(await read(l)).toEqual([{ kind: 'capture.unsorted', workspaceId: null, title: '2 captures to sort', key: 'capture-unsorted:2026-11-23', open: { view: 'tasks', workspaceId: 'ws-life' } }])
    expect(l.asked).toEqual([{ fn: 'tasks:list', args: { sector: 'life' } }])
    expect({ pillar: capture.pillar, every: capture.every, prefix: capture.prefix }).toEqual({ pillar: 'capture', every: 0, prefix: undefined })
  })

  it('says nothing when nothing is unsorted, LifeOS is signed out, or it does not answer', async () => {
    expect(await read(lifeos([{ source: { channel: 'Capture' } }]))).toEqual([])
    const out = lifeos([{ source: { channel: 'Unsorted' } }], false)
    expect(await read(out)).toEqual([])
    expect(out.asked).toEqual([])
    expect(await read(lifeos(new Error('LifeOS did not answer')))).toEqual([])
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
