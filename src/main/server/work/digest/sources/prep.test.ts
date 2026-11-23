import { beforeEach, describe, expect, it } from 'vitest'
import type { PrepUpcoming } from '@shared/contract-work-prep'
import type { Tell } from '@shared/work/tell'
import type { SourceEnv } from './index'
import { ASK_AHEAD_MS, forgetUpcoming, prepReady, prepStarting } from './prep'

/** Meetings from the prep pillar's read: one that is about to start interrupts, a brief that is ready waits. */

const ZONE = 'America/Chicago'
const at = (hhmm: string, day = 24): number => Date.parse(`2026-11-${day}T${hhmm}:00-06:00`)
const meeting = (over: Partial<PrepUpcoming> = {}): PrepUpcoming => ({ workspaceId: 'ws-purdue', sector: 'purdue', eventId: 'ev1', title: 'Budget review', startsAt: at('14:00'), endsAt: at('15:00'), with: ['Dana Reyes'], state: 'none', ...over })

function env(meetings: PrepUpcoming[] | Error): { env: SourceEnv; asked: { method: string; params: { from: number; to: number } }[] } {
  const asked: { method: string; params: { from: number; to: number } }[] = []
  return {
    asked,
    env: {
      call: async (method: string, params: { from: number; to: number }) => {
        asked.push({ method, params })
        if (meetings instanceof Error) throw meetings
        return { meetings: meetings.filter((m) => m.startsAt >= params.from && m.startsAt <= params.to) }
      },
      workspaces: () => [],
      day: '2026-11-24',
      zone: ZONE,
      since: 0
    } as unknown as SourceEnv
  }
}

beforeEach(forgetUpcoming)

describe('a meeting about to start', () => {
  it('is looked at each minute, with prep asked each five for the next twenty: one LifeOS read, not five', async () => {
    const { env: e, asked } = env([meeting()])
    await prepStarting.read(e, at('13:45'))
    for (const minute of ['13:46', '13:47', '13:48', '13:49']) await prepStarting.read(e, at(minute))
    expect(asked).toEqual([{ method: 'work.prep.upcoming', params: { from: at('13:45'), to: at('13:45') + ASK_AHEAD_MS } }])
    await prepStarting.read(e, at('13:50'))
    expect(asked).toHaveLength(2)
    expect(prepStarting).toMatchObject({ pillar: 'prep', every: 60_000, prefix: 'prep:' })
  })
  it('is told ten minutes before with its start as its clock, in his words and his zone, opening its page', async () => {
    const { env: e } = env([meeting()])
    expect(await prepStarting.read(e, at('13:49'))).toEqual([])
    // from what prep said a minute ago: no second ask is needed to tell it on time
    expect(await prepStarting.read(e, at('13:50'))).toEqual([
      { kind: 'prep.starting', workspaceId: 'ws-purdue', title: 'Budget review starts at 2:00 PM', detail: 'With Dana Reyes', key: `prep:ev1:${at('14:00')}`, open: { view: 'prep', workspaceId: 'ws-purdue', at: 'ev1' }, by: at('14:00') }
    ] satisfies Tell[])
  })
  it('says the same words at each read, so it is told once; once it has begun it is no longer read, and its row goes', async () => {
    const { env: e } = env([meeting()])
    expect(await prepStarting.read(e, at('13:55'))).toEqual(await prepStarting.read(e, at('13:51')))
    expect(await prepStarting.read(e, at('14:00'))).toEqual([])
  })
  it('names up to three others, and none when prep gives none', async () => {
    const { env: e } = env([meeting({ with: ['Dana Reyes', 'Marcus Hale', 'Priya Nair'] }), meeting({ eventId: 'ev2', with: [] })])
    const [a, b] = (await prepStarting.read(e, at('13:55'))) as Tell[]
    expect(a!.detail).toBe('With Dana Reyes, Marcus Hale and Priya Nair')
    expect(b).not.toHaveProperty('detail')
  })
  it('a meeting that moved is a new thing to tell: its key carries its start', async () => {
    const { env: e } = env([meeting({ startsAt: at('14:05') })])
    expect(((await prepStarting.read(e, at('13:58'))) as Tell[])[0]!.key).toBe(`prep:ev1:${at('14:05')}`)
  })
})

describe('a brief that is ready', () => {
  it("waits for the day's digest: read only when one is made, for the day ahead, with no clock", async () => {
    const { env: e, asked } = env([meeting({ state: 'briefed' }), meeting({ eventId: 'ev2', title: 'Staff sync', startsAt: at('16:00'), state: 'none' }), meeting({ eventId: 'ev3', title: 'Thumbnail review', startsAt: at('09:00', 25), with: [], state: 'briefed' })])
    const tells = (await prepReady.read(e, at('08:00'))) as Tell[]
    expect(asked[0]!.params).toEqual({ from: at('08:00'), to: at('08:00', 25) })
    expect(tells).toEqual([
      { kind: 'prep.ready', workspaceId: 'ws-purdue', title: 'Prep is ready for Budget review', detail: '2:00 PM, with Dana Reyes', key: 'prep-ready:ev1:2026-11-24', open: { view: 'prep', workspaceId: 'ws-purdue', at: 'ev1' } }
    ])
    expect(prepReady).toMatchObject({ pillar: 'prep', every: 0 })
    expect(prepReady.prefix).toBeUndefined()
  })
})
