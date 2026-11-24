/**
 * The weekly review, end to end in one process (src/main/server/work/review, src/shared/work/review.ts).
 * No Electron window, no network: Work's real mount (`startWork`) on a real SQLite file in a temp folder, with the
 * REAL review, outbox and routines modules, the real canvas part, the real Store for workspaces, threads and their
 * events, and a fake LifeOS that answers from a table of made-up rows for the week of Nov 16 2026 (Chicago) across six
 * jobs and records every call. Mail (a nudge), History (document versions) and Browser (the `teams.post` act kind a
 * held item needs) are small stand-in modules: those pillars need services this proof does not start.
 *
 * The clock is fake and only goes forward: Wednesday's make (steps 1 and 2), Thursday's make and presses (3 and 4),
 * Friday 4:00 PM's routine (5), then the Monday after for the look back (3 and 4, their second halves).
 *
 * Run: bun run script:e2e-review   (bun --preload scripts/lib/electron-stub.ts scripts/e2e-review.ts)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ClientRequest } from '../src/shared/contract'
import type { ReviewSettled } from '../src/shared/contract-work-review'
import type { OutboxItem } from '../src/shared/contract-work-outbox'
import type { RoutineRow, RoutineRun } from '../src/shared/contract-work-routines'
import type { WorkPush } from '../src/shared/contract-work'
import type { Principal } from '../src/shared/capabilities'
import type { WorkspaceMeta } from '../src/shared/domain'
import type { AgentEvent, SessionMeta } from '../src/shared/events'
import type { ReviewBody, SlippedRef, SlippedRow } from '../src/shared/work/review'
import type { Caller, WorkModule } from '../src/main/server/work/modules'
import type { RoutinesHost } from '../src/main/server/work/routines/host'

// ── the clock, installed before any server code loads (a store that keeps `Date.now` as a default must get this one) ──
const RealDate = Date
const clock = { now: RealDate.parse('2026-11-16T14:00:00Z') }
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock.now)
    else super(...(args as [string]))
  }
  static override now(): number {
    return clock.now
  }
}
globalThis.Date = FakeDate as unknown as DateConstructor

const { openDb, Store } = await import('../src/main/server/db')
const { LOCAL_PRINCIPAL } = await import('../src/shared/capabilities')
const { weekOf, stepWeek, mergeReview, totalWords } = await import('../src/shared/work/review')
const { startWork } = await import('../src/main/server/work/ctx')
const { WORK_MODULES } = await import('../src/main/server/work/modules')
const { lifeosSeamsFor } = await import('../src/main/server/work/lifeos/ctx')
const { ensureCanvasTables } = await import('../src/main/server/work/canvas/store')
const { outbox: outboxModule } = await import('../src/main/server/work/outbox/index')
const { outboxHostOf } = await import('../src/main/server/work/outbox/ctx')
const { routines, routinesEngine, routinesSeams } = await import('../src/main/server/work/routines/index')
const { review } = await import('../src/main/server/work/review/index')
const { seedRoutine, ROUTINE_RRULE, MAKE_JOB, ROUTINE_NAME } = await import('../src/main/server/work/review/friday')
const { NOT_A_PERSON, OPEN_IN_OUTBOX, UNDO_GONE } = await import('../src/main/server/work/review/settle')
const { keptWeek } = await import('../src/main/server/work/review/store')

// ── the week ──────────────────────────────────────────────────────────────────────────────────────
const TZ = 'America/Chicago'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Monday Nov 16 2026, 00:00 in Chicago (CST, UTC-6; no clock change that week). */
const MON = RealDate.parse('2026-11-16T06:00:00Z')
const at = (day: number, h: number, m = 0): number => MON + day * DAY + h * HOUR + m * MIN
/** Next week's Monday at 9:00 in Chicago: where "Next week" moves a task or a wait. */
const NEXT_MON_9 = at(7, 9)

// ── what the run prints ───────────────────────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
const short = (s: string): string => (s.length > 900 ? `${s.slice(0, 900)}…` : s).replace(/\s+/g, ' ')
async function step(name: string, run: () => unknown): Promise<void> {
  try {
    await run()
    passed++
    console.log(`ok: ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`FAIL: ${name}: ${short(err instanceof Error ? err.message : String(err))}`)
  }
}

// ── the fake LifeOS: made-up rows, every call recorded ────────────────────────────────────────────────
type Addr = { name: string; address: string }
const P = {
  riley: { name: 'Riley Okafor', address: 'riley@cosmic.example' },
  dana: { name: 'Dana Reyes', address: 'dana@purdue.example' },
  sam: { name: 'Sam Lindqvist', address: 'sam@purdue.example' },
  ada: { name: 'Ada Brennan', address: 'ada@hypixel.example' },
  jordan: { name: 'Jordan Vale', address: 'jordan@ref.example' },
  morgan: { name: 'Morgan Hale', address: 'morgan@lease.example' }
} satisfies Record<string, Addr>
const ME = 'owner@purdue.example'

const EVENTS = [
  // Cosmic: two meetings with Riley that overlap (10:00-12:00 joined is 2 h) and were followed up by a mail at 12:00.
  { _id: 'ev-cos-1', sector: 'cosmic', title: 'Sprint planning', startsAt: at(1, 10), endsAt: at(1, 11, 30), attendees: [P.riley, { address: ME }] },
  { _id: 'ev-cos-2', sector: 'cosmic', title: 'Design sync', startsAt: at(1, 11), endsAt: at(1, 12), attendees: [P.riley] },
  // Hypixel: alone for two hours; a call with Ada that no mail followed; one on Friday, ahead of Wednesday's make.
  { _id: 'ev-hyp-1', sector: 'hypixel', title: 'Footage review', startsAt: at(0, 15), endsAt: at(0, 17) },
  { _id: 'ev-hyp-3', sector: 'hypixel', title: 'Thumbnail call', startsAt: at(2, 10), endsAt: at(2, 10, 30), attendees: [P.ada] },
  { _id: 'ev-hyp-2', sector: 'hypixel', title: 'Edit review', startsAt: at(4, 14), endsAt: at(4, 15) },
  // Purdue: a meeting with Dana and Sam; the mail to Dana went before it, so nothing was sent after.
  { _id: 'ev-pur-1', sector: 'purdue', title: 'Bracket review', startsAt: at(2, 13), endsAt: at(2, 14), attendees: [P.dana, P.sam] },
  // Refereeing: a game; a call he declined, which counts for nothing and covers no desk time.
  { _id: 'ev-ref-1', sector: 'ref', title: 'Varsity game', startsAt: at(1, 18), endsAt: at(1, 20) },
  { _id: 'ev-ref-2', sector: 'ref', title: 'Crew call', startsAt: at(2, 8), endsAt: at(2, 9), attendees: [P.jordan], myResponse: 'declined' },
  // Life: half an hour, and a day-long event that is not calendar time.
  { _id: 'ev-life-1', sector: 'life', title: 'Dentist', startsAt: at(0, 12), endsAt: at(0, 12, 30) },
  { _id: 'ev-life-2', sector: 'life', title: 'Holiday market', startsAt: at(0, 0), endsAt: at(1, 0), allDay: true }
  // Unify: nothing all week.
]
const SENT = [
  { id: 'sent-cos-1', threadId: 'mt-cos-plan', subject: 'Server plan', to: [P.riley], sentAt: at(1, 12), sector: 'cosmic' },
  { id: 'sent-pur-1', threadId: 'mt-pur-seeds', subject: 'Seeds for the bracket', to: [P.dana], sentAt: at(2, 9), sector: 'purdue' }
]
const ANSWERED = [{ threadId: 'mt-pur-seeds', subject: 'Re: Seeds for the bracket', sector: 'purdue', answeredAt: at(2, 11), by: 'Dana Reyes' }]
type Task = { _id: string; title: string; sector: string; dueAt: number; state: 'open' | 'done' | 'dropped'; completedAt?: number }
const TASKS: Task[] = [
  { _id: 'tk-cos-done', title: 'Fix spawn lag', sector: 'cosmic', dueAt: at(1, 9), state: 'done', completedAt: at(1, 16) },
  { _id: 'tk-pur-1', title: 'Book the arena for finals', sector: 'purdue', dueAt: at(1, 9), state: 'open' },
  { _id: 'tk-hyp-1', title: 'Send color notes', sector: 'hypixel', dueAt: at(0, 17), state: 'open' },
  { _id: 'tk-life-1', title: 'Renew passport', sector: 'life', dueAt: at(2, 9), state: 'open' },
  { _id: 'tk-ref-1', title: 'File game report', sector: 'ref', dueAt: at(-6, 9), state: 'open' },
  { _id: 'tk-cos-2', title: 'Review the patch', sector: 'cosmic', dueAt: at(4, 12), state: 'open' }
]
type Wait = { _id: string; subject: string; sector: string; since: number; dueAt: number; to: Addr[]; state: 'waiting' | 'dismissed' }
const WAITS: Wait[] = [
  { _id: 'mt-pur-1', subject: 'Venue contract', sector: 'purdue', since: at(0, 10), dueAt: at(1, 10), to: [P.sam], state: 'waiting' },
  { _id: 'mt-cos-1', subject: 'Server costs', sector: 'cosmic', since: at(0, 11), dueAt: at(2, 11), to: [P.riley], state: 'waiting' },
  { _id: 'mt-life-1', subject: 'Lease renewal', sector: 'life', since: at(1, 9), dueAt: at(5, 9), to: [P.morgan], state: 'waiting' }
]
/** Every function the review module reads, as its testkit names them. */
const REVIEW_READS = ['mail:accounts', 'events:range', 'events:get', 'review:sentBetween', 'review:doneBetween', 'review:answeredBetween', 'tasks:due', 'tasks:get', 'mailWaits:list', 'mailWaits:get', 'docs:get', 'settings:get']

type LifeosCall = { kind: 'query' | 'mutation' | 'action' | 'subscribe'; fn: string; args: Record<string, unknown> }
const lifeosCalls: LifeosCall[] = []
const task = (id: unknown): Task => TASKS.find((t) => t._id === id) ?? assert.fail(`no task ${String(id)}`)
const wait = (id: unknown): Wait => WAITS.find((w) => w._id === id) ?? assert.fail(`no wait ${String(id)}`)
const happened = (t: number): boolean => t <= clock.now
const inSpan = (t: number, a: Record<string, unknown>): boolean => t >= Number(a.from) && t < Number(a.to)
/** A waiting mail's row: its thread and when the wait began, as the review keys it (`waitKey`). */
const waitRow = (id: string): string => `mail:${id}:${wait(id).since}`
/** The LifeOS documents of the made-up week, by id: a document is filed by its own sector. */
const DOC_SECTORS: Record<string, string> = { 'doc-hyp-notes': 'hypixel' }
function answer(fn: string, a: Record<string, unknown>): unknown {
  switch (fn) {
    case 'settings:get':
      return { timezone: TZ }
    case 'mail:accounts':
      return [{ address: ME, identities: [{ address: ME, isDefault: true }, { address: 'owner@cosmic.example', isDefault: false }] }]
    case 'events:range':
      return EVENTS.filter((e) => inSpan(e.startsAt, a))
    // A meeting put off to next week is read again by its id, once its day has come.
    case 'events:get':
      return EVENTS.find((e) => e._id === a.id) ?? null
    case 'docs:get':
      return DOC_SECTORS[String(a.id)] ? { _id: a.id, sector: DOC_SECTORS[String(a.id)] } : null
    case 'tasks:get':
      return { task: { _id: a.id, dueAt: task(a.id).dueAt } }
    case 'mailWaits:get': {
      const w = WAITS.find((x) => x._id === a.threadId && x.state === 'waiting')
      return w ? { since: w.since, dueAt: w.dueAt, to: w.to } : null
    }
    case 'review:sentBetween':
      return SENT.filter((m) => inSpan(m.sentAt, a) && happened(m.sentAt))
    case 'review:answeredBetween':
      return { rows: ANSWERED.filter((r) => inSpan(r.answeredAt, a) && happened(r.answeredAt)), answeredSince: MON - 60 * DAY }
    case 'review:doneBetween':
      return TASKS.filter((t) => t.state === 'done' && inSpan(t.completedAt!, a)).map((t) => ({ id: t._id, title: t.title, sector: t.sector, completedAt: t.completedAt }))
    case 'tasks:due':
      return TASKS.filter((t) => t.state === 'open' && t.dueAt < Number(a.before)).map(({ _id, title, sector, dueAt }) => ({ _id, title, sector, dueAt }))
    case 'mailWaits:list':
      return { page: WAITS.filter((w) => w.state === 'waiting').map((w) => ({ _id: w._id, subject: w.subject, sector: w.sector, waiting: { since: w.since, dueAt: w.dueAt, to: w.to } })), isDone: true, continueCursor: '' }
    case 'tasks:complete':
      return void Object.assign(task(a.id), { state: 'done', completedAt: clock.now })
    case 'tasks:reopen':
      return void Object.assign(task(a.id), { state: 'open', completedAt: undefined })
    case 'tasks:update':
      return void Object.assign(task(a.id), (a.patch as object) ?? {})
    case 'tasks:drop':
      return void Object.assign(task(a.id), { state: 'dropped' })
    case 'mailWaits:putOff': {
      const w = wait(a.threadId)
      if (w.since !== a.since || w.state !== 'waiting') return null
      const was = { state: w.state, dueAt: w.dueAt }
      w.dueAt = Number(a.until)
      return was
    }
    case 'mailWaits:dismiss': {
      const w = wait(a.threadId)
      if (w.since !== a.since || w.state !== 'waiting') return null
      const was = { state: w.state, dueAt: w.dueAt }
      w.state = 'dismissed'
      return was
    }
    case 'mailWaits:putBack':
      return void Object.assign(wait(a.threadId), { state: a.state, dueAt: a.dueAt })
  }
  throw new Error(`Could not find public function for '${fn}'`)
}
const lifeosClient = Object.fromEntries(
  (['query', 'mutation', 'action'] as const).map((kind) => [
    kind,
    async (fn: string, args: Record<string, unknown> = {}) => {
      lifeosCalls.push({ kind, fn, args: structuredClone(args) })
      return answer(fn, args)
    }
  ])
) as { query<T>(fn: string, args?: Record<string, unknown>): Promise<T>; mutation<T>(fn: string, args?: Record<string, unknown>): Promise<T>; action<T>(fn: string, args?: Record<string, unknown>): Promise<T> }

// ── the stand-in pillars, and a record of every call into them ─────────────────────────────────────────
const moduleCalls: { module: string; method: string; params: unknown }[] = []
const DOC = { at: 'lifeos', table: 'docs', id: 'doc-hyp-notes' } as const
const VERSIONS = new Map([[JSON.stringify(DOC), [{ at: at(1, 14), by: ['owner'] }, { at: at(1, 15), by: ['lifeos:bot:sync'] }]]])
const standIn = (id: WorkModule['id'], run: (method: string, params: Record<string, unknown>) => unknown): WorkModule => ({
  id,
  ensure() {},
  async handle(req) {
    const params = ((req as { params?: unknown }).params ?? {}) as Record<string, unknown>
    moduleCalls.push({ module: id, method: req.method, params })
    return { handled: true, result: await run(req.method, params) }
  }
})
const mailStandIn = standIn('mail', (method) => {
  if (method === 'work.mail.nudge') return { sessionId: 'nudge-standin' }
  throw new Error(`the stand-in Mail has no ${method}`)
})
const historyStandIn = standIn('history', (method, params) => {
  if (method !== 'work.history.versions') throw new Error(`the stand-in History has no ${method}`)
  const versions = VERSIONS.get(JSON.stringify(params.source))
  if (!versions) throw new Error('no such document')
  return { versions: versions.map((v, i) => ({ id: `v${i}`, cause: 'idle', kept: 'snapshot', ...v })), shared: false, names: {} }
})
/** The act kind a held item needs: `teams.post` is the browser pillar's, which needs a headed browser. Its execute records, so "never sent" is a fact. */
const executed: unknown[] = []
const browserStandIn: WorkModule = {
  id: 'browser',
  ensure() {},
  acts: [
    {
      kind: 'teams.post',
      store: 'host',
      payload: z.object({ channel: z.string(), text: z.string() }),
      words: (p: { channel: string; text: string }) => ({ summary: `Post to ${p.channel}: ${p.text}`, verb: 'Post' }),
      async execute(p: unknown) {
        executed.push(p)
        return { summary: 'posted' }
      },
      wayBack: () => null
    } as never
  ]
}
/** The real outbox module, with every call into its `handle` written down. */
const outboxCalls: { method: string; by: Caller }[] = []
const outboxSeen: WorkModule = {
  ...outboxModule,
  handle(req, ctx, by, signal) {
    outboxCalls.push({ method: req.method, by })
    return outboxModule.handle!(req, ctx, by, signal)
  }
}

// ── the host ──────────────────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'tc-e2e-review-'))
const db = openDb(join(dir, 'app.db'))
const store = new Store(db)
ensureCanvasTables(db)

const JOBS = [
  ['w-cosmic', 'Cosmic', 'cosmic'],
  ['w-hypixel', 'Hypixel', 'hypixel'],
  ['w-purdue', 'Purdue', 'purdue'],
  ['w-ref', 'Refereeing', 'ref'],
  ['w-unify', 'Unify', 'unify'],
  ['w-life', 'Personal', 'life']
] as const
JOBS.forEach(([id, name, sector], i) => store.insertWorkspace({ id, name, path: join(dir, id), git: false, createdAt: i + 1, kind: 'work', sector } as WorkspaceMeta))
store.insertWorkspace({ id: 'ws-code', name: 'Side code', path: join(dir, 'ws-code'), git: false, createdAt: 10 } as WorkspaceMeta)
const thread = (id: string, workspaceId: string, scope: 'work' | 'code' = 'work'): void =>
  store.insertSession({
    id, parentId: null, projectId: null, workspaceId, threadType: 'chat', planPath: null, provider: 'claude', model: 'claude-opus-4-8', reasoning: 'high', agentType: 'claude',
    title: id, cwd: dir, status: 'idle', archived: false, pinned: false, permission: 'auto', fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null,
    frozenActiveElapsed: 0, threadRules: null, nativeId: null, scope, routineRunId: null, createdAt: MON - 14 * DAY, updatedAt: at(6, 0)
  } as unknown as SessionMeta)
for (const [id, ws] of [['t-cosmic', 'w-cosmic'], ['t-hypixel', 'w-hypixel'], ['t-purdue', 'w-purdue'], ['t-life', 'w-life']]) thread(id!, ws!)
thread('t-code', 'ws-code', 'code')

/** The registry's part a Work mount reads, over the real store. Starting a thread is refused and written down. */
const started: unknown[] = []
/** What the host logged: a source the review left out says why here. */
const hostLog: string[] = []
const registry = {
  get: (id: string) => store.getSession(id) ?? undefined,
  getProject: () => null,
  listProjects: () => [],
  listWorkspaces: () => store.listWorkspaces(),
  eventsAfter: () => [],
  whisper: () => {},
  deliverAgentReport: (...args: unknown[]) => void started.push(['report', ...args]),
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {},
  onCatalog: () => () => {},
  onMeta: () => () => {},
  async startWith(...args: unknown[]) {
    started.push(['startWith', ...args])
    throw new Error('no thread may start in this proof')
  }
}
/** LifeOS's own connection, never opened: no device token, and a transport that refuses and is written down. */
const transportCalls: string[] = []
lifeosSeamsFor.current = {
  address: { url: 'https://lifeos.invalid', mcpUrl: 'https://lifeos.invalid/mcp' },
  tokens: { read: () => null, write: () => {}, clear: () => {} },
  hasGrant: () => false,
  transport: {
    open: async (fn: string) => {
      transportCalls.push(fn)
      throw new Error('no network in this proof')
    },
    connect: () => {
      transportCalls.push('connect')
      throw new Error('no network in this proof')
    }
  } as never
}
/** The routines engine's host handles, as routines.rig.test.ts plays them: workspaces from the real store, no add-on reads, no threads. */
routinesSeams.current = {
  interval: false,
  now: () => clock.now,
  host: {
    workspace: (id) => store.listWorkspaces().find((w) => w.id === id) ?? null,
    addon: () => null,
    mayRead: () => false,
    read: async () => {
      throw new Error('no add-on reads in this proof')
    },
    session: (id) => store.getSession(id),
    onMeta: () => () => {},
    markRead: () => {},
    markUnread: () => {},
    heldIn: () => 0,
    busyBelow: () => false,
    threadOfRun: () => null,
    readOnly: () => false,
    words: () => []
  } satisfies RoutinesHost
}
const before = [...WORK_MODULES]
WORK_MODULES.splice(0, WORK_MODULES.length, outboxSeen, routines, mailStandIn, historyStandIn, browserStandIn, review)
const work = startWork({ db, store, registry: registry as never, environmentId: 'env_box', dataDir: dir, log: (line) => void hostLog.push(line) }, [...WORK_MODULES])
work.ctx.lifeos = {
  connected: () => true,
  owner: () => lifeosClient,
  jwt: async () => 'jwt',
  subscribe: (fn, args, on) => {
    lifeosCalls.push({ kind: 'subscribe', fn, args: (args ?? {}) as Record<string, unknown> })
    // The Outbox's watch on LifeOS's held drafts: none are held there.
    if (fn === 'outboxHeld:held' || fn === 'calendarOps:held') queueMicrotask(() => on([] as never))
    return () => {}
  }
}
work.ctx.links = { link: async () => {}, forThread: async () => [], completeFor: async () => {} }
const pushes: WorkPush[] = []
work.pushes.onPush((p) => void pushes.push(p))
const outboxHost = outboxHostOf(work.ctx)!
const sendCalls: unknown[] = []
outboxHost.outbox.send = async (ref) => {
  sendCalls.push(ref)
  throw new Error('this proof refuses every send')
}

let n = 0
const rpc = async <T>(method: string, params?: unknown, principal: Principal = LOCAL_PRINCIPAL): Promise<T> => {
  const a = await work.handle({ id: String(++n), method, params } as ClientRequest, principal)
  if (!a.handled) throw new Error(`${method} not handled`)
  return a.result as T
}
const readKey: Principal = { kind: 'remote', keyId: 'k-tablet', name: 'tablet', audience: 'client', caps: ['read', 'operate'] }
const asThread: Caller = { kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-purdue' }
const keys = (rows: readonly { key: string }[]): string[] => rows.map((r) => r.key).sort()
const weekRow = () => db.prepare('SELECT from_at, made_at, made_by, routine_at, seen_at FROM work_review_weeks').all() as { from_at: number; made_at: number; made_by: string; routine_at: number | null; seen_at: number | null }[]
const say = (sessionId: string, t: number, by: Record<string, unknown> = { kind: 'owner' }): void => {
  clock.now = t
  store.appendEvent(sessionId, { type: 'user-text', text: 'made-up words', by } as unknown as AgentEvent)
}
const status = (sessionId: string, t: number, s: string): void => {
  clock.now = t
  store.appendEvent(sessionId, { type: 'status', status: s } as unknown as AgentEvent)
}
const held = (sessionId: string, t: number, channel: string, text: string): string => {
  clock.now = t
  const item = work.ctx.held.create({ kind: 'teams.post', sessionId, payload: { channel, text } })
  assert.equal(item.state, 'held')
  return item.ref.at === 'host' ? item.ref.id : assert.fail('a host row')
}

let code = 1
try {
  // ── Monday: the host boots with Work on; then the week happens ─────────────────────────────────────
  clock.now = at(0, 8)
  work.settings.set({ enabled: true })
  // The review's `start` seeds the Friday routine; this waits for that same make.
  await seedRoutine(work.ctx)
  status('t-cosmic', at(0, 9), 'running')
  say('t-cosmic', at(0, 9))
  say('t-cosmic', at(0, 9, 10))
  say('t-cosmic', at(0, 9, 25))
  status('t-cosmic', at(0, 9, 30), 'idle')
  const H1 = held('t-purdue', at(0, 10), '#esports-staff', 'bracket for finals')
  const H2 = held('t-cosmic', at(0, 11), '#dev-updates', 'patch notes')
  // Not his: a line the app wrote in a thread is no sign he was at the desk.
  say('t-cosmic', at(0, 14), { kind: 'app' })
  status('t-hypixel', at(0, 16), 'running')
  say('t-hypixel', at(0, 16))
  status('t-hypixel', at(0, 16, 45), 'idle')
  clock.now = at(1, 13, 50)
  work.ctx.canvas.open('t-hypixel', 'document', DOC, 'Color notes')
  say('t-life', at(1, 21))
  const H3 = held('t-purdue', at(2, 12), '#esports', 'finals schedule')
  say('t-purdue', at(2, 13, 30))
  say('t-purdue', at(2, 15))
  say('t-purdue', at(2, 15, 15))
  // A code thread is never a job's.
  say('t-code', at(2, 16))
  store.flushEvents()

  // ── Wednesday 6:00 PM ─────────────────────────────────────────────────────────────────────────────
  clock.now = at(2, 18)
  const WEEK = weekOf(clock.now, TZ)
  const ask = { from: WEEK.from, to: WEEK.to, tz: TZ }
  const body1 = await rpc<ReviewBody>('work.review.week', ask)
  const r1 = mergeReview([{ environmentId: 'env_box', body: body1 }], clock.now)!

  await step('1. the week asked for is Monday Nov 16 to Monday Nov 23 in Chicago', () => assert.deepEqual(WEEK, { from: MON, to: at(7, 0) }))
  await step("1. work.review.week, as this host's own window, answers the six Work workspaces as its jobs (the code workspace is none)", () => {
    assert.deepEqual(body1.jobs.map((j) => [j.workspaceId, j.sector, j.name]), JOBS.map(([id, name, sector]) => [id, sector, name]))
    assert.deepEqual(r1.jobs.map((j) => j.key), ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life'])
    assert.equal(body1.over, false)
    assert.equal(body1.by, 'owner')
  })
  await step('1. every source answered: nothing is left out', () => assert.deepEqual(body1.left, []))
  await step('1. merged hours per job, in ms: calendar measured, desk from the sittings less any counted event, threads\' run time apart', () => {
    const got = Object.fromEntries(r1.hours.map((h) => [h.job, { calendar: h.calendarMs, desk: h.deskMs, ran: h.ranMs, events: h.events }]))
    assert.deepEqual(got, {
      // 10:00-12:00 joined; Monday's sitting 8:55-9:25; the mail at 12:00 sits under the meeting; ran 9:00-9:30
      cosmic: { calendar: 2 * HOUR, desk: 30 * MIN, ran: 30 * MIN, events: 2 },
      // 2 h alone + the 30 m call; the message at 4:00 PM is under the 2 h, the document edit Tue 2:00 PM is 5 m; ran 45 m
      hypixel: { calendar: 2 * HOUR + 30 * MIN, desk: 5 * MIN, ran: 45 * MIN, events: 2 },
      // 1 h meeting; 1:30 PM is under it, 2:55-3:15 is 20 m, the 9:00 AM mail 5 m (the declined call covers nothing)
      purdue: { calendar: HOUR, desk: 25 * MIN, ran: 0, events: 1 },
      // the game; the declined call is not counted
      ref: { calendar: 2 * HOUR, desk: 0, ran: 0, events: 1 },
      // nothing all week
      unify: { calendar: 0, desk: 0, ran: 0, events: 0 },
      // the dentist; Tuesday 9:00 PM alone is 5 m; the day-long event is no calendar time
      life: { calendar: 30 * MIN, desk: 5 * MIN, ran: 0, events: 1 }
    })
  })
  await step('1. what each estimate stands on, and each total in words ("about" whenever desk time is in it)', () => {
    assert.deepEqual(Object.fromEntries(r1.hours.map((h) => [h.job, h.stands])), {
      cosmic: { said: 3, sent: 1, pressed: 0, edited: 0 },
      hypixel: { said: 1, sent: 0, pressed: 0, edited: 1 },
      purdue: { said: 3, sent: 1, pressed: 0, edited: 0 },
      ref: { said: 0, sent: 0, pressed: 0, edited: 0 },
      unify: { said: 0, sent: 0, pressed: 0, edited: 0 },
      life: { said: 1, sent: 0, pressed: 0, edited: 0 }
    })
    assert.deepEqual(Object.fromEntries(r1.hours.map((h) => [h.job, totalWords(h)])), {
      cosmic: 'about 2 h 30 m',
      hypixel: 'about 2 h 30 m',
      purdue: 'about 1 h 30 m',
      ref: '2 h',
      unify: null,
      life: 'about 30 m'
    })
    assert.deepEqual(body1.ran, [[0, 30 * MIN], [1, 45 * MIN]])
  })
  await step('1. what shipped: the two mails sent, the task finished, the answer Dana gave', () =>
    assert.deepEqual(keys(r1.shipped), [`answered:mt-pur-seeds:${at(2, 11)}`, 'done:tk-cos-done', 'sent:sent-cos-1', 'sent:sent-pur-1'])
  )
  const slipped1 = keys(body1.slipped.rows)
  await step('1. what slipped: the tasks past due (one from the week before), and not the one due Friday', () => {
    assert.deepEqual(slipped1.filter((k) => k.startsWith('task:')), ['task:tk-hyp-1', 'task:tk-life-1', 'task:tk-pur-1', 'task:tk-ref-1'])
    assert.equal(body1.slipped.rows.find((r) => r.key === 'task:tk-ref-1')!.at, at(-6, 9))
  })
  await step('1. what slipped: the mails waiting past their time, and not the one due Saturday', () =>
    assert.deepEqual(slipped1.filter((k) => k.startsWith('mail:')), [waitRow('mt-cos-1'), waitRow('mt-pur-1')])
  )
  await step('1. what slipped: the meetings with someone else on them and no mail to them after (not the ones Riley got a mail after, nor one alone or declined)', () => {
    assert.deepEqual(slipped1.filter((k) => k.startsWith('meeting:')), ['meeting:ev-hyp-3', 'meeting:ev-pur-1'])
    assert.deepEqual(body1.slipped.rows.find((r) => r.key === 'meeting:ev-pur-1')!.people, ['Dana Reyes', 'Sam Lindqvist'])
  })
  await step('1. what slipped: the REAL held items that waited over a day (Monday\'s two), not the one held six hours', () => {
    assert.deepEqual(slipped1.filter((k) => k.startsWith('held:')), [`held:host:${H1}`, `held:host:${H2}`].sort())
    assert.equal(body1.slipped.rows.find((r) => r.key === `held:host:${H1}`)!.title, 'Post to #esports-staff: bracket for finals')
    assert.ok(!slipped1.includes(`held:host:${H3}`))
    assert.equal(slipped1.length, 10)
  })
  await step('1. the week is kept: one row, made by the owner', () => assert.deepEqual(weekRow().map((r) => [r.from_at, r.made_at, r.made_by]), [[MON, at(2, 18), 'owner']]))

  // ── Wednesday, a minute later: who may ask ────────────────────────────────────────────────────────
  clock.now = at(2, 18, 1)
  await step("2. a thread's own call (a model caller) is refused for every method that shows or changes the review", async () => {
    const calls: [string, unknown][] = [
      ['work.review.week', ask],
      ['work.review.list', {}],
      ['work.review.settle', { row: { kind: 'task', id: 'tk-pur-1', dueAt: at(1, 9) }, how: 'now', tz: TZ }],
      ['work.review.undo', { token: 'x' }],
      ['work.review.seen', { from: MON }],
      ['work.review.routine', {}]
    ]
    const writes = lifeosCalls.filter((c) => c.kind === 'mutation').length
    for (const [method, params] of calls) await assert.rejects(review.handle!({ id: 'x', method, params } as never, work.ctx, asThread), (e: Error) => e.message === NOT_A_PERSON)
    assert.equal(await review.handle!({ id: 'x', method: 'work.review.ready', params: {} } as never, work.ctx, asThread).then((a) => (a as { result: unknown }).result), null)
    assert.equal(lifeosCalls.filter((c) => c.kind === 'mutation').length, writes)
  })
  await step('2. a key that cannot approve is refused the week too', () => assert.rejects(rpc('work.review.week', ask, readKey), (e: Error) => e.message === NOT_A_PERSON))
  const purdueThread = store.getSession('t-purdue')!
  const toolText = await work.tools
    .call(purdueThread, 'week_review', { week: '2026-11-18' }, new AbortController().signal)
    .then((r) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'))
  await step("2. week_review is a Purdue thread's tool and tells Purdue's week: its hours, what LifeOS holds of its sector (shipped and slipped)", () => {
    assert.ok(work.tools.listing(purdueThread).some((t) => t.name === 'week_review' && t.readOnly === true))
    for (const want of ['Week of Nov 16, Purdue.', 'In all: about 1 h 30 m', 'Seeds for the bracket', 'Book the arena for finals', 'Venue contract', 'Bracket review']) assert.ok(toolText.includes(want), `missing "${want}"`)
  })
  await step("2. week_review counts the job's own held item too, and leaves no source out", () => {
    const notCounted = toolText.split('\n').find((l) => l.startsWith('Not counted:'))
    assert.ok(toolText.includes('Post to #esports-staff: bracket for finals'), `the held item Purdue's thread made is missing${notCounted ? `; the tool says "${notCounted}"` : ''}${hostLog.filter((l) => l.includes('Outbox')).map((l) => `; the host logged "${l}"`).join('')}`)
    assert.equal(notCounted, undefined)
  })
  await step("2. week_review says nothing of another job's rows", () => {
    const others = ['Cosmic', 'Hypixel', 'Refereeing', 'Unify', 'Personal', 'Sprint planning', 'Design sync', 'Server plan', 'Server costs', 'Fix spawn lag', 'Footage review', 'Thumbnail call', 'Send color notes', 'Renew passport', 'File game report', 'Varsity game', 'Dentist', '#dev-updates', 'Riley', 'Ada', 'Lease renewal', 'Review the patch']
    const leaked = others.filter((w) => toolText.includes(w))
    assert.deepEqual(leaked, [], `the tool's text names ${leaked.join(', ')}`)
  })
  await step("2. a thread's read leaves no mark on the kept week", () => assert.deepEqual(weekRow().map((r) => r.made_at), [at(2, 18)]))

  // ── Thursday 9:00 AM: asked again in the same week ────────────────────────────────────────────────
  clock.now = at(3, 9)
  const body2 = await rpc<ReviewBody>('work.review.week', ask)
  await step('3. asked again later in the same week, the kept row is overwritten: one row, made now, what slipped read now', () => {
    assert.deepEqual(weekRow().map((r) => [r.from_at, r.made_at]), [[MON, at(3, 9)]])
    assert.equal(keptWeek(db, MON)!.madeAt, at(3, 9))
    assert.equal(body2.slipped.at, at(3, 9))
    assert.deepEqual(keys(body2.slipped.rows), slipped1)
  })

  // ── Thursday 10:00 AM: his presses ───────────────────────────────────────────────────────────────
  clock.now = at(3, 10)
  const ref = (key: string): SlippedRef => (body2.slipped.rows.find((r: SlippedRow) => r.key === key) ?? assert.fail(`no row ${key}`)).ref
  /** What one press reached: LifeOS's writes, the stand-in pillars, the Outbox. */
  const reached = async <T>(run: () => Promise<T>): Promise<{ out: T; lifeos: [string, unknown][]; modules: [string, string, unknown][]; outbox: string[] }> => {
    const [l, m, o] = [lifeosCalls.length, moduleCalls.length, outboxCalls.length]
    const out = await run()
    return {
      out,
      lifeos: lifeosCalls.slice(l).filter((c) => c.kind !== 'query' && c.kind !== 'subscribe').map((c) => [c.fn, c.args]),
      modules: moduleCalls.slice(m).map((c) => [c.module, c.method, c.params]),
      outbox: outboxCalls.slice(o).map((c) => c.method)
    }
  }
  const press = (key: string, how: 'now' | 'later' | 'drop', sector?: string) => reached(() => rpc<ReviewSettled>('work.review.settle', { row: ref(key), how, tz: TZ, ...(sector ? { sector } : {}) }))
  const nothingElse = { modules: [], outbox: [] }
  const markOf = (key: string): { how: string; until: number | null } | undefined => {
    const row = db.prepare('SELECT how, until FROM work_review_marks WHERE key = ?').get(key) as { how: string; until: number | null } | undefined
    // node:sqlite answers rows with no prototype
    return row ? { how: row.how, until: row.until } : undefined
  }

  const done = await press('task:tk-pur-1', 'now')
  await step("4. a task's Done calls tasks:complete with its id and nothing else", () => {
    assert.deepEqual({ lifeos: done.lifeos, modules: done.modules, outbox: done.outbox }, { lifeos: [['tasks:complete', { id: 'tk-pur-1' }]], ...nothingElse })
    assert.ok(done.out.undo)
  })
  await step('4. work.review.undo takes the press back exactly once: tasks:reopen, then "can no longer be taken back" with nothing called', async () => {
    const first = await reached(() => rpc('work.review.undo', { token: done.out.undo }))
    assert.deepEqual(first.lifeos, [['tasks:reopen', { id: 'tk-pur-1' }]])
    const second = await reached(() => assert.rejects(rpc('work.review.undo', { token: done.out.undo }), (e: Error) => e.message === UNDO_GONE))
    assert.deepEqual([second.lifeos, second.modules, second.outbox], [[], [], []])
    // and done again, for good
    assert.deepEqual((await press('task:tk-pur-1', 'now')).lifeos, [['tasks:complete', { id: 'tk-pur-1' }]])
  })
  const nextTask = await press('task:tk-hyp-1', 'later')
  await step("4. a task's Next week calls tasks:update with its due date at next Monday 9:00 AM in Chicago, and nothing else", () => {
    assert.equal(new RealDate(NEXT_MON_9).toISOString(), '2026-11-23T15:00:00.000Z')
    assert.deepEqual({ lifeos: nextTask.lifeos, modules: nextTask.modules, outbox: nextTask.outbox }, { lifeos: [['tasks:update', { id: 'tk-hyp-1', patch: { dueAt: NEXT_MON_9 } }]], ...nothingElse })
  })
  const dropTask = await press('task:tk-life-1', 'drop')
  await step("4. a task's Drop calls tasks:drop with its id and the reason, and nothing else", () =>
    assert.deepEqual({ lifeos: dropTask.lifeos, modules: dropTask.modules, outbox: dropTask.outbox }, { lifeos: [['tasks:drop', { id: 'tk-life-1', reason: 'Dropped in the weekly review' }]], ...nothingElse })
  )
  const putOff = await press(waitRow('mt-pur-1'), 'later')
  await step("4. a waiting mail's Next week calls mailWaits:putOff to next Monday 9:00 AM, and nothing else", () =>
    assert.deepEqual({ lifeos: putOff.lifeos, modules: putOff.modules, outbox: putOff.outbox }, { lifeos: [['mailWaits:putOff', { threadId: 'mt-pur-1', until: NEXT_MON_9, since: at(0, 10) }]], ...nothingElse })
  )
  const nudge = await press(waitRow('mt-cos-1'), 'now', 'cosmic')
  await step("4. a waiting mail's Nudge asks the Mail pillar (stand-in) for a draft in the Cosmic workspace, writes nothing in LifeOS, and has no undo", () => {
    assert.deepEqual({ lifeos: nudge.lifeos, modules: nudge.modules, outbox: nudge.outbox }, { lifeos: [], modules: [['mail', 'work.mail.nudge', { workspaceId: 'w-cosmic', threadId: 'mt-cos-1' }]], outbox: [] })
    assert.deepEqual(nudge.out, { undo: null, sessionId: 'nudge-standin' })
  })
  const stop = await press(waitRow('mt-cos-1'), 'drop')
  await step("4. a waiting mail's Stop waiting calls mailWaits:dismiss, and nothing else", () =>
    assert.deepEqual({ lifeos: stop.lifeos, modules: stop.modules, outbox: stop.outbox }, { lifeos: [['mailWaits:dismiss', { threadId: 'mt-cos-1', since: at(0, 11) }]], ...nothingElse })
  )
  const none = await press('meeting:ev-pur-1', 'drop')
  const later = await press('meeting:ev-hyp-3', 'later')
  await step("4. a meeting's None needed and Next week are the review's own marks: no call anywhere; Next week runs to next Monday", () => {
    for (const p of [none, later]) assert.deepEqual([p.lifeos, p.modules, p.outbox], [[], [], []])
    assert.deepEqual(markOf('meeting:ev-pur-1'), { how: 'drop', until: null })
    assert.deepEqual(markOf('meeting:ev-hyp-3'), { how: 'later', until: at(7, 0) })
  })
  const heldLater = await press(`held:host:${H2}`, 'later')
  await step("4. a held item's Next week is a mark to next Monday: no call anywhere", () => {
    assert.deepEqual([heldLater.lifeos, heldLater.modules, heldLater.outbox], [[], [], []])
    assert.deepEqual(markOf(`held:host:${H2}`), { how: 'later', until: at(7, 0) })
  })
  await step("4. a held item's \"now\" is refused: the review never sends one", async () => {
    const p = await reached(() => assert.rejects(rpc('work.review.settle', { row: ref(`held:host:${H1}`), how: 'now', tz: TZ }), (e: Error) => e.message === OPEN_IN_OUTBOX))
    assert.deepEqual([p.lifeos, p.modules, p.outbox], [[], [], []])
  })
  const discard = await press(`held:host:${H1}`, 'drop')
  await step("4. a held item's Discard is the REAL Outbox's discard alone: the row ends discarded, by the owner, never sent", async () => {
    assert.deepEqual({ lifeos: discard.lifeos, modules: discard.modules, outbox: discard.outbox }, { lifeos: [], modules: [], outbox: ['work.outbox.discard'] })
    assert.deepEqual(discard.out, { undo: null })
    const decided = (await rpc<{ items: OutboxItem[] }>('work.outbox.list', { show: 'decided' })).items.find((i) => i.ref.at === 'host' && i.ref.id === H1)
    assert.ok(decided, 'H1 is not in the decided list')
    assert.deepEqual([decided.state, decided.decidedBy], ['discarded', 'owner'])
    assert.deepEqual([executed, sendCalls], [[], []])
  })
  clock.now = at(3, 10, 5)
  const body3 = await rpc<ReviewBody>('work.review.week', ask)
  await step('4. the next make: every pressed row is gone; only the older task is left; the task marked done shipped', () => {
    assert.deepEqual(keys(body3.slipped.rows), ['task:tk-ref-1'])
    assert.ok(keys(mergeReview([{ environmentId: 'env_box', body: body3 }], clock.now)!.shipped).includes('done:tk-pur-1'))
  })

  // ── Friday 4:00 PM: the routine ──────────────────────────────────────────────────────────────────
  const all = async (): Promise<RoutineRow[]> => (await rpc<{ routines: RoutineRow[] }>('work.routines.list', {})).routines
  const mine = async (): Promise<RoutineRow[]> => (await all()).filter((r) => r.name === ROUTINE_NAME)
  await step('5. the review\'s start made exactly one routine through the REAL routines module: "Weekly review", Fridays at 4:00 PM in LifeOS\'s zone, job review.make, no prompt, in the Personal (life) workspace', async () => {
    const rows = await all()
    assert.equal(rows.length, 1)
    const [r] = rows
    assert.deepEqual(
      { name: r!.name, workspaceId: r!.workspaceId, job: r!.job, prompt: r!.prompt, trigger: r!.trigger, words: r!.words, enabled: r!.enabled, nextAt: r!.nextAt },
      { name: 'Weekly review', workspaceId: 'w-life', job: MAKE_JOB, prompt: '', trigger: { on: 'schedule', rrule: ROUTINE_RRULE, tz: TZ }, words: 'Fridays at 4:00 PM', enabled: true, nextAt: at(4, 16) }
    )
  })
  await step('5. a second seed makes none', async () => {
    await seedRoutine(work.ctx, TZ)
    assert.equal((await all()).length, 1)
  })
  const routineId = (await mine())[0]?.id ?? ''
  const sessionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
  clock.now = at(4, 16)
  const engine = routinesEngine(work.ctx)
  await engine.tick()
  await engine.drain()
  const runs = (await rpc<{ runs: RoutineRun[] }>('work.routines.runs', { id: routineId })).runs
  await step('5. at Friday 4:00 PM a tick of the real engine fires it with no thread: one quiet run that opens the review at the week\'s first ms', () => {
    assert.equal(runs.length, 1)
    const [run] = runs
    assert.deepEqual({ state: run!.state, sessionId: run!.sessionId, open: run!.open, summary: run!.summary, firedAt: run!.firedAt }, { state: 'quiet', sessionId: null, open: { place: 'review', at: MON }, summary: 'Week of Nov 16: 3 things slipped on this host', firedAt: at(4, 16) })
    assert.deepEqual(started, [])
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, sessionsBefore)
  })
  await step('5. the week is kept as the routine made it: by the routine, ready and unseen, what slipped read at 4:00 PM', () => {
    assert.deepEqual(weekRow().map((r) => [r.from_at, r.made_at, r.made_by, r.routine_at, r.seen_at]), [[MON, at(4, 16), 'routine', at(4, 16), null]])
    const kept = keptWeek(db, MON)!
    assert.deepEqual([kept.by, kept.slipped.at, keys(kept.slipped.rows)], ['routine', at(4, 16), [`held:host:${H3}`, 'task:tk-cos-2', 'task:tk-ref-1']])
    assert.ok(pushes.some((p) => (p as { push: string }).push === 'work.review' && (p as { seen?: boolean }).seen === false))
  })
  clock.now = at(4, 16, 1)
  await engine.tick()
  await engine.drain()
  await step('5. a tick a minute later fires nothing more', async () => assert.equal((await rpc<{ runs: RoutineRun[] }>('work.routines.runs', { id: routineId })).runs.length, 1))
  await step('5. work.review.ready names the week (for a read-only key too); work.review.seen clears it', async () => {
    assert.deepEqual(await rpc('work.review.ready', {}), { from: MON, madeAt: at(4, 16) })
    assert.deepEqual(await rpc('work.review.ready', {}, readKey), { from: MON, madeAt: at(4, 16) })
    assert.deepEqual(await rpc('work.review.seen', { from: MON }), { ok: true })
    assert.equal(await rpc('work.review.ready', {}), null)
    assert.ok(pushes.some((p) => (p as { push: string }).push === 'work.review' && (p as { seen?: boolean }).seen === true))
  })

  // ── The Monday after: the week is over ───────────────────────────────────────────────────────────
  // At 9:30 he finishes "Review the patch" in LifeOS itself.
  clock.now = at(7, 9, 30)
  task('tk-cos-2').state = 'done'
  task('tk-cos-2').completedAt = clock.now
  clock.now = at(7, 10)
  const over = await rpc<ReviewBody>('work.review.week', ask)
  await step('3. past the week\'s end, what slipped stays as it stood at the last make inside the week (Friday 4:00 PM), and a row dealt with since reads open: false', () => {
    assert.deepEqual([over.over, over.by, over.slipped.at, over.madeAt], [true, 'routine', at(4, 16), at(7, 10)])
    assert.deepEqual(over.slipped.rows.map((r) => [r.key, r.open]).sort(), [[`held:host:${H3}`, true], ['task:tk-cos-2', false], ['task:tk-ref-1', true]])
  })
  const nextAsk = { ...stepWeek(WEEK, 1, TZ), tz: TZ }
  const nextWeek = await rpc<ReviewBody>('work.review.week', nextAsk)
  await step('3. work.review.list lists the kept weeks, newest first, in LifeOS\'s zone', async () => {
    const list = await rpc<{ weeks: { from: number; to: number; tz: string; by: string }[]; tz: string }>('work.review.list', {})
    assert.equal(list.tz, TZ)
    assert.deepEqual(list.weeks.map((w) => [w.from, w.to, w.tz]), [[at(7, 0), at(14, 0), TZ], [MON, at(7, 0), TZ]])
  })
  await step('4. on Monday, Next week comes back for a task, a waiting mail and a held item (in the new week)', () => {
    const k = keys(nextWeek.slipped.rows)
    for (const want of ['task:tk-hyp-1', waitRow('mt-pur-1'), `held:host:${H2}`]) assert.ok(k.includes(want), `${want} is not back: ${k.join(', ')}`)
    assert.ok(!k.includes('meeting:ev-pur-1') && !keys(over.slipped.rows).includes('meeting:ev-pur-1'), 'None needed came back')
  })
  await step("4. on Monday, a meeting's Next week comes back (in last week's review or this week's)", () => {
    const where = [...keys(over.slipped.rows).map((k) => `last week: ${k}`), ...keys(nextWeek.slipped.rows).map((k) => `this week: ${k}`)]
    assert.ok(where.some((w) => w.endsWith('meeting:ev-hyp-3')), `meeting:ev-hyp-3 is in neither week; the mark ran out at ${new RealDate(at(7, 0)).toISOString()} and the rows shown are ${where.join(', ')}`)
  })
  await step('5. removing the routine and seeding again makes none, and work.review.routine says none', async () => {
    await rpc('work.routines.remove', { id: routineId })
    await seedRoutine(work.ctx, TZ)
    assert.deepEqual(await mine(), [])
    assert.equal(await rpc('work.review.routine', {}), null)
  })

  // ── the whole run ────────────────────────────────────────────────────────────────────────────────
  await step("nothing in the run ever called the Outbox's send: no work.outbox.send, no send, no act carried out, every held row held or discarded", () => {
    assert.ok(!outboxCalls.some((c) => c.method === 'work.outbox.send'))
    assert.deepEqual([sendCalls, executed], [[], []])
    const states = db.prepare('SELECT id, state FROM work_held_acts ORDER BY id').all() as { id: string; state: string }[]
    assert.deepEqual(Object.fromEntries(states.map((s) => [s.id, s.state])), { [H1]: 'discarded', [H2]: 'held', [H3]: 'held' })
  })
  await step('no thread was started, no network was opened, and LifeOS was read only through the functions the review names', () => {
    assert.deepEqual(started, [])
    assert.deepEqual(transportCalls, [])
    const reads = [...new Set(lifeosCalls.filter((c) => c.kind === 'query').map((c) => c.fn))].sort()
    assert.deepEqual(reads.filter((fn) => !REVIEW_READS.includes(fn)), [])
  })
  code = failures.length ? 1 : 0
} catch (err) {
  console.log(`FAIL: the run stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  code = 1
} finally {
  try {
    work.close()
  } catch {
    // closing is best effort
  }
  WORK_MODULES.splice(0, WORK_MODULES.length, ...before)
  routinesSeams.current = null
  lifeosSeamsFor.current = null
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
}
if (code === 0) console.log(`e2e-review: ${passed} steps passed`)
else console.log(`e2e-review: ${failures.length} failed, ${passed} passed${failures.length ? `\n  - ${failures.join('\n  - ')}` : ''}`)
process.exit(code)
