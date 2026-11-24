import { describe, expect, it } from 'vitest'
import type { SourceEnv } from './index'
import { missedTitle, scheduled } from './scheduled'

const NOW = Date.parse('2026-11-24T15:00:00Z')
const WORKSPACES = [
  { id: 'ws-cosmic', name: 'Cosmic', sector: 'cosmic' },
  { id: 'ws-purdue', name: 'Purdue', sector: 'purdue' }
]
const row = (o: Record<string, unknown>) => ({ _id: 'ob1', status: 'failed', scheduled: true, sendAt: Date.parse('2026-11-24T14:00:00Z'), sector: 'purdue', error: 'Not sent: its time passed. Reconnect the account', message: { kind: 'mail', subject: 'Budget' }, ...o })

function envOf(rows: unknown[] | 'throws', connected = true): SourceEnv {
  return {
    ctx: {
      lifeos: {
        connected: () => connected,
        owner: () => ({
          query: async (fn: string, args: unknown) => {
            expect([fn, args]).toEqual(['compose:list', { view: 'scheduled' }])
            if (rows === 'throws') throw new Error('LifeOS is down')
            return rows
          }
        })
      }
    } as never,
    modules: [],
    call: () => Promise.reject(new Error('not used')),
    workspaces: () => WORKSPACES,
    day: '2026-11-24',
    zone: 'America/Chicago',
    since: 0
  }
}

describe('the missed scheduled mail source', () => {
  it('tells each scheduled mail that failed once, in its sector\'s job, with its time on his clock and why', async () => {
    const tells = await scheduled.read(envOf([row({}), row({ _id: 'ob2', status: 'queued' }), row({ _id: 'ob3', scheduled: undefined })]), NOW)
    expect(tells).toEqual([
      {
        kind: 'mail.missed',
        workspaceId: 'ws-purdue',
        title: '"Budget" did not go at 8:00 AM on Nov 24',
        detail: 'Not sent: its time passed. Reconnect the account',
        key: 'mail-missed:ob1',
        open: { view: 'mail', workspaceId: 'ws-purdue' }
      }
    ])
    expect(scheduled).toMatchObject({ pillar: 'mail', prefix: 'mail-missed:' })
  })

  it('says the same words read today or tomorrow, so one already in a digest is not news again; a mail with no subject', async () => {
    const env = envOf([row({ sendAt: Date.parse('2026-11-23T14:00:00Z'), message: { kind: 'mail', subject: ' ' } })])
    const [today] = (await scheduled.read(env, Date.parse('2026-11-23T15:00:00Z'))) as { title: string }[]
    const [tomorrow] = (await scheduled.read(env, NOW)) as { title: string }[]
    expect(today?.title).toBe('A scheduled mail did not go at 8:00 AM on Nov 23')
    expect(tomorrow?.title).toBe(today?.title)
    expect(missedTitle('Lunch', '9:00 AM')).toBe('"Lunch" did not go at 9:00 AM')
  })

  it('throws when LifeOS is out of reach, so nothing told is called done', async () => {
    await expect(Promise.resolve(scheduled.read(envOf('throws'), NOW))).rejects.toThrow('LifeOS is down')
    await expect(Promise.resolve(scheduled.read(envOf([], false), NOW))).rejects.toThrow('not connected')
  })
  it('writes the time in the zone the failure was first told in, so a desktop in another zone does not make it news again', async () => {
    const env = { ...envOf([row({ sendAt: Date.parse('2026-11-23T12:00:00Z') })]), zone: 'America/Los_Angeles', zoneOf: () => 'America/New_York' }
    const [tell] = (await scheduled.read(env, NOW)) as { title: string }[]
    expect(tell?.title).toBe('"Budget" did not go at 7:00 AM on Nov 23')
  })
})
