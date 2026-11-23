import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREP_TASKS_MAX, PREP_WORKING_MS, type PrepAhead, type PrepPage, type PrepUpcoming } from '@shared/contract-work-prep'
import { parseSchedule } from '@shared/contract-work-routines'
import type { WorkspaceMeta } from '@shared/domain'
import { handled, NOT_HANDLED, type WorkToolResult } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkModule } from '../modules'
import { canvas as canvasModule } from '../canvas/index'
import { outbox as outboxModule } from '../outbox/index'
import { adminKey, approveKey, makeRig, readKey, type Rig } from '../outbox/rig'
import { AHEAD_ROUTINE } from './ahead'
import { prep } from './index'
import { fileWait } from './tools'
import { PrepStore } from './store'
import { templates as templatesModule } from '../templates/index'
import { setStartersRoot } from '../templates/shelf'
import { docx } from '../templates/testkit'
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
  // A recording's thread waits in prep_read for its file: a moment here, minutes in the app.
  Object.assign(fileWait, { everyMs: 2, forMs: 10 })
  rig = await makeRig({ modules: [outboxModule, canvasModule, templatesModule, prep] })
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

  it('never keep someone the calendar itself lists: an invitee is on the meeting already, and would follow the series to a day they are not invited', async () => {
    const { page: after } = await rig.rpc<{ page: PrepPage }>('work.prep.people', { ...params, people: [{ name: 'Maya Chen', address: 'Maya@X.test', personId: 'p-maya' }, { name: 'Tom Beck' }] })
    expect(after.doc.people).toEqual([{ name: 'Tom Beck' }])
    expect(after.invited).toEqual(['maya@x.test'])
    // typed in by her address or her name alone, she is that invitee still
    const typed = await rig.rpc<{ page: PrepPage }>('work.prep.people', { ...params, people: [{ name: 'maya@x.test' }, { name: 'maya  chen' }, { name: 'Dana Reyes' }] })
    expect(typed.page.doc.people).toEqual([{ name: 'Dana Reyes' }])
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
      dueAt: Date.parse('2026-11-24T15:00:00-05:00'), key: `prep:${row.id}:s1`,
      // LifeOS takes a key only as a quick add's own source
      source: { kind: 'manual', container: 'quick-add', channel: 'Meeting', messageId: `prep:${row.id}:s1`, sentAt: expect.any(Number) }
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
    const keyOf = (call: Record<string, unknown>) => [call.key, (call.source as { messageId?: string }).messageId, call.title]
    expect(keyOf(lifeos.called('tasks:create')[0]!)).toEqual(keyOf(lifeos.called('tasks:create')[1]!))
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

describe('a recording or a transcript as the notes', () => {
  const record = (name = 'Staff sync.m4a') => rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name } })

  it('needs no typed notes: it opens an empty meeting in the new thread’s own pane and names it on the page', async () => {
    const starts = fakeStarts()
    const { sessionId, itemId } = await record()
    expect(sessionId).toBe('t-meeting-1')
    const item = rig.work.ctx.canvas.get(itemId!)!
    // the follow-up thread's pane holds it, with no file yet: the window puts the file there through work.meetings.start
    expect(item).toMatchObject({ kind: 'meeting', sessionId: 't-meeting-1', source: { at: 'thread' }, title: 'Staff sync.m4a' })
    expect(rig.work.ctx.canvas.forSession('t-meeting-1').map((i) => i.id)).toEqual([itemId])
    const got = await page()
    expect(got.notesFile).toEqual({ kind: 'meeting', itemId, title: 'Staff sync.m4a' })
    expect(got.doc.notes).toMatchObject({ text: '', meetingItemId: itemId })
    expect(got).toMatchObject({ state: 'after', followSessionId: 't-meeting-1' })
    // the thread is told to read the meeting, and to write tasks through prep alone
    const text = starts.mock.calls[0]![0].text
    expect(text).toContain('Call prep_read first: it waits until the file has arrived and names the meeting. Then read it with meeting_read')
    expect(text).toContain('If it could not be read, say why and stop')
    expect(text).toContain('write no actions with meeting_notes')
    expect(text).not.toContain('Use his notes.')
    expect(starts.mock.calls[0]![0]).toMatchObject({ title: 'Follow up: Staff sync', about: { kind: 'event', ref: { at: 'lifeos', table: 'events', id: 'ev1' } } })
  })

  it('tells the thread which meeting to read through prep_read, and keeps what he typed beside it', async () => {
    fakeStarts()
    await note('Dana drives the van.')
    const { itemId } = await record('sync.vtt')
    const read = words(await call('prep_read', { event: 'ev1' }, 't-meeting-1'))
    expect(read).toContain(`open beside this thread as meeting ${itemId}. Read it with meeting_read.`)
    expect(read).toContain('His notes:\nDana drives the van.')
  })

  it('answers the thread still at work with its own meeting while that is still empty, and opens no second one', async () => {
    const starts = fakeStarts()
    const first = await record()
    // the first file never arrived: the second goes where it was to go
    expect(await record('again.m4a')).toEqual(first)
    expect(starts).toHaveBeenCalledTimes(1)
    expect(rig.work.ctx.canvas.forSession('t-meeting-1')).toHaveLength(1)
  })

  it('says nothing of a transcript in any push: a push carries ids and a revision alone', async () => {
    fakeStarts()
    await note('The budget is 4,200 dollars.')
    await record()
    await call('prep_follow_up', { event: 'ev1', summary: [{ text: 'The budget is settled.' }], tasks: [{ title: 'Send the budget' }] })
    expect(prepPushes().length).toBeGreaterThan(2)
    for (const push of prepPushes()) expect(Object.keys(push).sort()).toEqual(['eventId', 'push', 'rev', 'workspaceId'])
    expect(JSON.stringify(rig.pushes.filter((p) => p.push === 'work.prep'))).not.toContain('budget')
  })

  it('is his press alone', async () => {
    await expect(prep.handle!({ id: '1', method: 'work.prep.followUp', params: { ...params, recording: { name: 'x.m4a' } } } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner changes a meeting’s page')
  })

  it('names no recording once its meeting is gone', async () => {
    fakeStarts()
    const { itemId } = await record()
    rig.work.ctx.canvas.remove([itemId!])
    expect((await page()).notesFile).toBeNull()
  })
})

describe('notes written in a document', () => {
  let base: string
  let folder: string
  const doc = () => rig.rpc<{ page: PrepPage; source: { at: string; host: string; path: string }; title: string }>('work.prep.notesDoc', { ...params, today: '2026-11-23' })
  beforeEach(() => {
    // The workspace's own folder, and a starters folder with the one template prep asks for. Dummy files.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tc-prep-doc-')))
    folder = join(base, 'Purdue')
    mkdirSync(folder)
    mkdirSync(join(base, 'starters', 'any'), { recursive: true })
    writeFileSync(join(base, 'starters', 'any', 'Meeting notes.docx'), docx('{{Meeting}}', '{{Date}}'))
    setStartersRoot(join(base, 'starters'))
    rig.work.ctx.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(folder, 'ws-purdue')
  })
  afterEach(() => {
    setStartersRoot(null)
    rmSync(base, { recursive: true, force: true })
  })

  it('makes the notes file from the Meeting notes template in the workspace’s own folder, once, and keeps it as the notes', async () => {
    const made = await doc()
    expect(made.source).toEqual({ at: 'file', host: 'env_box', path: join(folder, 'Staff sync notes.docx') })
    expect(made.title).toBe('Staff sync notes.docx')
    expect(readdirSync(folder)).toEqual(['Staff sync notes.docx'])
    expect(made.page.notesFile).toEqual({ kind: 'document', title: 'Staff sync notes.docx', source: made.source })
    expect(made.page.doc.notes).toMatchObject({ text: '', file: made.source })
    expect(made.page.state).toBe('after')
    // a second ask answers the same file and makes no other
    expect((await doc()).source).toEqual(made.source)
    expect(readdirSync(folder)).toEqual(['Staff sync notes.docx'])
    // words typed later sit beside it; clearing them keeps the file
    expect((await note('And one more thing.')).page.doc.notes).toMatchObject({ text: 'And one more thing.', file: made.source })
    expect((await note('')).page.doc.notes).toMatchObject({ text: '', file: made.source })
  })

  it('is opened beside the follow-up thread, which is told to read it with doc_read', async () => {
    const starts = fakeStarts()
    const made = await doc()
    const { sessionId } = await follow()
    const items = rig.work.ctx.canvas.forSession(sessionId)
    expect(items).toMatchObject([{ kind: 'document', source: made.source, title: 'Staff sync notes.docx' }])
    expect(starts.mock.calls[0]![0].text).toContain('Read it with doc_read, and change nothing in it.')
    const read = words(await call('prep_read', { event: 'ev1' }, sessionId))
    expect(read).toContain(`His notes are the document “Staff sync notes.docx”, open beside this thread as item ${items[0]!.id}. Read it with doc_read.`)
    expect((await page()).notesFile).toMatchObject({ kind: 'document', itemId: items[0]!.id })
  })

  it('says so when the host has no Meeting notes template, and keeps the page as it was', async () => {
    rmSync(join(base, 'starters'), { recursive: true })
    await expect(doc()).rejects.toThrow()
    expect(pages()).toBe(0)
  })

  it('is his press alone', async () => {
    await expect(prep.handle!({ id: '1', method: 'work.prep.notesDoc', params } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner changes a meeting’s page')
    expect(readdirSync(folder)).toEqual([])
  })
})

describe('the push', () => {
  it('fires on every change of a page’s state, so Today and the digest read again: none, working, briefed, after', async () => {
    fakeStarts()
    const states: string[] = []
    const seen = () => prepPushes().length
    const upcomingState = async () => (await rig.rpc<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: START - 3_600_000, to: START + 3_600_000 })).meetings[0]!.state
    states.push(await upcomingState())
    let before = seen()
    await brief()
    expect(seen()).toBeGreaterThan(before)
    states.push(await upcomingState())
    before = seen()
    await call('prep_write', { event: 'ev1', matters: [{ text: 'Maya needs the seat list.' }] }, 't-meeting-1')
    expect(seen()).toBeGreaterThan(before)
    states.push(await upcomingState())
    before = seen()
    await note('Dana drives the van.')
    expect(seen()).toBeGreaterThan(before)
    states.push(await upcomingState())
    expect(states).toEqual(['none', 'working', 'briefed', 'after'])
    // each push names the page and nothing of it
    expect(prepPushes().at(-1)).toEqual({ push: 'work.prep', workspaceId: 'ws-purdue', eventId: 'ev1', rev: expect.any(Number) })
  })
})

describe('a thread the window knows has stopped', () => {
  it('is not waited on: a press with restart starts a new thread inside the twenty minutes, and without it answers the same one', async () => {
    const starts = fakeStarts()
    const first = await brief()
    expect(await brief()).toEqual(first)
    const again = await rig.rpc<{ sessionId: string }>('work.prep.brief', { ...params, restart: true })
    expect(again.sessionId).not.toBe(first.sessionId)
    expect(starts).toHaveBeenCalledTimes(2)
    expect((await page()).briefSessionId).toBe(again.sessionId)
    // the same for a follow-up
    await note('Dana drives the van.')
    const follow1 = await follow()
    const follow2 = await rig.rpc<{ sessionId: string }>('work.prep.followUp', { ...params, restart: true })
    expect(follow2.sessionId).not.toBe(follow1.sessionId)
  })
})

describe('a recording that never arrived', () => {
  it('is no notes: a follow-up from typed words starts a fresh thread and leaves the empty meeting behind', async () => {
    const starts = fakeStarts()
    const recorded = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    // the upload failed: the meeting has no file. He types his notes instead.
    await note('Dana drives the van.')
    const typed = await follow()
    expect(typed.sessionId).not.toBe(recorded.sessionId)
    expect(starts).toHaveBeenCalledTimes(2)
    expect(starts.mock.calls[1]![0].text).toContain('Use his notes.')
    expect(starts.mock.calls[1]![0].text).not.toContain('meeting_read')
    const got = await page()
    expect(got.doc.notes).toEqual({ text: 'Dana drives the van.', at: expect.any(Number) })
    expect(got.notesFile).toBeNull()
    expect(got.followSessionId).toBe(typed.sessionId)
  })

  it('lets go of the thread that waited for it once the window says so: the page stops saying it is at work, and the next Follow up or file starts fresh', async () => {
    const starts = fakeStarts()
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    expect(await page()).toMatchObject({ followSessionId: first.sessionId, followStartedAt: expect.any(Number), followUntil: expect.any(Number) })
    // the upload failed, and the window says the file is no notes, keeping what he typed
    const dropped = (await rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text: 'Dana drives the van.', dropFile: true })).page
    expect(dropped).toMatchObject({ followSessionId: null, followStartedAt: null, followUntil: null, notesFile: null })
    expect(dropped.doc.notes).toEqual({ text: 'Dana drives the van.', at: expect.any(Number) })
    // no restart asked: the thread that waited on the file is simply no longer the page's
    const typed = await follow()
    expect(typed.sessionId).not.toBe(first.sessionId)
    expect(starts.mock.calls[1]![0].text).toContain('Use his notes.')
    expect((await page()).followSessionId).toBe(typed.sessionId)
  })

  it('gives another file a meeting and a thread of its own after the first was dropped', async () => {
    fakeStarts()
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await rig.rpc('work.prep.notes', { ...params, text: '', dropFile: true })
    expect((await page()).doc.notes).toBeNull()
    const second = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.vtt' } })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.itemId).toBeTruthy()
    expect(second.itemId).not.toBe(first.itemId)
  })

  it('keeps every thread that wrote the outcome, oldest first and each once, so a rewrite hides no earlier mail', async () => {
    fakeStarts()
    await note('Dana drives the van.')
    const one = await follow()
    await call('prep_follow_up', { event: 'ev1', summary: [{ text: 'The van is settled.' }] }, one.sessionId)
    lifeos.outbox.push({ _id: 'ob1', status: 'draft', sector: 'purdue', origin: { threadId: one.sessionId }, message: { subject: 'Staff sync follow-up', to: [{ address: 'maya@x.test' }] } })
    const two = await rig.rpc<{ sessionId: string }>('work.prep.followUp', { ...params, restart: true })
    expect(two.sessionId).not.toBe(one.sessionId)
    // the second thread is shown the mail that waits, so it drafts none
    expect(words(await call('prep_read', { event: 'ev1' }, two.sessionId))).toContain('Follow-up mail already waiting for his press in the Outbox:\n- “Staff sync follow-up” to maya@x.test')
    await call('prep_follow_up', { event: 'ev1', summary: [{ text: 'The van and the forms are settled.' }] }, two.sessionId)
    // the first thread's mail is still on the page after the rewrite, and a third follow-up would still be told of it
    let got = await page()
    expect(got.doc.after?.by).toEqual([one.sessionId, two.sessionId])
    expect(got.drafts).toEqual([{ outboxId: 'ob1', subject: 'Staff sync follow-up', to: ['maya@x.test'] }])
    await call('prep_follow_up', { event: 'ev1', summary: [{ text: 'The van and the forms are settled.' }] }, one.sessionId)
    got = await page()
    expect(got.doc.after?.by).toEqual([two.sessionId, one.sessionId])
    expect(got.drafts).toHaveLength(1)
  })

  it('lets go of it over an outcome too: what an earlier thread wrote stays, and the header has no thread to wait on', async () => {
    fakeStarts()
    await note('Dana drives the van.')
    const done = await follow()
    await call('prep_follow_up', { event: 'ev1', summary: [{ text: 'The van is settled.' }] }, done.sessionId)
    // a restart with a recording, whose file then never arrives
    const again = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, restart: true, recording: { name: 'Staff sync.m4a' } })
    const dropped = (await rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text: 'Dana drives the van.', dropFile: true })).page
    expect(again.sessionId).not.toBe(done.sessionId)
    expect(dropped).toMatchObject({ followSessionId: null, followUntil: null })
    expect(dropped.doc.after?.summary).toEqual([{ text: 'The van is settled.' }])
    // the outcome keeps who wrote it, so that thread's mail stays on the page
    expect(dropped.doc.after?.by).toEqual([done.sessionId])
  })

  it('takes nothing else with it: a notes document the recording was to stand beside is still the page’s', async () => {
    fakeStarts()
    const source = { at: 'file' as const, host: 'box', path: '/tmp/ws-purdue/Staff sync notes.docx' }
    new PrepStore(rig.work.ctx.db).write('ws-purdue', { id: 'ev1', series: 'series1', title: 'Staff sync', startsAt: START, endsAt: null, peopleKeys: [] }, () => ({ people: [], brief: null, notes: null, after: null }), (doc) => ({ ...doc, notes: { text: 'Typed too.', at: 1, file: source } }), START)
    expect((await page()).notesFile).toMatchObject({ kind: 'document', title: 'Staff sync notes.docx' })
    const { itemId } = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    // while the recording stands it is the notes' file, and the document waits beside it
    expect(await page()).toMatchObject({ notesFile: { kind: 'meeting', itemId }, doc: { notes: { text: 'Typed too.', file: source, meetingItemId: itemId } } })
    const dropped = (await rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text: 'Typed too.', dropFile: true })).page
    expect(dropped.doc.notes).toEqual({ text: 'Typed too.', at: expect.any(Number), file: source })
    expect(dropped.notesFile).toMatchObject({ kind: 'document', title: 'Staff sync notes.docx' })
  })

  it('with nothing typed either, asks for notes, and the page stops calling the empty meeting notes', async () => {
    fakeStarts()
    // the window's word that the file never came did not reach this host (the link was down)
    const first = await rig.rpc<{ sessionId: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    expect(await page()).toMatchObject({ followSessionId: first.sessionId, doc: { notes: { meetingItemId: expect.any(String) } } })
    await expect(rig.rpc('work.prep.followUp', { ...params, restart: true })).rejects.toThrow('Add notes first.')
    // so the header asks for notes, not for a follow-up that would refuse on every press
    const got = await page()
    expect(got.doc.notes).toBeNull()
    expect(got).toMatchObject({ followSessionId: null, notesFile: null })
  })
})

describe('a task the page filed', () => {
  it('is one row, under To do: the facts leave it out of Tasks though its title names the subject', async () => {
    fakeStarts()
    await note('Staff rota is wrong.')
    await follow()
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Fix the staff rota' }] })
    expect((await decide('accept', 's1')).failed).toEqual([])
    const got = await page()
    const filed = got.doc.after!.tasks[0]!
    expect(filed).toMatchObject({ state: 'filed', lifeosTaskId: expect.any(String) })
    // "Staff sync" searches for "staff", which the new task's title holds
    expect(lifeos.called('tasks:search')).not.toEqual([])
    expect(got.tasks.map((t) => t.id)).not.toContain(filed.lifeosTaskId)
  })

  it('says LifeOS’s refusal in its own words, without the server’s wrapping', async () => {
    fakeStarts()
    await note('x')
    await follow()
    await call('prep_follow_up', { event: 'ev1', tasks: [{ title: 'Send the roster' }] })
    lifeos.failing.set('tasks:create', '[CONVEX M(tasks:create)] [Request ID: d3afe015d3d9787f] Server Error\nUncaught ConvexError: a keyed task carries its key as a quick add’s source')
    expect((await decide('accept', 's1')).failed).toEqual([{ id: 's1', error: 'A keyed task carries its key as a quick add’s source' }])
  })
})

describe('what the window is told of a thread it cannot see', () => {
  it('says until when a brief and a follow-up still count as at work, and nothing once they wrote or the bound ran out', async () => {
    fakeStarts()
    const now = dateNow()
    expect(await page()).toMatchObject({ briefUntil: null, followUntil: null })
    const { sessionId } = await brief()
    expect((await page()).briefUntil).toBe(START + PREP_WORKING_MS)
    now.mockReturnValue(START + PREP_WORKING_MS + 1)
    expect(await page()).toMatchObject({ briefUntil: null, state: 'none' })
    now.mockReturnValue(START + 1000)
    await call('prep_write', { event: 'ev1', matters: [{ text: 'Maya needs the seat list.' }] }, sessionId)
    expect((await page()).briefUntil).toBeNull()
    await note('Dana drives the van.')
    await follow()
    expect((await page()).followUntil).toBe(START + 1000 + PREP_WORKING_MS)
  })
})

describe('a recording the window says never arrived', () => {
  it('is dropped from the notes, keeping what he typed; without that word a file stays beside the words', async () => {
    fakeStarts()
    await note('Dana drives the van.')
    const { itemId } = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    expect((await note('Dana drives the van. Tom brings the form.')).page.doc.notes).toMatchObject({ meetingItemId: itemId })
    const dropped = await rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text: 'Dana drives the van.', dropFile: true })
    expect(dropped.page.doc.notes).toEqual({ text: 'Dana drives the van.', at: expect.any(Number) })
    expect(dropped.page.notesFile).toBeNull()
    // with nothing typed either, there are no notes at all
    await rig.rpc('work.prep.followUp', { ...params, restart: true, recording: { name: 'again.m4a' } })
    expect((await rig.rpc<{ page: PrepPage }>('work.prep.notes', { ...params, text: '', dropFile: true })).page.doc.notes).toBeNull()
  })
})

describe('a recording the host could not read', () => {
  const meetings = (status: string, error: string | null): WorkModule => ({
    id: 'meetings',
    ensure() {},
    async handle(req) {
      return req.method === 'work.meetings.get' ? handled({ meeting: { status, error } }) : NOT_HANDLED
    }
  })
  const withMeetings = async (module: WorkModule, run: () => Promise<void>) => {
    const before = [...WORK_MODULES]
    WORK_MODULES.splice(0, WORK_MODULES.length, module)
    try {
      await run()
    } finally {
      WORK_MODULES.splice(0, WORK_MODULES.length, ...before)
    }
  }

  it('says so on the page in the meeting’s own words, whenever the page is read', async () => {
    fakeStarts()
    const { itemId } = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await withMeetings(meetings('transcribing', null), async () => {
      expect((await page()).notesFile).toEqual({ kind: 'meeting', itemId, title: 'Staff sync.m4a' })
    })
    await withMeetings(meetings('failed', 'The transcriber is not installed on env_box.'), async () => {
      expect((await page()).notesFile).toEqual({ kind: 'meeting', itemId, title: 'Staff sync.m4a', error: 'The transcriber is not installed on env_box.' })
    })
  })

  it('is waited for inside prep_read by its own thread: one call, not a model turn a look, until the file has arrived', async () => {
    fakeStarts()
    Object.assign(fileWait, { everyMs: 2, forMs: 5_000 })
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    let done = false
    const reading = call('prep_read', { event: 'ev1' }, first.sessionId).then((r) => ((done = true), r))
    await new Promise((r) => setTimeout(r, 30))
    // the upload is still on its way: the read has not answered
    expect(done).toBe(false)
    await withMeetings(meetings('transcribing', null), async () => {
      const read = words(await reading)
      expect(read).toContain(`open beside this thread as meeting ${first.itemId}. Read it with meeting_read.`)
      expect(read).not.toContain('still on its way')
      expect(read).not.toContain('never arrived')
    })
    // any other thread reads the page at once
    await withMeetings(meetings('empty', null), async () => {
      expect(words(await call('prep_read', { event: 'ev1' }))).toContain('Meeting: Staff sync')
    })
  })

  it('tells its thread to stop when the file never came, and to ask again when it is only late', async () => {
    fakeStarts()
    Object.assign(fileWait, { everyMs: 2, forMs: 5_000 })
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    const reading = call('prep_read', { event: 'ev1' }, first.sessionId)
    await new Promise((r) => setTimeout(r, 20))
    await rig.rpc('work.prep.notes', { ...params, text: '', dropFile: true })
    expect(words(await reading)).toContain('The recording this thread was started for never arrived, and the page no longer waits for it. Stop here: write no outcome and draft no mail.')
    // late: the wait is bounded, and says how to go on
    Object.assign(fileWait, { everyMs: 2, forMs: 10 })
    const second = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    expect(words(await call('prep_read', { event: 'ev1' }, second.sessionId))).toContain('The recording is still on its way. Call prep_read again to keep waiting for it.')
  })

  it('is not replaced while it is being read: a second file picked beside a thread at work gets no meeting to go to', async () => {
    const starts = fakeStarts()
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await withMeetings(meetings('transcribing', null), async () => {
      // no item: the window uploads nothing, and says a follow-up is already at work
      expect(await rig.rpc('work.prep.followUp', { ...params, recording: { name: 'again.m4a' } })).toEqual({ sessionId: first.sessionId })
    })
    expect(starts).toHaveBeenCalledTimes(1)
    expect(rig.work.ctx.canvas.forSession('t-meeting-1')).toHaveLength(1)
  })

  it('is read again by the same thread when its follow-up stopped: a meeting is its own pane’s, so no new thread could read it', async () => {
    const starts = fakeStarts()
    const resume = vi.spyOn(rig.work.ctx.threads, 'resume').mockResolvedValue(undefined)
    await note('Dana drives the van.')
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    const startedAt = (await page()).followStartedAt!
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 60_000)
    await withMeetings(meetings('ready', null), async () => {
      // the window knows the thread stopped before it wrote
      expect(await rig.rpc('work.prep.followUp', { ...params, restart: true })).toEqual({ sessionId: first.sessionId, itemId: first.itemId })
    })
    expect(starts).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls[0]![0]).toBe(first.sessionId)
    expect(resume.mock.calls[0]![1]).toContain(`open beside this thread as meeting ${first.itemId}`)
    expect(resume.mock.calls[0]![1]).toContain('His notes:\nDana drives the van.')
    // the page counts the same thread as at work from this press
    expect(await page()).toMatchObject({ followSessionId: first.sessionId, followStartedAt: startedAt + 60_000, notesFile: { kind: 'meeting', itemId: first.itemId } })
  })

  it('says so when the stopped thread cannot be woken, and starts no thread that could not read the recording', async () => {
    const starts = fakeStarts()
    vi.spyOn(rig.work.ctx.threads, 'resume').mockRejectedValue(new Error('the thread is archived'))
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    const before = await page()
    await withMeetings(meetings('ready', null), async () => {
      await expect(rig.rpc('work.prep.followUp', { ...params, restart: true })).rejects.toThrow('The follow-up thread could not be started again (the thread is archived). Open it from More.')
      // nothing moved: the page still names the thread that holds the recording
      expect(await page()).toMatchObject({ followSessionId: first.sessionId, followStartedAt: before.followStartedAt, rev: before.rev, notesFile: { kind: 'meeting', itemId: first.itemId } })
    })
    expect(starts).toHaveBeenCalledTimes(1)
  })

  it('takes a new file in its place once it could not be read, in a thread and a meeting of its own, whatever the clock says', async () => {
    const starts = fakeStarts()
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await withMeetings(meetings('failed', 'The transcriber is not installed on env_box.'), async () => {
      // inside the twenty minutes and with no word from the window: the old thread read the failure, so it is not waited on
      const second = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.vtt' } })
      expect(second.sessionId).not.toBe(first.sessionId)
      expect(second.itemId).toBeTruthy()
      expect(second.itemId).not.toBe(first.itemId)
      // the new thread is not told the old meeting is beside it: prep_read names its own
      const text = starts.mock.calls[1]![0].text
      expect(text).not.toContain(first.itemId!)
      expect(text).toContain('Call prep_read first: it waits until the file has arrived and names the meeting.')
      expect((await page()).doc.notes).toMatchObject({ meetingItemId: second.itemId })
    })
  })

  it('is left behind by a follow-up from typed words once it could not be read: a fresh thread uses his notes, and none is sent to read it again', async () => {
    const starts = fakeStarts()
    const resume = vi.spyOn(rig.work.ctx.threads, 'resume').mockResolvedValue(undefined)
    const first = await rig.rpc<{ sessionId: string; itemId?: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await withMeetings(meetings('failed', 'The transcriber is not installed on env_box.'), async () => {
      // nothing typed: the recording was all the notes there were
      await expect(follow()).rejects.toThrow('Add notes first.')
      await note('Dana drives the van.')
      // typed since: the thread that read the failure is not waited on, with or without the window's word
      const typed = await follow()
      expect(typed.sessionId).not.toBe(first.sessionId)
      expect(starts.mock.calls[1]![0].text).toContain('Use his notes.')
      expect(starts.mock.calls[1]![0].text).not.toContain('meeting_read')
      const got = await page()
      expect(got.doc.notes).toEqual({ text: 'Dana drives the van.', at: expect.any(Number) })
      expect(got).toMatchObject({ notesFile: null, followSessionId: typed.sessionId })
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it('names the notes document kept beside it as the notes, and says what became of the recording', async () => {
    fakeStarts()
    const source = { at: 'file' as const, host: 'box', path: '/tmp/ws-purdue/Staff sync notes.docx' }
    new PrepStore(rig.work.ctx.db).write('ws-purdue', { id: 'ev1', series: 'series1', title: 'Staff sync', startsAt: START, endsAt: null, peopleKeys: [] }, () => ({ people: [], brief: null, notes: null, after: null }), (doc) => ({ ...doc, notes: { text: '', at: 1, file: source } }), START)
    await rig.rpc('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    await withMeetings(meetings('failed', 'The transcriber is not installed on env_box.'), async () => {
      expect((await page()).notesFile).toMatchObject({ kind: 'document', title: 'Staff sync notes.docx', source, error: 'Staff sync.m4a could not be read: The transcriber is not installed on env_box.' })
    })
  })

  it('still counts as notes for a typed follow-up while it holds a file, and no longer once it never got one', async () => {
    const starts = fakeStarts()
    await note('Dana drives the van.')
    const first = await rig.rpc<{ sessionId: string }>('work.prep.followUp', { ...params, recording: { name: 'Staff sync.m4a' } })
    // the file arrived and is being read: a second press answers the thread at work
    await withMeetings(meetings('transcribing', null), async () => {
      expect((await follow()).sessionId).toBe(first.sessionId)
    })
    expect(starts).toHaveBeenCalledTimes(1)
  })
})
