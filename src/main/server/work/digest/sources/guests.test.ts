import { describe, expect, it } from 'vitest'
import type { FindEntry } from '@shared/work/docFind'
import type { Tell } from '@shared/work/tell'
import { guests, guestTitle } from './guests'
import type { SourceEnv } from './index'

const NOW = Date.parse('2026-11-23T08:00:00Z')
const HOUR = 3_600_000
const WORKSPACES = [
  { id: 'ws-unify', name: 'Unify', sector: 'unify' },
  { id: 'ws-ref', name: 'Ref', sector: 'ref' }
]
const entry = (id: string, title: string, editedAt: number, lastBy?: FindEntry['lastBy']): FindEntry => ({
  key: `lifeos:docs:${id}`,
  title,
  kind: 'document',
  where: 'lifeos',
  source: { at: 'lifeos', table: 'docs', id },
  editedAt,
  createdAt: editedAt - 10 * HOUR,
  shared: true,
  guest: true,
  ...(lastBy ? { lastBy } : {}),
  comments: 0,
  waiting: 0,
  held: 0
})

function envOf(found: Record<string, FindEntry[] | Error>, since = 0): SourceEnv & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    ctx: {} as never,
    modules: [],
    async call<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      const got = found[(params as { workspaceId: string }).workspaceId]
      if (!got || got instanceof Error) throw got ?? new Error('no such Work workspace')
      return { entries: got, projects: [], hits: [], complete: true } as T
    },
    workspaces: () => WORKSPACES,
    day: '2026-11-23',
    since
  }
}

describe('the guests source', () => {
  it("tells one row a document a guest last edited since the last digest, from the docs pillar's list", async () => {
    const env = envOf(
      {
        'ws-unify': [entry('d1', 'Pricing notes', NOW - 2 * HOUR, 'guest'), entry('d2', 'Roadmap', NOW - HOUR, 'owner'), entry('d3', 'Old brief', NOW - 30 * HOUR, 'guest')],
        'ws-ref': [entry('d4', 'Game schedule', NOW - 3 * HOUR, 'guest')]
      },
      NOW - 20 * HOUR
    )
    expect(await guests.read(env, NOW)).toEqual([
      { kind: 'docs.guest', workspaceId: 'ws-unify', title: 'A guest edited Pricing notes', key: 'guest-edit:lifeos:docs:d1:2026-11-23', open: { view: 'docs', workspaceId: 'ws-unify' } },
      { kind: 'docs.guest', workspaceId: 'ws-ref', title: 'A guest edited Game schedule', key: 'guest-edit:lifeos:docs:d4:2026-11-23', open: { view: 'docs', workspaceId: 'ws-ref' } }
    ])
    expect(env.calls[0]).toEqual({ method: 'work.docs.find', params: { workspaceId: 'ws-unify', refresh: true } })
  })

  it('looks back a day when no digest was ever made', async () => {
    const env = envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - 23 * HOUR, 'guest'), entry('d3', 'Old brief', NOW - 25 * HOUR, 'guest')] })
    expect(((await guests.read(env, NOW)) as Tell[]).map((t) => t.title)).toEqual(['A guest edited Pricing notes'])
  })

  it("names the guest when there is a name", () => {
    expect(guestTitle('Pricing notes', 'Dana Reyes')).toBe('Dana Reyes edited Pricing notes')
    expect(guestTitle('Pricing notes', ' ')).toBe('A guest edited Pricing notes')
  })

  it('tells nothing for a job the docs pillar cannot list, nor when no guest edited', async () => {
    expect(await guests.read(envOf({ 'ws-unify': new Error('LifeOS is not signed in'), 'ws-ref': [entry('d2', 'Roadmap', NOW - HOUR)] }), NOW)).toEqual([])
  })

  it('says the same words on a second read with nothing changed', async () => {
    const env = envOf({ 'ws-unify': [entry('d1', 'Pricing notes', NOW - HOUR, 'guest')] }, NOW - 20 * HOUR)
    expect(await guests.read(env, NOW)).toEqual(await guests.read(env, NOW + 60_000))
  })
})
