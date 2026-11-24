import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { CLASHES_CAPS, ClashesRequestSchemas } from '@shared/contract-work-clashes'
import { requiredCapability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { WorkScope } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { clashes } from '.'
import { milesBetween } from './api'
import type { LifeosClash, LifeosRange, LifeosSide } from './read'
import type { Tell } from '@shared/work/tell'
import { clashesListTool } from './tool'
import { SPAN_DAYS, watchClashes } from './watch'
import { decide } from '../digest/rule'

/*
 * The clashes pillar on a LifeOS that stands in: the wire, the tool and its
 * mask, and the watcher's tells. Every event and place is made up.
 */

const ZONE = 'America/Indiana/Indianapolis'
const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const MODEL: Caller = { kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't1' }
const REMOTE: Caller = { kind: 'remote', caps: ['read', 'operate'] }
/** 2026-11-26 at `hour`:`minute` in Indiana (EST, five hours behind UTC). */
const at = (hour: number, minute = 0, day = 26): number => Date.UTC(2026, 10, day, hour + 5, minute)

const side = (over: Partial<LifeosSide>): LifeosSide => ({ eventId: 'e', sector: 'life', title: 'Event', startsAt: 0, endsAt: 0, can: [], ...over })
const staff = side({ eventId: 'e_staff', sector: 'purdue', title: 'Staff meeting', startsAt: at(16), endsAt: at(17), location: 'Room 210, Elm Hall', can: ['decline', 'propose'] })
const game = side({ eventId: 'e_game', sector: 'ref', title: 'Varsity Basketball', startsAt: at(17, 30), endsAt: at(19, 30), location: 'Maple Ridge High School, Cedar Falls, IN', place: 'Maple Ridge High School', can: ['move', 'late'] })
const driveClash: LifeosClash = { id: 'e_staff-e_game', kind: 'drive', a: staff, b: game, minutes: 45, metres: 38_624, measured: true, shortBy: 15 }
const overlapClash: LifeosClash = {
  id: 'e_lunch-e_call',
  kind: 'overlap',
  a: side({ eventId: 'e_lunch', sector: 'life', title: 'Lunch with Sam', startsAt: at(12, 0, 28), endsAt: at(13, 0, 28), location: 'Corner Cafe' }),
  b: side({ eventId: 'e_call', sector: 'cosmic', title: 'Build review', startsAt: at(12, 30, 28), endsAt: at(13, 30, 28) })
}

let db: DatabaseSync
let calls: { fn: string; args: Record<string, unknown> }[]
let answers: Record<string, (args: Record<string, unknown>) => unknown>
let subs: { fn: string; args: { from: number; to: number }; on: (v: unknown) => void; off: boolean }[]
let pushes: unknown[]
let on: boolean
let ctx: WorkCtx

const reply = async (fn: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  calls.push({ fn, args })
  const answer = answers[fn]
  if (!answer) throw new Error(`no fake for ${fn}`)
  return answer(args)
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
  const add = db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)')
  add.run('ws-purdue', 'Purdue', '/w/Purdue', 'work', 'purdue', 1)
  add.run('ws-life', 'Life', '/w/Life', 'work', 'life', 2)
  add.run('repo', 'temp-code', '/w/repo', 'code', 'cosmic', 3)
  clashes.ensure(db)
  calls = []
  subs = []
  pushes = []
  on = true
  answers = {
    'settings:get': () => ({ timezone: ZONE }),
    'clashes:range': () => ({ clashes: [driveClash, overlapClash], leaves: [] })
  }
  ctx = {
    db,
    host: 'env_box',
    enabled: () => on,
    log: () => {},
    push: (p: unknown) => void pushes.push(p),
    lifeos: {
      connected: () => true,
      owner: () => ({ query: reply, mutation: reply, action: reply }),
      subscribe: (fn: string, args: { from: number; to: number }, cb: (v: unknown) => void) => {
        const sub = { fn, args, on: cb, off: false }
        subs.push(sub)
        return () => void (sub.off = true)
      }
    }
  } as unknown as WorkCtx
})

const req = (method: string, params: unknown) => ({ id: '1', method, params }) as ClientRequest
const call = async (method: string, params: unknown, by: Caller = LOCAL): Promise<unknown> => {
  const answer = await clashes.handle!(req(method, params), ctx, by)
  return (answer as { result: unknown }).result
}

describe('the wire', () => {
  it('reads with read, quiets with operate and answers with approve', () => {
    expect(ClashesRequestSchemas.map((s) => s.shape.method.value)).toEqual(['work.clashes.list', 'work.clashes.leave', 'work.clashes.miles', 'work.clashes.waive', 'work.clashes.answer'])
    // A place a calendar made very long still goes with "This is fine": the pair he can see is never refused for its length.
    const waive = ClashesRequestSchemas.find((s) => s.shape.method.value === 'work.clashes.waive')!
    const long = { eventId: 'e_staff', startsAt: at(16), endsAt: at(18), location: 'Room '.repeat(500) }
    expect(waive.safeParse({ id: '1', method: 'work.clashes.waive', params: { id: 'e_staff-e_game', on: true, seen: [long] } }).success).toBe(true)
    expect(CLASHES_CAPS).toEqual({ 'work.clashes.list': 'read', 'work.clashes.leave': 'read', 'work.clashes.miles': 'read', 'work.clashes.waive': 'operate', 'work.clashes.answer': 'approve' })
    expect(requiredCapability({ method: 'work.clashes.answer' })).toBe('approve')
  })

  it("lists every job's clashes with this host's workspace for each job and miles from metres", async () => {
    answers['clashes:range'] = () => ({
      clashes: [driveClash],
      leaves: [{ eventId: 'e_game', leaveAt: at(16, 45), minutes: 45, metres: 38_624, measured: true, from: 'event', fromEventId: 'e_staff', fromTitle: 'Staff meeting' }]
    })
    const out = await call('work.clashes.list', { from: at(0), to: at(0, 0, 27) })
    expect(calls).toEqual([{ fn: 'clashes:range', args: { from: at(0), to: at(0, 0, 27) } }])
    expect(out).toEqual({
      clashes: [
        {
          id: 'e_staff-e_game',
          kind: 'drive',
          a: { eventId: 'e_staff', sector: 'purdue', workspaceId: 'ws-purdue', title: 'Staff meeting', startsAt: at(16), endsAt: at(17), location: 'Room 210, Elm Hall', can: ['decline', 'propose'] },
          // no Ref workspace on this host: no workspaceId
          b: { eventId: 'e_game', sector: 'ref', title: 'Varsity Basketball', startsAt: at(17, 30), endsAt: at(19, 30), place: 'Maple Ridge High School', location: 'Maple Ridge High School, Cedar Falls, IN', can: ['move', 'late'] },
          minutes: 45,
          miles: 24,
          measured: true,
          shortBy: 15
        }
      ],
      leaves: [{ eventId: 'e_game', leaveAt: at(16, 45), minutes: 45, miles: 24, from: 'event', fromTitle: 'Staff meeting', measured: true }]
    })
  })

  it("answers the drive between two stops for the workspace's job, and null when a stop has no point", async () => {
    answers['legs:ask'] = () => ({ minutes: 38, metres: 5000, measured: false })
    expect(await call('work.clashes.miles', { workspaceId: 'ws-purdue', from: { start: true }, to: { event: 'e_game' } })).toEqual({ miles: 3.1, minutes: 38, measured: false })
    expect(calls).toEqual([{ fn: 'legs:ask', args: { from: { start: true }, to: { event: 'e_game' }, sector: 'purdue' } }])
    answers['legs:ask'] = () => null
    expect(await milesBetween(ctx, 'ws-life', { place: 'Maple Ridge High School, Cedar Falls, IN' }, { start: true })).toBeNull()
    expect(calls[1]?.args.sector).toBe('life')
  })

  it('refuses miles for a workspace that is not a Work workspace with a job', async () => {
    await expect(call('work.clashes.miles', { workspaceId: 'repo', from: { start: true }, to: { event: 'e_game' } })).rejects.toThrow('Only a Work workspace linked to a job')
    await expect(call('work.clashes.miles', { workspaceId: 'nope', from: { start: true }, to: { event: 'e_game' } })).rejects.toThrow('No such workspace')
    expect(calls).toEqual([])
  })

  it("answers one event's leave from a read around its start, and null when it has none", async () => {
    answers['events:get'] = () => ({ _id: 'e_game', startsAt: at(17, 30) })
    answers['clashes:range'] = () => ({ clashes: [], leaves: [{ eventId: 'e_other', leaveAt: at(9), measured: true, from: 'start' }, { eventId: 'e_game', leaveAt: at(16, 40), minutes: 50, measured: false, from: 'start' }] })
    expect(await call('work.clashes.leave', { eventId: 'e_game' })).toEqual({ leaveAt: at(16, 40), minutes: 50, from: 'start', measured: false })
    expect(calls[0]).toEqual({ fn: 'events:get', args: { id: 'e_game' } })
    expect(calls[1]?.args).toEqual({ from: at(16, 30), to: at(18, 30) })
    answers['clashes:range'] = () => ({ clashes: [], leaves: [] })
    expect(await call('work.clashes.leave', { eventId: 'e_game' })).toBeNull()
    answers['events:get'] = () => null
    expect(await call('work.clashes.leave', { eventId: 'e_gone' })).toBeNull()
  })

  it('quiets a clash and takes that back', async () => {
    answers['clashes:waive'] = () => null
    answers['clashes:unwaive'] = () => null
    expect(await call('work.clashes.waive', { id: 'e_staff-e_game', on: true })).toBeNull()
    expect(await call('work.clashes.waive', { id: 'e_staff-e_game', on: false })).toBeNull()
    expect(calls).toEqual([
      { fn: 'clashes:waive', args: { id: 'e_staff-e_game' } },
      { fn: 'clashes:unwaive', args: { id: 'e_staff-e_game' } }
    ])
    // What he saw goes with the waive, for LifeOS to hold the pair to; never with the taking back.
    calls.length = 0
    const seen = [
      { eventId: 'e_staff', startsAt: at(16), endsAt: at(18), location: 'Cedar Hall' },
      { eventId: 'e_game', startsAt: at(17, 30), endsAt: at(19, 30) }
    ]
    await call('work.clashes.waive', { id: 'e_staff-e_game', on: true, seen })
    await call('work.clashes.waive', { id: 'e_staff-e_game', on: false, seen })
    expect(calls).toEqual([
      { fn: 'clashes:waive', args: { id: 'e_staff-e_game', seen } },
      { fn: 'clashes:unwaive', args: { id: 'e_staff-e_game' } }
    ])
    // A pair that changed since is refused in LifeOS's words.
    answers['clashes:waive'] = () => {
      throw Object.assign(new Error('[CONVEX M(clashes:waive)] Uncaught ConvexError: These events changed. Look at them again first.'), { data: 'These events changed. Look at them again first.' })
    }
    await expect(call('work.clashes.waive', { id: 'e_staff-e_game', on: true, seen })).rejects.toThrow(/^These events changed\. Look at them again first\.$/)
  })
})

describe('his answer', () => {
  beforeEach(() => {
    answers['calendarOps:save'] = () => 'op_1'
    answers['calendarOps:send'] = () => null
    answers['events:update'] = () => null
  })

  it('declines with his note: saved, then sent as his press', async () => {
    await call('work.clashes.answer', { eventId: 'e_staff', way: 'decline', comment: ' Reffing that night ' })
    expect(calls).toEqual([
      { fn: 'calendarOps:save', args: { kind: 'decline', eventId: 'e_staff', payload: { comment: 'Reffing that night' } } },
      { fn: 'calendarOps:send', args: { id: 'op_1', cause: 'press' } }
    ])
  })

  it('proposes a new time', async () => {
    await call('work.clashes.answer', { eventId: 'e_staff', way: 'propose', start: at(14), end: at(15) })
    expect(calls).toEqual([
      { fn: 'calendarOps:save', args: { kind: 'propose', eventId: 'e_staff', payload: { proposedStart: at(14), proposedEnd: at(15) } } },
      { fn: 'calendarOps:send', args: { id: 'op_1', cause: 'press' } }
    ])
  })

  it("moves a calendar's event on its calendar", async () => {
    answers['events:get'] = () => ({ _id: 'e_game', source: 'gcal', startsAt: at(17, 30) })
    // Handed to LifeOS's sender for the calendar: queued, not yet done.
    expect(await call('work.clashes.answer', { eventId: 'e_game', way: 'move', start: at(18), end: at(20) })).toEqual({ queued: true })
    expect(calls.slice(1)).toEqual([
      { fn: 'calendarOps:save', args: { kind: 'update', eventId: 'e_game', payload: { startsAt: at(18), endsAt: at(20) } } },
      { fn: 'calendarOps:send', args: { id: 'op_1', cause: 'press' } }
    ])
  })

  it('moves an event that lives only in LifeOS there, with nothing sent', async () => {
    answers['events:get'] = () => ({ _id: 'e_game', source: 'manual', startsAt: at(17, 30) })
    // Written in LifeOS itself: done when it answers.
    expect(await call('work.clashes.answer', { eventId: 'e_game', way: 'move', start: at(18), end: at(20) })).toEqual({ queued: false })
    expect(calls).toEqual([
      { fn: 'events:get', args: { id: 'e_game' } },
      { fn: 'events:update', args: { id: 'e_game', patch: { startsAt: at(18), endsAt: at(20) } } }
    ])
  })

  it('moves its arrive-by and a leave-by he set by hand with it, by as much, so the lead the offer left is still there and LifeOS takes the move', async () => {
    // An 8:00 PM game that wants him there at 7:45, with 7:10 set by hand to leave, moved to 8:15: there by 8:00, leave at 7:25.
    answers['events:get'] = () => ({ _id: 'e_game', source: 'manual', startsAt: at(20), arriveByAt: at(19, 45), leaveByAt: at(19, 10) })
    await call('work.clashes.answer', { eventId: 'e_game', way: 'move', start: at(20, 15), end: at(22, 15) })
    expect(calls.at(-1)).toEqual({ fn: 'events:update', args: { id: 'e_game', patch: { startsAt: at(20, 15), endsAt: at(22, 15), arriveByAt: at(20), leaveByAt: at(19, 25) } } })
    // Moved earlier, past where the old leave-by stood: it goes earlier too, never after the new start.
    calls.length = 0
    answers['events:get'] = () => ({ _id: 'e_game', source: 'manual', startsAt: at(16), leaveByAt: at(15, 45) })
    await call('work.clashes.answer', { eventId: 'e_game', way: 'move', start: at(15, 30), end: at(16, 30) })
    expect(calls.at(-1)).toEqual({ fn: 'events:update', args: { id: 'e_game', patch: { startsAt: at(15, 30), endsAt: at(16, 30), leaveByAt: at(15, 15) } } })
  })

  it('reads the pair the time was offered from again, and sends nothing when a calendar changed it since', async () => {
    const seen = [
      { eventId: 'e_staff', startsAt: at(16), endsAt: at(17) },
      { eventId: 'e_game', startsAt: at(17, 30), endsAt: at(19, 30) }
    ]
    const events: Record<string, unknown> = { e_staff: { startsAt: at(16), endsAt: at(17) }, e_game: { source: 'gcal', startsAt: at(17, 30), endsAt: at(19, 30) } }
    answers['events:get'] = (args) => events[args.id as string] ?? null
    await call('work.clashes.answer', { eventId: 'e_staff', way: 'propose', start: at(14), end: at(15), seen })
    expect(calls.map((c) => c.fn)).toEqual(['events:get', 'events:get', 'calendarOps:save', 'calendarOps:send'])
    // The meeting now runs to 7:00 PM: the offer was made against 5:00.
    calls.length = 0
    events.e_staff = { startsAt: at(16), endsAt: at(19) }
    await expect(call('work.clashes.answer', { eventId: 'e_game', way: 'move', start: at(18), end: at(20), seen })).rejects.toThrow(/^These events changed\. Go back for a new time\.$/)
    expect(calls.map((c) => c.fn)).toEqual(['events:get'])
  })

  it("refuses a thread's call whatever its key holds, and a key without approve, before LifeOS is asked", async () => {
    await expect(call('work.clashes.answer', { eventId: 'e_staff', way: 'decline' }, MODEL)).rejects.toThrow('Only the owner answers a clash')
    await expect(call('work.clashes.answer', { eventId: 'e_staff', way: 'decline' }, REMOTE)).rejects.toThrow('Only the owner answers a clash')
    expect(calls).toEqual([])
  })

  it('refuses a time with no end or an end before its start, and passes on a LifeOS refusal in its words', async () => {
    await expect(call('work.clashes.answer', { eventId: 'e_staff', way: 'propose', start: at(14) })).rejects.toThrow('A new time needs a start and an end.')
    await expect(call('work.clashes.answer', { eventId: 'e_staff', way: 'move', start: at(14), end: at(13) })).rejects.toThrow('The end must come after the start.')
    answers['calendarOps:save'] = () => {
      throw Object.assign(new Error('[CONVEX M(calendarOps:save)] Uncaught ConvexError: This invitation has no organizer to answer.'), { data: 'This invitation has no organizer to answer.' })
    }
    await expect(call('work.clashes.answer', { eventId: 'e_staff', way: 'decline' })).rejects.toThrow(/^This invitation has no organizer to answer\.$/)
  })
})

describe('clashes_list', () => {
  const scope = (sector: string | null, workspaceId: string | null): WorkScope => ({ sessionId: 't1', workspaceId, sector, host: 'env_box', away: false, routineRunId: null, shared: () => false })
  const run = async (s: WorkScope, args: Record<string, unknown> = {}) => {
    const out = await clashesListTool.run(args, { ...ctx, scope: s, sessionId: 't1', signal: new AbortController().signal } as ToolCtx)
    return { text: (out.content[0] as { text: string }).text, error: out.isError === true }
  }

  it("lists the thread's job's clashes and shows another job's event as its job and times alone", async () => {
    const { text, error } = await run(scope('purdue', 'ws-purdue'))
    expect(error).toBe(false)
    expect(text).toContain("Purdue's clashes over the next 7 days, times in America/Indiana/Indianapolis:")
    expect(text).toContain('Staff meeting (Purdue, 4:00 PM to 5:00 PM, at Room 210, Elm Hall, event e_staff, can decline, propose)')
    expect(text).toContain('- Thu, Nov 26: not enough time to drive from')
    expect(text).toContain('a Ref event (5:30 PM to 7:30 PM)')
    // the other job's title, place and drive never reach the thread; nor do the minutes short, which with the
    // two times give the drive (15 short of a 30 minute gap: 45 minutes from Room 210)
    for (const hidden of ['Varsity Basketball', 'Maple Ridge', 'Cedar Falls', 'e_game', '24 mi', '45 min', '15 min', 'about'])
      expect(text).not.toContain(hidden)
    // a clash of two other jobs is not this thread's
    expect(text).not.toContain('Build review')
    expect(text).not.toContain('Lunch with Sam')
    expect(calls.find((c) => c.fn === 'clashes:range')?.args).toMatchObject({ to: expect.any(Number) })
  })

  it('reads a Work Chat only for the job it names, and refuses another job from a job\'s thread', async () => {
    expect((await run(scope(null, null))).error).toBe(true)
    const life = await run(scope(null, null), { sector: 'life', days: 14 })
    expect(life.text).toContain('Lunch with Sam (Life, 12:00 PM to 1:00 PM, at Corner Cafe, event e_lunch) overlaps a Cosmic event (12:30 PM to 1:30 PM).')
    expect(life.text).not.toContain('Build review')
    const range = calls.filter((c) => c.fn === 'clashes:range').at(-1)!.args as { from: number; to: number }
    expect(range.to - range.from).toBe(14 * 86_400_000)
    expect((await run(scope('purdue', 'ws-purdue'), { sector: 'ref' })).text).toBe("This thread reads only the purdue job's clashes.")
  })

  it('gives the minutes short and the drive when both events are the thread\'s job', async () => {
    const lab = side({ eventId: 'e_lab', sector: 'purdue', title: 'Lab tour', startsAt: at(17, 30), endsAt: at(18, 30), location: 'West Campus' })
    answers['clashes:range'] = () => ({ clashes: [{ ...driveClash, id: 'e_staff-e_lab', b: lab }], leaves: [] })
    const { text } = await run(scope('purdue', 'ws-purdue'))
    expect(text).toContain('- Thu, Nov 26: 15 min short to drive from Staff meeting')
    expect(text).toContain('to Lab tour (Purdue, 5:30 PM to 6:30 PM, at West Campus, event e_lab) (45 min drive, 24 mi).')
  })

  it("says each event's own day: a block of weeks, an event the night before, and the second 1:30 AM", async () => {
    const block = side({ eventId: 'e_block', sector: 'purdue', title: 'Block', startsAt: at(9, 0, 2), endsAt: at(17, 0, 22) })
    const late = side({ eventId: 'e_late', sector: 'purdue', title: 'Late call', startsAt: at(23, 0, 23), endsAt: at(23, 45, 23) })
    const early = side({ eventId: 'e_early', sector: 'ref', startsAt: at(0, 15, 24), endsAt: at(2, 0, 24) })
    answers['clashes:range'] = () => ({
      clashes: [
        { id: 'e_block-e_game', kind: 'overlap', a: block, b: side({ eventId: 'e_g', sector: 'ref', startsAt: at(18, 0, 20), endsAt: at(20, 0, 20) }) },
        { id: 'e_late-e_early', kind: 'drive', a: late, b: early, minutes: 40, measured: true, shortBy: 10 },
        // Nov 1 2026, the clocks go back at 2:00 AM: 1:30 EST is the second 1:30 AM
        { id: 'e_x-e_y', kind: 'overlap', a: side({ eventId: 'e_x', sector: 'purdue', title: 'Night shift', startsAt: at(0, 0, 1), endsAt: at(3, 0, 1) }), b: side({ eventId: 'e_y', sector: 'ref', startsAt: at(1, 30, 1), endsAt: at(2, 30, 1) }) }
      ],
      leaves: []
    })
    const { text } = await run(scope('purdue', 'ws-purdue'))
    // under the game's day, not the block's first one
    expect(text).toContain('- Fri, Nov 20: Block (Purdue, Nov 2, 9:00 AM to Nov 22, 5:00 PM, event e_block) overlaps a Ref event (6:00 PM to 8:00 PM).')
    // under the later event's day, the earlier one's start with its own weekday
    expect(text).toContain('- Tue, Nov 24: not enough time to drive from Late call (Purdue, Mon 11:00 PM to 11:45 PM, event e_late) to a Ref event (12:15 AM to 2:00 AM).')
    expect(text).toContain('overlaps a Ref event (second 1:30 AM to 2:30 AM).')
  })

  it('refuses a Work thread with no Work home: it reads no job, as a Work Chat would every one', async () => {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('t1', 'repo', null)
    const out = await run(scope(null, null), { sector: 'purdue' })
    expect(out).toEqual({ text: 'This thread belongs to no Work workspace, so it reads no job.', error: true })
    expect(calls.filter((c) => c.fn === 'clashes:range')).toEqual([])
    // A Work Chat (its row names no workspace) still reads the job it names.
    db.prepare("UPDATE sessions SET workspace_id = NULL WHERE id = 't1'").run()
    expect((await run(scope(null, null), { sector: 'purdue' })).error).toBe(false)
  })

  it('says so when there are none', async () => {
    answers['clashes:range'] = () => ({ clashes: [], leaves: [] })
    expect((await run(scope('purdue', 'ws-purdue'), { days: 1 })).text).toBe('No clashes for Purdue over the next day.')
  })
})

describe('the tell', () => {
  let told: Tell[]
  let done: string[]
  const flush = () => new Promise((r) => setTimeout(r, 5))
  const range = (...c: LifeosClash[]): LifeosRange => ({ clashes: c, leaves: [] })
  const giveTell = () => {
    const tell = Object.assign((t: Tell) => void told.push(t), { done: (key: string) => void done.push(key), quiet: () => {} })
    ;(ctx as unknown as { tell: unknown }).tell = tell
  }
  const rows = () => db.prepare('SELECT key FROM work_clashes_told ORDER BY key').all() as { key: string }[]

  beforeEach(() => {
    told = []
    done = []
    giveTell()
  })

  it("watches today and the next fourteen days in his zone, and moves on when his day turns", async () => {
    let now = at(10)
    const stop = watchClashes(ctx, () => now)
    await flush()
    expect(subs.at(-1)).toMatchObject({ fn: 'clashes:range', args: { from: at(0), to: at(0) + SPAN_DAYS * 86_400_000 } })
    now = at(0, 30, 27)
    subs.at(-1)!.on(range())
    await flush()
    expect(subs.at(-2)!.off).toBe(true)
    expect(subs.at(-1)!.args.from).toBe(at(0, 0, 27))
    stop()
    expect(subs.at(-1)!.off).toBe(true)
  })

  it('tells a new clash once from the earlier job\'s workspace, again when an event moves, and takes it back when it is gone', async () => {
    const stop = watchClashes(ctx, () => at(9))
    await flush()
    subs.at(-1)!.on(range(driveClash))
    await flush()
    expect(pushes).toEqual([{ push: 'work.clashes' }])
    expect(told).toEqual([
      {
        kind: 'clashes.new',
        workspaceId: 'ws-purdue',
        title: '15 min short between Staff meeting and Varsity Basketball',
        detail: 'Thu, Nov 26, 5:30 PM, Ref and Purdue',
        open: { view: 'agenda', workspaceId: 'ws-purdue', at: 'e_staff' },
        // today's clash: by its start
        by: at(17, 30),
        key: 'clash:e_staff-e_game'
      }
    ])
    // the same clash again: nothing new
    subs.at(-1)!.on(range(driveClash, overlapClash))
    await flush()
    expect(told.map((t) => t.key)).toEqual(['clash:e_staff-e_game', 'clash:e_lunch-e_call'])
    // a later day's clash carries its start too: the digest holds it until that comes near
    expect(told[1]?.by).toBe(at(12, 30, 28))
    expect(told[1]?.workspaceId).toBe('ws-life')
    // the game moved: told again under the same key
    const moved = { ...driveClash, b: { ...game, startsAt: at(17, 45) } }
    subs.at(-1)!.on(range(moved, overlapClash))
    await flush()
    expect(told.map((t) => t.key)).toEqual(['clash:e_staff-e_game', 'clash:e_lunch-e_call', 'clash:e_staff-e_game'])
    // gone (moved apart, or fine by him)
    subs.at(-1)!.on(range(overlapClash))
    await flush()
    expect(done).toEqual(['clash:e_staff-e_game'])
    expect(rows()).toEqual([{ key: 'clash:e_lunch-e_call' }])
    stop()
  })

  it('gives a clash early tomorrow, found the evening before, a clock that interrupts before the 8:00 AM digest', async () => {
    const stop = watchClashes(ctx, () => at(21))
    await flush()
    const dawn = { ...driveClash, a: { ...staff, startsAt: at(6, 30, 27), endsAt: at(7, 0, 27) }, b: { ...game, startsAt: at(7, 0, 27), endsAt: at(9, 0, 27) } }
    subs.at(-1)!.on(range(dawn))
    await flush()
    expect(told[0]?.by).toBe(at(7, 0, 27))
    expect(decide(told[0]!, 'clock', at(8, 0, 27))).toBe('now')
    // one two weeks out waits for the digest that comes before it
    expect(decide({ by: at(18, 0, 30) }, 'clock', at(8, 0, 27))).toBe('wait')
    stop()
  })

  it("tells nothing when this host holds no workspace of the earlier event's job", async () => {
    const stop = watchClashes(ctx, () => at(9))
    await flush()
    const refFirst = { ...driveClash, id: 'e_game-e_staff', a: game, b: staff }
    subs.at(-1)!.on(range(refFirst))
    await flush()
    expect(told).toEqual([])
    expect(rows()).toEqual([])
    stop()
  })

  it('declares its kind for the digest', () => {
    expect(clashes.tells).toEqual([{ kind: 'clashes.new', group: 'clashes', name: 'Clashes' }])
  })
})

describe('with Work off', () => {
  it('answers nothing, asks LifeOS nothing, and the watcher tells nothing', async () => {
    on = false
    const told: unknown[] = []
    ;(ctx as unknown as { tell: unknown }).tell = Object.assign((t: unknown) => void told.push(t), { done: () => {} })
    for (const [method, params] of [
      ['work.clashes.list', { from: at(0), to: at(0, 0, 27) }],
      ['work.clashes.leave', { eventId: 'e_game' }],
      ['work.clashes.miles', { workspaceId: 'ws-purdue', from: { start: true }, to: { event: 'e_game' } }],
      ['work.clashes.waive', { id: 'e_staff-e_game', on: true }],
      ['work.clashes.answer', { eventId: 'e_staff', way: 'decline' }]
    ] as const)
      await expect(call(method, params)).rejects.toThrow('Work is off on this host.')
    const tool = await clashesListTool.run({}, { ...ctx, scope: { sessionId: 't1', workspaceId: 'ws-purdue', sector: 'purdue', host: 'env_box', away: false, routineRunId: null, shared: () => false }, sessionId: 't1', signal: new AbortController().signal } as ToolCtx)
    expect(tool.isError).toBe(true)
    const stop = watchClashes(ctx, () => at(9))
    subs.at(-1)!.on({ clashes: [driveClash], leaves: [] })
    await new Promise((r) => setTimeout(r, 5))
    expect(pushes).toEqual([])
    expect(told).toEqual([])
    expect(calls.filter((c) => c.fn !== 'settings:get')).toEqual([])
    stop()
  })
})
