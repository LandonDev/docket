import { describe, expect, it } from 'vitest'
import type { SearchReach } from '@shared/work/search'
import { tierOf } from '../run'
import { COSMIC, everywhere, makeRig, onlyPurdue, PURDUE, window } from '../testkit'
import { doc, event, EVENTS_AHEAD_DAYS, EVENTS_BACK_DAYS, eventsInOrder, eventsWindow, lifeosSources, mail, person, project, task, taskKeysIn } from './lifeos'

/**
 * LifeOS's kinds, against a LifeOS in memory with made-up rows of three
 * sectors: each kind is found, stamped with the job of its sector, and a
 * row of a sector outside the reach never comes back, whatever LifeOS
 * answered.
 */

const ask = (text: string, reach: SearchReach = everywhere, limit = 4) => ({ text, reach, limit, by: window, signal: new AbortController().signal })
const DAY = 86_400_000

describe('people', () => {
  const rows = [
    { _id: 'p1', name: 'Dana Kim', sectors: ['purdue'], notes: 'Finance lead', identities: [{ kind: 'email', value: 'dana.kim@example.edu' }] },
    { _id: 'p2', name: 'Sam Ortiz', sectors: ['cosmic', 'purdue'], identities: [{ kind: 'slack', value: 'U1', email: 'sam@cosmic.example' }] },
    { _id: 'p3', name: 'Dana Ref', sectors: ['ref'], identities: [{ kind: 'email', value: 'dana@ref.example' }] }
  ]
  it('are found by a name, in the job one of their sectors is, opened in People', async () => {
    const rig = makeRig()
    rig.rows['people:list'] = rows
    const hits = await person.search(ask('dana'), rig.ctx)
    expect(hits).toEqual([
      {
        key: 'lifeos:people:p1',
        kind: 'person',
        title: 'Dana Kim',
        detail: 'dana.kim@example.edu',
        workspaceId: PURDUE,
        open: { to: 'view', view: 'people', with: { person: 'p1' } },
        chip: { kind: 'person', label: 'Dana Kim', ref: { at: 'lifeos', table: 'people', id: 'p1' }, excerpt: 'Finance lead' }
      }
    ])
    expect(rig.asked).toEqual([{ fn: 'people:list', args: { images: false } }])
  })
  it('are found by an address as well as a name', async () => {
    const rig = makeRig()
    rig.rows['people:list'] = rows
    expect((await person.search(ask('cosmic.example'), rig.ctx)).map((h) => h.title)).toEqual(['Sam Ortiz'])
    expect((await person.search(ask('dana.kim@example'), rig.ctx)).map((h) => h.title)).toEqual(['Dana Kim'])
  })
  it('of a sector outside the reach never come back, and one in two sectors stands in the job in reach', async () => {
    const rig = makeRig()
    rig.rows['people:list'] = rows
    expect((await person.search(ask('dana'), rig.ctx)).map((h) => h.key)).not.toContain('lifeos:people:p3')
    const cosmicOnly: SearchReach = { workspaces: [everywhere.workspaces[1]], chats: false, sessionId: null }
    expect((await person.search(ask('sam', cosmicOnly), rig.ctx)).map((h) => h.workspaceId)).toEqual([COSMIC])
    expect(await person.search(ask('dana', cosmicOnly), rig.ctx)).toEqual([])
  })
})

describe('mail', () => {
  const rows = [
    { _id: 'm1', sector: 'purdue', subject: 'Budget for the spring LAN', snippet: 'Here are the numbers', senders: ['Dana Kim'], lastMessageAt: 50 },
    { _id: 'm2', sector: 'cosmic', subject: 'Server costs', snippet: 'the budget went over in March', senders: ['Ops'], lastMessageAt: 40 },
    { _id: 'm3', sector: 'ref', subject: 'Budget for whistles', senders: ['League'], lastMessageAt: 30 }
  ]
  it("is LifeOS's own search asked once, each thread in the job of its sector, opened in Mail", async () => {
    const rig = makeRig()
    rig.rows['mail:search'] = rows
    const hits = await mail.search(ask('budget'), rig.ctx)
    expect(rig.asked).toEqual([{ fn: 'mail:search', args: { text: 'budget' } }])
    expect(hits.map((h) => [h.key, h.workspaceId, h.detail, h.at])).toEqual([
      ['lifeos:mailThreads:m1', PURDUE, 'Dana Kim', 50],
      ['lifeos:mailThreads:m2', COSMIC, 'Ops', 40]
    ])
    expect(hits[0].open).toEqual({ to: 'view', view: 'mail', with: { mail: 'm1' } })
    expect(hits[0].chip).toMatchObject({ kind: 'mail', ref: { at: 'lifeos', table: 'mailThreads', id: 'm1' } })
  })
  it('carries the line the words are in only when the subject and sender do not hold them', async () => {
    const rig = makeRig()
    rig.rows['mail:search'] = rows
    const [bySubject, byBody] = await mail.search(ask('budget'), rig.ctx)
    expect(bySubject.snippet).toBeUndefined()
    expect(byBody.snippet).toBe('the budget went over in March')
  })
  it('of a sector outside the reach never comes back', async () => {
    const rig = makeRig()
    rig.rows['mail:search'] = rows
    expect((await mail.search(ask('budget', onlyPurdue), rig.ctx)).map((h) => h.key)).toEqual(['lifeos:mailThreads:m1'])
    expect((await mail.search(ask('budget'), rig.ctx)).map((h) => h.key)).not.toContain('lifeos:mailThreads:m3')
  })
  it('names a mail with no subject', async () => {
    const rig = makeRig()
    rig.rows['mail:search'] = [{ _id: 'm9', sector: 'purdue', subject: '' }]
    expect((await mail.search(ask('x'), rig.ctx))[0].title).toBe('(no subject)')
  })
})

describe('tasks', () => {
  const found = [
    { _id: 't1', sector: 'purdue', title: 'Send the budget to Dana', dueAt: 900, status: 'todo', key: 'PUR-7' },
    { _id: 't2', sector: 'cosmic', title: 'Budget the servers', status: 'done' },
    { _id: 't3', sector: 'life', title: 'Budget the holiday' }
  ]
  it("are LifeOS's ranking of the titles, each in the job of its sector, opened in Tasks", async () => {
    const rig = makeRig()
    rig.rows['tasks:search'] = found
    const hits = await task.search(ask('budget'), rig.ctx)
    expect(rig.asked).toEqual([{ fn: 'tasks:search', args: { text: 'budget' } }])
    expect(hits.map((h) => [h.key, h.workspaceId, h.detail, h.at])).toEqual([
      ['lifeos:tasks:t1', PURDUE, 'PUR-7', 900],
      ['lifeos:tasks:t2', COSMIC, 'Done', undefined]
    ])
    expect(hits[0].open).toEqual({ to: 'view', view: 'tasks', with: { task: 't1' } })
  })
  it('asks LifeOS for the one sector when the reach is one job', async () => {
    const rig = makeRig()
    rig.rows['tasks:search'] = found
    const hits = await task.search(ask('budget', onlyPurdue), rig.ctx)
    expect(rig.asked).toEqual([{ fn: 'tasks:search', args: { text: 'budget', sector: 'purdue' } }])
    // LifeOS answered other sectors' rows all the same: the reach is the fence here
    expect(hits.map((h) => h.key)).toEqual(['lifeos:tasks:t1'])
  })
  it('a key he typed is found first, and shown once', async () => {
    const rig = makeRig()
    rig.rows['tasks:byKeys'] = [{ _id: 't41', sector: 'purdue', title: 'Order the jerseys', key: 'PUR-41' }]
    rig.rows['tasks:search'] = [found[0], { _id: 't41', sector: 'purdue', title: 'Order the jerseys', key: 'PUR-41' }]
    const hits = await task.search(ask('pur-41'), rig.ctx)
    expect(rig.asked.map((a) => [a.fn, a.args])).toEqual([
      ['tasks:byKeys', { keys: ['pur-41'] }],
      ['tasks:search', { text: 'pur-41' }]
    ])
    expect(hits.map((h) => h.key)).toEqual(['lifeos:tasks:t41', 'lifeos:tasks:t1'])
    expect(taskKeysIn('see PUR-41 and x-1 and COS-9000')).toEqual(['PUR-41', 'COS-9000'])
    expect(taskKeysIn('budget')).toEqual([])
  })
  it('a task found by its key in a sector outside the reach never comes back', async () => {
    const rig = makeRig()
    rig.rows['tasks:byKeys'] = [{ _id: 'r1', sector: 'ref', title: 'Renew the licence', key: 'REF-3' }]
    rig.rows['tasks:search'] = []
    expect(await task.search(ask('REF-3'), rig.ctx)).toEqual([])
  })
})

describe('events', () => {
  const now = Date.now()
  const rows = [
    { _id: 'e1', sector: 'purdue', title: 'Budget review', startsAt: now + 3 * DAY, location: 'Córdova 120' },
    { _id: 'e2', sector: 'purdue', title: 'Budget kickoff', startsAt: now - 2 * DAY },
    { _id: 'e3', sector: 'cosmic', title: 'Standup', startsAt: now + DAY, location: 'Budget room' },
    { _id: 'e4', sector: 'ref', title: 'Budget meeting', startsAt: now + DAY }
  ]
  it('are found by a title or a place in a window of two constants, what is coming first, opened in Agenda', async () => {
    const rig = makeRig()
    rig.rows['events:range'] = rows
    const hits = await event.search(ask('budget'), rig.ctx)
    expect(hits.map((h) => [h.key, h.workspaceId])).toEqual([
      ['lifeos:events:e3', COSMIC],
      ['lifeos:events:e1', PURDUE],
      ['lifeos:events:e2', PURDUE]
    ])
    expect(hits[1]).toMatchObject({ detail: 'Córdova 120', at: rows[0].startsAt, open: { to: 'view', view: 'agenda', with: { event: 'e1' } } })
    const { from, to } = rig.asked[0].args as { from: number; to: number }
    expect(rig.asked[0].fn).toBe('events:range')
    expect(Math.round((now - from) / DAY)).toBe(EVENTS_BACK_DAYS)
    expect(Math.round((to - now) / DAY)).toBe(EVENTS_AHEAD_DAYS)
    expect([EVENTS_BACK_DAYS, EVENTS_AHEAD_DAYS]).toEqual([30, 120])
    expect(eventsWindow(1000 * DAY)).toEqual({ from: 970 * DAY, to: 1120 * DAY })
  })
  it('are found by a place with its accents aside', async () => {
    const rig = makeRig()
    rig.rows['events:range'] = rows
    expect((await event.search(ask('cordova'), rig.ctx)).map((h) => h.key)).toEqual(['lifeos:events:e1'])
  })
  it('of a sector outside the reach never come back', async () => {
    const rig = makeRig()
    rig.rows['events:range'] = rows
    expect((await event.search(ask('budget', onlyPurdue), rig.ctx)).map((h) => h.key)).toEqual(['lifeos:events:e1', 'lifeos:events:e2'])
    expect(rig.asked[0].args).toMatchObject({ sector: 'purdue' })
  })
  it('order what is coming soonest first, then what has passed latest first', () => {
    const at = (id: string, d: number) => ({ _id: id, title: id, startsAt: now + d * DAY })
    expect(eventsInOrder([at('past2', -5), at('next2', 9), at('past1', -1), at('next1', 2)], now).map((e) => e._id)).toEqual(['next1', 'next2', 'past1', 'past2'])
  })
})

describe('documents', () => {
  const lifeos = (rig: ReturnType<typeof makeRig>): void => {
    rig.rows['docs:list'] = (a: Record<string, unknown>) => ({
      page: a.sector === 'purdue' ? [{ _id: 'd1', sector: 'purdue', title: 'Budget FY27', editedAt: 9 }, { _id: 'd2', sector: 'purdue', title: 'Run of show', editedAt: 8 }] : [{ _id: 'd5', sector: 'cosmic', title: 'Roadmap', editedAt: 7 }]
    })
    rig.rows['catalog:search'] = (a: Record<string, unknown>) =>
      a.sector === 'purdue'
        ? [{ table: 'docs', id: 'd1', snippet: 'the budget for FY27' }, { table: 'docs', id: 'd2', snippet: '…a budget line for pizza…' }, { table: 'docs', id: 'd9', snippet: '…old budget notes…' }]
        : [{ table: 'sheets', id: 's1', snippet: 'budget' }]
    rig.rows['docs:get'] = (a: Record<string, unknown>) => (a.id === 'd9' ? { title: 'Archive 2024' } : null)
  }
  it('are found by a title first, then by their text with its line, a sector at a time, opened in Docs', async () => {
    const rig = makeRig()
    lifeos(rig)
    const hits = await doc.search(ask('budget'), rig.ctx)
    expect(hits.map((h) => [h.key, h.title, h.snippet, h.workspaceId])).toEqual([
      ['lifeos:docs:d1', 'Budget FY27', undefined, PURDUE],
      ['lifeos:docs:d2', 'Run of show', '…a budget line for pizza…', PURDUE],
      ['lifeos:docs:d9', 'Archive 2024', '…old budget notes…', PURDUE]
    ])
    expect(hits[0].open).toEqual({ to: 'view', view: 'docs', with: { doc: { id: 'd1', title: 'Budget FY27' } } })
    expect(hits[0].chip).toEqual({ kind: 'doc', label: 'Budget FY27', ref: { at: 'lifeos', table: 'docs', id: 'd1' } })
    // one catalog search and one page of titles a sector in reach, and the one title that was not in a page
    expect(rig.asked.map((a) => `${a.fn}:${a.args.sector ?? a.args.id}`).sort()).toEqual(['catalog:search:cosmic', 'catalog:search:purdue', 'docs:get:d9', 'docs:list:cosmic', 'docs:list:purdue'])
  })
  it('of a sector outside the reach are never asked for', async () => {
    const rig = makeRig()
    lifeos(rig)
    // Cosmic holds a document called Roadmap; a search from Purdue alone never asks Cosmic for it.
    rig.rows['catalog:search'] = () => []
    const hits = await doc.search(ask('roadmap', onlyPurdue), rig.ctx)
    expect(hits).toEqual([])
    expect(rig.asked.map((a) => [a.fn, a.args.sector])).toEqual(expect.arrayContaining([['docs:list', 'purdue'], ['catalog:search', 'purdue']]))
    expect(rig.asked.some((a) => a.args.sector === 'cosmic')).toBe(false)
  })
})

describe('projects', () => {
  const rows = [
    { _id: 'j1', sector: 'purdue', name: 'Spring LAN', description: 'The budget and the venue' },
    { _id: 'j2', sector: 'cosmic', name: 'Budget tooling' },
    { _id: 'j3', sector: 'unify', name: 'Budget app' }
  ]
  it('are found by a name or a description, each in the job of its sector, opened in Projects', async () => {
    const rig = makeRig()
    rig.rows['projects:list'] = rows
    const hits = await project.search(ask('budget'), rig.ctx)
    expect(hits.map((h) => [h.key, h.title, h.workspaceId])).toEqual([
      ['lifeos:projects:j1', 'Spring LAN', PURDUE],
      ['lifeos:projects:j2', 'Budget tooling', COSMIC]
    ])
    expect(hits[0].open).toEqual({ to: 'view', view: 'projects', with: { project: 'j1' } })
  })
  it('of a sector outside the reach never come back', async () => {
    const rig = makeRig()
    rig.rows['projects:list'] = rows
    expect((await project.search(ask('budget', onlyPurdue), rig.ctx)).map((h) => h.key)).toEqual(['lifeos:projects:j1'])
  })
})

describe('every LifeOS kind', () => {
  it('is read from LifeOS over the network while nothing is mirrored, and asks nothing for a reach with no sector', async () => {
    const rig = makeRig()
    const bare: SearchReach = { workspaces: [everywhere.workspaces[2]], chats: true, sessionId: null }
    for (const source of lifeosSources) {
      expect(source.lifeos, source.kind).toBe(true)
      expect(await source.search(ask('budget', bare), rig.ctx)).toEqual([])
    }
    expect(rig.asked).toEqual([])
    expect(lifeosSources.map((s) => [s.kind, tierOf(s, rig.ctx)])).toEqual([
      ['person', 'network'],
      ['mail', 'network'],
      // the open tasks the mirror holds; nothing while it is cold
      ['task', 'instant'],
      ['task', 'network'],
      ['event', 'network'],
      ['doc', 'network'],
      ['project', 'network']
    ])
  })
  it('answers one more than the limit, so the frame can say there are more', async () => {
    const rig = makeRig()
    rig.rows['mail:search'] = Array.from({ length: 20 }, (_, i) => ({ _id: `m${i}`, sector: 'purdue', subject: `Budget ${i}` }))
    expect(await mail.search(ask('budget', everywhere, 4), rig.ctx)).toHaveLength(5)
  })
})
