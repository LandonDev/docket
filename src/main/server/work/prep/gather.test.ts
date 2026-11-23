import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { emptyPrepDoc } from '@shared/contract-work-prep'
import type { WorkCtx } from '../modules'
import { gather, peopleOf, upcoming } from './gather'
import { ensurePrepTables, PrepStore } from './store'
import { FakeLifeos } from './testLifeos'

/**
 * A meeting's facts, read with no model (docs/agents/work-prep.md "The
 * facts"). The host reads LifeOS as the owner, across every sector, so the
 * fence is the gatherer's: what is proved here is that another sector's
 * event, person and task never reach a page.
 */

const NOW = Date.parse('2026-11-23T09:00:00-05:00')
const at = (iso: string): number => Date.parse(iso)

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
  const add = db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)')
  add.run('ws-purdue', 'Purdue', 'work', 'purdue', 1)
  add.run('ws-cosmic', 'Cosmic', 'work', 'cosmic', 2)
  add.run('ws-bare', 'Unlinked', 'work', null, 3)
  add.run('ws-code', 'temp-code', null, null, 4)
  ensurePrepTables(db)
  const lifeos = new FakeLifeos()
  const ctx = { db, host: 'box', log: () => {}, lifeos: { connected: () => lifeos.connected, owner: () => lifeos } } as unknown as WorkCtx
  return { db, ctx, lifeos, store: new PrepStore(db) }
}

/** Purdue's Staff sync with two of its people and one outsider, and Cosmic's rows beside them. Dummy data. */
function world() {
  const s = setup()
  const { lifeos } = s
  lifeos.event({
    _id: 'ev1',
    uid: 'series1@20261123T190000Z',
    location: 'RecWell 204',
    leaveAt: at('2026-11-23T13:40:00-05:00'),
    description: 'Agenda https://example.com/agenda.pdf and https://purdue.zoom.us/j/1',
    attendees: [
      { address: 'Maya@X.test', name: 'Maya C.', response: 'accepted' },
      { address: 'tom@x.test', response: 'declined' },
      { address: 'cory@cosmic.test', name: 'Cory', response: 'needsAction' }
    ]
  })
  lifeos.person({
    _id: 'p-maya',
    name: 'Maya Chen',
    sectors: ['purdue'],
    emails: ['maya@x.test'],
    mail: [
      { _id: 'm-old', sector: 'purdue', subject: 'Spring roster', lastMessageAt: 100 },
      { _id: 'm-new', sector: 'purdue', subject: 'Arena budget', lastMessageAt: 200, unread: true },
      { _id: 'm-far', sector: 'cosmic', subject: 'Cosmic secret', lastMessageAt: 300 }
    ]
  })
  lifeos.person({ _id: 'p-tom', name: 'Tom Beck', sectors: ['purdue'], emails: ['tom@x.test'] })
  // A person of another job: found by address, never one of Purdue's people.
  lifeos.person({ _id: 'p-cory', name: 'Cory of Cosmic', sectors: ['cosmic'], emails: ['cory@cosmic.test'], mail: [{ _id: 'm-cory', sector: 'cosmic', subject: 'Crate values', lastMessageAt: 400 }] })
  lifeos.task({ _id: 't-asked', title: 'Send Maya the roster', askerId: 'p-maya', dueAt: 500 })
  lifeos.task({ _id: 't-waiting', title: 'Quote for chairs', status: 'waiting', waitingOnPersonId: 'p-tom' })
  lifeos.task({ _id: 't-done', title: 'Old ask', status: 'done', askerId: 'p-maya' })
  lifeos.task({ _id: 't-staff', title: 'Staff handbook update' })
  lifeos.task({ _id: 't-staff-done', title: 'Staff party', status: 'done' })
  lifeos.task({ _id: 't-far', sector: 'cosmic', title: 'Staff crate rework', askerId: 'p-cory' })
  return s
}

describe('the fence', () => {
  it('refuses an event of another sector, whatever the window asked', async () => {
    const { ctx, lifeos } = world()
    lifeos.event({ _id: 'ev-cosmic', sector: 'cosmic', title: 'Crate review' })
    await expect(gather(ctx, 'ws-purdue', 'ev-cosmic', NOW)).rejects.toThrow('That event is not in Purdue’s sector.')
    // refused on the event alone: nothing else was read for it
    expect(lifeos.calls.map((c) => c.fn)).toEqual(['events:get'])
    await expect(gather(ctx, 'ws-purdue', 'missing', NOW)).rejects.toThrow('LifeOS has no such event.')
  })

  it('is for a Work workspace linked to a sector, with LifeOS connected', async () => {
    const { ctx, lifeos } = world()
    for (const id of ['ws-bare', 'ws-code', 'nope']) await expect(gather(ctx, id, 'ev1', NOW)).rejects.toThrow('A meeting’s page is for a Work workspace linked to a LifeOS sector.')
    expect(lifeos.calls).toEqual([])
    lifeos.connected = false
    await expect(gather(ctx, 'ws-purdue', 'ev1', NOW)).rejects.toThrow('LifeOS is not connected on this computer.')
  })

  it('asks every sector-taking query for the workspace’s sector, and shows nothing of another’s', async () => {
    const { ctx, lifeos } = world()
    const { page } = await gather(ctx, 'ws-purdue', 'ev1', NOW)
    for (const fn of ['people:page', 'tasks:search']) for (const args of lifeos.called(fn)) expect(args.sector, fn).toBe('purdue')
    const said = JSON.stringify(page)
    for (const far of ['Cory of Cosmic', 'p-cory', 'Crate values', 'Cosmic secret', 'm-far', 'Staff crate rework', 't-far']) expect(said, far).not.toContain(far)
    // the outsider is the event's own name and address, nothing of LifeOS's
    expect(page.people[2]).toEqual({ name: 'Cory', address: 'cory@cosmic.test' })
  })
})

describe('the facts', () => {
  it('reads the people, their newest mail, their tasks, the subject’s tasks and the links', async () => {
    const { ctx } = world()
    const { page } = await gather(ctx, 'ws-purdue', 'ev1', NOW)
    expect(page).toMatchObject({ workspaceId: 'ws-purdue', sector: 'purdue', rev: 0, state: 'none', last: null, problems: [], morePeople: 0, briefSessionId: null, followSessionId: null })
    expect(page.event).toEqual({ id: 'ev1', title: 'Staff sync', startsAt: at('2026-11-23T14:00:00-05:00'), endsAt: at('2026-11-23T14:45:00-05:00'), allDay: false, location: 'RecWell 204', leaveAt: at('2026-11-23T13:40:00-05:00') })
    expect(page.people).toEqual([
      { name: 'Maya Chen', address: 'maya@x.test', personId: 'p-maya', mail: { id: 'm-new', subject: 'Arena budget', at: 200, unread: true } },
      { name: 'Tom Beck', address: 'tom@x.test', personId: 'p-tom', declined: true },
      { name: 'Cory', address: 'cory@cosmic.test' }
    ])
    expect(page.tasks).toEqual([
      { id: 't-asked', title: 'Send Maya the roster', dueAt: 500, why: 'asked', who: 'Maya Chen' },
      { id: 't-waiting', title: 'Quote for chairs', why: 'waiting', who: 'Tom Beck' },
      // "Staff sync" leaves "staff": an open task that names it, with no second line
      { id: 't-staff', title: 'Staff handbook update' }
    ])
    expect(page.files).toEqual([
      { title: 'agenda.pdf', url: 'https://example.com/agenda.pdf' },
      { title: 'Join', url: 'https://purdue.zoom.us/j/1' }
    ])
    expect(page.doc).toEqual(emptyPrepDoc())
  })

  it('writes nothing', async () => {
    const { ctx, db } = world()
    await gather(ctx, 'ws-purdue', 'ev1', NOW)
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_prep_pages').get()).toEqual({ n: 0 })
  })

  it('runs no task search for a title with no subject', async () => {
    const { ctx, lifeos } = world()
    lifeos.event({ _id: 'ev2', title: 'Weekly sync' })
    await gather(ctx, 'ws-purdue', 'ev2', NOW)
    expect(lifeos.called('tasks:search')).toEqual([])
  })

  it('leaves out a part that fails and names it, never the whole page', async () => {
    const { ctx, lifeos } = world()
    lifeos.failing.set('tasks:search', 'search is down')
    lifeos.failing.set('people:page', 'people are down')
    const { page } = await gather(ctx, 'ws-purdue', 'ev1', NOW)
    expect(page.problems.sort()).toEqual(['people', 'tasks'])
    expect(page.people.map((p) => p.name)).toEqual(['Maya C.', 'tom@x.test', 'Cory'])
    expect(page.tasks).toEqual([])
    expect(page.files).toHaveLength(2)
  })
})

describe('the people', () => {
  it('fold by address, the event’s own first, and draw twelve', () => {
    const event = { attendees: [{ address: 'A@x.test', name: 'Ann' }, { address: 'a@x.test', name: 'Ann again' }, { address: 'b@x.test' }] }
    expect(peopleOf(event, [{ name: 'Ann Lee', address: 'a@x.test' }, { name: 'Dana Reyes' }, { name: 'dana  reyes' }, { name: 'Zed', address: 'z@x.test', personId: 'p-z' }])).toEqual([
      { name: 'Ann', address: 'a@x.test' },
      { name: 'b@x.test', address: 'b@x.test' },
      { name: 'Dana Reyes', added: true },
      { name: 'Zed', address: 'z@x.test', personId: 'p-z', added: true }
    ])
  })

  it('counts the people past twelve and asks LifeOS for none of them', async () => {
    const { ctx, lifeos } = setup()
    lifeos.event({ _id: 'big', attendees: Array.from({ length: 15 }, (_, i) => ({ address: `p${i}@x.test`, response: 'accepted' })) })
    const { page } = await gather(ctx, 'ws-purdue', 'big', NOW)
    expect(page.people).toHaveLength(12)
    expect(page.morePeople).toBe(3)
    expect(lifeos.called('people:find')).toHaveLength(12)
  })

  it('an added person the window named by id is still only one of the sector’s people', async () => {
    const { ctx, lifeos, store } = world()
    lifeos.event({ _id: 'solo', title: 'Budget review' })
    store.write('ws-purdue', { id: 'solo', series: null, title: 'Budget review', startsAt: 1, endsAt: null, peopleKeys: [] }, emptyPrepDoc, (doc) => ({ ...doc, people: [{ name: 'Cory', personId: 'p-cory' }, { name: 'Maya', personId: 'p-maya' }] }), NOW)
    const { page } = await gather(ctx, 'ws-purdue', 'solo', NOW)
    expect(page.people).toEqual([
      { name: 'Cory', added: true },
      { name: 'Maya', added: true, personId: 'p-maya', mail: { id: 'm-new', subject: 'Arena budget', at: 200, unread: true } }
    ])
  })
})

describe('last time', () => {
  it('follows the series: its decisions, its open questions and the tasks it filed that are still open', async () => {
    const { ctx, lifeos, store } = world()
    lifeos.task({ _id: 'task-open', title: 'Order jerseys' })
    lifeos.task({ _id: 'task-done', title: 'Book the bus', status: 'done' })
    store.write(
      'ws-purdue',
      { id: 'ev0', series: 'series1', title: 'Staff sync', startsAt: at('2026-11-16T14:00:00-05:00'), endsAt: null, peopleKeys: [] },
      emptyPrepDoc,
      (doc) => ({
        ...doc,
        people: [{ name: 'Dana Reyes', address: 'dana@x.test' }],
        brief: { matters: [], agreed: [], files: [{ title: 'Roster sheet', url: 'https://example.com/roster' }], at: 1, by: 't0' },
        after: {
          summary: [],
          decisions: [{ text: 'Scrims move to Thursdays' }],
          questions: [{ text: 'Who drives to Illinois' }],
          tasks: [
            { id: 's1', title: 'Order jerseys', state: 'filed', lifeosTaskId: 'task-open' },
            { id: 's2', title: 'Book the bus', state: 'filed', lifeosTaskId: 'task-done' },
            { id: 's3', title: 'Never accepted', state: 'proposed' }
          ],
          at: 2
        }
      }),
      NOW
    )
    const { page } = await gather(ctx, 'ws-purdue', 'ev1', NOW)
    expect(page.last).toEqual({
      eventId: 'ev0',
      title: 'Staff sync',
      startsAt: at('2026-11-16T14:00:00-05:00'),
      decided: [{ text: 'Scrims move to Thursdays' }],
      open: [{ text: 'Who drives to Illinois' }],
      tasks: [{ id: 'task-open', title: 'Order jerseys' }]
    })
    // a new page of the series starts with the people he added before, and its files
    expect(page.people.at(-1)).toEqual({ name: 'Dana Reyes', address: 'dana@x.test', added: true })
    expect(page.doc.people).toEqual([{ name: 'Dana Reyes', address: 'dana@x.test' }])
    expect(page.files.at(-1)).toEqual({ title: 'Roster sheet', url: 'https://example.com/roster' })
    // still nothing written for this meeting
    expect(store.get('ws-purdue', 'ev1')).toBeNull()
  })

  it('is not drawn when the page before said nothing', async () => {
    const { ctx, store } = world()
    store.write('ws-purdue', { id: 'ev0', series: 'series1', title: 'Staff sync', startsAt: 5, endsAt: null, peopleKeys: [] }, emptyPrepDoc, (doc) => doc, NOW)
    expect((await gather(ctx, 'ws-purdue', 'ev1', NOW)).page.last).toBeNull()
  })
})

describe('what is coming', () => {
  it('lists timed meetings with someone else on them in this host’s linked workspaces, each with its state', async () => {
    const { ctx, lifeos, store } = world()
    const day = at('2026-11-23T00:00:00-05:00')
    lifeos.event({ _id: 'alone', title: 'Focus time', startsAt: day + 3_600_000 })
    lifeos.event({ _id: 'allday', title: 'Conference', allDay: true, attendees: [{ address: 'maya@x.test' }], startsAt: day })
    lifeos.event({ _id: 'hidden', title: 'Hidden', hidden: true, attendees: [{ address: 'maya@x.test' }], startsAt: day + 2 * 3_600_000 })
    lifeos.event({ _id: 'cosmic1', sector: 'cosmic', title: 'Crate review', startsAt: day + 10 * 3_600_000, endsAt: undefined, attendees: [{ address: 'cory@cosmic.test', name: 'Cory' }] })
    // a sector with no workspace on this host is another host's to list
    lifeos.event({ _id: 'ref1', sector: 'ref', title: 'Crew call', startsAt: day + 11 * 3_600_000, attendees: [{ address: 'ump@x.test' }] })
    // no attendees on the feed, but he added someone to the series before
    lifeos.event({ _id: 'added1', title: 'Budget review', uid: 'bud@20261123T210000Z', startsAt: day + 16 * 3_600_000, endsAt: day + 17 * 3_600_000 })
    store.write('ws-purdue', { id: 'added0', series: 'bud', title: 'Budget review', startsAt: day - 7 * 86_400_000, endsAt: null, peopleKeys: [] }, emptyPrepDoc, (doc) => ({ ...doc, people: [{ name: 'Dana Reyes' }] }), NOW)
    store.write('ws-purdue', { id: 'ev1', series: 'series1', title: 'Staff sync', startsAt: at('2026-11-23T14:00:00-05:00'), endsAt: null, peopleKeys: [] }, emptyPrepDoc, (doc) => ({ ...doc, brief: { matters: [{ text: 'x' }], agreed: [], files: [], at: 1, by: 't' } }), NOW)

    const meetings = await upcoming(ctx, day, day + 86_400_000, NOW)
    expect(meetings).toEqual([
      { workspaceId: 'ws-cosmic', sector: 'cosmic', eventId: 'cosmic1', title: 'Crate review', startsAt: day + 10 * 3_600_000, endsAt: day + 11 * 3_600_000, with: ['Cory'], state: 'none' },
      { workspaceId: 'ws-purdue', sector: 'purdue', eventId: 'ev1', title: 'Staff sync', startsAt: at('2026-11-23T14:00:00-05:00'), endsAt: at('2026-11-23T14:45:00-05:00'), with: ['Maya C.', 'tom@x.test', 'Cory'], state: 'briefed' },
      { workspaceId: 'ws-purdue', sector: 'purdue', eventId: 'added1', title: 'Budget review', startsAt: day + 16 * 3_600_000, endsAt: day + 17 * 3_600_000, with: ['Dana Reyes'], state: 'none' }
    ])
    // one read of LifeOS, no query per person
    expect(lifeos.calls.map((c) => c.fn)).toEqual(['events:range'])
  })
})
