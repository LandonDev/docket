import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { followedUp, meetingsSlipped, preppedAfter } from '../followup'
import { setMark } from '../store'
import { DAY, docItem, held, HOUR, makeRig, MIN, MON, TZ, WEEK, type Rig } from '../testkit'
import { eventsBetween, ownAddresses, toEvent } from './calendar'
import { jobsOf, type Asked } from './common'
import { DOCS_MOST, fileFacts, isHim } from './files'
import { heldFacts } from './held'
import { answeredBetween, sentBetween, waitingPast } from './mail'
import { doneBetween, pastDue } from './tasks'

/** Each source of the weekly review against a stand-in: what it asks for, what it keeps, and what it leaves out. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  // Each made-up LifeOS document is of the sector of the workspace it is open in.
  rig.lifeos['docs:get'] = (a: { id: string }) => ({ sector: a.id === 'd2' ? 'cosmic' : 'purdue' })
})
afterEach(() => rig.close())

const asked = (over: Partial<Asked> = {}): Asked => ({ from: WEEK.from, to: WEEK.to, tz: TZ, now: WEEK.to + HOUR, cut: WEEK.to, before: { from: WEEK.from - 7 * DAY, to: WEEK.to - 7 * DAY }, ...over })
const owner = () => rig.ctx.lifeos.owner()
const event = (id: string, o: Record<string, unknown> = {}) => ({ _id: id, sector: 'purdue', title: 'Budget review', startsAt: MON + 14 * HOUR, endsAt: MON + 15 * HOUR, allDay: false, ...o })

describe('the calendar', () => {
  it('names the others on an event, his own addresses left out', async () => {
    rig.lifeos['mail:accounts'] = [{ address: 'Him@Example.edu', identities: [{ address: 'alias@example.edu' }] }]
    const self = await ownAddresses(owner())
    expect([...self]).toEqual(['him@example.edu', 'alias@example.edu'])
    const e = toEvent(event('e1', { attendees: [{ address: 'him@example.edu', name: 'Him' }, { address: 'ALIAS@example.edu' }, { address: 'Dana@Example.edu', name: 'Dana Reyes' }, { address: 'sam@example.edu' }], myResponse: 'declined', hidden: true }) as never, self)
    expect(e).toMatchObject({ id: 'e1', people: ['Dana Reyes', 'sam@example.edu'], others: 2, addresses: ['dana@example.edu', 'sam@example.edu'], declined: true, hidden: true, endsAt: MON + 15 * HOUR })
  })

  it('asks a week early and keeps what still ran into the span, a timed event of days included', async () => {
    rig.lifeos['events:range'] = [
      event('ended', { startsAt: WEEK.from - 3 * HOUR, endsAt: WEEK.from - HOUR }),
      event('ran-in', { startsAt: WEEK.from - HOUR, endsAt: WEEK.from + HOUR }),
      // Saturday to Monday noon: begun more than a day before the week, and still its Monday morning.
      event('trip', { startsAt: WEEK.from - 2 * DAY, endsAt: WEEK.from + 12 * HOUR }),
      event('in'),
      event('cosmic', { sector: 'cosmic' })
    ]
    const got = await eventsBetween(owner(), WEEK.from, WEEK.to, new Set(), asked())
    expect(rig.calls.at(-1)).toEqual({ fn: 'events:range', args: { from: WEEK.from - 7 * DAY, to: WEEK.to } })
    expect(got.map((e) => e.id)).toEqual(['ran-in', 'trip', 'in', 'cosmic'])
    // A thread's tool reads its own sector alone.
    expect((await eventsBetween(owner(), WEEK.from, WEEK.to, new Set(), asked({ only: 'cosmic' }))).map((e) => e.id)).toEqual(['cosmic'])
    expect(await eventsBetween(owner(), WEEK.from, WEEK.to, new Set(), asked({ only: null }))).toEqual([])
  })
})

describe('tasks', () => {
  it('reads what he finished in the week and what is past due and open', async () => {
    rig.lifeos['review:doneBetween'] = [{ id: 'k1', title: 'Order the new jerseys', sector: 'purdue', completedAt: MON + HOUR }, { id: 'k2', title: 'Fix the crate drop rates', sector: 'cosmic', completedAt: MON + 2 * HOUR }]
    rig.lifeos['tasks:due'] = [{ _id: 'k3', title: 'Send the thumbnail drafts', sector: 'hypixel', dueAt: MON + DAY }, { _id: 'k4', title: 'No date', sector: 'purdue' }]
    expect(await doneBetween(owner(), WEEK.from, WEEK.to, asked())).toEqual([
      { id: 'k1', title: 'Order the new jerseys', at: MON + HOUR, sector: 'purdue' },
      { id: 'k2', title: 'Fix the crate drop rates', at: MON + 2 * HOUR, sector: 'cosmic' }
    ])
    expect(rig.calls.at(-1)).toEqual({ fn: 'review:doneBetween', args: { from: WEEK.from, to: WEEK.to } })
    const due = await pastDue(owner(), WEEK.to, asked())
    expect(rig.calls.at(-1)).toEqual({ fn: 'tasks:due', args: { before: WEEK.to } })
    expect(due).toEqual([{ key: 'task:k3', ref: { kind: 'task', id: 'k3', dueAt: MON + DAY }, sector: 'hypixel', workspaceId: null, title: 'Send the thumbnail drafts', at: MON + DAY, people: [], others: 0, open: true }])
    expect(await pastDue(owner(), WEEK.to, asked({ only: 'purdue' }))).toEqual([])
  })
})

describe('mail', () => {
  it('reads what he sent and which of his mails were answered', async () => {
    rig.lifeos['review:sentBetween'] = [{ id: 'm1', threadId: 't1', subject: 'Spring travel roster', to: [{ name: 'Dana Reyes', address: 'Dana@Example.edu' }, { address: 'sam@example.edu' }], sentAt: MON + HOUR, sector: 'purdue' }]
    rig.lifeos['review:answeredBetween'] = { rows: [{ threadId: 't2', subject: 'Field trip forms', sector: 'purdue', since: MON, answeredAt: MON + 2 * HOUR, by: 'Dana Reyes' }], answeredSince: MON - DAY }
    expect(await sentBetween(owner(), WEEK.from, WEEK.to, asked())).toEqual([{ id: 'm1', threadId: 't1', subject: 'Spring travel roster', to: ['Dana Reyes', 'sam@example.edu'], addresses: ['dana@example.edu', 'sam@example.edu'], at: MON + HOUR, sector: 'purdue' }])
    expect(await answeredBetween(owner(), WEEK.from, WEEK.to, asked())).toEqual({ rows: [{ threadId: 't2', subject: 'Field trip forms', by: 'Dana Reyes', at: MON + 2 * HOUR, sector: 'purdue' }], answeredSince: MON - DAY })
    // An empty span asks nothing.
    const calls = rig.calls.length
    expect(await sentBetween(owner(), WEEK.to, WEEK.to, asked())).toEqual([])
    expect(rig.calls).toHaveLength(calls)
  })

  it('pages the Waiting on mailbox and keeps the mails past their time by the cut', async () => {
    const wait = (id: string, dueAt: number, sector = 'hypixel') => ({ _id: id, subject: 'Winter video schedule', sector, waiting: { since: MON - 4 * DAY, dueAt, to: [{ name: 'Sam Lindqvist', address: 'sam@example.com' }] } })
    rig.lifeos['mailWaits:list'] = (args: { paginationOpts: { cursor: string | null } }) => (args.paginationOpts.cursor === null ? { page: [wait('t1', MON + DAY), wait('late', WEEK.to + DAY)], isDone: false, continueCursor: 'c2' } : { page: [wait('t2', MON + 2 * DAY, 'purdue')], isDone: true, continueCursor: '' })
    const got = await waitingPast(owner(), WEEK.to, asked())
    const since = MON - 4 * DAY
    expect(got.part).toBe(false)
    expect(got.rows.map((r) => r.key)).toEqual([`mail:t1:${since}`, `mail:t2:${since}`])
    expect(got.rows[0]).toEqual({ key: `mail:t1:${since}`, ref: { kind: 'mail', threadId: 't1', since }, sector: 'hypixel', workspaceId: null, title: 'Winter video schedule', at: since, people: ['Sam Lindqvist'], others: 1, open: true })
    expect((await waitingPast(owner(), WEEK.to, asked({ only: 'purdue' }))).rows.map((r) => r.key)).toEqual([`mail:t2:${since}`])
  })

  it('says it read in part when the last page it reads is not the end', async () => {
    rig.lifeos['mailWaits:list'] = (args: { paginationOpts: { cursor: string | null } }) => ({ page: [{ _id: `t-${args.paginationOpts.cursor ?? 0}`, sector: 'purdue', waiting: { since: MON, dueAt: MON + DAY } }], isDone: false, continueCursor: `${Number(args.paginationOpts.cursor ?? 0) + 1}` })
    const got = await waitingPast(owner(), WEEK.to, asked())
    expect(got.rows).toHaveLength(3)
    expect(got.part).toBe(true)
  })

  it('keys a wait by its thread and when it began: a newer wait on the thread is another row', async () => {
    const wait = (since: number) => ({ _id: 't1', sector: 'purdue', waiting: { since, dueAt: since + DAY } })
    rig.lifeos['mailWaits:list'] = { page: [wait(MON)], isDone: true, continueCursor: '' }
    const first = (await waitingPast(owner(), WEEK.to, asked())).rows[0]!.key
    rig.lifeos['mailWaits:list'] = { page: [wait(MON + 2 * DAY)], isDone: true, continueCursor: '' }
    expect((await waitingPast(owner(), WEEK.to, asked())).rows[0]!.key).not.toBe(first)
  })
})

describe('held items', () => {
  it('lists one that has waited a day, and none he marked for next week', async () => {
    rig.outbox.waiting = [held('old', { createdAt: WEEK.to - 2 * DAY }), held('fresh', { createdAt: WEEK.to - HOUR }), held('marked', { createdAt: WEEK.to - 3 * DAY }), held('sending', { createdAt: WEEK.to - 3 * DAY, state: 'sending' }), held('failed', { createdAt: WEEK.to - 3 * DAY, state: 'failed' }), held('lo', { ref: { at: 'lifeos', table: 'outbox', id: 'd1' }, workspaceId: null, sector: 'cosmic', createdAt: WEEK.to - 2 * DAY })]
    const got = await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set(['held:host:marked']))
    expect(got.slipped.map((r) => r.key)).toEqual(['held:host:old', 'held:host:failed', 'held:lifeos:outbox:d1'])
    expect(got.slipped[0]).toMatchObject({ ref: { kind: 'held', ref: { at: 'host', id: 'old' } }, workspaceId: 'w-purdue', sector: 'purdue', title: 'Post the bracket to #esports', at: WEEK.to - 2 * DAY })
    expect(rig.moduleCalls.map((c) => [c.method, c.params])).toEqual([
      ['work.outbox.list', { show: 'waiting', limit: 500 }],
      ['work.outbox.list', { show: 'decided', limit: 500 }]
    ])
  })

  it('counts each of his presses as a point, and lists what went out on his press, a mail left to the mail', async () => {
    const pressed = (id: string, o: Record<string, unknown>) => held(id, { state: 'sent', decidedBy: 'owner', decidedAt: MON + HOUR, ...o })
    rig.outbox.decided = [
      pressed('post', {}),
      pressed('mail', { kind: 'mail.send', decidedAt: MON + 2 * HOUR }),
      pressed('remote', { decidedBy: 'owner:remote', decidedAt: MON + 3 * HOUR, workspaceId: 'w-cosmic', sector: 'cosmic' }),
      pressed('granted', { decidedBy: 'grant:g1', decidedAt: MON + 4 * HOUR }),
      pressed('discarded', { state: 'discarded', decidedAt: MON + 5 * HOUR }),
      pressed('last-week', { decidedAt: MON - 6 * DAY }),
      pressed('chat', { workspaceId: null, sector: null, decidedAt: MON + 6 * HOUR })
    ]
    const got = await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())
    expect(got.points).toEqual([
      [MON + HOUR, 0, 'pressed'],
      [MON + 2 * HOUR, 0, 'pressed'],
      [MON + 3 * HOUR, 1, 'pressed'],
      [MON + 5 * HOUR, 0, 'pressed']
    ])
    expect(got.before).toEqual([[MON - 6 * DAY, 0, 'pressed']])
    expect(got.shipped.map((s) => [s.key, s.kind, s.title])).toEqual([
      ['held:host:post', 'approved', 'Post the bracket to #esports'],
      ['held:host:remote', 'approved', 'Post the bracket to #esports']
    ])
  })

  it('reads one job alone for a thread’s tool', async () => {
    rig.outbox.waiting = [held('p', { createdAt: MON }), held('c', { createdAt: MON, workspaceId: 'w-cosmic', sector: 'cosmic' })]
    const got = await heldFacts(rig.ctx, asked({ only: 'cosmic' }), jobsOf(rig.db, { workspaceId: 'w-cosmic' }), new Set())
    expect(got.slipped.map((r) => r.key)).toEqual(['held:host:c'])
  })

  it('files an item by its own sector when it names another job’s workspace, so Purdue’s tool never sees a Cosmic item', async () => {
    // Made in Purdue's workspace, its LifeOS item since moved to Cosmic.
    const moved = { workspaceId: 'w-purdue', sector: 'cosmic' as const, summary: 'Post the patch notes' }
    rig.outbox.waiting = [held('moved', { createdAt: MON, ...moved })]
    rig.outbox.decided = [held('pressed', { state: 'sent', decidedBy: 'owner', decidedAt: MON + HOUR, ...moved })]
    const purdue = await heldFacts(rig.ctx, asked({ only: 'purdue' }), jobsOf(rig.db, { workspaceId: 'w-purdue' }), new Set())
    expect(purdue).toMatchObject({ slipped: [], shipped: [], points: [] })
    // On the page it is Cosmic's: its point counts for Cosmic's job.
    const all = await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())
    expect(all.points).toEqual([[MON + HOUR, 1, 'pressed']])
  })

  it('says it read in part when a list comes back full at its cap', async () => {
    const many = (n: number, o: Record<string, unknown>) => Array.from({ length: n }, (_, i) => held(`h${i}`, o))
    expect((await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())).part).toBe(false)
    rig.outbox.waiting = many(500, { createdAt: MON })
    expect((await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())).part).toBe(true)
    rig.outbox.waiting = []
    // The newest 500 decided, all after the span began: older ones of the span may be past the cut.
    rig.outbox.decided = many(500, { state: 'sent', decidedBy: 'owner', decidedAt: MON + HOUR, updatedAt: MON + HOUR })
    expect((await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())).part).toBe(true)
    // One of them reaches back before the span: the list holds the whole span.
    rig.outbox.decided.push(held('old', { state: 'sent', decidedBy: 'owner', decidedAt: MON - 30 * DAY, updatedAt: MON - 30 * DAY }))
    expect((await heldFacts(rig.ctx, asked(), jobsOf(rig.db), new Set())).part).toBe(false)
  })
})

describe('documents he changed', () => {
  it('counts a version he wrote into, in the week or the week before, and never an agent’s', async () => {
    expect(['owner', 'lifeos:desktop', 'lifeos:bot:x', 'agent:box:t1', 'guest:g', 'external:Word'].map(isHim)).toEqual([true, true, false, false, false, false])
    rig.items.set('w-purdue', [docItem('d1', 'w-purdue', MON + HOUR), docItem('stale', 'w-purdue', MON - 30 * DAY)])
    rig.items.set('w-cosmic', [docItem('d2', 'w-cosmic', MON + HOUR)])
    rig.versions.set(JSON.stringify({ at: 'lifeos', table: 'docs', id: 'd1' }), [{ at: MON + HOUR, by: ['owner', 'agent:box:t1'] }, { at: MON + 2 * HOUR, by: ['agent:box:t1'] }, { at: MON - 6 * DAY, by: ['lifeos:desktop'] }, { at: MON - 60 * DAY, by: ['owner'] }])
    rig.versions.set(JSON.stringify({ at: 'lifeos', table: 'docs', id: 'd2' }), new Error('moved'))
    const got = await fileFacts(rig.ctx, asked(), jobsOf(rig.db))
    expect(got.points).toEqual([[MON + HOUR, 0, 'edited']])
    expect(got.before).toEqual([[MON - 6 * DAY, 0, 'edited']])
    // The stale document was never asked about; the one that failed cost only its own edits, and says edits may be short.
    expect(rig.moduleCalls.map((c) => (c.params as { source: { id: string } }).source.id).sort()).toEqual(['d1', 'd2'])
    expect(got.part).toBe(true)
  })

  it('asks about 200 documents at most, the newest first, and says so when history answers for none', async () => {
    rig.items.set('w-purdue', Array.from({ length: DOCS_MOST + 30 }, (_, i) => docItem(`d${i}`, 'w-purdue', MON + i * MIN)))
    await expect(fileFacts(rig.ctx, asked(), jobsOf(rig.db))).rejects.toThrow('Document history did not answer')
    expect(rig.moduleCalls).toHaveLength(DOCS_MOST)
    expect((rig.moduleCalls[0]!.params as { source: { id: string } }).source.id).toBe(`d${DOCS_MOST + 29}`)
    // Past the cap with every one read: what was read counts, and the rest is said.
    for (let i = 0; i < DOCS_MOST + 30; i++) rig.versions.set(JSON.stringify({ at: 'lifeos', table: 'docs', id: `d${i}` }), [])
    expect((await fileFacts(rig.ctx, asked(), jobsOf(rig.db))).part).toBe(true)
    rig.items.clear()
    expect(await fileFacts(rig.ctx, asked(), jobsOf(rig.db))).toEqual({ points: [], before: [], part: false })
  })

  it('files a document by its own sector, never by the tab it was open in', async () => {
    rig.lifeos['docs:get'] = (a: { id: string }) => ({ sector: a.id === 'cosmic-doc' ? 'cosmic' : 'purdue' })
    rig.db.prepare(`UPDATE workspaces SET path = ? WHERE id = ?`).run('/work/cosmic', 'w-cosmic')
    const file = { at: 'file', host: 'box', path: '/work/cosmic/Notes/patch.tcdoc' } as const
    // A Cosmic LifeOS document and a .tcdoc in Cosmic's folder, both open in a Purdue thread's canvas.
    rig.items.set('w-purdue', [docItem('cosmic-doc', 'w-purdue', MON + HOUR), { ...docItem('f', 'w-purdue', MON + HOUR), source: file }])
    rig.versions.set(JSON.stringify({ at: 'lifeos', table: 'docs', id: 'cosmic-doc' }), [{ at: MON + HOUR, by: ['owner'] }])
    rig.versions.set(JSON.stringify(file), [{ at: MON + 2 * HOUR, by: ['owner'] }])
    // Purdue's tool counts neither.
    expect((await fileFacts(rig.ctx, asked({ only: 'purdue' }), jobsOf(rig.db, { workspaceId: 'w-purdue' }))).points).toEqual([])
    // The page counts both under Cosmic.
    expect((await fileFacts(rig.ctx, asked(), jobsOf(rig.db))).points.sort((a, b) => a[0] - b[0])).toEqual([
      [MON + HOUR, 1, 'edited'],
      [MON + 2 * HOUR, 1, 'edited']
    ])
  })
})

describe('a meeting that was not followed up', () => {
  const meeting = (o: Record<string, unknown> = {}) => toEvent(event('e1', { attendees: [{ address: 'dana@example.edu', name: 'Dana Reyes' }], ...o }) as never, new Set())
  const sent = (at: number, to: string) => ({ at, addresses: [to] })

  it('is one that ended, with someone else on it, and no mail to any of them since', () => {
    const e = meeting()
    expect(followedUp(e, [])).toBe(false)
    expect(followedUp(e, [sent(MON + 14 * HOUR, 'dana@example.edu')])).toBe(false)
    expect(followedUp(e, [sent(MON + 16 * HOUR, 'someone@else.test')])).toBe(false)
    expect(followedUp(e, [sent(MON + 16 * HOUR, 'dana@example.edu')])).toBe(true)
    const span = { from: WEEK.from, cut: WEEK.to }
    expect(meetingsSlipped([e], [], span, new Set())).toEqual([{ key: 'meeting:e1', ref: { kind: 'meeting', eventId: 'e1' }, sector: 'purdue', workspaceId: null, title: 'Budget review', at: MON + 14 * HOUR, people: ['Dana Reyes'], others: 1, open: true }])
    expect(meetingsSlipped([e], [sent(MON + 16 * HOUR, 'dana@example.edu')], span, new Set())).toEqual([])
  })

  it('is not one whose page in Prep holds notes or an outcome, asked through Prep\'s own wire', async () => {
    const e = meeting()
    const span = { from: WEEK.from, cut: WEEK.to }
    expect(meetingsSlipped([e], [], span, new Set(), new Set(['e1']))).toEqual([])
    // No Prep on the host: nothing is asked and the mail rule stands alone.
    expect(await preppedAfter(rig.ctx, WEEK.from, WEEK.to)).toEqual(new Set())
    const { WORK_MODULES } = await import('../../modules')
    const asked: unknown[] = []
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle(req) { asked.push([req.method, (req as { params?: unknown }).params]); return { handled: true, result: { meetings: [{ eventId: 'e1', state: 'after' }, { eventId: 'e2', state: 'briefed' }] } } } })
    expect(await preppedAfter(rig.ctx, WEEK.from, WEEK.to)).toEqual(new Set(['e1']))
    expect(asked).toEqual([['work.prep.upcoming', { from: WEEK.from, to: WEEK.to }]])
    WORK_MODULES.pop()
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle() { throw new Error('down') } })
    expect(await preppedAfter(rig.ctx, WEEK.from, WEEK.to)).toEqual(new Set())
  })

  it('is never one he was alone at, declined, hid, that has not ended, or that he marked', () => {
    const span = { from: WEEK.from, cut: MON + 20 * HOUR }
    const none = (e: ReturnType<typeof meeting>, hidden = new Set<string>()) => expect(meetingsSlipped([e], [], span, hidden)).toEqual([])
    none(meeting({ attendees: [] }))
    none(meeting({ myResponse: 'declined' }))
    none(meeting({ hidden: true }))
    none(meeting({ allDay: true }))
    none(meeting({ startsAt: MON + 19 * HOUR, endsAt: MON + 21 * HOUR }))
    none(meeting({ startsAt: WEEK.from - 2 * HOUR, endsAt: WEEK.from - HOUR }))
    none(meeting(), new Set(['meeting:e1']))
  })

  it('a mark hides a row until its day', async () => {
    setMark(rig.db, { key: 'held:host:old', how: 'later', until: WEEK.to + 2 * HOUR }, WEEK.to)
    setMark(rig.db, { key: 'meeting:e9', how: 'drop', until: null }, WEEK.to)
    const { hiddenKeys } = await import('../store')
    expect([...hiddenKeys(rig.db, WEEK.to + HOUR)].sort()).toEqual(['held:host:old', 'meeting:e9'])
    // Its day has come: the held item is back, the meeting that needs nothing stays away.
    expect([...hiddenKeys(rig.db, WEEK.to + 3 * HOUR)]).toEqual(['meeting:e9'])
  })
})
