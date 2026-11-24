import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REVIEW_CAPS } from '@shared/contract-work-review'
import { PREP_UPCOMING_MAX_MS } from '@shared/contract-work-prep'
import { LEFT, mergeReview, type ReviewBody } from '@shared/work/review'
import { WORK_MODULES, type ToolCtx } from '../modules'
import { NOT_A_WEEK, review, UNKNOWN_ZONE, weekFor } from '.'
import { NOT_A_PERSON } from './settle'
import { keptWeek, readyWeek, setMark } from './store'
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

describe('the meetings judged', () => {
  it('judges none while his own addresses are unread: he would be "someone else" on every event', async () => {
    rig.lifeos['mail:accounts'] = new Error('down')
    rig.lifeos['events:range'] = [{ _id: 'solo', sector: 'purdue', title: 'Focus block', startsAt: MON + 8 * HOUR, endsAt: MON + 9 * HOUR, attendees: [{ address: 'him@example.edu' }] }]
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    // Its own line: mail answered, so the waits and their presses stand.
    expect(body.left).toEqual([LEFT.self])
    expect(body.slipped.rows.filter((r) => r.ref.kind === 'meeting')).toEqual([])
  })

  it('asks Prep over the whole span it answers, ending at the cut, and carries what Prep calls done for the window', async () => {
    // Sunday 11:00 PM to Monday 1:00 AM: it ends in the week and began before it.
    rig.lifeos['events:range'] = [{ _id: 'late', sector: 'purdue', title: 'Overnight stream', startsAt: WEEK.from - HOUR, endsAt: WEEK.from + HOUR, attendees: [{ address: 'dana@example.edu' }] }]
    const asked: unknown[] = []
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle(req) { asked.push((req as { params?: unknown }).params); return { handled: true, result: { meetings: [{ eventId: 'late', state: 'after' }] } } } })
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(asked).toEqual([{ from: FRIDAY - PREP_UPCOMING_MAX_MS, to: FRIDAY }])
    expect(body.slipped.rows.filter((r) => r.ref.kind === 'meeting')).toEqual([])
    expect(body.prepped).toEqual(['late'])
  })

  it('a meeting put off on the box and followed up in the Mac’s Prep leaves Slipped, gathered on each host and merged', async () => {
    // Thursday of the week before, put off on the box to this week. Its notes are written in the Mac's Prep.
    const thursday = { _id: 'old', sector: 'purdue', title: 'Budget review', startsAt: WEEK.from - 4 * DAY, endsAt: WEEK.from - 4 * DAY + HOUR, attendees: [{ address: 'dana@example.edu' }] }
    rig.lifeos['events:get'] = thursday
    setMark(rig.db, { key: 'meeting:old', how: 'later', until: WEEK.from }, WEEK.from - 3 * DAY)
    const box = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(box.slipped.rows.map((r) => r.key)).toContain('meeting:old')
    rig.close()
    // The Mac: no mark, no carried meeting; its Prep holds Thursday's page.
    rig = makeRig()
    for (const [fn, v] of Object.entries({ 'mail:accounts': [{ address: 'him@example.edu' }], 'events:range': [], 'review:sentBetween': [], 'review:doneBetween': [], 'review:answeredBetween': { rows: [], answeredSince: null }, 'tasks:due': [], 'mailWaits:list': { page: [], isDone: true, continueCursor: '' } })) rig.lifeos[fn] = v
    const asked: { from: number; to: number }[] = []
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle(req) { const p = (req as { params: { from: number; to: number } }).params; asked.push(p); return { handled: true, result: { meetings: p.from <= thursday.startsAt ? [{ eventId: 'old', state: 'after' }] : [] } } } })
    const mac = { ...(await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)), host: 'mac' }
    expect(mac.prepped).toEqual(['old'])
    const merged = mergeReview([{ environmentId: 'env-box', body: box }, { environmentId: 'env-mac', body: mac }], FRIDAY, { home: 'env-box' })!
    expect(merged.slipped.map((r) => r.key)).not.toContain('meeting:old')
  })

  it('says Prep unread on a host whose LifeOS is out, so a meeting another host lists stands as last known', async () => {
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle() { return { handled: true, result: { meetings: [] } } } })
    rig.connected = false
    const mac = { ...(await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)), host: 'mac' }
    expect(mac.left).toEqual([LEFT.lifeos, LEFT.prep])
    // The box read LifeOS and judged the meeting; the Mac, which may hold its notes, could not look.
    rig.connected = true
    const box = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY + MIN)
    const merged = mergeReview([{ environmentId: 'env-box', body: box }, { environmentId: 'env-mac', body: mac }], FRIDAY + MIN, { home: 'env-box' })!
    expect(merged.slipped.filter((r) => r.ref.kind === 'meeting').map((r) => r.unchecked)).toEqual([true])
    expect(merged.left).toContain(LEFT.prep)
  })

  it('says a Prep that did not answer, and keeps every meeting as last known', async () => {
    WORK_MODULES.push({ id: 'prep' as never, ensure() {}, async handle() { throw new Error('LifeOS down') } })
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body.left).toEqual([LEFT.prep])
    const merged = mergeReview([{ environmentId: 'env-box', body }], FRIDAY)!
    expect(merged.slipped.filter((r) => r.ref.kind === 'meeting').map((r) => r.unchecked)).toEqual([true])
    expect(merged.known.slipped).toBe(false)
  })

  it('judges no put-off meeting when the mail sent since it ended could not be read', async () => {
    // Put off last Thursday to this week; it ended before the week began.
    setMark(rig.db, { key: 'meeting:old', how: 'later', until: WEEK.from }, WEEK.from - 3 * DAY)
    rig.lifeos['events:get'] = { _id: 'old', sector: 'purdue', title: 'Budget review', startsAt: WEEK.from - 4 * DAY, endsAt: WEEK.from - 4 * DAY + HOUR, attendees: [{ address: 'dana@example.edu' }] }
    const sent = rig.lifeos['review:sentBetween'] as (a: { from: number }) => unknown
    rig.lifeos['review:sentBetween'] = (a: { from: number }) => {
      if (a.from < WEEK.from) throw new Error('timed out')
      return sent(a)
    }
    const body = await weekFor(rig.ctx, { ...ask, by: 'owner' }, undefined, FRIDAY)
    expect(body.left).toEqual([LEFT.mail])
    expect(body.slipped.rows.map((r) => r.key)).not.toContain('meeting:old')
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
    // The mail he sent in the week is the kept read joined to the fresh one, and the line says it is as last read.
    expect(later.left).toEqual([LEFT.mailKept])
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

  it('never shows a Cosmic item stamped with Purdue’s workspace to Purdue, and changes no mark', async () => {
    rig.outbox.waiting = [held('moved', { createdAt: MON, workspaceId: 'w-purdue', sector: 'cosmic', summary: 'Post the patch notes to #announcements' })]
    setMark(rig.db, { key: 'held:host:gone', how: 'later', until: MON }, MON - DAY)
    const marks = () => rig.db.prepare('SELECT key FROM work_review_marks').all()
    const before = marks()
    expect(await run('t-purdue')).not.toContain('#announcements')
    expect(await run('t-cosmic')).toContain('#announcements')
    expect(marks()).toEqual(before)
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
