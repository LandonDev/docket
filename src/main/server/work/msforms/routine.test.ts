import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import { TriggerSchema, type Trigger, type TriggerRange } from '@shared/work'
import type { Caller } from '../modules'
import { emitNewAnswers } from './events'
import {
  answerTaskKey,
  checkpointOf,
  ensureMsformJobs,
  fileAnswerTasks,
  FORM_NOT_IN_WORKSPACE,
  JOB_NEEDS_FORM,
  MSFORM_TASKS_JOB,
  MSFORM_TASKS_MOST,
  msformRoutineRefusal,
  msformTrigger,
  setTriggerDb,
  WITHHELD_ROUTINE
} from './routine'
import { ensureMsformsTables, MsformsStore } from './store'
import { answersWithheld, refuseWithheld, routineWithheld } from './withhold'

/**
 * A Microsoft form's answers as a routine's trigger and job (routine.ts), and Purdue's withhold, on an in-memory
 * database and a LifeOS stand-in that files a key once, as LifeOS's quick add does.
 */

const FORM = 'Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrF0001'
const trigger = (workspaceId = 'ws-purdue', formId = FORM): Trigger => ({ on: 'file', source: { at: 'msform', workspaceId, formId }, by: 'someone-else' })

let db: DatabaseSync
/** LifeOS: every task by its key; `failAt` makes the n-th new write throw once */
let lifeos: { tasks: Map<string, { title: string; description: string; sector: string }>; writes: number; failAt: number | null; up: boolean }
const ctx = () => ({
  db,
  lifeos: {
    connected: () => lifeos.up,
    owner: () => ({
      mutation: async (fn: string, args: { key: string; title: string; description: string; sector: string }) => {
        expect(fn).toBe('tasks:create')
        lifeos.writes++
        if (lifeos.failAt !== null && lifeos.writes === lifeos.failAt) {
          lifeos.failAt = null
          throw new Error('LifeOS is busy')
        }
        if (!lifeos.tasks.has(args.key)) lifeos.tasks.set(args.key, { title: args.title, description: args.description, sector: args.sector })
        return `task_${args.key}`
      }
    })
  }
}) as never

const form = (over: { workspaceId?: string; sector?: string | null; lastId?: number } = {}) => {
  const store = new MsformsStore(db)
  const row = store.create({
    workspaceId: over.workspaceId ?? 'ws-purdue',
    formId: FORM,
    tenant: 'purdue0',
    sector: over.sector === undefined ? 'purdue' : over.sector,
    title: 'Esports tryouts',
    folder: { libraryId: 'box~recwell', path: 'Esports', siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell' },
    madeBy: 'owner'
  })
  if (over.lastId) store.update(row.workspaceId, FORM, { lastId: over.lastId, count: over.lastId })
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT, sector TEXT)`)
  db.prepare(`INSERT INTO workspaces (id, name, path, kind, sector) VALUES ('ws-purdue', 'Purdue', '/w/purdue', 'work', 'purdue'), ('ws-cosmic', 'Cosmic', '/w/cosmic', 'work', 'cosmic')`).run()
  ensureMsformsTables(db)
  ensureMsformJobs(db)
  lifeos = { tasks: new Map(), writes: 0, failAt: null, up: true }
})

const range = (fromId: number, toId: number): TriggerRange => ({ formId: FORM, fromId, toId })
const run = (r?: TriggerRange, t: Trigger = trigger()) => fileAnswerTasks(ctx(), { workspaceId: 'ws-purdue', firedAt: 1, trigger: t, ...(r ? { range: r } : {}) })

describe('the trigger', () => {
  it('is a file trigger the shared schema takes, its source a form in a workspace', () => {
    expect(TriggerSchema.parse(trigger())).toEqual(trigger())
    expect(() => TriggerSchema.parse({ on: 'file', source: { at: 'msform', workspaceId: '', formId: FORM }, by: 'someone-else' })).toThrow()
  })

  it("says the form's title, and fires once per new range with a count and the range alone", () => {
    form()
    setTriggerDb(db)
    expect(msformTrigger.at).toBe('msform')
    expect(msformTrigger.words(trigger())).toBe('When someone answers Esports tryouts')
    setTriggerDb(null)
    expect(msformTrigger.words(trigger())).toBe('When someone answers the form')
    const fired: [string, TriggerRange | undefined][] = []
    const off = msformTrigger.arm(trigger(), (cause, r) => fired.push([cause, r]), {})
    const at = { workspaceId: 'ws-purdue', formId: FORM, title: 'Esports tryouts', count: 2, at: 5 }
    emitNewAnswers({ ...at, added: 2, fromId: 1, toId: 2 })
    // the same answers told again, another form, another job's: nothing
    emitNewAnswers({ ...at, added: 2, fromId: 1, toId: 2 })
    emitNewAnswers({ ...at, formId: 'Other_form_id_000000000000', added: 1, fromId: 1, toId: 1 })
    emitNewAnswers({ ...at, workspaceId: 'ws-cosmic', added: 1, fromId: 3, toId: 3 })
    emitNewAnswers({ ...at, added: 1, count: 3, fromId: 3, toId: 3 })
    off()
    emitNewAnswers({ ...at, added: 1, count: 4, fromId: 4, toId: 4 })
    expect(fired).toEqual([
      ['2 new responses to Esports tryouts', { formId: FORM, fromId: 1, toId: 2 }],
      ['1 new response to Esports tryouts', { formId: FORM, fromId: 3, toId: 3 }]
    ])
  })

  it('arms nothing for another kind of file', () => {
    expect(msformTrigger.arm({ on: 'file', source: { at: 'file', host: 'h', path: '/a' }, by: 'someone-else' }, () => {}, {})).toBeTypeOf('function')
  })
})

describe('the job msforms.tasks', () => {
  it('files one task per new answer, titled with the form alone, keyed per answer, and moves its checkpoint', async () => {
    form({ lastId: 3 })
    const done = await run(range(2, 3))
    expect(done).toEqual({ words: 'Filed 2 tasks for new answers to Esports tryouts', open: { place: 'forms', item: FORM } })
    expect([...lifeos.tasks.keys()]).toEqual([answerTaskKey(FORM, 2), answerTaskKey(FORM, 3)])
    expect(answerTaskKey(FORM, 2)).toBe(`msforms:${FORM}:2`)
    for (const t of lifeos.tasks.values()) {
      expect(t).toMatchObject({ title: 'New answer to Esports tryouts', sector: 'purdue' })
      expect(t.description).not.toMatch(/@|lphale/)
    }
    expect(checkpointOf(db, 'ws-purdue', FORM)).toBe(3)
    // told again, or after a restart (the checkpoint is in the database): nothing new is written
    expect(await run(range(2, 3))).toMatchObject({ words: 'No new answers' })
    expect(lifeos.writes).toBe(2)
  })

  it('a failed write keeps the checkpoint at the last task LifeOS confirmed; the retry files the rest and none twice', async () => {
    form({ lastId: 4 })
    lifeos.failAt = 3
    await expect(run(range(1, 4))).rejects.toThrow('Filed 2 tasks, then LifeOS did not file the next: LifeOS is busy')
    expect(checkpointOf(db, 'ws-purdue', FORM)).toBe(2)
    expect(await run(range(1, 4))).toMatchObject({ words: 'Filed 2 tasks for new answers to Esports tryouts' })
    expect(lifeos.tasks.size).toBe(4)
    // a checkpoint lost after LifeOS took a write: its key files nothing twice
    db.prepare('DELETE FROM work_msforms_jobs').run()
    await run(range(1, 4))
    expect(lifeos.tasks.size).toBe(4)
  })

  it('a firing folded into a run still going is covered by the next: past the checkpoint up to the newest answer seen', async () => {
    form({ lastId: 2 })
    await run(range(1, 2))
    new MsformsStore(db).update('ws-purdue', FORM, { lastId: 6, count: 6 })
    expect(await run(range(6, 6))).toMatchObject({ words: 'Filed 4 tasks for new answers to Esports tryouts' })
    expect(checkpointOf(db, 'ws-purdue', FORM)).toBe(6)
  })

  it('Run now before any firing files nothing for answers older than the routine; after one, what is new', async () => {
    form({ lastId: 7 })
    expect(await run()).toMatchObject({ words: 'No new answers' })
    expect(checkpointOf(db, 'ws-purdue', FORM)).toBe(7)
    new MsformsStore(db).update('ws-purdue', FORM, { lastId: 8, count: 8 })
    expect(await run()).toMatchObject({ words: 'Filed 1 task for new answers to Esports tryouts' })
  })

  it(`files at most ${MSFORM_TASKS_MOST} a run and says how many wait`, async () => {
    form({ lastId: MSFORM_TASKS_MOST + 5 })
    expect(await run(range(1, MSFORM_TASKS_MOST + 5))).toMatchObject({ words: `Filed ${MSFORM_TASKS_MOST} tasks for new answers to Esports tryouts; 5 more on the next run` })
    expect(await run()).toMatchObject({ words: 'Filed 5 tasks for new answers to Esports tryouts' })
  })

  it('refuses another trigger, another job, a form gone or moved sector, and LifeOS away, writing nothing', async () => {
    form({ lastId: 2 })
    await expect(run(range(1, 2), { on: 'schedule', rrule: 'FREQ=DAILY', tz: 'UTC' })).rejects.toThrow("runs on a Microsoft form's answers")
    await expect(run(range(1, 2), trigger('ws-cosmic'))).rejects.toThrow('not in this job')
    await expect(run(range(1, 2), trigger('ws-purdue', 'Missing_form_id_000000000'))).rejects.toThrow('not in this job')
    lifeos.up = false
    await expect(run(range(1, 2))).rejects.toThrow('LifeOS is not connected')
    db.prepare(`UPDATE workspaces SET sector = 'ref' WHERE id = 'ws-purdue'`).run()
    lifeos.up = true
    await expect(run(range(1, 2))).rejects.toThrow('not in this job')
    expect(lifeos.writes).toBe(0)
  })
})

describe('saving a routine on a form', () => {
  it("refuses another job's form, and the job with no form", () => {
    form()
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-cosmic', trigger: trigger(), job: MSFORM_TASKS_JOB })).toBe(FORM_NOT_IN_WORKSPACE)
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-purdue', trigger: trigger('ws-purdue', 'Missing_form_id_000000000'), job: MSFORM_TASKS_JOB })).toBe(FORM_NOT_IN_WORKSPACE)
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-purdue', trigger: { on: 'schedule', rrule: 'FREQ=DAILY', tz: 'UTC' }, job: MSFORM_TASKS_JOB })).toBe(JOB_NEEDS_FORM)
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-purdue', trigger: { on: 'schedule', rrule: 'FREQ=DAILY', tz: 'UTC' }, job: null })).toBeNull()
  })

  it("refuses a Purdue form's routine that starts a thread with the withhold's words, offering the job; the job saves, and another sector's thread saves", () => {
    form()
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-purdue', trigger: trigger(), job: null })).toBe(WITHHELD_ROUTINE)
    expect(WITHHELD_ROUTINE.startsWith(MSFORM_WITHHELD_WORDS)).toBe(true)
    expect(WITHHELD_ROUTINE).toContain('File a task for each answer')
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-purdue', trigger: trigger(), job: MSFORM_TASKS_JOB })).toBeNull()
    db.prepare('DELETE FROM work_msforms').run()
    form({ workspaceId: 'ws-cosmic', sector: 'cosmic' })
    expect(msformRoutineRefusal(db, { workspaceId: 'ws-cosmic', trigger: trigger('ws-cosmic'), job: null })).toBeNull()
    expect(routineWithheld('purdue', true)).toBe(true)
    expect(routineWithheld('purdue', false)).toBe(false)
    expect(routineWithheld('cosmic', true)).toBe(false)
  })
})

describe("Purdue's withhold at an answer read", () => {
  const scopes = new Map<string, { routineRunId: string | null }>([
    ['t-routine', { routineRunId: 'run-1' }],
    ['t-run-now', { routineRunId: 'run-2' }],
    ['t-his', { routineRunId: null }]
  ])
  const scopeCtx = { scopeOf: (id: string) => (scopes.has(id) ? ({ routineRunId: scopes.get(id)!.routineRunId } as never) : null) }
  const model = (sessionId: string): Caller => ({ kind: 'model', sessionId }) as Caller

  it("withholds a Purdue form's answers from any thread a routine started, by its trigger or Run now; never from his own asks or another sector", () => {
    for (const id of ['t-routine', 't-run-now']) {
      expect(answersWithheld(scopeCtx, model(id), 'purdue')).toBe(true)
      expect(() => refuseWithheld(scopeCtx, model(id), 'purdue')).toThrow(MSFORM_WITHHELD_WORDS)
    }
    expect(answersWithheld(scopeCtx, model('t-routine'), 'cosmic')).toBe(false)
    expect(answersWithheld(scopeCtx, model('t-his'), 'purdue')).toBe(false)
    expect(answersWithheld(scopeCtx, { kind: 'local' } as Caller, 'purdue')).toBe(false)
    expect(answersWithheld(scopeCtx, model('t-routine'), null)).toBe(false)
    expect(() => refuseWithheld(scopeCtx, model('t-his'), 'purdue')).not.toThrow()
  })

  it("holds for a routine's delegated child, whose own row names no run, and for a thread whose provenance is unknown", () => {
    const child = { scopeOf: (id: string) => (id === 't-child' ? ({ routineRunId: null, routineRun: 'run-1' } as never) : id === 't-far' ? ({ routineRunId: null, routineRun: 'unknown-run' } as never) : id === 't-his' ? ({ routineRunId: null, routineRun: null } as never) : null) }
    expect(answersWithheld(child, model('t-child'), 'purdue')).toBe(true)
    expect(answersWithheld(child, model('t-far'), 'purdue')).toBe(true)
    // no scope for the thread, or no thread named at all: provenance cannot be established
    expect(answersWithheld(child, model('t-gone'), 'purdue')).toBe(true)
    expect(answersWithheld(child, { kind: 'model' } as Caller, 'purdue')).toBe(true)
    // his own thread and its children read as before; outside a withheld sector nothing changes
    expect(answersWithheld(child, model('t-his'), 'purdue')).toBe(false)
    expect(answersWithheld(child, model('t-child'), 'cosmic')).toBe(false)
  })
})
