import { describe, expect, it } from 'vitest'
import type { Tell } from '@shared/work/tell'
import type { WorkCtx, WorkModule } from '../../modules'
import type { SourceEnv, SourceRead } from './index'
import { lapses } from './lapses'

/** A sign-in or a licence about to end, as the host tells it: the two stages, the clock on the last day, and what goes when it is renewed. */

const DAY = 86_400_000
const NOW = Date.parse('2026-11-23T09:00:00-06:00')
const until = Date.parse('2026-12-05T13:22:00-06:00')

const env = (found: { id: string; title: string; until: number }[]): SourceEnv =>
  ({
    ctx: { log: () => {} } as unknown as WorkCtx,
    modules: [{ id: 'winvm', ensure: () => {}, health: { check: async () => [], lapses: () => found } }] as unknown as WorkModule[],
    call: async () => {
      throw new Error('not used')
    },
    workspaces: () => [],
    day: '2026-11-23',
    zone: 'America/Chicago',
    since: 0
  }) as SourceEnv
const read = (found: Parameters<typeof env>[0], now: number): SourceRead => lapses.read(env(found), now) as SourceRead

describe('the lapses source', () => {
  const evaluation = { id: 'evaluation', title: 'Windows evaluation', until }
  it('says nothing while the end is further off than fourteen days', () => {
    expect(read([evaluation], until - 20 * DAY).tells).toEqual([])
  })
  it('fourteen days before, it waits for the digest: no clock, and it opens Connections', () => {
    const { tells } = read([evaluation], NOW)
    expect(tells).toEqual([{ kind: 'connections.ending', workspaceId: null, title: 'Windows evaluation ends Dec 5', key: `lapse:winvm:evaluation:${until}:0`, open: { settings: 'connections' } }] satisfies Tell[])
    expect(tells[0]).not.toHaveProperty('by')
  })
  it('on the last day it carries its end as its clock, so it interrupts, under its own key', () => {
    const { tells } = read([evaluation], until - 5 * 3_600_000)
    expect(tells).toEqual([{ kind: 'connections.ending', workspaceId: null, title: 'Windows evaluation ends Dec 5 at 1:22 PM', key: `lapse:winvm:evaluation:${until}:1`, open: { settings: 'connections' }, by: until }])
  })
  it('one that has already ended is not rung as news: Connections shows it', () => {
    expect(read([evaluation], until + 1).tells).toEqual([])
    expect(read([evaluation], until + 9 * DAY).tells).toEqual([])
  })
  it('read again with nothing changed it says the same words: a re-read is not news', () => {
    expect(read([evaluation], NOW).tells).toEqual(read([evaluation], NOW + 6 * 3_600_000).tells)
  })
  it("writes the time in his zone, whatever zone the host runs in", () => {
    // 1:22 PM in Chicago is 7:22 PM in UTC: the title says his own clock
    expect(read([evaluation], until - 5 * 3_600_000).tells[0]!.title).toBe('Windows evaluation ends Dec 5 at 1:22 PM')
  })
  it('names the year when the end is in another one', () => {
    const next = Date.parse('2027-01-05T01:22:00-06:00')
    expect(read([{ ...evaluation, until: next }], Date.parse('2026-12-28T09:00:00-06:00')).tells[0]!.title).toBe('Windows evaluation ends Jan 5, 2027')
  })
  it('keeps both stages of a lapse still listed, and none of one renewed or gone', () => {
    expect(read([evaluation], NOW).keep).toEqual([`lapse:winvm:evaluation:${until}:0`, `lapse:winvm:evaluation:${until}:1`])
    // far off: nothing told yet, but its rows (none) would be kept
    expect(read([evaluation], until - 60 * DAY)).toEqual({ tells: [], keep: [`lapse:winvm:evaluation:${until}:0`, `lapse:winvm:evaluation:${until}:1`] })
    expect(read([], NOW)).toEqual({ tells: [], keep: [] })
    expect(lapses).toMatchObject({ id: 'lapses', pillar: null, prefix: 'lapse:', every: 6 * 3_600_000 })
  })
})
