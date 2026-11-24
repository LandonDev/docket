import { DatabaseSync } from 'node:sqlite'
import type { WorkPush } from '@shared/contract-work'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { CanvasItem, WorkScope } from '@shared/work'
import { weekOf } from '@shared/work/review'
import { WORK_MODULES, type Caller, type PushTo, type WorkCtx, type WorkModule } from '../modules'
import { forgetUndos } from './settle'
import { ensureReviewTables } from './store'

/**
 * What the weekly review's tests share: one host (`box`) with three jobs (Purdue and Cosmic linked to their
 * sectors, a third with none), a LifeOS that answers from a table of made-up rows and records every call, and
 * stand-ins for the Outbox, Mail and History pillars in `WORK_MODULES`. Made-up names only.
 */

export const TZ = 'America/Chicago'
export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
/** Monday Nov 16 2026, 00:00 in Chicago. */
export const MON = Date.parse('2026-11-16T06:00:00Z')
export const WEEK = weekOf(MON, TZ)
/** Friday 4:00 PM of that week: when the routine makes it. */
export const FRIDAY = MON + 4 * DAY + 16 * HOUR

export const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
export const approver: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
export const reader: Caller = { kind: 'remote', caps: ['read', 'operate'] }
export const thread = (sessionId = 't-purdue'): Caller => ({ kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId })

export type Call = { fn: string; args: Record<string, unknown> }
export type ModuleCall = { method: string; params: unknown; by: Caller }

export interface Rig {
  db: DatabaseSync
  ctx: WorkCtx
  /** LifeOS's answers by function: a value, a function of the args, or an Error to throw */
  lifeos: Record<string, unknown>
  calls: Call[]
  /** every call that reached a stand-in pillar */
  moduleCalls: ModuleCall[]
  pushes: { p: WorkPush; to?: PushTo }[]
  /** what the Outbox lists */
  outbox: { waiting: OutboxItem[]; decided: OutboxItem[] }
  /** the canvas items of each workspace, and each document's versions by its source's JSON */
  items: Map<string, CanvasItem[]>
  versions: Map<string, { at: number; by: string[] }[] | Error>
  started: { workspaceId: string; text: string }[]
  /** the routines the stand-in Routines pillar holds */
  routines: { id: string; workspaceId: string; name: string; job?: string; trigger: unknown; enabled: boolean; words: string }[]
  /** what `ctx.tell` was given, and the keys it was told are done */
  told: { kind: string; key?: string; title: string; detail?: string; workspaceId: string | null; open?: unknown }[]
  toldDone: string[]
  connected: boolean
  session(id: string, o?: Partial<{ parent: string; workspace: string | null; cold: boolean; routineRunId: string; masterId: string; startedBy: string; status: string; created: number; updated: number; scope: string }>): void
  event(sessionId: string, ts: number, payload: Record<string, unknown>): void
  said(sessionId: string, ts: number, by?: Record<string, unknown> | null): void
  status(sessionId: string, ts: number, status: string): void
  close(): void
}

export const held = (id: string, o: Partial<OutboxItem> = {}): OutboxItem => ({
  ref: { at: 'host', id },
  kind: 'teams.post',
  workspaceId: 'w-purdue',
  sessionId: 't-purdue',
  sector: 'purdue',
  summary: 'Post the bracket to #esports',
  verb: 'Post',
  account: null,
  state: 'held',
  payload: {},
  createdAt: MON + HOUR,
  decidedBy: null,
  decidedAt: null,
  n: 1,
  why: 'kind' as never,
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: MON + HOUR,
  ...o
} as OutboxItem)

export function makeRig(): Rig {
  const db = new DatabaseSync(':memory:')
  db.exec(`ATTACH DATABASE ':memory:' AS cold`)
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'code', sector TEXT, created_at INTEGER NOT NULL, path TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, workspace_id TEXT, cold INTEGER NOT NULL DEFAULT 0, routine_run_id TEXT, master_id TEXT, started_by TEXT,
    status TEXT NOT NULL DEFAULT 'idle', scope TEXT NOT NULL DEFAULT 'code', title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  const EVENTS = `(session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq))`
  db.exec(`CREATE TABLE events ${EVENTS}`)
  db.exec(`CREATE TABLE cold.events ${EVENTS}`)
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  ensureReviewTables(db)
  const ws = db.prepare('INSERT INTO workspaces (id, name, kind, sector, created_at) VALUES (?, ?, ?, ?, ?)')
  ws.run('w-purdue', 'Purdue', 'work', 'purdue', 1)
  ws.run('w-cosmic', 'Cosmic', 'work', 'cosmic', 2)
  ws.run('w-side', 'Side work', 'work', null, 3)
  ws.run('code', 'temp-code', 'code', null, 4)

  const rig = {
    db,
    lifeos: {} as Record<string, unknown>,
    calls: [] as Call[],
    moduleCalls: [] as ModuleCall[],
    pushes: [] as { p: WorkPush; to?: PushTo }[],
    outbox: { waiting: [] as OutboxItem[], decided: [] as OutboxItem[] },
    items: new Map<string, CanvasItem[]>(),
    versions: new Map<string, { at: number; by: string[] }[] | Error>(),
    started: [] as { workspaceId: string; text: string }[],
    routines: [],
    told: [],
    toldDone: [],
    connected: true
  } as unknown as Rig

  const answer = async (fn: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    rig.calls.push({ fn, args })
    if (!(fn in rig.lifeos)) throw new Error(`Could not find public function for '${fn}'`)
    const a = rig.lifeos[fn]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : a
  }
  const seqs = new Map<string, number>()
  rig.session = (id, o = {}) => {
    db.prepare('INSERT INTO sessions (id, parent_id, workspace_id, cold, routine_run_id, master_id, started_by, status, scope, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      o.parent ?? null,
      o.workspace === undefined ? 'w-purdue' : o.workspace,
      o.cold ? 1 : 0,
      o.routineRunId ?? null,
      o.masterId ?? null,
      o.startedBy ?? null,
      o.status ?? 'idle',
      o.scope ?? 'work',
      id,
      o.created ?? MON - 30 * DAY,
      o.updated ?? MON + 6 * DAY
    )
  }
  rig.event = (sessionId, ts, payload) => {
    const seq = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, seq)
    const cold = (db.prepare('SELECT cold FROM sessions WHERE id = ?').get(sessionId) as { cold: number } | undefined)?.cold
    db.prepare(`INSERT INTO ${cold ? 'cold.events' : 'events'} (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)`).run(sessionId, seq, ts, JSON.stringify(payload))
  }
  rig.said = (sessionId, ts, by = { kind: 'owner' }) => rig.event(sessionId, ts, { type: 'user-text', text: 'made-up words', ...(by ? { by } : {}) })
  rig.status = (sessionId, ts, status) => rig.event(sessionId, ts, { type: 'status', status })

  rig.ctx = {
    db,
    host: 'box',
    dataDir: '/nowhere',
    enabled: () => true,
    log: () => {},
    push: (p: WorkPush, to?: PushTo) => void rig.pushes.push({ p, ...(to ? { to } : {}) }),
    scopeOf: (id: string) => ({ sessionId: id, workspaceId: id === 't-chat' ? null : id === 't-cosmic' ? 'w-cosmic' : id === 't-side' ? 'w-side' : 'w-purdue', sector: id === 't-cosmic' ? 'cosmic' : id === 't-side' || id === 't-chat' ? null : 'purdue', host: 'box', away: false, routineRunId: null }) as unknown as WorkScope,
    lifeos: {
      connected: () => rig.connected,
      owner: () => ({ query: answer, mutation: answer, action: answer })
    },
    canvas: { forWorkspace: (workspaceId: string) => rig.items.get(workspaceId) ?? [] },
    tell: Object.assign((t: Rig['told'][number]) => void rig.told.push(t), { done: (key: string) => void rig.toldDone.push(key), quiet: () => {} }),
    threads: {
      start: async (o: { workspaceId: string; text: string }) => {
        rig.started.push(o)
        return 'new-thread'
      }
    }
  } as unknown as WorkCtx

  // Stand-ins for the pillars the review calls through their own `handle`.
  const fake = (id: WorkModule['id'], run: (method: string, params: Record<string, unknown>, by: Caller) => unknown): WorkModule => ({
    id,
    ensure() {},
    async handle(req, _ctx, by) {
      rig.moduleCalls.push({ method: req.method, params: (req as { params?: unknown }).params, by })
      return { handled: true, result: await run(req.method, ((req as { params?: unknown }).params ?? {}) as Record<string, unknown>, by) }
    }
  })
  const before = [...WORK_MODULES]
  WORK_MODULES.splice(
    0,
    WORK_MODULES.length,
    fake('outbox', (method, params) => {
      if (method === 'work.outbox.list') return { items: params.show === 'decided' ? rig.outbox.decided : rig.outbox.waiting, waiting: rig.outbox.waiting.length }
      if (method === 'work.outbox.discard') return { ...held('x'), state: 'discarded' }
      throw new Error(`the stand-in Outbox has no ${method}`)
    }),
    fake('mail', (method) => {
      if (method === 'work.mail.nudge') return { sessionId: 'nudge-thread' }
      throw new Error(`the stand-in Mail has no ${method}`)
    }),
    fake('routines', (method, params) => {
      if (method === 'work.routines.list') return { routines: rig.routines.filter((r) => r.workspaceId === params.workspaceId) }
      if (method === 'work.routines.save') {
        const row = { id: `r${rig.routines.length + 1}`, workspaceId: String(params.workspaceId), name: String(params.name), job: params.job as string, trigger: params.trigger, enabled: true, words: 'Fridays at 4:00 PM' }
        rig.routines.push(row)
        return row
      }
      throw new Error(`the stand-in Routines has no ${method}`)
    }),
    fake('history', (method, params) => {
      if (method !== 'work.history.versions') throw new Error(`the stand-in History has no ${method}`)
      const got = rig.versions.get(JSON.stringify(params.source))
      if (!got || got instanceof Error) throw got ?? new Error('no such document')
      return { versions: got.map((v, i) => ({ id: `v${i}`, cause: 'idle', kept: 'snapshot', ...v })), shared: false, names: {} }
    })
  )
  rig.close = () => {
    WORK_MODULES.splice(0, WORK_MODULES.length, ...before)
    forgetUndos()
    db.close()
  }
  return rig
}

/** A document item of a workspace, for the files gather. */
export const docItem = (id: string, workspaceId: string, updatedAt: number): CanvasItem => ({ id, sessionId: 't', workspaceId, kind: 'document', title: id, source: { at: 'lifeos', table: 'docs', id }, state: 'open', position: 0, rev: 1, createdAt: 1, updatedAt })
