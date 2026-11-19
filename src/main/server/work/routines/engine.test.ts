import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSchedule, scheduleRrule, scheduleWords, type RoutineRun } from '@shared/contract-work-routines'
import type { SessionMeta } from '@shared/events'
import type { WorkPush } from '@shared/contract-work'
import type { Trigger } from '@shared/work'
import { RoutinesEngine, LIFEOS_SINCE, noteOwnWrite, type EngineDeps, type LifeosEvent } from './engine'
import type { RoutinesHost } from './host'
import { dueCount, nextAt } from './schedule'
import { ensureRoutineTables, type NewRoutine } from './store'

/**
 * The scheduler and its triggers against a clock the test moves and a host
 * the test plays: no model turn, no LifeOS, no add-on server.
 */

const TZ = 'America/New_York'
/** Monday, Nov 16 2026, at a wall time in New York. */
const at = (day: number, hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return Date.parse(`2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`)
}
const WEEKDAYS_7AM: Trigger = { on: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0', tz: TZ }

interface Rig {
  db: DatabaseSync
  clock: { now: number }
  engine: RoutinesEngine
  started: { workspaceId: string; text: string; routineRunId?: string; model?: string }[]
  woke: { sessionId: string; text: string }[]
  sessions: Map<string, SessionMeta>
  read: string[]
  marks: { read: string[]; unread: string[] }
  held: Map<string, number>
  pushes: WorkPush[]
  subs: { fn: string; args: { sector: string; after: number }; on: (v: unknown) => void; off: boolean }[]
  lifeosUp: { value: boolean }
  readAnswer: { text: string; runs: boolean }
  files: Map<string, string>
  /** a thread's status changed, as the registry would say */
  settle(sessionId: string, status: SessionMeta['status']): void
  stop(): void
  add(n: Partial<NewRoutine> & { trigger: Trigger }): string
  /** a new engine on the same database: a restart */
  restart(): void
}

function makeRig(): Rig {
  const db = new DatabaseSync(':memory:')
  ensureRoutineTables(db)
  const clock = { now: at(16, '06:00') }
  const sessions = new Map<string, SessionMeta>()
  const metaFns = new Set<(s: SessionMeta) => void>()
  const rig = {
    db,
    clock,
    started: [],
    woke: [],
    sessions,
    read: [],
    marks: { read: [], unread: [] },
    held: new Map(),
    pushes: [],
    subs: [],
    lifeosUp: { value: true },
    readAnswer: { text: 'no reply yet', runs: true },
    files: new Map()
  } as unknown as Rig
  let n = 0
  const host: RoutinesHost = {
    workspace: (id) => ({ id, name: id, sector: id === 'ws-purdue' ? 'purdue' : id === 'ws-cosmic' ? 'cosmic' : null }) as never,
    addon: (_ws, name) => ({ id: `addon-${name}`, name }) as never,
    mayRead: () => rig.readAnswer.runs,
    read: async (addonId, tool, args) => {
      rig.read.push(`${addonId}/${tool} ${JSON.stringify(args)}`)
      return { content: [{ type: 'text', text: rig.readAnswer.text }] } as never
    },
    session: (id) => sessions.get(id) ?? null,
    onMeta: (fn) => (metaFns.add(fn), () => metaFns.delete(fn)),
    markRead: (id) => void rig.marks.read.push(id),
    markUnread: (id) => void rig.marks.unread.push(id),
    heldIn: (id) => rig.held.get(id) ?? 0
  }
  const make = (): RoutinesEngine => {
    const deps: EngineDeps = {
      ctx: {
        db,
        host: 'env_box',
        log: () => {},
        push: (p) => void rig.pushes.push(p),
        threads: {
          start: async (o) => {
            const id = `t${++n}`
            sessions.set(id, { id, status: 'running', routineRunId: o.routineRunId, scope: 'work' } as unknown as SessionMeta)
            rig.started.push(o)
            return id
          },
          resume: async (sessionId, text) => void rig.woke.push({ sessionId, text }),
          ownerSaid: () => false
        },
        lifeos: {
          connected: () => rig.lifeosUp.value,
          owner: () => {
            throw new Error('no owner client in this test')
          },
          jwt: async () => 'jwt',
          subscribe: (fn, args, on) => {
            const sub = { fn, args: args as { sector: string; after: number }, on: on as (v: unknown) => void, off: false }
            rig.subs.push(sub)
            return () => void (sub.off = true)
          }
        }
      },
      host,
      now: () => clock.now,
      files: {
        stat: (p) => (rig.files.has(p) ? { mtimeMs: rig.files.get(p)!.length * 1000 + rig.files.get(p)!.charCodeAt(0), size: rig.files.get(p)!.length } : null),
        read: (p) => (rig.files.has(p) ? Buffer.from(rig.files.get(p)!) : null)
      }
    }
    return new RoutinesEngine(deps)
  }
  let stop = () => {}
  rig.engine = make()
  stop = rig.engine.start({ interval: false })
  rig.stop = () => stop()
  rig.restart = () => {
    stop()
    rig.engine = make()
    stop = rig.engine.start({ interval: false })
  }
  rig.settle = (sessionId, status) => {
    const s = { ...sessions.get(sessionId)!, status }
    sessions.set(sessionId, s)
    for (const fn of metaFns) fn(s)
  }
  rig.add = (o) => {
    const s = o.trigger.on === 'schedule' ? parseSchedule(o.trigger.rrule) : null
    return rig.engine.store.create(
      {
        workspaceId: 'ws-purdue',
        kind: 'routine',
        name: 'Morning sweep',
        prompt: 'Read Purdue mail and tell me what needs me.',
        ends: { kind: 'never' },
        nextAt: s && o.trigger.on === 'schedule' ? nextAt(s, o.trigger.tz, clock.now) : o.trigger.on === 'read' || o.trigger.on === 'file' ? clock.now : null,
        cursor: o.trigger.on === 'lifeos' || (o.trigger.on === 'file' && o.trigger.source.at === 'lifeos') ? { after: clock.now } : {},
        createdBy: 'owner',
        ...o
      },
      clock.now
    ).id
  }
  return rig
}

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => rig.stop())

const tickAt = async (t: number): Promise<void> => {
  rig.clock.now = t
  await rig.engine.tick()
}
const runs = (id: string): RoutineRun[] => rig.engine.store.runs(id)

describe('the schedule', () => {
  it('reads and writes its rules, and says them in words', () => {
    const s = parseSchedule(WEEKDAYS_7AM.on === 'schedule' ? WEEKDAYS_7AM.rrule : '')!
    expect(s).toEqual({ every: 'week', days: [1, 2, 3, 4, 5], hour: 7, minute: 0 })
    expect(scheduleWords(s)).toBe('Weekdays at 7:00 AM')
    expect(scheduleWords(parseSchedule('FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=15;BYMINUTE=0')!)).toBe('Tue and Thu at 3:00 PM')
    expect(scheduleWords(parseSchedule('FREQ=MINUTELY;INTERVAL=15')!)).toBe('Every 15 minutes')
    expect(scheduleRrule(parseSchedule('FREQ=HOURLY;INTERVAL=2')!)).toBe('FREQ=HOURLY;INTERVAL=2')
    expect(parseSchedule('FREQ=MINUTELY;INTERVAL=1')).toBeNull()
    expect(parseSchedule('FREQ=YEARLY;BYMONTH=1')).toBeNull()
  })

  it('keeps 7:00 on the wall clock of its own zone across a clock change', () => {
    const s = parseSchedule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=7;BYMINUTE=0')!
    // Sunday Nov 1 2026 is the day New York leaves daylight time.
    const first = nextAt(s, TZ, Date.parse('2026-10-25T08:00:00-04:00'))
    expect(new Date(first).toISOString()).toBe('2026-11-01T12:00:00.000Z')
    expect(new Date(nextAt(s, TZ, Date.parse('2026-10-24T08:00:00-04:00'))).toISOString()).toBe('2026-10-25T11:00:00.000Z')
    expect(dueCount(s, TZ, Date.parse('2026-10-25T11:00:00.000Z'), Date.parse('2026-11-08T12:00:00.000Z'))).toBe(3)
  })
})

describe('a weekday routine on a fake clock', () => {
  it('fires once per due time, and only on weekdays', async () => {
    const id = rig.add({ trigger: WEEKDAYS_7AM })
    await tickAt(at(16, '06:59'))
    expect(rig.started).toHaveLength(0)
    await tickAt(at(16, '07:00'))
    expect(rig.started).toHaveLength(1)
    expect(rig.started[0]).toMatchObject({ workspaceId: 'ws-purdue', routineRunId: runs(id)[0]!.id })
    expect(rig.started[0]!.text).toMatch(/^Read Purdue mail and tell me what needs me\.\n\n---\nStarted by the routine “Morning sweep”: Weekdays at 7:00 AM\.$/)
    // ticking on through the morning fires nothing more
    for (const t of ['07:00', '07:01', '09:30', '23:59']) await tickAt(at(16, t))
    expect(rig.started).toHaveLength(1)
    rig.settle('t1', 'idle')
    for (const day of [17, 18, 19, 20, 21, 22, 23]) {
      await tickAt(at(day, '07:00'))
      const last = runs(id)[0]!
      if (last.state === 'running') rig.settle(last.sessionId!, 'idle')
    }
    // Tue to Fri, then Mon 23: Saturday and Sunday fire nothing
    expect(rig.started).toHaveLength(6)
    expect(runs(id).every((r) => r.folded === 0)).toBe(true)
  })

  it('folds three runs missed while the host was down into one', async () => {
    const id = rig.add({ trigger: WEEKDAYS_7AM })
    await tickAt(at(17, '07:00'))
    rig.settle('t1', 'idle')
    // the host is down from Tuesday morning to Friday 9:00: Wed, Thu and Fri are missed
    rig.restart()
    await tickAt(at(20, '09:00'))
    expect(rig.started).toHaveLength(2)
    const folded = runs(id)[0]!
    expect(folded).toMatchObject({ folded: 2, cause: 'Weekdays at 7:00 AM' })
    expect(rig.started[1]!.text).toContain('(3 times due since the last run; this one run covers them)')
    // the next is Monday, not another catch-up
    expect(rig.engine.store.get(id)!.nextAt).toBe(at(23, '07:00'))
    rig.settle('t2', 'idle')
    await tickAt(at(20, '09:01'))
    expect(rig.started).toHaveLength(2)
  })

  it('loses no schedule when the host is killed mid-run', async () => {
    const id = rig.add({ trigger: WEEKDAYS_7AM })
    await tickAt(at(16, '07:00'))
    expect(runs(id)[0]!.state).toBe('running')
    // killed while the run's thread works; it comes back stopped
    rig.sessions.set('t1', { ...rig.sessions.get('t1')!, status: 'stopped' })
    rig.restart()
    expect(runs(id)[0]).toMatchObject({ state: 'failed', summary: 'Failed' })
    expect(rig.marks.unread).toEqual(['t1'])
    expect(rig.engine.store.get(id)!.nextAt).toBe(at(17, '07:00'))
    await tickAt(at(16, '12:00'))
    expect(rig.started).toHaveLength(1)
    await tickAt(at(17, '07:00'))
    expect(rig.started).toHaveLength(2)
  })

  it('a kill before the run had its thread leaves a failed run and the next due time, never a second firing', async () => {
    const id = rig.add({ trigger: WEEKDAYS_7AM })
    // the row is written with the next due time before the thread is asked for: cut the process there
    const r = rig.engine.store.get(id)!
    rig.engine.store.newRun(id, at(16, '07:00'), 'Weekdays at 7:00 AM', 0, 'starting', { nextAt: at(17, '07:00') })
    expect(r.nextAt).toBe(at(16, '07:00'))
    rig.restart()
    expect(runs(id)[0]).toMatchObject({ state: 'failed', summary: 'Failed: the host stopped before its thread started' })
    await tickAt(at(16, '07:05'))
    expect(rig.started).toHaveLength(0)
    await tickAt(at(17, '07:00'))
    expect(rig.started).toHaveLength(1)
  })

  it('a firing due while the last run still works folds into it', async () => {
    const id = rig.add({ trigger: { on: 'schedule', rrule: 'FREQ=MINUTELY;INTERVAL=15', tz: TZ } })
    rig.engine.store.setNext(id, at(16, '07:00'))
    await tickAt(at(16, '07:00'))
    await tickAt(at(16, '07:15'))
    await tickAt(at(16, '07:30'))
    expect(rig.started).toHaveLength(1)
    expect(runs(id)[0]!.folded).toBe(2)
  })
})

describe('a run as it settles', () => {
  it('is marked read when quiet, and unread when it held something, asked something or failed', async () => {
    const id = rig.add({ trigger: WEEKDAYS_7AM })
    await tickAt(at(16, '07:00'))
    rig.settle('t1', 'idle')
    expect(runs(id)[0]).toMatchObject({ state: 'quiet', summary: 'Nothing held' })
    expect(rig.marks).toEqual({ read: ['t1'], unread: [] })
    await tickAt(at(17, '07:00'))
    rig.held.set('t2', 2)
    rig.settle('t2', 'idle')
    expect(runs(id)[0]).toMatchObject({ state: 'held', summary: 'Held 2' })
    await tickAt(at(18, '07:00'))
    rig.settle('t3', 'waiting')
    expect(runs(id)[0]).toMatchObject({ state: 'asked' })
    await tickAt(at(19, '07:00'))
    rig.settle('t4', 'error')
    expect(runs(id)[0]).toMatchObject({ state: 'failed' })
    expect(rig.marks.unread).toEqual(['t2', 't3', 't4'])
    expect(rig.engine.row(rig.engine.store.get(id)!)).toMatchObject({ lastState: 'failed', running: false, words: 'Weekdays at 7:00 AM' })
  })
})

describe('a watch', () => {
  const watch = (o: { once?: boolean; fire?: 'changed' | 'non-empty' } = {}): string =>
    rig.add({
      kind: 'watch',
      name: 'Reply from events booking',
      trigger: { on: 'read', addon: 'addon-outlook', tool: 'search_mail', args: { from: 'events@purdue.edu' }, fire: o.fire ?? 'changed', everySec: 600 },
      ends: { kind: 'once' },
      resumeSessionId: 't-plan',
      createdBy: 'model'
    })
  beforeEach(() => {
    rig.sessions.set('t-plan', { id: 't-plan', status: 'idle', scope: 'work' } as unknown as SessionMeta)
  })

  it('reads with no model at its pace, fires on a change, wakes its thread and closes', async () => {
    const id = watch()
    await tickAt(at(16, '09:00'))
    await tickAt(at(16, '09:05'))
    await tickAt(at(16, '09:10'))
    // a baseline, then one read ten minutes on; the same answer fires nothing
    expect(rig.read).toEqual([`addon-outlook/search_mail {"from":"events@purdue.edu"}`, `addon-outlook/search_mail {"from":"events@purdue.edu"}`])
    expect(rig.woke).toEqual([])
    rig.readAnswer.text = 'Re: Ballroom for the spring LAN: it is yours on March 6.'
    await tickAt(at(16, '09:20'))
    expect(rig.started).toEqual([])
    expect(rig.woke).toEqual([{ sessionId: 't-plan', text: 'Your watch “Reply from events booking” fired: What it reads changed.\n\nRe: Ballroom for the spring LAN: it is yours on March 6.' }])
    expect(runs(id)[0]).toMatchObject({ state: 'fired', sessionId: 't-plan' })
    expect(rig.engine.row(rig.engine.store.get(id)!)).toMatchObject({ ended: true, enabled: false })
    // closed: no more reads
    await tickAt(at(16, '10:00'))
    expect(rig.read).toHaveLength(3)
  })

  it('reads nothing once its tool is no longer set to Runs', async () => {
    const id = watch()
    rig.readAnswer.runs = false
    await tickAt(at(16, '09:00'))
    expect(rig.read).toEqual([])
    expect(rig.engine.store.get(id)!.lastWords).toBe('Waiting: its tool is not set to Runs')
  })

  it('"non-empty" fires on the first answer with something in it', async () => {
    watch({ fire: 'non-empty' })
    rig.readAnswer.text = '[]'
    await tickAt(at(16, '09:00'))
    expect(rig.woke).toEqual([])
    rig.readAnswer.text = '[{"subject":"Re: Ballroom"}]'
    await tickAt(at(16, '09:10'))
    expect(rig.woke).toHaveLength(1)
  })

  it('with a day ends on that day without firing, and a watch whose thread is gone ends', async () => {
    const id = watch()
    rig.db.prepare(`UPDATE work_routines SET until_at = ?, once = 0 WHERE id = ?`).run(at(17, '00:00'), id)
    await tickAt(at(17, '00:01'))
    expect(rig.engine.store.get(id)).toMatchObject({ ended: true })
    const other = watch()
    rig.sessions.delete('t-plan')
    rig.readAnswer.text = 'changed'
    await tickAt(at(17, '00:02'))
    rig.readAnswer.text = 'changed again'
    await tickAt(at(17, '00:30'))
    expect(runs(other)[0]).toMatchObject({ state: 'failed', summary: 'Failed: its thread is gone' })
  })
})

describe('LifeOS events', () => {
  it('one subscription per workspace, in its own sector: a mail in Purdue starts the Purdue routine only', async () => {
    const purdue = rig.add({ name: 'Mail from events booking', trigger: { on: 'lifeos', kinds: ['mail.received'] } })
    const purdueTasks = rig.add({ name: 'Invoice tasks', trigger: { on: 'lifeos', kinds: ['task.created'] } })
    const cosmic = rig.add({ workspaceId: 'ws-cosmic', name: 'Cosmic mail', trigger: { on: 'lifeos', kinds: ['mail.received'] } })
    await tickAt(at(16, '09:00'))
    const live = () => rig.subs.filter((s) => !s.off)
    expect(live().map((s) => [s.fn, s.args.sector])).toEqual([
      [LIFEOS_SINCE, 'purdue'],
      [LIFEOS_SINCE, 'cosmic']
    ])
    const page = (events: LifeosEvent[]) => ({ events, next: events.at(-1)!.at })
    const t0 = at(16, '06:00')
    live()[0]!.on(page([{ sector: 'purdue', kind: 'mail.received', ref: { table: 'mailThreads', id: 'mt1' }, at: t0 + 1 }]))
    await Promise.resolve()
    expect(rig.started).toHaveLength(1)
    expect(rig.started[0]!.text).toContain('Started by the routine “Mail from events booking”: New mail.\nWhat it heard: mail.received mailThreads/mt1')
    expect(runs(purdue)).toHaveLength(1)
    expect(runs(purdueTasks)).toHaveLength(0)
    expect(runs(cosmic)).toHaveLength(0)
    // every Purdue cursor moved; the feed follows from there
    expect(rig.engine.store.get(purdueTasks)!.cursor.after).toBe(t0 + 1)
    expect(live().map((s) => [s.args.sector, s.args.after])).toEqual([
      ['cosmic', t0],
      ['purdue', t0 + 1]
    ])
    // the same page again (a re-answer) fires nothing
    rig.subs[0]!.on(page([{ sector: 'purdue', kind: 'mail.received', ref: { table: 'mailThreads', id: 'mt1' }, at: t0 + 1 }]))
    expect(rig.started).toHaveLength(1)
  })

  it('waits while LifeOS is down, and says so', async () => {
    const id = rig.add({ trigger: { on: 'lifeos', kinds: ['mail.received'] } })
    rig.lifeosUp.value = false
    await tickAt(at(16, '09:00'))
    expect(rig.subs).toEqual([])
    expect(rig.engine.row(rig.engine.store.get(id)!).waiting).toBe('Waiting on LifeOS')
    rig.lifeosUp.value = true
    await tickAt(at(16, '09:01'))
    expect(rig.subs.filter((s) => !s.off)).toHaveLength(1)
  })

  it('a LifeOS document fires on its own doc.changed event', async () => {
    const id = rig.add({ name: 'Budget', trigger: { on: 'file', source: { at: 'lifeos', table: 'docs', id: 'd1' }, by: 'someone-else' } })
    await tickAt(at(16, '09:00'))
    const t0 = at(16, '06:00')
    rig.subs[0]!.on({
      events: [
        { sector: 'purdue', kind: 'doc.changed', ref: { table: 'docs', id: 'd2' }, at: t0 + 1 },
        { sector: 'purdue', kind: 'doc.changed', ref: { table: 'docs', id: 'd1' }, at: t0 + 2 }
      ],
      next: t0 + 2
    })
    expect(runs(id)).toHaveLength(1)
  })
})

describe('a file on this host', () => {
  it('fires when someone else changes it, never on the first look or on its own write', async () => {
    const path = '/work/Nationals travel budget.xlsx'
    rig.files.set(path, 'v1')
    const id = rig.add({ name: 'Nationals travel budget', trigger: { on: 'file', source: { at: 'file', host: 'env_box', path }, by: 'someone-else' } })
    await tickAt(at(16, '09:00'))
    expect(rig.started).toHaveLength(0)
    rig.files.set(path, 'written by an agent here')
    noteOwnWrite(path, 'written by an agent here')
    await tickAt(at(16, '09:01'))
    expect(rig.started).toHaveLength(0)
    rig.files.set(path, 'Dana changed the hotel line')
    await tickAt(at(16, '09:02'))
    expect(rig.started).toHaveLength(1)
    expect(runs(id)[0]!.cause).toBe('Nationals travel budget.xlsx changed')
  })
})
