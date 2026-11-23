import { describe, expect, it } from 'vitest'
import type { SourceEnv } from './index'
import { waiting } from './waiting'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const DAY = '2026-11-23'
const WORKSPACES = [
  { id: 'ws-cosmic', name: 'Cosmic', sector: 'cosmic' },
  { id: 'ws-purdue', name: 'Purdue', sector: 'purdue' }
]
const wait = (sector: string, dueAt = NOW - 3_600_000) => ({ _id: `t-${Math.random()}`, subject: 'Budget review', sector, waiting: { since: dueAt - 86_400_000, dueAt, asked: false, to: [{ name: 'Dana Reyes', address: 'dana@example.com' }] } })

function envOf(pages: Record<string, unknown[][]> | 'throws', o: { connected?: boolean } = {}): SourceEnv & { asked: unknown[] } {
  const asked: unknown[] = []
  const owner = {
    async query(fn: string, args: { sector: string; paginationOpts: { cursor: string | null } }) {
      asked.push({ fn, args })
      if (pages === 'throws') throw new Error('LifeOS is down')
      const all = pages[args.sector] ?? [[]]
      const at = args.paginationOpts.cursor ? Number(args.paginationOpts.cursor) : 0
      return { page: all[at] ?? [], isDone: at >= all.length - 1, continueCursor: String(at + 1) }
    }
  }
  return {
    asked,
    ctx: { lifeos: { connected: () => o.connected ?? true, owner: () => owner } } as never,
    modules: [],
    call: () => Promise.reject(new Error('not used')),
    workspaces: () => WORKSPACES,
    day: DAY,
    zone: 'America/Chicago',
    since: 0
  }
}

describe('the waiting source', () => {
  it('tells one row a job with the count of due waits, read as mail_waiting reads them', async () => {
    const env = envOf({ cosmic: [[wait('cosmic'), wait('cosmic')], [wait('cosmic')]], purdue: [[wait('purdue')]] })
    expect(await waiting.read(env, NOW)).toEqual([
      { kind: 'mail.waiting', workspaceId: 'ws-cosmic', title: '3 sent mails have no answer', key: 'mail-waiting:ws-cosmic:2026-11-23', open: { view: 'mail', workspaceId: 'ws-cosmic' } },
      { kind: 'mail.waiting', workspaceId: 'ws-purdue', title: '1 sent mail has no answer', key: 'mail-waiting:ws-purdue:2026-11-23', open: { view: 'mail', workspaceId: 'ws-purdue' } }
    ])
    expect(env.asked[0]).toEqual({ fn: 'mailWaits:list', args: { sector: 'cosmic', paginationOpts: { numItems: 100, cursor: null } } })
  })

  it("counts neither another sector's rows nor a wait not yet due", async () => {
    const env = envOf({ cosmic: [[wait('purdue'), wait('cosmic', NOW + 60_000)]], purdue: [[]] })
    expect(await waiting.read(env, NOW)).toEqual([])
  })

  it('tells nothing while LifeOS is signed out or does not answer', async () => {
    expect(await waiting.read(envOf({ cosmic: [[wait('cosmic')]] }, { connected: false }), NOW)).toEqual([])
    expect(await waiting.read(envOf('throws'), NOW)).toEqual([])
  })

  it('says the same words on a second read with nothing changed', async () => {
    const env = envOf({ cosmic: [[wait('cosmic'), wait('cosmic')]] })
    expect(await waiting.read(env, NOW)).toEqual(await waiting.read(env, NOW + 60_000))
  })

  it('is read only before a day is made', () => {
    expect({ id: waiting.id, pillar: waiting.pillar, every: waiting.every, prefix: waiting.prefix }).toEqual({ id: 'waiting', pillar: 'mail', every: 0, prefix: undefined })
  })
})
