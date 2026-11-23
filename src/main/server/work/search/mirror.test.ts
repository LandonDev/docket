import { afterEach, describe, expect, it } from 'vitest'
import type { SearchReach } from '@shared/work/search'
import type { WorkCtx } from '../modules'
import { search } from './index'
import { makeMirror, mirror, setMirror } from './mirror'
import { listSources, runSearch, tierOf } from './run'
import { event, lifeosSources, openTask, person, task } from './sources/lifeos'
import { COSMIC, everywhere, makeRig, onlyPurdue, PURDUE, window } from './testkit'

/**
 * Answers at once: people, open tasks and events held in memory by live
 * subscriptions while Work is on. Warm, they are found with no call to
 * LifeOS; cold, or once LifeOS is gone, the sources ask LifeOS as before.
 */

const DAY = 86_400_000
/** A LifeOS whose live queries the test feeds: every subscription, with the value it last sent. */
function live(rig: ReturnType<typeof makeRig>) {
  const subs: { fn: string; args: Record<string, unknown>; on(value: unknown): void; off: boolean }[] = []
  const ctx = {
    ...rig.ctx,
    lifeos: {
      ...rig.ctx.lifeos,
      subscribe: (fn: string, args: unknown, on: (value: unknown) => void) => {
        const sub = { fn, args: args as Record<string, unknown>, on, off: false }
        subs.push(sub)
        return () => void (sub.off = true)
      }
    }
  } as unknown as WorkCtx
  const send = (fn: string, value: unknown): void => subs.filter((s) => s.fn === fn && !s.off).forEach((s) => s.on(value))
  return { ctx, subs, send }
}
const ask = (text: string, reach: SearchReach = everywhere, limit = 4) => ({ text, reach, limit, by: window, signal: new AbortController().signal })
const now = Date.now()
const PEOPLE = [
  { _id: 'p1', name: 'Dana Kim', sectors: ['purdue'], identities: [{ kind: 'email', value: 'dana.kim@example.edu' }] },
  { _id: 'p2', name: 'Dana Ref', sectors: ['ref'] }
]
const TASKS = [
  { _id: 't1', sector: 'purdue', title: 'Send the budget to Dana', status: 'todo', key: 'PUR-41', dueAt: now + DAY },
  { _id: 't2', sector: 'cosmic', title: 'Budget the servers', status: 'doing' },
  { _id: 't3', sector: 'life', title: 'Budget the holiday', status: 'todo' }
]
const EVENTS = [
  { _id: 'e1', sector: 'purdue', title: 'Budget review', startsAt: now + 2 * DAY, location: 'Room 120' },
  { _id: 'e2', sector: 'ref', title: 'Budget meeting', startsAt: now + DAY }
]

afterEach(() => setMirror(null))

describe('the mirror', () => {
  it('follows LifeOS by three live queries: people, the open tasks, and the events of the window', () => {
    const rig = makeRig()
    const { ctx, subs } = live(rig)
    const m = makeMirror(ctx, { now: () => 1000 * DAY, every: () => () => {} })
    expect(subs.map((s) => [s.fn, s.args])).toEqual([
      ['people:list', { images: false }],
      ['tasks:list', {}],
      ['events:range', { from: 970 * DAY, to: 1120 * DAY }]
    ])
    m.stop()
  })
  it('is cold until each list arrives, then holds it, and follows every change', () => {
    const rig = makeRig()
    const { ctx, send } = live(rig)
    const m = makeMirror(ctx, { every: () => () => {} })
    expect([m.people(), m.tasks(), m.events()]).toEqual([null, null, null])
    send('people:list', PEOPLE)
    expect(m.people()).toHaveLength(2)
    expect(m.tasks()).toBeNull()
    send('people:list', [PEOPLE[0]])
    expect(m.people()).toHaveLength(1)
    send('tasks:list', TASKS)
    send('events:range', EVENTS)
    expect(m.size()).toEqual({ people: 1, tasks: 3, events: 2 })
    m.stop()
  })
  it('drops what it holds the moment LifeOS is not connected, and fills again from the live queries when it is back', () => {
    const rig = makeRig()
    const { ctx, send } = live(rig)
    let up = true
    ;(ctx.lifeos as { connected(): boolean }).connected = () => up
    const m = makeMirror(ctx, { every: () => () => {} })
    send('people:list', PEOPLE)
    expect(m.people()).toHaveLength(2)
    up = false
    expect(m.people()).toBeNull()
    up = true
    // nothing stale is answered once it is back: cold until LifeOS sends the list again
    expect(m.people()).toBeNull()
    send('people:list', PEOPLE)
    expect(m.people()).toHaveLength(2)
    m.stop()
  })
  it('asks for the events again each day, as the window moves, and lets the old query go', () => {
    const rig = makeRig()
    const { ctx, subs } = live(rig)
    let clock = 1000 * DAY
    let daily: () => void = () => {}
    const m = makeMirror(ctx, { now: () => clock, every: (run, ms) => ((daily = run), expect(ms).toBe(DAY), () => {}) })
    clock += DAY
    daily()
    const events = subs.filter((s) => s.fn === 'events:range')
    expect(events.map((s) => [s.args.from, s.off])).toEqual([
      [970 * DAY, true],
      [971 * DAY, false]
    ])
    m.stop()
  })
  it('stops every live query and forgets what it held', () => {
    const rig = makeRig()
    const { ctx, subs, send } = live(rig)
    const m = makeMirror(ctx, { every: () => () => {} })
    send('people:list', PEOPLE)
    m.stop()
    expect(subs.every((s) => s.off)).toBe(true)
    expect(m.people()).toBeNull()
  })
  it("lives from the module's start to its stop: never while Work is off", () => {
    const rig = makeRig()
    const { ctx, subs } = live(rig)
    expect(mirror()).toBeNull()
    const stop = search.start!(ctx)
    expect(mirror()).not.toBeNull()
    expect(subs).toHaveLength(3)
    stop()
    expect(mirror()).toBeNull()
    expect(subs.every((s) => s.off)).toBe(true)
  })
})

describe('the sources, with the mirror warm', () => {
  const warm = (rig: ReturnType<typeof makeRig>) => {
    const l = live(rig)
    const m = makeMirror(l.ctx, { every: () => () => {} })
    setMirror(m)
    l.send('people:list', PEOPLE)
    l.send('tasks:list', TASKS)
    l.send('events:range', EVENTS)
    return l
  }
  it('answer people, open tasks and events at once, with no call to LifeOS, inside the reach as before', async () => {
    const rig = makeRig()
    const { ctx } = warm(rig)
    expect([tierOf(person, ctx), tierOf(openTask, ctx), tierOf(event, ctx), tierOf(task, ctx)]).toEqual(['instant', 'instant', 'instant', 'network'])
    expect((await person.search(ask('dana'), ctx)).map((h) => [h.key, h.workspaceId])).toEqual([['lifeos:people:p1', PURDUE]])
    expect((await openTask.search(ask('budget'), ctx)).map((h) => [h.key, h.workspaceId])).toEqual([
      ['lifeos:tasks:t1', PURDUE],
      ['lifeos:tasks:t2', COSMIC]
    ])
    expect((await openTask.search(ask('budget', onlyPurdue), ctx)).map((h) => h.key)).toEqual(['lifeos:tasks:t1'])
    expect((await openTask.search(ask('pur-41'), ctx)).map((h) => h.key)).toEqual(['lifeos:tasks:t1'])
    expect((await event.search(ask('budget'), ctx)).map((h) => h.key)).toEqual(['lifeos:events:e1'])
    expect(rig.asked).toEqual([])
  })
  it('are answered in the first, instant call of a search; only the rest is left for the network', async () => {
    const rig = makeRig()
    const { ctx } = warm(rig)
    const answer = await runSearch(ctx, { modules: [], own: lifeosSources, reach: everywhere, text: 'budget', by: window, tier: 'instant' })
    expect(answer.groups.map((g) => [g.source, g.hits.map((h) => h.key)])).toEqual([
      ['search.task/instant', ['lifeos:tasks:t1', 'lifeos:tasks:t2']],
      ['search.event', ['lifeos:events:e1']]
    ])
    expect(answer.pending.map((p) => p.source)).toEqual(['search.mail', 'search.task/network', 'search.doc', 'search.project'])
    expect(rig.asked).toEqual([])
  })
})

describe('the sources, with the mirror cold or lost', () => {
  it('ask LifeOS as before while a list has not arrived', async () => {
    const rig = makeRig()
    const l = live(rig)
    setMirror(makeMirror(l.ctx, { every: () => () => {} }))
    rig.rows['people:list'] = PEOPLE
    rig.rows['events:range'] = EVENTS
    expect([tierOf(person, l.ctx), tierOf(event, l.ctx)]).toEqual(['network', 'network'])
    expect((await person.search(ask('dana'), l.ctx)).map((h) => h.key)).toEqual(['lifeos:people:p1'])
    expect((await event.search(ask('budget'), l.ctx)).map((h) => h.key)).toEqual(['lifeos:events:e1'])
    expect(await openTask.search(ask('budget'), l.ctx)).toEqual([])
    expect(rig.asked.map((a) => a.fn)).toEqual(['people:list', 'events:range'])
    const listed = listSources([], lifeosSources).map((s) => [s.id, tierOf(s.source, l.ctx)])
    expect(listed).toContainEqual(['search.person', 'network'])
  })
  it('ask LifeOS again once the mirror lost it: one list back, the others still to come', async () => {
    const rig = makeRig()
    const l = live(rig)
    let up = true
    ;(l.ctx.lifeos as { connected(): boolean }).connected = () => up
    setMirror(makeMirror(l.ctx, { every: () => () => {} }))
    l.send('people:list', PEOPLE)
    l.send('events:range', EVENTS)
    expect(tierOf(person, l.ctx)).toBe('instant')
    up = false
    expect(tierOf(person, l.ctx)).toBe('network')
    up = true
    l.send('people:list', PEOPLE)
    expect([tierOf(person, l.ctx), tierOf(event, l.ctx)]).toEqual(['instant', 'network'])
  })
  it('with no mirror at all (Work just turned on, a test) every LifeOS kind is asked of LifeOS', async () => {
    const rig = makeRig()
    rig.rows['people:list'] = PEOPLE
    expect(mirror()).toBeNull()
    expect((await person.search(ask('dana'), rig.ctx)).map((h) => h.key)).toEqual(['lifeos:people:p1'])
    expect(await openTask.search(ask('budget'), rig.ctx)).toEqual([])
  })
})
