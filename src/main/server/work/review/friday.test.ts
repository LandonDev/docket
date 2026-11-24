import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { review } from '.'
import { MAKE_JOB, ROUTINE_NAME, ROUTINE_RRULE, routineOf, seedRoutine } from './friday'
import { keptWeek, readyWeek, setupOf } from './store'
import { FRIDAY, HOUR, makeRig, MON, thread, TZ, WEEK, window, type Rig } from './testkit'

/** Friday: the routine the review seeds once a host, the job it runs with no model, and telling him once. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  rig.lifeos['settings:get'] = { timezone: TZ }
  rig.lifeos['mail:accounts'] = []
  rig.lifeos['events:range'] = []
  rig.lifeos['review:sentBetween'] = []
  rig.lifeos['review:doneBetween'] = []
  rig.lifeos['review:answeredBetween'] = { rows: [], answeredSince: null }
  rig.lifeos['tasks:due'] = [{ _id: 'k1', title: 'Send the travel forms', sector: 'purdue', dueAt: MON + HOUR }]
  rig.lifeos['mailWaits:list'] = { page: [], isDone: true, continueCursor: '' }
})
afterEach(() => rig.close())

const job = () => review.jobs!.find((j) => j.id === MAKE_JOB)!
const call = (method: string, params: unknown, by = window) => review.handle!({ id: '1', method, params } as never, rig.ctx, by)

describe('the routine is seeded once a host', () => {
  it('in the first linked workspace, or the Life one when there is one, Fridays at 4:00 PM in LifeOS’s time zone, running the job and no model', async () => {
    await seedRoutine(rig.ctx, undefined, FRIDAY)
    expect(rig.routines).toEqual([{ id: 'r1', workspaceId: 'w-purdue', name: ROUTINE_NAME, job: MAKE_JOB, trigger: { on: 'schedule', rrule: ROUTINE_RRULE, tz: TZ }, enabled: true, words: 'Fridays at 4:00 PM' }])
    expect(rig.moduleCalls.at(-1)).toMatchObject({ method: 'work.routines.save', params: { prompt: '', ends: { kind: 'never' } }, by: { kind: 'local' } })
    expect(setupOf(rig.db)).toEqual({ seededAt: FRIDAY, routineId: 'r1', workspaceId: 'w-purdue' })
    // Again, at the next boot and at every later look: nothing is made twice.
    await seedRoutine(rig.ctx)
    await seedRoutine(rig.ctx)
    expect(rig.routines).toHaveLength(1)

    const other = makeRig()
    other.lifeos['settings:get'] = { timezone: TZ }
    other.db.prepare('INSERT INTO workspaces (id, name, kind, sector, created_at) VALUES (?, ?, ?, ?, ?)').run('w-life', 'Life', 'work', 'life', 9)
    await seedRoutine(other.ctx)
    expect(other.routines.map((r) => r.workspaceId)).toEqual(['w-life'])
    other.close()
  })

  it('is never made again once he removed it', async () => {
    await seedRoutine(rig.ctx)
    expect(await routineOf(rig.ctx)).toEqual({ workspaceId: 'w-purdue', routineId: 'r1', words: 'Fridays at 4:00 PM' })
    rig.routines.length = 0
    await seedRoutine(rig.ctx)
    expect(rig.routines).toEqual([])
    // The menu's row goes with it.
    expect(await call('work.review.routine', {})).toEqual({ handled: true, result: null })
  })

  it('says a paused routine is paused', async () => {
    await seedRoutine(rig.ctx)
    rig.routines[0]!.enabled = false
    expect((await routineOf(rig.ctx))!.words).toBe('Fridays at 4:00 PM, paused')
  })

  it('waits for a time zone: LifeOS’s, else the first window’s', async () => {
    rig.lifeos['settings:get'] = {}
    await seedRoutine(rig.ctx)
    expect(rig.routines).toEqual([])
    expect(setupOf(rig.db).seededAt).toBeNull()
    await seedRoutine(rig.ctx, 'Mars/Olympus')
    expect(rig.routines).toEqual([])
    await seedRoutine(rig.ctx, 'America/New_York')
    expect(rig.routines[0]!.trigger).toEqual({ on: 'schedule', rrule: ROUTINE_RRULE, tz: 'America/New_York' })
  })

  it('waits for a linked Work workspace', async () => {
    rig.db.exec(`UPDATE workspaces SET sector = NULL`)
    await seedRoutine(rig.ctx)
    expect(rig.routines).toEqual([])
    expect(setupOf(rig.db).seededAt).toBeNull()
    // He links one later: the next try makes it, once, and does not reuse the try that found none.
    rig.db.exec(`UPDATE workspaces SET sector = 'purdue' WHERE id = 'w-purdue'`)
    await seedRoutine(rig.ctx)
    await seedRoutine(rig.ctx)
    expect(rig.routines.map((r) => r.workspaceId)).toEqual(['w-purdue'])
  })

  it('only a person reads which routine it is', async () => {
    await expect(call('work.review.routine', {}, thread())).rejects.toThrow('Only you')
  })
})

describe('the job', () => {
  it('makes this week’s review with no thread, keeps it as ready, and says what its run’s row opens', async () => {
    const out = await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY })
    expect(out).toEqual({ words: 'Week of Nov 16: 1 thing slipped on this host', open: { place: 'review', at: WEEK.from } })
    expect(rig.started).toEqual([])
    expect(keptWeek(rig.db, WEEK.from)).toMatchObject({ by: 'routine', madeAt: FRIDAY, from: WEEK.from, to: WEEK.to, tz: TZ })
    expect(readyWeek(rig.db)).toEqual({ from: WEEK.from, madeAt: FRIDAY })
    expect(rig.pushes.map((x) => x.p)).toEqual([{ push: 'work.review', from: WEEK.from, madeAt: FRIDAY, seen: false }])
  })

  it('names itself by what it makes, and gives no firm count for a week a source did not answer', async () => {
    expect(job().name).toBe('Your hours, what shipped and what slipped')
    // The tasks could not be read: the review is kept as far as it goes, and its run does not say "nothing slipped".
    delete rig.lifeos['tasks:due']
    const out = await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY })
    expect(out).toEqual({ words: 'Week of Nov 16: some of it could not be read', open: { place: 'review', at: WEEK.from } })
    expect(keptWeek(rig.db, WEEK.from)!.left.length).toBeGreaterThan(0)
  })

  it('tells him once a week through the digest, with a press that opens the page at that week, and never again for a second make of the same week', async () => {
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY })
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY + HOUR })
    // No `by`: nothing is too late, so the digest's rule lets it wait for the day's one notice.
    expect(rig.told).toEqual([{ kind: 'review.ready', workspaceId: null, title: 'Your week is ready to review', detail: 'Week of Nov 16', key: `review:${WEEK.from}`, open: { place: 'review', at: String(WEEK.from) } }])
    expect(review.tells).toEqual([{ kind: 'review.ready', group: 'review', name: 'The weekly review' }])
    // The week after is told again.
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY + 7 * 24 * HOUR })
    expect(rig.told.map((t) => t.key)).toEqual([`review:${WEEK.from}`, `review:${WEEK.to}`])
  })

  it('a second run of a week he opened tells nobody and leaves it seen', async () => {
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY })
    await call('work.review.seen', { from: WEEK.from })
    // Run now, the same Friday evening.
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY + 2 * HOUR })
    expect(rig.told.map((t) => t.key)).toEqual([`review:${WEEK.from}`])
    expect(await call('work.review.ready', {})).toEqual({ handled: true, result: null })
  })

  it('ready answers null once he has seen it', async () => {
    await job().run(rig.ctx, { workspaceId: 'w-purdue', firedAt: FRIDAY })
    expect(await call('work.review.ready', {})).toEqual({ handled: true, result: { from: WEEK.from, madeAt: FRIDAY } })
    await call('work.review.seen', { from: WEEK.from })
    expect(await call('work.review.ready', {})).toEqual({ handled: true, result: null })
    // The digest's row goes with it, once.
    expect(rig.toldDone).toEqual([`review:${WEEK.from}`])
    await call('work.review.seen', { from: WEEK.from })
    expect(rig.toldDone).toHaveLength(1)
  })
})
