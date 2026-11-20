import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STARTER_PLAYS, type PlayDraft, type PlayRow, type RoutineRow } from '@shared/contract-work-routines'
import type { WorkspaceMeta } from '@shared/domain'
import type { ContextChip, WorkToolResult } from '@shared/work'
import { outbox as outboxModule } from '../outbox/index'
import { cast, makeRig, type Rig } from '../outbox/rig'
import { routinesHost, type RoutinesHost } from './host'
import { routines, routinesSeams } from './index'
import { playSeams, playTools } from './playMethods'
import { PlayStore } from './plays'
import { ensureRoutineTables, RoutineStore } from './store'

/**
 * Plays on the hold's rig: a real Work mount with the routines module, a
 * fake registry. What it proves: only he makes, changes or starts a play; a
 * thread's proposal starts nothing; a start hands its thread the
 * instructions and the things it takes through the host's own start (never
 * as words he typed); a routine runs only a play that takes nothing; and a
 * draft from a Purdue thread is never sent to a model.
 */

let rig: Rig
const clock = { now: Date.parse('2026-11-20T09:00:00-05:00') }
const started: { workspaceId: string; text: string; title?: string; about?: ContextChip }[] = []
const words = new Map<string, { by: 'owner' | 'app' | 'agent'; text: string }[]>()
const drafts: string[] = []
const text = (r: WorkToolResult | { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const call = (sessionId: string, name: string, args: Record<string, unknown>) => rig.work.tools.call(rig.sessions.get(sessionId)!, name, args, new AbortController().signal)
const plays = async (workspaceId = 'ws-ref') => (await rig.rpc<{ plays: PlayRow[] }>('work.routines.plays', { workspaceId })).plays
const asModel = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-ref' }
const mail: ContextChip = { kind: 'mail', label: 'Varsity football, Fri 7:00', ref: { at: 'lifeos', table: 'mailThreads', id: 'm1' }, excerpt: 'You are assigned: Lafayette Jeff at Harrison' }
const task: ContextChip = { kind: 'task', label: 'Buy whistle', ref: { at: 'lifeos', table: 'tasks', id: 'k1' } }

beforeEach(async () => {
  started.length = 0
  words.clear()
  drafts.length = 0
  routinesSeams.current = {
    interval: false,
    now: () => clock.now,
    host: {
      workspace: (id) => rig.workspaces.get(id) ?? null,
      addon: () => null,
      mayRead: () => false,
      read: (addon, tool, args) => routinesHost()!.read(addon, tool, args),
      session: (id) => rig.sessions.get(id) ?? null,
      onMeta: () => () => {},
      markRead: () => {},
      markUnread: () => {},
      heldIn: () => 0,
      busyBelow: () => false,
      threadOfRun: () => null,
      readOnly: () => false,
      words: (id) => words.get(id) ?? []
    } satisfies RoutinesHost
  }
  playSeams.draft = async (prompt) => {
    drafts.push(prompt)
    return 'Here it is: {"name": "Game assignment", "instructions": "1. Read the mail.\\n2. Draft the event.", "takes": ["mail", "nonsense"]}'
  }
  rig = await makeRig({ modules: [outboxModule, routines] })
  cast(rig)
  rig.workspace('ws-ref', { kind: 'work', sector: 'ref' } as Partial<WorkspaceMeta>)
  rig.thread('t-ref', { scope: 'work', workspaceId: 'ws-ref' })
  // The registry's start, as threads.ts makes it: the host's own, never a row the owner typed.
  rig.work.ctx.threads.start = async (o) => {
    started.push({ workspaceId: o.workspaceId, text: o.text, ...(o.title ? { title: o.title } : {}), ...(o.about ? { about: o.about } : {}) })
    const id = `t-run${started.length}`
    rig.thread(id, { scope: 'work', workspaceId: o.workspaceId, status: 'running' })
    return id
  }
})
afterEach(async () => {
  await rig.close()
  routinesSeams.current = null
  playSeams.draft = null
})

const save = (o: Partial<{ id: string; name: string; instructions: string; takes: string[]; starter: string; workspaceId: string }>) =>
  rig.rpc<PlayRow>('work.routines.playSave', { workspaceId: 'ws-ref', name: 'Game assignment', instructions: 'Turn the mail into an event.', takes: ['mail'], ...o })

describe('a proposal', () => {
  it('starts nothing until he adds it, and a thread can make, change, start or remove no play itself', async () => {
    const made = await call('t-ref', 'play_propose', { name: 'Game assignment', instructions: 'Turn the assignment mail into an event.', takes: ['mail'] })
    expect(text(made)).toBe('Proposed the play “Game assignment” (takes mail). It waits in Plays for the owner to add; nothing runs until he starts it.')
    const [row] = await plays()
    expect(row).toMatchObject({ proposed: true, createdBy: 'model', madeIn: 't-ref', takes: ['mail'] })
    expect(rig.pushes).toContainEqual({ push: 'work.routines.plays', workspaceId: 'ws-ref' })
    await expect(rig.rpc('work.routines.playStart', { id: row!.id, inputs: { chips: [mail] } })).rejects.toThrow('a proposal starts nothing until the owner adds it')

    // the same name twice is refused, to the thread as to him
    expect((await call('t-ref', 'play_propose', { name: 'game assignment', instructions: 'x' })).isError).toBe(true)

    for (const [method, params] of [
      ['work.routines.playSave', { id: row!.id, workspaceId: 'ws-ref', name: 'x', instructions: 'x', takes: [] }],
      ['work.routines.playStart', { id: row!.id, inputs: { chips: [mail] } }],
      ['work.routines.playRemove', { id: row!.id }],
      ['work.routines.playDraft', { sessionId: 't-ref' }]
    ] as const) {
      await expect(routines.handle!({ id: '1', method, params } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner makes, changes or starts a play')
    }
    expect(started).toEqual([])

    // his Add: the proposal is a play of his
    const added = await save({ id: row!.id, instructions: 'Turn the assignment mail into an event and a pay line.' })
    expect(added).toMatchObject({ id: row!.id, proposed: false, instructions: 'Turn the assignment mail into an event and a pay line.' })
  })

  it('is listed to a thread with its mark, and a Work Chat has no play tools', async () => {
    await save({})
    await call('t-ref', 'play_propose', { name: 'Month’s pay', instructions: 'Total the month.', takes: ['date'] })
    for (let i = 0; i < 4; i++) await call('t-ref', 'play_propose', { name: `Idea ${i}`, instructions: 'x' })
    const sixth = await call('t-ref', 'play_propose', { name: 'One more', instructions: 'x' })
    expect(sixth.isError).toBe(true)
    expect(text(sixth)).toBe('This thread already has 5 plays waiting for the owner.')
    for (const p of (await plays()).filter((x) => x.name.startsWith('Idea'))) await rig.rpc('work.routines.playRemove', { id: p.id })
    expect(text(await call('t-ref', 'play_list', {}))).toBe('(proposed) Month’s pay (takes date)\nTotal the month.\n\nGame assignment (takes mail)\nTurn the mail into an event.')
    expect(rig.work.tools.of(rig.sessions.get('t-ref')!)!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['play_list', 'play_propose']))
    expect(playTools({ ...rig.work.ctx.scopeOf('t-ref')!, workspaceId: null })).toEqual([])
  })
})

describe('a start', () => {
  it('gives the thread the things it takes and the instructions, through the host’s own start', async () => {
    const p = await save({ takes: ['mail', 'date', 'text'] })
    await expect(rig.rpc('work.routines.playStart', { id: p.id, inputs: { chips: [], date: '2026-11-20', text: 'Bring the flags' } })).rejects.toThrow('“Game assignment”: it takes one mail')
    await expect(rig.rpc('work.routines.playStart', { id: p.id, inputs: { chips: [mail, task], date: '2026-11-20', text: 'x' } })).rejects.toThrow('it takes no task')
    await expect(rig.rpc('work.routines.playStart', { id: p.id, inputs: { chips: [mail], text: 'x' } })).rejects.toThrow('it takes a date')

    const { sessionId } = await rig.rpc<{ sessionId: string }>('work.routines.playStart', { id: p.id, inputs: { chips: [mail], date: '2026-11-20', text: 'Bring the flags' } })
    expect(sessionId).toBe('t-run1')
    expect(started).toEqual([
      {
        workspaceId: 'ws-ref',
        about: mail,
        // named by the host, so no model is asked to title it from the mail
        title: 'Game assignment: Varsity football, Fri 7:00',
        text: [
          'About this mail: Varsity football, Fri 7:00 (LifeOS mailThreads m1)',
          '> You are assigned: Lafayette Jeff at Harrison',
          'The date: Friday, November 20, 2026 (2026-11-20)',
          'From me:',
          '> Bring the flags',
          '',
          'Turn the mail into an event.',
          '',
          '---',
          'Started from the play “Game assignment”.'
        ].join('\n')
      }
    ])
  })

  it('needs one press for a play that takes nothing', async () => {
    const p = await save({ name: 'Weekly sweep', takes: [] })
    await rig.rpc('work.routines.playStart', { id: p.id, inputs: {} })
    expect(started[0]!.text).toBe('Turn the mail into an event.\n\n---\nStarted from the play “Weekly sweep”.')
    expect(started[0]!.about).toBeUndefined()
    expect(started[0]!.title).toBe('Weekly sweep')
  })

  it('refuses a date that is no day, in the host’s words', async () => {
    const p = await save({ takes: ['date'] })
    await expect(rig.rpc('work.routines.playStart', { id: p.id, inputs: { date: '2026-13-45' } })).rejects.toThrow('“Game assignment”: 2026-13-45 is not a day')
  })
})

describe('the starters', () => {
  it('are added only by him, once each, and only in their own sector', async () => {
    const starter = STARTER_PLAYS.ref![0]!
    const added = await save({ name: starter.name, instructions: starter.instructions, takes: starter.takes, starter: starter.key })
    expect(added.starter).toBe('ref.assignment')
    await expect(save({ name: 'Another name', starter: starter.key })).rejects.toThrow('that starter is added already')
    await expect(save({ name: 'Bill', starter: 'life.bill' })).rejects.toThrow('no starter life.bill for this workspace')
    expect(await plays('ws-purdue')).toEqual([])
  })
})

describe('a routine that runs a play', () => {
  const weekly = { on: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0', tz: 'America/New_York' }

  it('runs only a play that takes nothing, reads it afresh at each firing, and keeps it from being deleted', async () => {
    const takesMail = await save({})
    await expect(rig.rpc('work.routines.save', { workspaceId: 'ws-ref', name: 'Mondays', prompt: '', playId: takesMail.id, trigger: weekly, ends: { kind: 'never' } })).rejects.toThrow(
      '“Game assignment” takes mail: a routine runs only a play that takes nothing'
    )
    await expect(rig.rpc('work.routines.save', { workspaceId: 'ws-ref', name: 'Mondays', prompt: '', trigger: weekly, ends: { kind: 'never' } })).rejects.toThrow('say what it does, or pick a play')

    const p = await save({ name: 'Weekly pay check', instructions: 'Check the pay sheet.', takes: [] })
    const r = await rig.rpc<RoutineRow>('work.routines.save', { workspaceId: 'ws-ref', name: 'Mondays', prompt: '', playId: p.id, trigger: weekly, ends: { kind: 'never' } })
    expect(r.playId).toBe(p.id)
    await save({ id: p.id, name: 'Weekly pay check', instructions: 'Check the pay sheet and the calendar.', takes: [] })
    await rig.rpc('work.routines.runNow', { id: r.id })
    expect(started[0]!.text).toMatch(/^Check the pay sheet and the calendar\.\n\n---\nStarted by the routine “Mondays”, which runs the play “Weekly pay check”: /)

    await expect(rig.rpc('work.routines.playRemove', { id: p.id })).rejects.toThrow('the routine “Mondays” runs it; change or delete that routine first')
    // nor may it come to take something while a routine runs it; and a play changed under it by another build fails the run
    await expect(save({ id: p.id, name: 'Weekly pay check', instructions: 'x', takes: ['date'] })).rejects.toThrow('the routine “Mondays” runs it, and a routine runs only a play that takes nothing')
    rig.work.ctx.db.prepare(`UPDATE work_routines_plays SET takes = '["date"]' WHERE id = ?`).run(p.id)
    // the first run's thread is done with (stopped), so the next press is a run of its own
    rig.sessions.get('t-run1')!.status = 'stopped'
    const failed = await rig.rpc<{ state: string; summary: string }>('work.routines.runNow', { id: r.id })
    expect(failed).toMatchObject({ state: 'failed', summary: 'Failed: its play now takes date' })
    expect(started).toHaveLength(1)
    rig.work.ctx.db.prepare(`UPDATE work_routines_plays SET takes = '[]' WHERE id = ?`).run(p.id)
    await rig.rpc('work.routines.remove', { id: r.id })
    await rig.rpc('work.routines.playRemove', { id: p.id })
    expect((await plays()).map((x) => x.name)).toEqual(['Game assignment'])
  })

  it('runs only a play of its own workspace that he added, and lets an ended routine’s play go', async () => {
    const proposal = (await call('t-ref', 'play_propose', { name: 'Idea', instructions: 'x' }), (await plays())[0]!)
    await expect(rig.rpc('work.routines.save', { workspaceId: 'ws-ref', name: 'Mondays', prompt: '', playId: proposal.id, trigger: weekly, ends: { kind: 'never' } })).rejects.toThrow(`no play ${proposal.id} in this workspace`)
    const elsewhere = await save({ workspaceId: 'ws-purdue', name: 'Purdue sweep', takes: [] })
    await expect(rig.rpc('work.routines.save', { workspaceId: 'ws-ref', name: 'Mondays', prompt: '', playId: elsewhere.id, trigger: weekly, ends: { kind: 'never' } })).rejects.toThrow(`no play ${elsewhere.id} in this workspace`)

    const p = await save({ name: 'Once', takes: [] })
    const r = await rig.rpc<RoutineRow>('work.routines.save', { workspaceId: 'ws-ref', name: 'Just once', prompt: '', playId: p.id, trigger: weekly, ends: { kind: 'once' } })
    await rig.rpc('work.routines.runNow', { id: r.id })
    await rig.rpc('work.routines.playRemove', { id: p.id })
    expect((await plays()).some((x) => x.id === p.id)).toBe(false)
  })
})

describe('the routines table from before plays', () => {
  it('gains play_id at the next boot, its rows kept', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE work_routines (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, reasoning TEXT,
      trigger_spec TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, until_at INTEGER, once INTEGER NOT NULL DEFAULT 0, resume_session_id TEXT, next_at INTEGER, last_at INTEGER,
      last_session_id TEXT, last_state TEXT, last_words TEXT, cursor TEXT, proposed INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0, made_in TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO work_routines (id, workspace_id, kind, name, prompt, trigger_spec, created_by, created_at) VALUES ('r1', 'w', 'routine', 'Old', 'Do it', ?, 'owner', 1)`).run(JSON.stringify({ on: 'lifeos', kinds: ['mail.received'] }))
    ensureRoutineTables(db)
    ensureRoutineTables(db)
    expect(new RoutineStore(db).get('r1')).toMatchObject({ name: 'Old', prompt: 'Do it', playId: null })
    expect(new PlayStore(db).list('w')).toEqual([])
  })
})

describe('Draft from the thread', () => {
  it('drafts from the thread’s words on his press, and never sends a Purdue thread to a model', async () => {
    words.set('t-ref', [
      { by: 'owner', text: 'Put this assignment on my calendar with the drive.' },
      { by: 'agent', text: 'Drafted the game and a 40 minute drive before it.' }
    ])
    const draft = await rig.rpc<PlayDraft>('work.routines.playDraft', { sessionId: 't-ref' })
    expect(draft).toEqual({ name: 'Game assignment', instructions: '1. Read the mail.\n2. Draft the event.', takes: ['mail'] })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toContain('[owner] Put this assignment on my calendar with the drive.\n[agent] Drafted the game and a 40 minute drive before it.')

    words.set('t-work', [{ by: 'agent', text: 'Student roster summary' }])
    await expect(rig.rpc('work.routines.playDraft', { sessionId: 't-work' })).rejects.toThrow('a Purdue thread is not sent to a model')
    expect(drafts).toHaveLength(1)
  })
})

describe('a workspace removed', () => {
  it('takes its plays with it', async () => {
    await save({})
    routines.workspaceRemoved!('ws-ref', rig.work.ctx)
    expect(await plays()).toEqual([])
  })
})
