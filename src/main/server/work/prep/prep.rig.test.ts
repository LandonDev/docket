import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PrepPage, PrepUpcoming } from '@shared/contract-work-prep'
import type { WorkspaceMeta } from '@shared/domain'
import { outbox as outboxModule } from '../outbox/index'
import { makeRig, readKey, type Rig } from '../outbox/rig'
import { prep } from './index'
import { PrepStore } from './store'
import { FakeLifeos } from './testLifeos'

/**
 * Prep on the hold's rig: a real Work mount with the prep module, a fake
 * registry and LifeOS in memory. What it proves: reading a page writes
 * nothing; only he changes a page; a page stays when its thread goes and
 * goes with its workspace; and what is coming lists this host's own
 * workspaces alone. Dummy data.
 */

let rig: Rig
let lifeos: FakeLifeos
const asModel = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-purdue' }
const START = Date.parse('2026-11-23T14:00:00-05:00')
const pages = (): number => (rig.work.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_prep_pages').get() as { n: number }).n
const page = async (eventId = 'ev1', workspaceId = 'ws-purdue') => (await rig.rpc<{ page: PrepPage }>('work.prep.page', { workspaceId, eventId })).page

function workspace(id: string, sector: string | null): void {
  rig.workspace(id, { kind: 'work', sector } as Partial<WorkspaceMeta>)
  rig.work.ctx.db.prepare('INSERT INTO workspaces (id, name, path, git, created_at, kind, sector) VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, id, `/tmp/${id}`, Date.now(), 'work', sector)
}

beforeEach(async () => {
  rig = await makeRig({ modules: [outboxModule, prep] })
  lifeos = new FakeLifeos()
  rig.work.ctx.lifeos = { connected: () => lifeos.connected, owner: () => lifeos, jwt: async () => 'jwt', subscribe: () => () => {} }
  workspace('ws-purdue', 'purdue')
  rig.thread('t-purdue', { scope: 'work', workspaceId: 'ws-purdue' })
  lifeos.event({ _id: 'ev1', uid: 'series1@20261123T190000Z', startsAt: START, attendees: [{ address: 'maya@x.test', name: 'Maya Chen', response: 'accepted' }] })
  lifeos.person({ _id: 'p-maya', name: 'Maya Chen', sectors: ['purdue'], emails: ['maya@x.test'] })
})
afterEach(async () => {
  await rig.close()
})

describe('a page', () => {
  it('is read with the facts and writes nothing, for a key that may only read', async () => {
    const got = await page()
    expect(got).toMatchObject({ sector: 'purdue', rev: 0, state: 'none', people: [{ name: 'Maya Chen', personId: 'p-maya' }] })
    expect((await rig.rpc<{ page: PrepPage }>('work.prep.page', { workspaceId: 'ws-purdue', eventId: 'ev1' }, readKey)).page.event.title).toBe('Staff sync')
    expect(pages()).toBe(0)
    expect(rig.pushes.filter((p) => p.push === 'work.prep')).toEqual([])
  })

  it('refuses an event of another sector', async () => {
    lifeos.event({ _id: 'ev-cosmic', sector: 'cosmic' })
    await expect(page('ev-cosmic')).rejects.toThrow('That event is not in Purdue’s sector.')
    await expect(rig.rpc('work.prep.people', { workspaceId: 'ws-purdue', eventId: 'ev-cosmic', people: [{ name: 'Dana Reyes' }] })).rejects.toThrow('That event is not in Purdue’s sector.')
    expect(pages()).toBe(0)
  })
})

describe('the people he adds', () => {
  it('are kept with the page, each once, and said in a push', async () => {
    const { page: after } = await rig.rpc<{ page: PrepPage }>('work.prep.people', {
      workspaceId: 'ws-purdue',
      eventId: 'ev1',
      people: [{ name: 'Dana Reyes', address: 'Dana@X.test' }, { name: 'Dana R.', address: 'dana@x.test' }, { name: 'Tom Beck' }]
    })
    expect(after.rev).toBe(1)
    expect(after.doc.people).toEqual([{ name: 'Dana Reyes', address: 'dana@x.test' }, { name: 'Tom Beck' }])
    expect(after.people.map((p) => p.name)).toEqual(['Maya Chen', 'Dana Reyes', 'Tom Beck'])
    expect(rig.pushes).toContainEqual({ push: 'work.prep', workspaceId: 'ws-purdue', eventId: 'ev1', rev: 1 })
    const row = new PrepStore(rig.work.ctx.db).get('ws-purdue', 'ev1')!
    expect(row).toMatchObject({ series: 'series1', title: 'Staff sync', startsAt: START, peopleKeys: ['maya@x.test', 'dana@x.test', '~tom beck'] })

    // next week's page of the series starts with them
    lifeos.event({ _id: 'ev2', uid: 'series1@20261130T190000Z', startsAt: START + 7 * 86_400_000 })
    expect((await page('ev2')).people.map((p) => p.name)).toEqual(['Dana Reyes', 'Tom Beck'])
    expect(pages()).toBe(1)
  })

  it('are his to change: a thread’s own call is refused', async () => {
    const params = { workspaceId: 'ws-purdue', eventId: 'ev1', people: [{ name: 'Dana Reyes' }] }
    await expect(prep.handle!({ id: '1', method: 'work.prep.people', params } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner changes a meeting’s page')
    expect(pages()).toBe(0)
  })
})

describe('a page and what it hangs from', () => {
  it('stays when its thread is deleted, and goes with its workspace', async () => {
    const store = new PrepStore(rig.work.ctx.db)
    const event = { id: 'ev1', series: 'series1', title: 'Staff sync', startsAt: START, endsAt: null, peopleKeys: [] }
    store.write('ws-purdue', event, () => ({ people: [], brief: null, notes: null, after: null }), (doc) => doc, Date.now(), { brief: 't-brief', follow: 't-follow' })
    prep.sessionsRemoved!(['t-brief', 't-gone'], rig.work.ctx)
    expect(store.get('ws-purdue', 'ev1')).toMatchObject({ briefSessionId: null, briefAt: null, followSessionId: 't-follow', rev: 2 })
    expect(rig.pushes).toContainEqual({ push: 'work.prep', workspaceId: 'ws-purdue', eventId: 'ev1', rev: 2 })
    prep.workspaceRemoved!('ws-purdue', rig.work.ctx)
    expect(pages()).toBe(0)
  })
})

describe('what is coming', () => {
  it('answers this host’s linked workspaces alone, at most 31 days a call', async () => {
    workspace('ws-cosmic', 'cosmic')
    lifeos.event({ _id: 'c1', sector: 'cosmic', title: 'Crate review', startsAt: START + 3_600_000, endsAt: START + 2 * 3_600_000, attendees: [{ address: 'cory@cosmic.test', name: 'Cory' }] })
    lifeos.event({ _id: 'r1', sector: 'ref', title: 'Crew call', startsAt: START + 2 * 3_600_000, attendees: [{ address: 'ump@x.test' }] })
    lifeos.event({ _id: 'far', title: 'Next quarter', startsAt: START + 40 * 86_400_000, attendees: [{ address: 'maya@x.test' }] })
    const { meetings } = await rig.rpc<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: START - 3_600_000, to: START + 400 * 86_400_000 }, readKey)
    expect(meetings.map((m) => [m.workspaceId, m.eventId, m.state, m.with])).toEqual([
      ['ws-purdue', 'ev1', 'none', ['Maya Chen']],
      ['ws-cosmic', 'c1', 'none', ['Cory']]
    ])
    expect(lifeos.called('events:range')).toEqual([{ from: START - 3_600_000, to: START - 3_600_000 + 31 * 86_400_000 }])
  })
})
