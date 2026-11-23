import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REVIEW_CAPS } from '@shared/contract-work-review'
import { LEFT, type ReviewBody } from '@shared/work/review'
import type { ToolCtx } from '../modules'
import { NOT_A_WEEK, review, UNKNOWN_ZONE, weekFor } from '.'
import { NOT_A_PERSON } from './settle'
import { keptWeek, readyWeek } from './store'
import { approver, DAY, FRIDAY, held, HOUR, makeRig, MIN, MON, reader, thread, TZ, WEEK, window, type Rig } from './testkit'

/**
 * The review's module on one host: what a week's body holds, what is kept and what is read again, who may ask, and
 * what a thread's own tool may see.
 */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  // A LifeOS with one made-up week across two sectors.
  rig.lifeos['mail:accounts'] = [{ address: 'him@example.edu' }]
  rig.lifeos['events:range'] = [
    { _id: 'e1', sector: 'purdue', title: 'Budget review', startsAt: MON + 14 * HOUR, endsAt: MON + 15 * HOUR, allDay: false, attendees: [{ address: 'dana@example.edu', name: 'Dana Reyes' }] },
    { _id: 'e2', sector: 'cosmic', title: 'Patch planning', startsAt: MON + 16 * HOUR, endsAt: MON + 17 * HOUR, allDay: false }
  ]
  rig.lifeos['review:sentBetween'] = (a: { from: number }) => (a.from === WEEK.from ? [{ id: 'm1', threadId: 't1', subject: 'Season 12 patch notes', to: [{ name: 'Riley Okafor', address: 'riley@example.com' }], sentAt: MON + 18 * HOUR, sector: 'cosmic' }] : [])
  rig.lifeos['review:doneBetween'] = [{ id: 'k1', title: 'Order the new jerseys', sector: 'purdue', completedAt: MON + 9 * HOUR }]
  rig.lifeos['review:answeredBetween'] = { rows: [], answeredSince: null }
  rig.lifeos['tasks:due'] = [{ _id: 'k2', title: 'Send the travel forms', sector: 'purdue', dueAt: MON + DAY }]
  rig.lifeos['mailWaits:list'] = { page: [], isDone: true, continueCursor: '' }
  rig.session('t-purdue')
  rig.said('t-purdue', MON + 10 * HOUR)
  rig.status('t-purdue', MON + 10 * HOUR, 'running')
  rig.status('t-purdue', MON + 10 * HOUR + 30 * MIN, 'idle')
})
afterEach(() => rig.close())

const ask = { from: WEEK.from, to: WEEK.to, tz: TZ }
const call = (method: string, params: unknown, by = window) => review.handle!({ id: '1', method, params } as never, rig.ctx, by)
const week = async (by = window): Promise<ReviewBody> => ((await call('work.review.week', ask, by)) as { result: ReviewBody }).result

describe('a week’s body', () => {
  it('holds this host’s jobs, LifeOS’s facts for every sector, his points, the threads’ run time and what slipped', async () => {
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body).toMatchObject({ host: 'box', from: WEEK.from, to: WEEK.to, tz: TZ, madeAt: FRIDAY, by: 'owner', over: false, left: [] })
    expect(body.jobs).toEqual([
      { workspaceId: 'w-purdue', sector: 'purdue', name: 'Purdue' },
      { workspaceId: 'w-cosmic', sector: 'cosmic', name: 'Cosmic' },
      { workspaceId: 'w-side', sector: null, name: 'Side work' }
    ])
    expect(body.lifeos!.events.map((e) => [e.id, e.sector, e.people])).toEqual([
      ['e1', 'purdue', ['Dana Reyes']],
      ['e2', 'cosmic', []]
    ])
    expect(body.lifeos!.sent).toHaveLength(1)
    expect(body.lifeos!.done).toEqual([{ id: 'k1', title: 'Order the new jerseys', at: MON + 9 * HOUR, sector: 'purdue' }])
    expect(body.points).toEqual([[MON + 10 * HOUR, 0, 'said']])
    expect(body.ran).toEqual([[0, 30 * MIN]])
    // The task past due, and the meeting with Dana that no mail followed.
    expect(body.slipped.rows.map((r) => r.key)).toEqual(['task:k2', 'meeting:e1'])
    expect(body.slipped.at).toBe(FRIDAY)
    // The week before is compared over the same span: Monday to Friday 4:00 PM.
    expect(body.before).toMatchObject({ from: WEEK.from - 7 * DAY, to: FRIDAY - 7 * DAY })
  })

  it('stands when a source throws: the rest is read and the page is told what is missing', async () => {
    rig.lifeos['events:range'] = new Error('down')
    rig.lifeos['tasks:due'] = new Error('down')
    rig.outbox.waiting = [held('h1', { createdAt: MON })]
    rig.db.exec('DROP TABLE settings')
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body.left).toEqual([LEFT.calendar, LEFT.tasks, LEFT.threads])
    expect(body.lifeos).toMatchObject({ events: [], sent: [{ id: 'm1' }], done: [{ id: 'k1' }] })
    // No calendar, so no meeting can be judged; the held item still shows.
    expect(body.slipped.rows.map((r) => r.key)).toEqual(['held:host:h1'])
    expect(body.points).toEqual([])
  })

  it('says one line when LifeOS answers nothing at all, or is not signed in', async () => {
    for (const fn of Object.keys(rig.lifeos)) rig.lifeos[fn] = new Error('unreachable')
    expect((await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)).left).toEqual([LEFT.lifeos])
    rig.connected = false
    const calls = rig.calls.length
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body.lifeos).toBeNull()
    expect(body.left).toEqual([LEFT.lifeos])
    expect(rig.calls).toHaveLength(calls)
    // His messages on this host are still counted.
    expect(body.points).toHaveLength(1)
  })

  it('lists no meeting when the sent mail could not be read: nobody can say it was not followed up', async () => {
    rig.lifeos['review:sentBetween'] = new Error('not deployed')
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body.left).toEqual([LEFT.mail])
    expect(body.slipped.rows.map((r) => r.key)).toEqual(['task:k2'])
  })
})

describe('what is kept', () => {
  it('a week that is not over is made again and overwritten', async () => {
    await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(keptWeek(rig.db, WEEK.from)!.madeAt).toBe(FRIDAY)
    rig.lifeos['tasks:due'] = []
    const again = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY + DAY)
    expect(again.slipped.rows.map((r) => r.key)).toEqual(['meeting:e1'])
    expect(keptWeek(rig.db, WEEK.from)).toEqual(again)
    expect((await call('work.review.list', {})) as unknown).toEqual({ handled: true, result: { weeks: [{ from: WEEK.from, to: WEEK.to, tz: TZ, madeAt: FRIDAY + DAY, by: 'owner' }], tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } })
  })

  it('once the week is over, what slipped is frozen as it stood, and a row dealt with since says so', async () => {
    await weekFor(rig.ctx, { ...ask, by: 'routine' }, undefined, FRIDAY)
    // The next Wednesday: the task is done, a new one is late, and an hour of thread time was found.
    rig.lifeos['tasks:due'] = [{ _id: 'k9', title: 'Late since', sector: 'purdue', dueAt: WEEK.to - HOUR }]
    rig.status('t-purdue', MON + 3 * DAY, 'running')
    rig.status('t-purdue', MON + 3 * DAY + HOUR, 'idle')
    const later = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, WEEK.to + 2 * DAY)
    expect(later.over).toBe(true)
    expect(later.slipped.at).toBe(FRIDAY)
    expect(later.slipped.rows.map((r) => [r.key, r.open])).toEqual([
      ['task:k2', false],
      ['meeting:e1', true]
    ])
    // Hours are read fresh: their facts carry times.
    expect(later.ran).toEqual([[0, 30 * MIN + HOUR]])
    expect(later.by).toBe('routine')
    expect(keptWeek(rig.db, WEEK.from)!.slipped.at).toBe(FRIDAY)
  })

  it('compares a week that is over with the whole of the week before, and a running one with the same span', async () => {
    const running = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(running.before).toMatchObject({ from: WEEK.from - 7 * DAY, to: FRIDAY - 7 * DAY })
    const over = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, WEEK.to + DAY)
    expect(over.before).toMatchObject({ from: WEEK.from - 7 * DAY, to: WEEK.from })
  })

  it('keeps a kept meeting as it last stood when the mail sent since the week could not be read', async () => {
    await weekFor(rig.ctx, { ...ask, by: 'routine' }, undefined, FRIDAY)
    // The Wednesday after: the read of mail sent since the week ended fails; the week's own mail still answers.
    const sent = rig.lifeos['review:sentBetween']
    rig.lifeos['review:sentBetween'] = (args: { from: number }) => {
      if (args.from >= WEEK.to) throw new Error('timed out')
      return sent
    }
    const later = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, WEEK.to + 2 * DAY)
    // Nobody can say the meeting was followed up or not: it stays open, and the gap is said.
    expect(later.left).toEqual([LEFT.mail])
    expect(later.slipped.rows.find((r) => r.key === 'meeting:e1')!.open).toBe(true)
  })

  it('a week first asked for after it ended shows what is still open from it, each time as of now', async () => {
    const first = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, WEEK.to + DAY)
    expect(first.slipped.at).toBe(WEEK.to + DAY)
    rig.lifeos['tasks:due'] = []
    const second = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, WEEK.to + 2 * DAY)
    expect(second.slipped).toEqual({ at: WEEK.to + 2 * DAY, rows: [expect.objectContaining({ key: 'meeting:e1' })] })
  })

  it('two windows asking at once share one read', async () => {
    const [a, b] = await Promise.all([week(), week()])
    expect(a).toBe(b)
    expect(rig.calls.filter((c) => c.fn === 'tasks:due')).toHaveLength(1)
  })
})

describe('who may ask', () => {
  it('declares every method with its capability: approve, and read for ready alone', () => {
    expect(REVIEW_CAPS).toEqual({
      'work.review.week': 'approve',
      'work.review.list': 'approve',
      'work.review.settle': 'approve',
      'work.review.undo': 'approve',
      'work.review.ready': 'read',
      'work.review.seen': 'approve',
      'work.review.routine': 'approve'
    })
  })

  it('refuses a thread’s own call and a key that may not approve, before anything is read', async () => {
    for (const by of [thread(), reader]) {
      await expect(call('work.review.week', ask, by)).rejects.toThrow(NOT_A_PERSON)
      await expect(call('work.review.list', {}, by)).rejects.toThrow(NOT_A_PERSON)
      await expect(call('work.review.seen', { from: WEEK.from }, by)).rejects.toThrow(NOT_A_PERSON)
    }
    expect(rig.calls).toEqual([])
    expect((await week(approver)).host).toBe('box')
  })

  it('answers only for a whole week of a zone it knows', async () => {
    await expect(call('work.review.week', { ...ask, from: ask.from + HOUR })).rejects.toThrow(NOT_A_WEEK)
    await expect(call('work.review.week', { ...ask, tz: 'UTC' })).rejects.toThrow(NOT_A_WEEK)
    await expect(call('work.review.week', { ...ask, tz: 'Mars/Olympus' })).rejects.toThrow(UNKNOWN_ZONE)
  })

  it('leaves every other method to the rest of the chain', async () => {
    expect(await call('work.outbox.list', {})).toEqual({ handled: false })
  })
})

describe('ready, and seen', () => {
  it('names the newest week the routine made until he opens it, and tells every screen', async () => {
    expect(readyWeek(rig.db)).toBeNull()
    await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY - HOUR)
    expect(readyWeek(rig.db)).toBeNull()
    await weekFor(rig.ctx, { ...ask, by: 'routine' }, undefined, FRIDAY)
    expect(await call('work.review.ready', {}, reader)).toEqual({ handled: true, result: { from: WEEK.from, madeAt: FRIDAY } })
    // A thread hears of no review.
    expect(await call('work.review.ready', {}, thread())).toEqual({ handled: true, result: null })
    // His own later look does not make it unseen or forget that the routine made it.
    await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY + HOUR)
    expect(readyWeek(rig.db)).toEqual({ from: WEEK.from, madeAt: FRIDAY })
    expect(await call('work.review.seen', { from: WEEK.from })).toEqual({ handled: true, result: { ok: true } })
    expect(readyWeek(rig.db)).toBeNull()
    expect(rig.pushes.map((x) => x.p)).toEqual([{ push: 'work.review', from: WEEK.from, madeAt: expect.any(Number), seen: true }])
    // Seen twice tells nobody twice.
    await call('work.review.seen', { from: WEEK.from })
    expect(rig.pushes).toHaveLength(1)
  })
})

describe('the week_review tool', () => {
  const tool = () => review.tools!({} as never).find((t) => t.name === 'week_review')!
  const run = async (sessionId: string, args: Record<string, unknown> = { week: '2026-11-18' }): Promise<string> => {
    const out = await tool().run(args, { ...rig.ctx, scope: rig.ctx.scopeOf(sessionId)!, sessionId, signal: new AbortController().signal } as ToolCtx)
    return (out.content[0] as { text: string }).text
  }

  // The host's zone is LifeOS's when it says one.
  beforeEach(() => {
    rig.lifeos['settings:get'] = { timezone: TZ }
  })

  it('is read only and answers for the thread’s own job alone', async () => {
    expect(tool().readOnly).toBe(true)
    rig.outbox.waiting = [held('hp', { createdAt: MON }), held('hc', { createdAt: MON, workspaceId: 'w-cosmic', sector: 'cosmic', summary: 'Post the patch notes to #announcements' })]
    const purdue = await run('t-purdue')
    expect(purdue).toContain('Week of Nov 16, Purdue.')
    expect(purdue).toContain('On the calendar (measured): 1 h, 1 event')
    expect(purdue).toContain('At the desk (an estimate, never a measure): about 15 m, from 1 message')
    expect(purdue).toContain('Threads ran (measured; not his hours): 30 m')
    expect(purdue).toContain('Finished Order the new jerseys, Mon')
    expect(purdue).toContain('Send the travel forms, due Tue')
    expect(purdue).toContain('Post the bracket to #esports, held since Mon')
    // Nothing of Cosmic: its event, its mail, its held item.
    for (const other of ['Cosmic', 'Patch', 'Season 12', 'Riley', '#announcements']) expect(purdue).not.toContain(other)

    const cosmic = await run('t-cosmic')
    expect(cosmic).toContain('Week of Nov 16, Cosmic.')
    expect(cosmic).toContain('Sent Season 12 patch notes to Riley Okafor, Mon')
    for (const other of ['Purdue', 'Budget', 'jerseys', 'travel forms', 'Dana', '#esports']) expect(cosmic).not.toContain(other)
  })

  it('adds the job\'s own sums from Money, asked for that workspace alone', async () => {
    const { WORK_MODULES } = await import('../modules')
    const asked: unknown[] = []
    WORK_MODULES.push({ id: 'money' as never, ensure() {}, async handle(req) { asked.push((req as { params?: unknown }).params); return { handled: true, result: { rows: [{ workspaceId: 'w-purdue', in: 120_00, out: 45_50 }] } } } })
    expect(await run('t-purdue')).toContain("Money (the job's ledger, as Money sums it): $120.00 in, $45.50 out")
    expect(asked).toEqual([{ from: '2026-11-16', to: '2026-11-23', workspaceId: 'w-purdue' }])
    // Another job's thread asks for its own workspace and is shown nothing of this one.
    expect(await run('t-cosmic')).not.toContain('Money')
  })

  it('makes its week on the mount\'s own context, where the pillars it calls find themselves', async () => {
    // The mount runs a tool with a copy of its context; the Outbox knows only the mount's own object.
    const stop = review.start!(rig.ctx)
    const seen: unknown[] = []
    const { WORK_MODULES } = await import('../modules')
    const outbox = WORK_MODULES.find((m) => m.id === 'outbox')!
    const real = outbox.handle!
    outbox.handle = async (req, ctx, by) => {
      seen.push(ctx)
      return real(req, ctx, by)
    }
    await run('t-purdue')
    stop()
    outbox.handle = real
    expect(seen.length).toBeGreaterThan(0)
    for (const ctx of seen) expect(ctx).toBe(rig.ctx)
  })

  it('shows a job with no sector nothing of LifeOS, and a Work Chat nothing at all', async () => {
    const side = await run('t-side')
    expect(side).toContain('Week of Nov 16, Side work.')
    expect(side).toContain('Nothing seen.')
    for (const other of ['Budget', 'jerseys', 'Season 12', 'travel forms']) expect(side).not.toContain(other)
    expect(await run('t-chat')).toContain('This thread is in no job')
  })

  it('keeps nothing: a thread’s read leaves no mark on what he sees', async () => {
    await run('t-purdue')
    expect(keptWeek(rig.db, WEEK.from)).toBeNull()
    expect(readyWeek(rig.db)).toBeNull()
  })
})
