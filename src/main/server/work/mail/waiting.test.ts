import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkScope } from '@shared/work'
import { WORK_MODULES, type Caller, type ToolCtx, type WorkCtx, type WorkModule } from '../modules'
import { mail } from '.'
import { ensureWaitingTables, NUDGE_ROUTINE, nudgePrompt, reportDrops, setWaiting, startNudge, waitingOf, waitingText, waitingTool, type DropRow, type WaitRow } from './waiting'

/**
 * Waiting on, on the host (docs/agents/work-mail.md "Waiting on"): his press
 * starts a thread that drafts a nudge, the workspace's switch makes or pauses
 * one routine and no grant, a nudge LifeOS dropped is told to its thread, and
 * a thread reads its own sector's list.
 */

const owner: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const model: Caller = { kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't1' }

type Call = { fn: string; args: Record<string, unknown> }

function fakeCtx(answers: Record<string, unknown> = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, sector TEXT, work_settings TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws', 'Purdue Esports', 'work', 'purdue', null)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('code', 'temp-code', null, null, null)
  ensureWaitingTables(db)
  const calls: Call[] = []
  const started: { workspaceId: string; text: string; about?: unknown }[] = []
  const results: { sessionId: string; kind: string; summary: string }[] = []
  const answer = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    const a = answers[fn]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a
  }
  const ctx = {
    db,
    host: 'box',
    log: () => {},
    scopeOf: (id: string) => (id === 'gone' ? null : ({ sessionId: id } as WorkScope)),
    lifeos: {
      connected: () => true,
      owner: () => ({
        query: async (fn: string, args: Record<string, unknown>) => answer(fn, args),
        mutation: async (fn: string, args: Record<string, unknown>) => answer(fn, args)
      })
    },
    threads: {
      start: async (o: { workspaceId: string; text: string; about?: unknown }) => {
        started.push(o)
        return 'nudge-thread'
      }
    },
    results: { add: (r: { sessionId: string; kind: string; summary: string }) => void results.push(r) }
  } as unknown as WorkCtx
  return { ctx, calls, started, results }
}

const thread = (sector: string) => ({
  thread: { _id: 'mt1', subject: 'Quote for the spring refresh', sector },
  messages: [
    { fromMe: false, sentAt: 1, to: [] },
    { fromMe: true, sentAt: Date.UTC(2026, 10, 13, 15), to: [{ name: 'Maya Chen', address: 'maya@x.test' }], cc: [{ address: 'tom@x.test' }] }
  ]
})

describe('Draft a nudge', () => {
  it('starts a thread in the workspace, linked to the mail, that drafts and never sends', async () => {
    const { ctx, started } = fakeCtx({ 'mail:thread': thread('purdue') })
    expect(await startNudge(ctx, owner, 'ws', 'mt1')).toEqual({ sessionId: 'nudge-thread' })
    expect(started).toHaveLength(1)
    expect(started[0]!.workspaceId).toBe('ws')
    expect(started[0]!.about).toEqual({ kind: 'mail', label: 'Quote for the spring refresh', ref: { at: 'lifeos', table: 'mailThreads', id: 'mt1' } })
    const text = started[0]!.text
    expect(text).toContain('“Quote for the spring refresh” (LifeOS mail thread mt1)')
    expect(text).toContain('He wrote to Maya Chen and tom@x.test on Fri, Nov 13')
    expect(text).toContain('draft_mail')
    expect(text).toContain('you never send')
  })

  it("is a person's press: a thread's own call is refused, and a mail of another sector", async () => {
    const { ctx, started } = fakeCtx({ 'mail:thread': thread('cosmic') })
    await expect(startNudge(ctx, model, 'ws', 'mt1')).rejects.toThrow('only a person')
    await expect(startNudge(ctx, { kind: 'remote', caps: ['read'] }, 'ws', 'mt1')).rejects.toThrow('only a person')
    await expect(startNudge(ctx, owner, 'ws', 'mt1')).rejects.toThrow("not in this workspace's sector")
    await expect(startNudge(ctx, owner, 'code', 'mt1')).rejects.toThrow('Work workspace with a sector')
    expect(started).toHaveLength(0)
  })

  it('words the prompt with the subject and whom he wrote to', () => {
    expect(nudgePrompt({ id: 'x', subject: '', to: 'Dana', since: Date.UTC(2026, 10, 2, 15) })).toContain('“(no subject)”')
  })
})

describe("the workspace's Waiting on", () => {
  // The routines pillar as the switch reaches it: its own methods, recorded.
  let routineCalls: Call[]
  let rows: { id: string; workspaceId: string; enabled: boolean }[]
  let kept: WorkModule[]
  beforeEach(() => {
    routineCalls = []
    rows = []
    kept = WORK_MODULES.splice(0)
    WORK_MODULES.push({
      id: 'routines',
      ensure: () => {},
      async handle(req, _ctx, by) {
        if (by.kind === 'model') throw new Error('a thread cannot change routines')
        const params = req.params as Record<string, unknown>
        routineCalls.push({ fn: req.method, args: params })
        if (req.method === 'work.routines.list') return { handled: true, result: { routines: rows } }
        if (req.method === 'work.routines.save') {
          const row = { id: `r${rows.length + 1}`, workspaceId: String(params.workspaceId), enabled: true }
          rows.push(row)
          return { handled: true, result: row }
        }
        if (req.method === 'work.routines.pause') {
          const row = rows.find((r) => r.id === params.id)!
          row.enabled = !params.paused
          return { handled: true, result: row }
        }
        return { handled: false }
      }
    })
  })
  afterEach(() => {
    WORK_MODULES.splice(0, WORK_MODULES.length, ...kept)
  })

  it('reads the days from LifeOS for the sector, and the switch off until he turns it on', async () => {
    const { ctx, calls } = fakeCtx({ 'mailWaits:days': 3 })
    expect(await waitingOf(ctx, owner, 'ws')).toEqual({ days: 3, routine: false })
    expect(calls).toEqual([{ fn: 'mailWaits:days', args: { sector: 'purdue' } }])
  })

  it('sets the days for the sector in LifeOS', async () => {
    const { ctx, calls } = fakeCtx({ 'mailWaits:days': 5, 'mailWaits:setDays': null })
    await setWaiting(ctx, owner, 'ws', { days: 5 })
    expect(calls[0]).toEqual({ fn: 'mailWaits:setDays', args: { sector: 'purdue', days: 5 } })
  })

  it('makes one routine on mail.waiting the first time, pauses it, resumes it, and makes no grant', async () => {
    const { ctx } = fakeCtx({ 'mailWaits:days': 3 })
    expect((await setWaiting(ctx, owner, 'ws', { routine: true })).routine).toBe(true)
    const saved = routineCalls.find((c) => c.fn === 'work.routines.save')!
    expect(saved.args).toMatchObject({ workspaceId: 'ws', name: NUDGE_ROUTINE, trigger: { on: 'lifeos', kinds: ['mail.waiting'] }, ends: { kind: 'never' } })
    expect(String(saved.args.prompt)).toContain('you never send')
    expect((await setWaiting(ctx, owner, 'ws', { routine: false })).routine).toBe(false)
    expect((await setWaiting(ctx, owner, 'ws', { routine: true })).routine).toBe(true)
    expect(routineCalls.filter((c) => c.fn === 'work.routines.save')).toHaveLength(1)
    expect(routineCalls.filter((c) => c.fn === 'work.routines.pause').map((c) => c.args.paused)).toEqual([true, false])
    // Nothing on the switch's road reaches the hold's grants.
    expect(routineCalls.some((c) => /grant/.test(c.fn))).toBe(false)
  })

  it('reads off once he deleted the routine in Routines, and makes a new one when turned on', async () => {
    const { ctx } = fakeCtx({ 'mailWaits:days': 3 })
    await setWaiting(ctx, owner, 'ws', { routine: true })
    rows.splice(0)
    expect((await waitingOf(ctx, owner, 'ws')).routine).toBe(false)
    await setWaiting(ctx, owner, 'ws', { routine: true })
    expect(routineCalls.filter((c) => c.fn === 'work.routines.save')).toHaveLength(2)
  })

  it("refuses a thread's own call, and still shows the switch while LifeOS does not answer", async () => {
    const { ctx } = fakeCtx({ 'mailWaits:days': new Error('down') })
    await expect(setWaiting(ctx, model, 'ws', { routine: true })).rejects.toThrow('only a person')
    await expect(setWaiting(ctx, { kind: 'remote', caps: ['read', 'operate'] }, 'ws', { days: 2 })).rejects.toThrow('only a person')
    expect(await waitingOf(ctx, owner, 'ws')).toEqual({ days: null, routine: false, error: 'LifeOS did not answer: down' })
  })
})

describe('a nudge LifeOS dropped', () => {
  const drop = (id: string, threadId: string, host = 'box'): DropRow => ({ _id: id, threadId: 'mt1', subject: 'Quote', repliedBy: 'Maya Chen', origin: { app: 'tempcode', threadId, host } })

  it('is told to the thread that drafted it, once, then forgotten in LifeOS', async () => {
    const { ctx, calls, results } = fakeCtx({ 'mailWaits:ackDrop': null })
    const told = new Set<string>()
    await reportDrops(ctx, [drop('d1', 't-nudge')], told)
    await reportDrops(ctx, [drop('d1', 't-nudge')], told)
    expect(results).toEqual([{ sessionId: 't-nudge', kind: 'mail.nudge.dropped', summary: 'Dropped the unsent nudge “Quote”: Maya Chen replied', ref: { at: 'lifeos', table: 'mailThreads', id: 'mt1' } }])
    expect(calls.filter((c) => c.fn === 'mailWaits:ackDrop')).toEqual([{ fn: 'mailWaits:ackDrop', args: { id: 'd1' } }])
  })

  it('is only forgotten when its thread is gone, and asked again when the acknowledgement fails', async () => {
    const gone = fakeCtx({ 'mailWaits:ackDrop': null })
    await reportDrops(gone.ctx, [drop('d2', 'gone')], new Set())
    expect(gone.results).toHaveLength(0)
    expect(gone.calls).toHaveLength(1)
    const failing = fakeCtx({ 'mailWaits:ackDrop': new Error('down') })
    const told = new Set<string>()
    await reportDrops(failing.ctx, [drop('d3', 't-nudge')], told)
    expect(told.has('d3')).toBe(false)
  })
})

describe('mail_waiting, for a thread', () => {
  const row = (id: string, sector: string, asked = false): WaitRow => ({
    _id: id,
    subject: `Subject ${id}`,
    sector,
    waiting: { since: Date.UTC(2026, 10, 13, 15), dueAt: 0, asked, to: [{ name: 'Maya Chen', address: 'maya@x.test' }, { address: 'b@x.test' }, { address: 'c@x.test' }] }
  })

  it("lists its own sector's waits and no other's", () => {
    const text = waitingText([row('a', 'purdue', true), row('b', 'cosmic')], 'purdue', Date.UTC(2026, 10, 20, 15))
    expect(text).toContain('(1)')
    expect(text).toContain('“Subject a” to Maya Chen and 2 more, sent Fri, Nov 13 (7 days), he asked to be reminded; mail thread a')
    expect(text).not.toContain('Subject b')
    expect(waitingText([], 'purdue')).toBe('Nothing in this sector is waiting on a reply.')
  })

  it('is read only, listed only to a thread with a sector, and refuses without one', async () => {
    expect(waitingTool.readOnly).toBe(true)
    const scope = (sector: string | null) => ({ sessionId: 't', workspaceId: 'ws', sector, host: 'box', away: false, routineRunId: null, shared: () => false }) as WorkScope
    expect(mail.tools!(scope('purdue')).map((t) => t.name)).toEqual(['mail_waiting'])
    expect(mail.tools!(scope(null))).toEqual([])
    const { ctx } = fakeCtx({ 'mailWaits:list': { page: [row('a', 'purdue')] } })
    const answer = await waitingTool.run({}, { ...ctx, scope: scope('purdue'), sessionId: 't', signal: new AbortController().signal } as ToolCtx)
    expect(answer.content[0]).toMatchObject({ type: 'text' })
    const refused = await waitingTool.run({}, { ...ctx, scope: scope(null), sessionId: 't', signal: new AbortController().signal } as ToolCtx)
    expect(refused.isError).toBe(true)
  })

  it('is named in the preamble of a thread with a sector only', () => {
    const scope = (sector: string | null) => ({ sector }) as WorkScope
    expect(mail.preamble!(scope('purdue'))).toContain('mail_waiting')
    expect(mail.preamble!(scope(null))).not.toContain('mail_waiting')
  })
})
