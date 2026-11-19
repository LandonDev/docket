import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { LOCAL_PRINCIPAL, type Capability, type Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { SessionMeta } from '@shared/events'
import { handled, NOT_HANDLED, type WorkScope } from '@shared/work'
import { openDb, Store } from '../db'
import type { SessionRegistry } from '../sessions'
import type { WorkPartDeps } from './ctx'
import type { Caller, ToolCtx, WorkCtx, WorkModule, WorkSend } from './modules'

// The mount alone: a Work thread's scope here is whatever the test says it is (work/scope.ts decides it for real).
// The part also keeps something that lives only while Work is on, as a later part's connection will.
const scopes = new Map<string, WorkScope>()
const part = { up: 0, down: 0 }
vi.mock('./scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scope')>()),
  scopePart: (_ctx: WorkCtx, deps: WorkPartDeps) => {
    deps.whileOn(() => {
      part.up++
      return () => void part.down++
    })
    return {
      scopeOf: (id: string) => scopes.get(id) ?? null,
      createWorkspace: async () => {
        throw new Error('not in this test')
      },
      admitSession: () => {}
    }
  }
}))
const { startWork } = await import('./ctx')

/**
 * A module registered through the one mount gets its table made, its method
 * routed with the caller's capabilities, its push delivered and its tool
 * listed and run: everything a pillar fills, proven with a fake before any
 * pillar exists.
 */

interface Seen {
  ensured: number
  started: number
  stopped: number
  handled: { method: string; by: Caller; host: string }[]
  /** a handler that waits on the signal the router gave it, and what it saw */
  waiting: { started: number; aborted: number }
  ran: { args: unknown; sessionId: string; workspaceId: string | null; aborted: boolean }[]
  /** a tool call that waits on its signal, and what it saw */
  slow: { started: number; aborted: number }
  /** how many slow calls had been aborted by the time the module was stopped */
  abortedAtStop: number
  removed: { sessions: string[][]; workspaces: string[] }
  send: WorkSend | null
  subscribed: number
  unsubscribed: number
}
const fakeModule = (seen: Seen): WorkModule => ({
  id: 'mail',
  ensure(db) {
    seen.ensured++
    db.exec(`CREATE TABLE IF NOT EXISTS work_mail_fake (id TEXT PRIMARY KEY, note TEXT NOT NULL)`)
  },
  async handle(req, ctx, by, signal) {
    const method = req.method as string
    if (method === 'work.mail.elsewhere') return NOT_HANDLED
    if (method === 'work.mail.wait') {
      seen.waiting.started++
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
      seen.waiting.aborted++
      return handled('stopped')
    }
    seen.handled.push({ method, by, host: ctx.host })
    return handled({ pong: (req as { params?: { n?: number } }).params?.n ?? 0 })
  },
  onPush(send) {
    seen.subscribed++
    seen.send = send
    return () => {
      seen.unsubscribed++
      seen.send = null
    }
  },
  tools(scope) {
    return [
      {
        name: 'mail_fake_search',
        description: `Search mail in ${scope.sector ?? 'every sector'}`,
        input: z.object({ query: z.string().describe('what to look for'), limit: z.number().int().optional() }),
        readOnly: true,
        run: async (args, ctx: ToolCtx) => {
          seen.ran.push({ args, sessionId: ctx.sessionId, workspaceId: ctx.scope.workspaceId, aborted: ctx.signal.aborted })
          return { content: [{ type: 'text', text: `found for ${(args as { query: string }).query} on ${ctx.host}` }] }
        }
      },
      {
        name: 'mail_fake_slow',
        description: 'Waits until it is cancelled',
        input: z.object({}),
        readOnly: true,
        run: (_args, ctx: ToolCtx) =>
          new Promise((resolve) => {
            seen.slow.started++
            ctx.signal.addEventListener('abort', () => {
              seen.slow.aborted++
              resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true })
            })
          })
      },
      // refused by the mount, each for its own reason
      { name: 'Mail-Bad', description: 'x', input: z.object({}), readOnly: true, run: async () => ({ content: [] }) },
      { name: 'mail_not_an_object', description: 'x', input: z.string(), readOnly: true, run: async () => ({ content: [] }) },
      { name: 'mail_fake_search', description: 'twice', input: z.object({}), readOnly: true, run: async () => ({ content: [] }) }
    ]
  },
  start(ctx: WorkCtx) {
    seen.started++
    ctx.log('mail started')
    return () => {
      seen.abortedAtStop = seen.slow.aborted
      seen.stopped++
    }
  },
  sessionsRemoved: (ids) => void seen.removed.sessions.push(ids),
  workspaceRemoved: (id) => void seen.removed.workspaces.push(id)
})
const fresh = (): Seen => ({ ensured: 0, started: 0, stopped: 0, handled: [], waiting: { started: 0, aborted: 0 }, ran: [], slow: { started: 0, aborted: 0 }, abortedAtStop: -1, removed: { sessions: [], workspaces: [] }, send: null, subscribed: 0, unsubscribed: 0 })

let dir: string
let db: ReturnType<typeof openDb>
let seen: Seen
let work: ReturnType<typeof startWork>
const sessions = new Map<string, SessionMeta>()
const session = (id: string, scope?: 'work' | 'code'): SessionMeta => {
  const meta = { id, provider: 'claude', ...(scope ? { scope } : {}) } as SessionMeta
  sessions.set(id, meta)
  return meta
}
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const remote = (caps: Capability[]): Principal => ({ kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps })
/** The registry as the mount uses it: a thread by id, and the two delete hooks. */
const deleted = { sessions: [] as ((ids: string[]) => void)[], workspaces: [] as ((id: string) => void)[] }
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: (fn: (ids: string[]) => void) => (deleted.sessions.push(fn), () => {}),
  onWorkspaceDeleted: (fn: (id: string) => void) => (deleted.workspaces.push(fn), () => {})
} as unknown as SessionRegistry
const scopeFor = (id: string, sector: string | null = 'purdue'): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector, host: 'env_test', away: false, routineRunId: null, shared: () => false })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-mount-'))
  db = openDb(join(dir, 'test.db'))
  seen = fresh()
  sessions.clear()
  scopes.clear()
  part.up = part.down = 0
  deleted.sessions.length = deleted.workspaces.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [fakeModule(seen)])
})
afterEach(() => {
  work.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('while Work is off', () => {
  it("makes the module's table all the same, since an ensure only adds", () => {
    expect(seen.ensured).toBe(1)
    db.prepare(`INSERT INTO work_mail_fake (id, note) VALUES (?, ?)`).run('a', 'made while off')
    expect(db.prepare(`SELECT note FROM work_mail_fake WHERE id = 'a'`).get()).toEqual({ note: 'made while off' })
  })
  it('starts nothing, subscribes nothing, routes nothing and lists no tool, even for a Work thread', async () => {
    scopes.set('t-work', scopeFor('t-work'))
    expect([seen.started, seen.subscribed, part.up]).toEqual([0, 0, 0])
    await expect(work.handle(req('work.mail.ping', { n: 1 }), LOCAL_PRINCIPAL)).rejects.toThrow('Work is off on this host')
    expect(seen.handled).toEqual([])
    expect(work.tools.of(session('t-work', 'work'))).toBeNull()
    expect(work.tools.listing(session('t-work', 'work'))).toEqual([])
  })
})

describe('with Work on', () => {
  const pushes: WorkPush[] = []
  let offPush: () => void
  beforeEach(async () => {
    pushes.length = 0
    offPush = work.pushes.onPush((p) => pushes.push(p))
    await work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)
  })
  afterEach(() => offPush())

  it('starts the module and what the parts keep running once, and tells every socket the switch moved', () => {
    expect([seen.started, seen.subscribed, seen.stopped]).toEqual([1, 1, 0])
    expect([part.up, part.down]).toEqual([1, 0])
    expect(pushes).toEqual([{ push: 'work', settings: { enabled: true } }])
    // setting it to what it already is starts nothing twice and pushes nothing
    work.settings.set({ enabled: true })
    expect(seen.started).toBe(1)
    expect(pushes).toHaveLength(1)
  })

  it("routes the pillar's method to its module with the caller's capabilities, and to no other module", async () => {
    expect(await work.handle(req('work.mail.ping', { n: 7 }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { pong: 7 } })
    await work.handle(req('work.mail.ping', {}), remote(['read', 'operate']))
    session('t1', 'work')
    await work.handle(req('app.workMailPing', { sessionId: 't1', token: work.tools.tokenFor('t1') }), LOCAL_PRINCIPAL)
    // without that thread's own token a bridge method never reaches the module
    await expect(work.handle(req('app.workMailPing', { sessionId: 't1', token: work.tools.tokenFor('t2') }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    await expect(work.handle(req('app.workMailPing', { sessionId: 't1' }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    expect(seen.handled).toEqual([
      { method: 'work.mail.ping', by: { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }, host: 'env_test' },
      { method: 'work.mail.ping', by: { kind: 'remote', caps: ['read', 'operate'] }, host: 'env_test' },
      // a bridge method is a thread's own call: the model's, never a person's
      { method: 'app.workMailPing', by: { kind: 'model', caps: [], sessionId: 't1' }, host: 'env_test' }
    ])
    // another pillar's method never reaches this module, and one it declines says "not built"
    await expect(work.handle(req('work.tasks.list', {}), LOCAL_PRINCIPAL)).rejects.toThrow('not built: work.tasks.list (milestone 25)')
    await expect(work.handle(req('work.mail.elsewhere', {}), LOCAL_PRINCIPAL)).rejects.toThrow('not built: work.mail.elsewhere (milestone 23)')
    expect(seen.handled).toHaveLength(3)
  })

  it("gives a handler a signal that aborts when the caller's socket goes, or when Work is turned off", async () => {
    // the socket closes under a long request (a forwarded job whose caller went away)
    const socket = new AbortController()
    const first = work.handle(req('work.mail.wait', {}), remote(['read']), socket)
    await vi.waitFor(() => expect(seen.waiting.started).toBe(1))
    expect(seen.waiting.aborted).toBe(0)
    socket.abort()
    expect(await first).toEqual({ handled: true, result: 'stopped' })
    // no socket handed over (a host-side caller): Work turning off still reaches it
    const second = work.handle(req('work.mail.wait', {}), LOCAL_PRINCIPAL)
    const third = work.handle(req('work.mail.wait', {}), LOCAL_PRINCIPAL, new AbortController())
    await vi.waitFor(() => expect(seen.waiting.started).toBe(3))
    work.settings.set({ enabled: false })
    expect(await second).toEqual({ handled: true, result: 'stopped' })
    expect(await third).toEqual({ handled: true, result: 'stopped' })
    expect(seen.waiting.aborted).toBe(3)
    // a module written before the signal, with three arguments, is called as it was
    const old: WorkModule = { id: 'tasks', ensure() {}, handle: async (r, _ctx, by) => handled({ method: r.method, kind: by.kind }) }
    const booted = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [old])
    booted.settings.set({ enabled: true })
    expect(await booted.handle(req('work.tasks.list', {}), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { method: 'work.tasks.list', kind: 'local' } })
    booted.close()
  })

  it("delivers the module's push to every socket, and stops when the socket goes", () => {
    const other: WorkPush[] = []
    const offOther = work.pushes.onPush((p) => other.push(p))
    const push = { push: 'work.mail', unread: 4 } as unknown as WorkPush
    seen.send!(push)
    work.ctx.push(push)
    expect(pushes.slice(1)).toEqual([push, push])
    expect(other).toEqual([push, push])
    offOther()
    seen.send!(push)
    expect(other).toHaveLength(2)
    expect(pushes).toHaveLength(4)
  })

  it('sends a push that names a capability only to the sockets that hold it', () => {
    const got = { window: [] as WorkPush[], reader: [] as WorkPush[], approver: [] as WorkPush[], admin: [] as WorkPush[] }
    const offs = [
      work.pushes.onPush((p) => got.window.push(p), LOCAL_PRINCIPAL),
      work.pushes.onPush((p) => got.reader.push(p), remote(['read'])),
      work.pushes.onPush((p) => got.approver.push(p), remote(['read', 'approve'])),
      work.pushes.onPush((p) => got.admin.push(p), remote(['admin']))
    ]
    const held = { push: 'work.outbox', held: 1 } as unknown as WorkPush
    const count = { push: 'work.mail', unread: 4 } as unknown as WorkPush
    seen.send!(held, { need: 'approve' })
    work.ctx.push(count)
    expect(got.window).toEqual([held, count])
    expect(got.reader).toEqual([count])
    expect(got.approver).toEqual([held, count])
    expect(got.admin).toEqual([held, count])
    for (const off of offs) off()
  })

  it("sends a push that names a file only to the sockets whose caller could name that file: this host's window, and a key whose roots hold it", () => {
    const inside = join(dir, 'job')
    mkdirSync(inside)
    const fenced = startWork(
      { db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [inside], denied: () => [join(inside, 'private')] } },
      [fakeModule(seen)]
    )
    const got = { window: [] as WorkPush[], key: [] as WorkPush[] }
    const offs = [fenced.pushes.onPush((p) => got.window.push(p), LOCAL_PRINCIPAL), fenced.pushes.onPush((p) => got.key.push(p), remote(['read']))]
    const about = (path: string) => ({ push: 'work.pdf', path }) as unknown as WorkPush
    fenced.ctx.push(about(join(inside, 'w9.pdf')), { path: join(inside, 'w9.pdf') })
    fenced.ctx.push(about('/etc/passwd'), { path: '/etc/passwd' })
    fenced.ctx.push(about(join(inside, 'private', 'a.pdf')), { path: join(inside, 'private', 'a.pdf') })
    // both rules at once: the file is inside, but the key does not hold approve
    fenced.ctx.push(about(join(inside, 'b.pdf')), { path: join(inside, 'b.pdf'), need: 'approve' })
    expect(got.window.map((p) => (p as unknown as { path: string }).path)).toEqual([join(inside, 'w9.pdf'), '/etc/passwd', join(inside, 'private', 'a.pdf'), join(inside, 'b.pdf')])
    expect(got.key.map((p) => (p as unknown as { path: string }).path)).toEqual([join(inside, 'w9.pdf')])
    for (const off of offs) off()
    fenced.close()
  })

  it('lists the tool to a Work thread through the one mount, and to no code thread', () => {
    scopes.set('t-work', scopeFor('t-work'))
    scopes.set('t-code', scopeFor('t-code'))
    const mounted = work.tools.of(session('t-work', 'work'))!
    expect(mounted.tools.map((t) => t.name)).toEqual(['mail_fake_search', 'mail_fake_slow'])
    expect(mounted.scope.sector).toBe('purdue')
    // the row decides: a thread whose scope is not 'work' gets none, whatever else is true of it
    expect(work.tools.of(session('t-code', 'code'))).toBeNull()
    expect(work.tools.of(session('t-code'))).toBeNull()
    // a Work thread the scope resolver does not know gets none either
    expect(work.tools.of(session('t-unknown', 'work'))).toBeNull()
    expect(work.tools.listing(session('t-work', 'work')).slice(0, 1)).toEqual([
      {
        name: 'mail_fake_search',
        description: 'Search mail in purdue',
        readOnly: true,
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: { query: expect.objectContaining({ type: 'string', description: 'what to look for' }), limit: expect.objectContaining({ type: 'integer' }) },
          required: ['query']
        })
      }
    ])
  })

  it('refuses a tool with a bad name, a second of the same name and an input that is not an object, and says why', () => {
    scopes.set('t-work', scopeFor('t-work'))
    work.tools.of(session('t-work', 'work'))
    const said = vi.mocked(console.error).mock.calls.map((c) => String(c[0]))
    expect(said).toEqual([
      '[work] mail tool refused: Mail-Bad: a tool name is lower snake case',
      '[work] mail tool refused: mail_not_an_object: its input is not a z.object',
      '[work] mail tool refused: mail_fake_search: registered twice'
    ])
  })

  it("runs a tool with the thread's scope, and answers bad arguments as the tool's error", async () => {
    scopes.set('t-work', scopeFor('t-work'))
    const thread = session('t-work', 'work')
    const signal = new AbortController().signal
    expect(await work.tools.call(thread, 'mail_fake_search', { query: 'budget' }, signal)).toEqual({ content: [{ type: 'text', text: 'found for budget on env_test' }] })
    expect(seen.ran).toEqual([{ args: { query: 'budget' }, sessionId: 't-work', workspaceId: 'w1', aborted: false }])
    const bad = await work.tools.call(thread, 'mail_fake_search', { limit: 'ten' }, signal)
    expect(bad.isError).toBe(true)
    expect(seen.ran).toHaveLength(1)
    await expect(work.tools.call(thread, 'mail_other', {}, signal)).rejects.toThrow('unknown tool: mail_other')
    await expect(work.tools.call(session('t-code'), 'mail_fake_search', { query: 'x' }, signal)).rejects.toThrow('unknown tool: mail_fake_search')
  })

  it("the bridge lists and calls only with the thread's own token", async () => {
    scopes.set('t-work', scopeFor('t-work'))
    session('t-work', 'work')
    session('t-other', 'work')
    const token = work.tools.tokenFor('t-work')
    expect(token).not.toBe(work.tools.tokenFor('t-other'))
    const listed = await work.handle(req('app.workTools', { sessionId: 't-work', token }), LOCAL_PRINCIPAL)
    expect(listed.handled && (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['mail_fake_search', 'mail_fake_slow'])
    const called = await work.handle(req('app.workCall', { sessionId: 't-work', token, call: 9, tool: 'mail_fake_search', args: { query: 'q' } }), LOCAL_PRINCIPAL)
    expect(called).toEqual({ handled: true, result: { content: [{ type: 'text', text: 'found for q on env_test' }] } })
    // another thread's token, and a guess, are both refused before anything runs
    await expect(work.handle(req('app.workCall', { sessionId: 't-other', token, call: 9, tool: 'mail_fake_search', args: { query: 'q' } }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    await expect(work.handle(req('app.workTools', { sessionId: 't-work', token: '' }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    expect(seen.ran).toHaveLength(1)
  })

  it("a harness's cancel, and the bridge's socket closing, each reach the running tool's signal", async () => {
    scopes.set('t-work', scopeFor('t-work'))
    session('t-work', 'work')
    const token = work.tools.tokenFor('t-work')
    const first = work.handle(req('app.workCall', { sessionId: 't-work', token, call: 7, tool: 'mail_fake_slow', args: {} }), LOCAL_PRINCIPAL)
    await vi.waitFor(() => expect(seen.slow.started).toBe(1))
    // another thread's cancel, and a cancel of another call, touch nothing
    await expect(work.handle(req('app.workCancel', { sessionId: 't-work', token: 'guess', call: 7 }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    await work.handle(req('app.workCancel', { sessionId: 't-work', token, call: 8 }), LOCAL_PRINCIPAL)
    expect(seen.slow.aborted).toBe(0)
    expect(await work.handle(req('app.workCancel', { sessionId: 't-work', token, call: 7 }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: null })
    expect(await first).toEqual({ handled: true, result: { content: [{ type: 'text', text: 'cancelled' }], isError: true } })
    expect(seen.slow.aborted).toBe(1)

    const socket = new AbortController()
    const second = work.handle(req('app.workCall', { sessionId: 't-work', token, call: 9, tool: 'mail_fake_slow', args: {} }), LOCAL_PRINCIPAL, socket)
    await vi.waitFor(() => expect(seen.slow.started).toBe(2))
    socket.abort()
    await second
    expect(seen.slow.aborted).toBe(2)
  })

  it('turned off, aborts the tool calls in flight, whichever harness made them, before it stops the modules', async () => {
    scopes.set('t-work', scopeFor('t-work'))
    const thread = session('t-work', 'work')
    // Claude's call: its own signal from the SDK, held in no map of the bridge's
    const claude = work.tools.call(thread, 'mail_fake_slow', {}, new AbortController().signal)
    // Codex's or Muse's call, through the bridge
    const bridge = work.handle(req('app.workCall', { sessionId: 't-work', token: work.tools.tokenFor('t-work'), call: 3, tool: 'mail_fake_slow', args: {} }), LOCAL_PRINCIPAL)
    await vi.waitFor(() => expect(seen.slow.started).toBe(2))
    expect(seen.slow.aborted).toBe(0)
    await work.handle(req('work.set', { enabled: false }), LOCAL_PRINCIPAL)
    expect(seen.slow.aborted).toBe(2)
    // both were aborted by the time the module's own stop ran
    expect(seen.abortedAtStop).toBe(2)
    expect(await claude).toEqual({ content: [{ type: 'text', text: 'cancelled' }], isError: true })
    expect(await bridge).toEqual({ handled: true, result: { content: [{ type: 'text', text: 'cancelled' }], isError: true } })
    expect(seen.stopped).toBe(1)

    // on again: a new call runs under a fresh period, and the caller's own signal still stops it alone
    await work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)
    const harness = new AbortController()
    const again = work.tools.call(thread, 'mail_fake_slow', {}, harness.signal)
    await vi.waitFor(() => expect(seen.slow.started).toBe(3))
    expect(seen.slow.aborted).toBe(2)
    harness.abort()
    await again
    expect(seen.slow.aborted).toBe(3)
  })

  it('closing the host aborts the calls in flight too', async () => {
    scopes.set('t-work', scopeFor('t-work'))
    const call = work.tools.call(session('t-work', 'work'), 'mail_fake_slow', {}, new AbortController().signal)
    await vi.waitFor(() => expect(seen.slow.started).toBe(1))
    work.close()
    await call
    expect(seen.slow.aborted).toBe(1)
  })

  it('turned off again, stops the module and what the parts kept running, drops its push source and lists no tool', async () => {
    scopes.set('t-work', scopeFor('t-work'))
    await work.handle(req('work.set', { enabled: false }), LOCAL_PRINCIPAL)
    expect([seen.started, seen.stopped, seen.unsubscribed]).toEqual([1, 1, 1])
    expect([part.up, part.down]).toEqual([1, 1])
    expect(pushes.at(-1)).toEqual({ push: 'work', settings: { enabled: false } })
    expect(work.tools.of(session('t-work', 'work'))).toBeNull()
    await expect(work.handle(req('work.mail.ping', {}), LOCAL_PRINCIPAL)).rejects.toThrow('Work is off on this host')
  })
})

describe('at boot', () => {
  it('a host whose switch was left on starts its modules; one that was left off does not', () => {
    const store = new Store(db)
    store.setSetting('work', '{"enabled":true}')
    const again = fresh()
    const booted = startWork({ db, store, registry: { get: () => null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [fakeModule(again)])
    expect([again.ensured, again.started, again.subscribed]).toEqual([1, 1, 1])
    expect(part.up).toBe(1)
    booted.close()
    expect(again.stopped).toBe(1)
    expect(part.down).toBe(1)
    expect(seen.started).toBe(0)
  })
  it('a module that fails to start leaves the others running', () => {
    const store = new Store(db)
    store.setSetting('work', '{"enabled":true}')
    const ok = fresh()
    const broken: WorkModule = { id: 'tasks', ensure() {}, start: () => { throw new Error('boom') } }
    const booted = startWork({ db, store, registry: { get: () => null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [broken, fakeModule(ok)])
    expect(ok.started).toBe(1)
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes('[work] tasks did not start'))).toBe(true)
    booted.close()
  })
})

describe('a fault in one pillar', () => {
  const deps = () => ({ db, store: new Store(db), registry: { get: (id: string) => sessions.get(id) ?? null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} })
  it('a module whose tables cannot be made is left out, answers its fault by name, and the others run', async () => {
    const ok = fresh()
    let started = 0
    const broken: WorkModule = {
      id: 'tasks',
      ensure: () => void db.exec('CREATE TABLE'),
      handle: async () => handled('should never answer'),
      tools: () => [{ name: 'tasks_fake', description: 'x', input: z.object({}), readOnly: true, run: async () => ({ content: [] }) }],
      start: () => (started++, () => {})
    }
    const booted = startWork(deps(), [broken, fakeModule(ok)])
    booted.settings.set({ enabled: true })
    scopes.set('t-work', scopeFor('t-work'))
    expect(started).toBe(0)
    expect(ok.started).toBe(1)
    await expect(booted.handle(req('work.tasks.list', {}), LOCAL_PRINCIPAL)).rejects.toThrow(/^work: tasks could not make its tables: /)
    expect(await booted.handle(req('work.mail.ping', { n: 2 }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { pong: 2 } })
    expect(booted.tools.of(session('t-work', 'work'))!.tools.map((t) => t.name)).toEqual(['mail_fake_search', 'mail_fake_slow'])
    booted.close()
  })
})

describe('a deleted thread or workspace', () => {
  it('is told to every module, Work on or off, so no row outlives what it was kept for', () => {
    expect(work.settings.enabled()).toBe(false)
    for (const fn of deleted.sessions) fn(['t1', 't1-child'])
    for (const fn of deleted.workspaces) fn('w1')
    expect(seen.removed).toEqual({ sessions: [['t1', 't1-child']], workspaces: ['w1'] })
  })
  it("one module's fault in clearing leaves the others told", () => {
    const ok = fresh()
    const broken: WorkModule = { id: 'tasks', ensure() {}, sessionsRemoved: () => { throw new Error('boom') } }
    deleted.sessions.length = 0
    const booted = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [broken, fakeModule(ok)])
    for (const fn of deleted.sessions) fn(['t9'])
    expect(ok.removed.sessions).toEqual([['t9']])
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes('[work] tasks did not clear deleted threads'))).toBe(true)
    booted.close()
  })
})
