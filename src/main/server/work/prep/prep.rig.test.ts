import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREP_TASKS_MAX, PREP_WORKING_MS, type PrepAhead, type PrepPage, type PrepUpcoming } from '@shared/contract-work-prep'
import { parseSchedule } from '@shared/contract-work-routines'
import type { WorkspaceMeta } from '@shared/domain'
import { handled, NOT_HANDLED, type WorkToolResult } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkModule } from '../modules'
import { outbox as outboxModule } from '../outbox/index'
import { adminKey, approveKey, makeRig, readKey, type Rig } from '../outbox/rig'
import { AHEAD_ROUTINE } from './ahead'
import { prep } from './index'
import { PrepStore } from './store'
import { FakeLifeos } from './testLifeos'

/** Prep through the Work router, tools and pushes, with a fake session registry and dummy LifeOS data. */

let rig: Rig
let lifeos: FakeLifeos
const asModel = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-purdue' }
const START = Date.parse('2026-11-23T14:00:00-05:00')
const params = { workspaceId: 'ws-purdue', eventId: 'ev1' }
const call = (name: string, args: Record<string, unknown> = {}, sessionId = 't-purdue') =>
  rig.work.tools.call(rig.sessions.get(sessionId)!, name, args, new AbortController().signal)
const words = (r: WorkToolResult) => r.content.map((c) => c.type === 'text' ? c.text : '').join('\n')
const prepPushes = () => rig.pushes.filter((p) => p.push === 'work.prep')
const dateNow = () => vi.spyOn(Date, 'now').mockReturnValue(START)
const note = (text: string) => rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text })
const brief = () => rig.rpc<{ sessionId: string }>('work.prep.brief', params)
const follow = () => rig.rpc<{ sessionId: string }>('work.prep.followUp', params)
const decide = (decision: 'accept' | 'reject', ...taskIds: string[]) =>
  rig.rpc<{ page: PrepPage; failed: { id: string; error: string }[] }>('work.prep.decide', { ...params, decision, taskIds }, approveKey)

function fakeStarts() {
  let count = 0
  return vi.spyOn(rig.work.ctx.threads, 'start').mockImplementation(async (input) => {
    const id = `t-meeting-${++count}`
    rig.thread(id, { scope: 'work', workspaceId: input.workspaceId })
    return id
  })
}
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
  vi.restoreAllMocks()
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

describe('his presses', () => {
  it('starts the brief with an event chip and its facts, and answers the same thread to concurrent presses', async () => {
    const start = fakeStarts()
    const [first, second] = await Promise.all([brief(), brief()])
    expect(first).toEqual({ sessionId: 't-meeting-1' })
    expect(second).toEqual(first)
    expect(start).toHaveBeenCalledExactlyOnceWith({
      workspaceId: params.workspaceId,
      title: 'Prepare: Staff sync',
      about: { kind: 'event', label: 'Staff sync', ref: { at: 'lifeos', table: 'events', id: 'ev1' } },
      text: expect.stringContaining('Maya Chen <maya@x.test>')
    })
    expect(start.mock.calls[0]?.[0].text).toContain('prep_write')
    expect(await page()).toMatchObject({ briefSessionId: first.sessionId, state: 'working' })
    expect(prepPushes()).toEqual([{ push: 'work.prep', ...params, rev: 1 }])
  })

  it('starts a new brief after twenty minutes with no brief written', async () => {
    const now = dateNow()
    const start = fakeStarts()
    await brief()
    now.mockReturnValue(START + PREP_WORKING_MS - 1)
    expect(await brief()).toEqual({ sessionId: 't-meeting-1' })
    now.mockReturnValue(START + PREP_WORKING_MS)
    expect(await brief()).toEqual({ sessionId: 't-meeting-2' })
    expect(start).toHaveBeenCalledTimes(2)
    expect(prepPushes()).toHaveLength(2)
  })

  it('starts a fresh brief after the first writes one', async () => {
    const now = dateNow()
    const start = fakeStarts()
    await brief()
    await call('prep_write', { event: 'ev1', matters: [{ text: 'Review the roster' }] }, 't-meeting-1')
    now.mockReturnValue(START + 1)
    expect(await brief()).toEqual({ sessionId: 't-meeting-2' })
    expect(await brief()).toEqual({ sessionId: 't-meeting-2' })
    expect(start).toHaveBeenCalledTimes(2)
    expect(prepPushes()).toHaveLength(3)
  })

  it.each([
    ['work.prep.brief', params],
    ['work.prep.notes', { ...params, text: 'Notes' }],
    ['work.prep.followUp', params],
    ['work.prep.decide', { ...params, taskIds: ['s1'], decision: 'accept' }],
    ['work.prep.ahead', { workspaceId: 'ws-purdue', on: true }]
  ])('refuses a thread’s own call to %s', async (method, args) => {
    await expect(prep.handle!({ id: 'model', method, params: args } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner changes a meeting’s page')
    expect(lifeos.calls).toEqual([])
    expect(prepPushes()).toEqual([])
  })

  it('trims and keeps notes, and clears them on an empty press', async () => {
    dateNow()
    expect((await note('  Maya has the roster.\nTom has the keys.  ')).page).toMatchObject({
      state: 'after', rev: 1, doc: { notes: { text: 'Maya has the roster.\nTom has the keys.', at: START } }
    })
    expect((await note('  ')).page).toMatchObject({ state: 'none', rev: 2, doc: { notes: null } })
    expect(prepPushes()).toEqual([1, 2].map((rev) => ({ push: 'work.prep', ...params, rev })))
  })

  it('requires notes before starting a follow-up thread', async () => {
    const start = fakeStarts()
    await expect(follow()).rejects.toThrow('Add notes first.')
    expect(start).not.toHaveBeenCalled()
    expect(prepPushes()).toEqual([])
  })

  it('links and starts a follow-up from his notes, and answers the same thread on a second press', async () => {
    fakeStarts()
    await note('Dana will check the roster.')
    const first = await follow()
    expect(await follow()).toEqual(first)
    expect(rig.work.ctx.threads.start).toHaveBeenCalledExactlyOnceWith({
      workspaceId: params.workspaceId,
      title: 'Follow up: Staff sync',
      about: { kind: 'event', label: 'Staff sync', ref: { at: 'lifeos', table: 'events', id: 'ev1' } },
      text: expect.stringContaining('Dana will check the roster.')
    })
    expect(await page()).toMatchObject({ followSessionId: first.sessionId, rev: 2 })
    expect(prepPushes()).toEqual([1, 2].map((rev) => ({ push: 'work.prep', ...params, rev })))
  })

  it('starts a fresh follow-up once an outcome is written and retries an unwritten one after twenty minutes', async () => {
    const now = dateNow()
    fakeStarts()
    await note('Dana will check the roster.')
    await follow()
    await call('prep_follow_up', { event: 'ev1', decisions: [{ text: 'Dana will check the roster.' }] }, 't-meeting-1')
    now.mockReturnValue(START + 1)
    expect(await follow()).toEqual({ sessionId: 't-meeting-2' })
    expect(await follow()).toEqual({ sessionId: 't-meeting-2' })
    now.mockReturnValue(START + 1 + PREP_WORKING_MS)
    expect(await follow()).toEqual({ sessionId: 't-meeting-3' })
    expect(prepPushes()).toHaveLength(5)
  })
})

describe('the prep tools', () => {
  it('lists its tools and preamble only in a linked workspace', () => {
    const names = (id: string) => rig.work.tools.listing(rig.sessions.get(id)!).filter((t) => t.name.startsWith('prep_')).map((t) => [t.name, t.readOnly])
    workspace('ws-bare', null)
    rig.thread('t-bare', { scope: 'work', workspaceId: 'ws-bare' })
    rig.thread('t-chat', { scope: 'work', workspaceId: null })
    expect(names('t-purdue')).toEqual([['prep_read', true], ['prep_today', true], ['prep_write', false], ['prep_follow_up', false]])
    const preamble = prep.preamble!(rig.work.ctx.scopeOf('t-purdue')!)!
    expect(preamble.split('\n')).toHaveLength(2)
    expect(preamble).toContain('Never use add_task')
    expect(preamble).toContain('Use draft_mail')
    for (const id of ['t-chat', 't-bare']) {
      expect(names(id)).toEqual([])
      expect(prep.preamble!(rig.work.ctx.scopeOf(id)!)).toBeNull()
    }
  })

  it('defaults to the newest event link, ignoring newer links to other tables', async () => {
    lifeos.event({ _id: 'ev-old', title: 'Old meeting' })
    const link = { sector: 'purdue', host: 'box', threadId: 't-purdue', title: 'Staff sync', state: 'open' as const }
    rig.work.ctx.links.forThread = vi.fn().mockResolvedValue([
      { ...link, entity: { table: 'events', id: 'ev-old' }, at: 1 },
      { ...link, entity: { table: 'tasks', id: 'task-1' }, at: 3 },
      { ...link, entity: { table: 'events', id: 'ev1' }, at: 2 }
    ])
    expect(words(await call('prep_read'))).toContain('Staff sync (event ev1)')
    await call('prep_write', { matters: [{ text: 'Review the roster' }] })
    await call('prep_follow_up', { decisions: [{ text: 'The roster is ready' }] })
    expect(await page()).toMatchObject({ doc: { brief: { by: 't-purdue' }, after: { decisions: [{ text: 'The roster is ready' }] } } })
    expect(await page('ev-old')).toMatchObject({ rev: 0 })
  })

  it('asks for an event id if the thread has no event link', async () => {
    const result = await call('prep_read')
    expect(result.isError).toBe(true)
    expect(words(result)).toContain('Pass its LifeOS event id as event.')
    expect(lifeos.calls).toEqual([])
  })

  it.each([
    ['prep_read', {}],
    ['prep_write', { matters: [{ text: 'Review the roster' }] }],
    ['prep_follow_up', { tasks: [{ title: 'Ask Maya' }] }]
  ])('%s refuses an event in another sector', async (name, args) => {
    lifeos.event({ _id: 'ev-far', sector: 'cosmic' })
    const result = await call(name, { event: 'ev-far', ...args })
    expect(result.isError).toBe(true)
    expect(words(result)).toBe('That event is not in Purdue’s sector.')
    expect(lifeos.calls.map((c) => c.fn)).toEqual(['events:get'])
    expect(prepPushes()).toEqual([])
  })

  it('replaces the brief, merges added people once and pushes each write', async () => {
    dateNow()
    await rig.rpc('work.prep.people', { ...params, people: [{ name: 'Dana Reyes', address: 'dana@x.test' }] })
    const result = await call('prep_write', {
      event: 'ev1',
      matters: [{ text: 'Review the roster', ref: { table: 'tasks', id: 'task-1' } }],
      agreed: [{ text: 'The date is set' }],
      files: [{ title: 'Roster', url: 'https://example.com/roster' }],
      people: [{ name: 'Dana', address: 'DANA@X.TEST' }, { name: 'Tom Beck' }, { name: 'tom beck' }]
    })
    expect(words(result)).toBe('Kept the brief for “Staff sync” (1 thing). It is on the meeting’s page.')
    expect(await page()).toMatchObject({
      state: 'briefed', rev: 2, doc: {
        people: [{ name: 'Dana Reyes', address: 'dana@x.test' }, { name: 'Tom Beck' }],
        brief: {
          matters: [{ text: 'Review the roster', ref: { table: 'tasks', id: 'task-1' } }],
          agreed: [{ text: 'The date is set' }], files: [{ title: 'Roster', url: 'https://example.com/roster' }], at: START, by: 't-purdue'
        }
      }
    })
    await call('prep_write', { event: 'ev1', matters: [{ text: 'Ask about travel' }] })
    expect((await page()).doc.brief).toEqual({ matters: [{ text: 'Ask about travel' }], agreed: [], files: [], at: START, by: 't-purdue' })
    expect(prepPushes()).toEqual([1, 2, 3].map((rev) => ({ push: 'work.prep', ...params, rev })))
  })
})

describe('Prepare ahead', () => {
  const cosmic = { workspaceId: 'ws-cosmic' }

  it('uses the routines handler as owner and saves once, pauses and resumes its daily schedule', async () => {
    workspace(cosmic.workspaceId, 'cosmic')
    lifeos.event({ _id: 'ev-cosmic', sector: 'cosmic' })
    let routine: { id: string; enabled: boolean } | null = null
    const handle = vi.fn<NonNullable<WorkModule['handle']>>(async (req) => {
      switch (req.method) {
        case 'work.routines.list':
          return handled({ routines: routine ? [routine] : [] })
        case 'work.routines.save':
          return handled(routine = { id: 'r-ahead', enabled: true })
        case 'work.routines.pause':
          return handled(routine = { id: 'r-ahead', enabled: !req.params.paused })
        default:
          return NOT_HANDLED
      }
    })
    const module = { id: 'routines', ensure() {}, handle } satisfies WorkModule
    WORK_MODULES.push(module)
    try {
      const set = (on: boolean) => rig.rpc<PrepAhead>('work.prep.ahead', { ...cosmic, on, tz: 'America/New_York' }, adminKey)
      const on = { offered: true, on: true, routineId: 'r-ahead' }
      expect(await rig.rpc('work.prep.ahead', cosmic, readKey)).toEqual({ offered: true, on: false })
      expect(await Promise.all([set(true), set(true)])).toEqual([on, on])
      const saves = handle.mock.calls.filter(([req]) => req.method === 'work.routines.save')
      expect(saves).toHaveLength(1)
      const [req, ctx, by] = saves[0]!
      expect(ctx).toBe(rig.work.ctx)
      expect(by satisfies Caller).toEqual({ kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] })
      expect(req).toMatchObject({
        method: 'work.routines.save',
        params: {
          ...cosmic, name: AHEAD_ROUTINE, prompt: expect.stringContaining('prep_today'),
          trigger: { on: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0', tz: 'America/New_York' }, ends: { kind: 'never' }
        }
      })
      expect(parseSchedule('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')).toMatchObject({ hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] })
      expect(await page('ev-cosmic', cosmic.workspaceId)).toMatchObject({ aheadOn: true, aheadOffered: true })
      expect(await set(false)).toEqual({ ...on, on: false })
      expect(await page('ev-cosmic', cosmic.workspaceId)).toMatchObject({ aheadOn: false, aheadOffered: true })
      expect(await set(true)).toEqual(on)
      expect(handle.mock.calls.flatMap(([req]) => req.method === 'work.routines.pause' ? [req.params] : [])).toEqual([
        { id: 'r-ahead', paused: true }, { id: 'r-ahead', paused: false }
      ])
      expect(handle.mock.calls.filter(([req]) => req.method === 'work.routines.save')).toHaveLength(1)
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(module), 1)
    }
    expect(await page('ev-cosmic', cosmic.workspaceId)).toMatchObject({ aheadOn: false, aheadOffered: true })
  })

  it('requires admin to set the switch and withholds it in Purdue', async () => {
    workspace(cosmic.workspaceId, 'cosmic')
    await expect(rig.rpc('work.prep.ahead', { ...cosmic, on: true }, readKey)).rejects.toThrow('Only the owner with admin')
    await expect(rig.rpc('work.prep.ahead', { workspaceId: 'ws-purdue', on: true })).rejects.toThrow('Prepare ahead is not offered for Purdue.')
    expect(await rig.rpc('work.prep.ahead', { workspaceId: 'ws-purdue' }, readKey)).toEqual({ offered: false, on: false })
    expect(await page()).toMatchObject({ aheadOn: false, aheadOffered: false })
  })

  it('lists at most eight upcoming meetings from the workspace with guests and no brief in the next sixteen hours', async () => {
    dateNow()
    workspace(cosmic.workspaceId, 'cosmic')
    const attendees = [{ name: 'Tom Beck', address: 'tom@x.test' }]
    const hour = 3_600_000
    lifeos.event({ _id: 'briefed', title: 'Already briefed', startsAt: START + 1, attendees })
    lifeos.event({ _id: 'alone', title: 'Solo review', startsAt: START + 2 })
    lifeos.event({ _id: 'late', title: 'Too late', startsAt: START + 16 * hour, attendees })
    lifeos.event({ _id: 'early', title: 'Too early', startsAt: START - 1, attendees })
    lifeos.event({ _id: 'outside', title: 'Wrong workspace', startsAt: START + 3, sector: 'cosmic', attendees })
    lifeos.event({ _id: 'working', title: 'Already working', startsAt: START + 4, attendees })
    lifeos.event({ _id: 'after', title: 'Already has notes', startsAt: START + 5, attendees })
    for (let i = 0; i < 9; i++) lifeos.event({ _id: `need-${i}`, title: `Roster ${i}`, startsAt: START + (i + 1) * hour, attendees })
    await call('prep_write', { event: 'briefed', matters: [{ text: 'Review the roster' }] })
    fakeStarts()
    await rig.rpc('work.prep.brief', { ...params, eventId: 'working' })
    await rig.rpc('work.prep.notes', { ...params, eventId: 'after', text: 'Maya has the roster.' })
    const text = words(await call('prep_today'))
    expect(lifeos.called('events:range')).toEqual([{ from: START, to: START + 16 * hour, sector: 'purdue' }])
    expect(text.match(/^Meeting:/gm)).toHaveLength(8)
    expect(text).toContain('Staff sync (event ev1)')
    expect(text).toContain('Roster 0 (event need-0)')
    expect(text).toContain('Tom Beck <tom@x.test>')
    for (const missing of ['Already briefed', 'Solo review', 'Too late', 'Too early', 'Wrong workspace', 'Already working', 'Already has notes', 'Roster 7']) expect(text).not.toContain(missing)
  })

  it('says when none of the workspace’s meetings need a brief', async () => {
    dateNow()
    await call('prep_write', { event: 'ev1', matters: [{ text: 'Review the roster' }] })
    expect(words(await call('prep_today'))).toBe('No meetings today need a brief.')
  })
})

describe('suggested tasks', () => {
  it('files an accepted suggestion once, with its own key, and records the result in the follow-up thread', async () => {
    fakeStarts()
    await note('Maya can send the roster.')
    const { sessionId } = await follow()
    const add = vi.spyOn(rig.work.ctx.results, 'add')
    const result = await call('prep_follow_up', {
      event: 'ev1', tasks: [{ title: 'Send the roster', who: 'Maya Chen', due: '2026-11-24T15:00:00-05:00', quote: 'Maya can send the roster.' }]
    }, sessionId)
    expect(words(result)).toContain('Suggested tasks wait for the owner')
    expect(lifeos.called('tasks:create')).toEqual([])
    expect((await page()).doc.after?.tasks[0]).toMatchObject({ id: 's1', state: 'proposed', who: 'Maya Chen' })
    const [a, b] = await Promise.all([decide('accept', 's1'), decide('accept', 's1')])
    expect(a.failed).toEqual([])
    expect(b.page.doc.after?.tasks[0]).toMatchObject({ id: 's1', state: 'filed', lifeosTaskId: 'task_1' })
    const row = new PrepStore(rig.work.ctx.db).get(params.workspaceId, params.eventId)!
    expect(lifeos.called('tasks:create')).toEqual([{
      sector: 'purdue', title: 'Send the roster', description: 'From “Staff sync”, Mon Nov 23.\n“Maya can send the roster.”',
      dueAt: Date.parse('2026-11-24T15:00:00-05:00'), key: `prep:${row.id}:s1`
    }])
    expect(add).toHaveBeenCalledExactlyOnceWith({
      sessionId, kind: 'prep.task.filed', summary: 'Filed the task “Send the roster”', ref: { at: 'lifeos', table: 'tasks', id: 'task_1' }
    })
    expect(prepPushes()).toEqual([1, 2, 3, 4].map((rev) => ({ push: 'work.prep', ...params, rev })))
    expect(lifeos.called('compose:send')).toEqual([])
  })

  it('recovers the same LifeOS task when the first filing saved it but lost the reply', async () => {
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }] })
    const mutate = lifeos.mutation
    vi.spyOn(lifeos, 'mutation').mockImplementationOnce(async (fn, args) => {
      await mutate(fn, args)
      throw new Error('LifeOS did not answer.')
    })
    const failed = await decide('accept', 's1')
    expect(failed.failed).toEqual([{ id: 's1', error: 'LifeOS did not answer.' }])
    expect(failed.page.doc.after?.tasks[0]?.state).toBe('proposed')
    const retried = await decide('accept', 's1')
    expect(retried.failed).toEqual([])
    expect(retried.page.doc.after?.tasks[0]).toMatchObject({ state: 'filed', lifeosTaskId: 'task_1' })
    expect(lifeos.tasks.size).toBe(1)
    expect(lifeos.called('tasks:create')).toHaveLength(2)
    expect(lifeos.called('tasks:create')[0]).toEqual(lifeos.called('tasks:create')[1])
    expect(prepPushes()).toHaveLength(2)
  })

  it('carries matching filed and rejected tasks through a rewrite and keeps filed tasks omitted from it', async () => {
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send Roster' }, { title: 'Book bus' }, { title: 'Keep Score' }] })
    await decide('accept', 's1', 's3')
    await decide('reject', 's2')
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'send roster!' }, { title: 'BOOK BUS' }, { title: 'Call Dana' }] })
    expect((await page()).doc.after?.tasks).toEqual([
      { id: 's1', title: 'Send Roster', state: 'filed', lifeosTaskId: 'task_1' },
      { id: 's2', title: 'Book bus', state: 'rejected' },
      { id: 's4', title: 'Call Dana', state: 'proposed' },
      { id: 's3', title: 'Keep Score', state: 'filed', lifeosTaskId: 'task_2' }
    ])
    expect(lifeos.called('tasks:create')).toHaveLength(2)
    expect(prepPushes()).toHaveLength(5)
  })

  it('never reuses suggestion ids even after the thread clears the list', async () => {
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }] })
    await call('prep_follow_up', { event: 'ev1', tasks: [] })
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }] })
    expect((await decide('accept', 's1')).page.doc.after?.tasks).toEqual([{ id: 's2', title: 'Send roster', state: 'proposed' }])
    expect(lifeos.called('tasks:create')).toEqual([])
    expect(prepPushes()).toHaveLength(3)
  })

  it('keeps the page intact when a rewrite and carried tasks would exceed its limit', async () => {
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }] })
    await decide('accept', 's1')
    const result = await call('prep_follow_up', { event: 'ev1', tasks: Array.from({ length: PREP_TASKS_MAX }, (_, i) => ({ title: `Roster step ${i}` })) })
    expect(result.isError).toBe(true)
    expect(words(result)).toContain('Suggest fewer tasks')
    expect((await page()).doc.after?.tasks).toEqual([{ id: 's1', title: 'Send roster', state: 'filed', lifeosTaskId: 'task_1' }])
    expect(prepPushes()).toHaveLength(2)
  })

  it('keeps a failed task proposed and reports LifeOS’s words while filing the other tasks', async () => {
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }, { title: 'Call Dana', due: '2026-11-24' }] })
    const mutate = lifeos.mutation
    vi.spyOn(lifeos, 'mutation').mockImplementation(async (fn, args) => {
      if (fn === 'tasks:create' && args?.title === 'Send roster') throw new Error('LifeOS could not save the roster task.')
      return mutate(fn, args)
    })
    const answer = await decide('accept', 's1', 's2')
    expect(answer.failed).toEqual([{ id: 's1', error: 'LifeOS could not save the roster task.' }])
    expect(answer.page.doc.after?.tasks.map((t) => [t.id, t.state])).toEqual([['s1', 'proposed'], ['s2', 'filed']])
    expect(lifeos.called('tasks:create')[0]).toMatchObject({ dueAt: new Date(2026, 10, 24, 9).getTime() })
    expect(prepPushes()).toHaveLength(2)
  })

  it('does not record a result when the follow-up thread is gone', async () => {
    fakeStarts()
    await note('Maya can send the roster.')
    const { sessionId } = await follow()
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send roster' }] }, sessionId)
    rig.sessions.delete(sessionId)
    const add = vi.spyOn(rig.work.ctx.results, 'add')
    expect((await decide('accept', 's1')).page.doc.after?.tasks[0]?.state).toBe('filed')
    expect(add).not.toHaveBeenCalled()
  })
})
