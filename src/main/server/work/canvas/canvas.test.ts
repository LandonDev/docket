import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, METHOD_CAPABILITY, type Principal } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import { fenceRequest, FenceError } from '../../remote/fence'
import type { SessionRegistry } from '../../sessions'
import type { WorkCtx } from '../modules'
import { lifeosMoved, noteMoved, retryMoved, tellLifeosMoved } from './move'
import { canvasItemDir, canvasStoreOf, CANVAS_OPEN_MAX } from './store'

// Milestone 6 builds the scope; here a Work thread's scope is the test's.
vi.mock('../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('../ctx')
const { canvas } = await import('./index')

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const thread = (id: string, scope: 'work' | 'code' = 'work', over: Partial<SessionMeta> = {}): SessionMeta => {
  const meta = { id, provider: 'claude', workspaceId: 'w1', ...(scope === 'work' ? { scope } : {}), ...over } as SessionMeta
  sessions.set(id, meta)
  return meta
}
const removed: ((ids: string[]) => void)[] = []
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: (fn: (ids: string[]) => void) => (removed.push(fn), () => {}),
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry
const boot = (): void => {
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [canvas])
  work.pushes.onPush((p) => pushes.push(p))
}
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const call = async (method: string, params: unknown, principal: Principal = LOCAL_PRINCIPAL): Promise<unknown> => {
  const out = await work.handle(ClientRequestSchema.parse(req(method, params)), principal)
  return out.handled ? out.result : undefined
}
const store = () => canvasStoreOf(db)
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const ids = (sessionId: string): string[] => store().list(sessionId).map((i) => i.id)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-canvas-'))
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  sessions.clear()
  removed.length = 0
  thread('t1')
  boot()
})
afterEach(() => {
  work.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the store', () => {
  it('opens an item last in the tab row, with the thread\'s workspace; the same kind and source twice is one item', () => {
    const a = store().open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    const b = store().open('t1', { kind: 'sheet', source: file('/b.xlsx'), title: 'B' })
    expect(a).toMatchObject({ sessionId: 't1', workspaceId: 'w1', kind: 'pdf', state: 'open', position: 0, rev: 0 })
    expect(b.position).toBe(1)
    // An item already open keeps its place: opening it again shows it (the push names it) and takes the new title.
    const again = store().open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A again' })
    expect(again.id).toBe(a.id)
    expect(again).toMatchObject({ position: 0, title: 'A again', rev: 1 })
    expect(ids('t1')).toEqual([a.id, b.id])
    expect(pushes.at(-1)).toMatchObject({ opened: a.id })
    // The same title changes nothing in the row.
    expect(store().open('t1', { itemId: a.id })).toMatchObject({ position: 0, rev: 1 })
  })

  it("`{ at: 'thread' }` twice is two items, each with its own folder; a close keeps the row and the folder", () => {
    const a = store().open('t1', { kind: 'document', source: { at: 'thread' }, title: 'Draft' })
    const b = store().open('t1', { kind: 'document', source: { at: 'thread' }, title: 'Draft' })
    expect(a.id).not.toBe(b.id)
    expect(existsSync(canvasItemDir(dir, 't1', a.id))).toBe(true)
    expect(existsSync(canvasItemDir(dir, 't1', b.id))).toBe(true)
    store().close(a.id)
    expect(store().get(a.id)).toMatchObject({ state: 'closed', rev: 1 })
    expect(existsSync(canvasItemDir(dir, 't1', a.id))).toBe(true)
    expect(ids('t1')).toEqual([b.id])
  })

  it('reopens by id last in the row, bumping rev; refuses an item of another thread', () => {
    const a = store().open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    const b = store().open('t1', { kind: 'pdf', source: file('/b.pdf'), title: 'B' })
    store().close(a.id)
    const back = store().open('t1', { itemId: a.id })
    expect(back).toMatchObject({ state: 'open', position: 2, rev: 2, title: 'A' })
    expect(ids('t1')).toEqual([b.id, a.id])
    thread('t2')
    expect(() => store().open('t2', { itemId: a.id })).toThrow(`no canvas item ${a.id} in thread t2`)
    expect(() => store().open('t1', { kind: 'pdf', title: 'no source' })).toThrow('an open names an item, or its kind, source and title')
  })

  it('reorders: the listed ids first, the rest after in their order, foreign ids ignored', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((n) => store().open('t1', { kind: 'pdf', source: file(`/${n}.pdf`), title: n }))
    thread('t2')
    const other = store().open('t2', { kind: 'pdf', source: file('/o.pdf'), title: 'o' })
    const items = store().reorder('t1', [c.id, other.id, 'nope', c.id])
    expect(items.map((i) => i.id)).toEqual([c.id, a.id, b.id])
    expect(items.map((i) => i.position)).toEqual([0, 1, 2])
    expect(store().get(other.id)?.position).toBe(0)
  })

  it(`holds at most ${CANVAS_OPEN_MAX} open items a thread`, () => {
    for (let i = 0; i < CANVAS_OPEN_MAX; i++) store().open('t1', { kind: 'pdf', source: file(`/${i}.pdf`), title: `${i}` })
    expect(() => store().open('t1', { kind: 'pdf', source: file('/more.pdf'), title: 'more' })).toThrow(`This thread already has ${CANVAS_OPEN_MAX} items open; close one first.`)
    // Opening one that is already open is no new tab.
    expect(() => store().open('t1', { kind: 'pdf', source: file('/0.pdf'), title: '0' })).not.toThrow()
  })

  it('refuses a code thread and a thread that does not exist', () => {
    thread('c1', 'code')
    expect(() => store().open('c1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })).toThrow('not a Work thread: c1')
    expect(() => store().open('ghost', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })).toThrow('unknown thread: ghost')
    expect(() => store().close('nope')).toThrow('no canvas item nope')
    expect(() => store().reorder('ghost', [])).toThrow('unknown thread: ghost')
  })

  it('skips a row whose kind or source no longer parses, and says so once', () => {
    const logged: string[] = []
    work.close()
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: (l) => logged.push(l) }, [canvas])
    const a = store().open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    db.prepare(`INSERT INTO work_canvas_items (id, session_id, kind, title, source, position, created_at, updated_at) VALUES ('bad1', 't1', 'pdf', 'x', '{"at":"nowhere"}', 5, 1, 1), ('bad2', 't1', 'scroll', 'y', '{"at":"thread"}', 6, 1, 1)`).run()
    expect(ids('t1')).toEqual([a.id])
    expect(ids('t1')).toEqual([a.id])
    expect(logged.filter((l) => l.includes('bad1'))).toHaveLength(1)
    expect(logged.filter((l) => l.includes('bad2'))).toHaveLength(1)
  })

  it("a deleted thread's rows and folders go", () => {
    const a = store().open('t1', { kind: 'document', source: { at: 'thread' }, title: 'Draft' })
    for (const fn of removed) fn(['t1'])
    expect(store().get(a.id)).toBeNull()
    expect(existsSync(join(dir, 'canvas', 't1'))).toBe(false)
  })

  it('refuses an id that would name a path', () => {
    expect(() => canvasItemDir(dir, '../x', 'i')).toThrow('canvas: bad id')
    expect(() => canvasItemDir(dir, 't1', 'a/b')).toThrow('canvas: bad id')
  })

  it('keeps the items across a restart', () => {
    store().open('t1', { kind: 'pdf', source: file('/a.pdf'), title: 'A' })
    store().open('t1', { kind: 'document', source: { at: 'thread' }, title: 'Draft' })
    const before = store().list('t1')
    work.close()
    db.close()
    db = openDb(join(dir, 'test.db'))
    boot()
    expect(store().list('t1')).toEqual(before)
  })
})

describe('through the mount', () => {
  it('with Work off, the methods answer that Work is off', async () => {
    await expect(call('work.canvas.list', { sessionId: 't1' })).rejects.toThrow('Work is off on this host')
  })

  describe('with Work on', () => {
    beforeEach(async () => {
      await call('work.set', { enabled: true })
      pushes.length = 0
    })

    it('routes the four methods, each change pushing the open list and an open naming its item', async () => {
      const a = (await call('work.canvas.open', { sessionId: 't1', kind: 'pdf', source: file('/a.pdf'), title: 'A' })) as { id: string }
      expect(pushes.at(-1)).toEqual({ push: 'work.canvas', sessionId: 't1', items: [expect.objectContaining({ id: a.id })], opened: a.id })
      const b = (await call('work.canvas.open', { sessionId: 't1', kind: 'sheet', source: file('/b.xlsx'), title: 'B' })) as { id: string }
      expect(await call('work.canvas.list', { sessionId: 't1' })).toEqual({ items: store().list('t1') })
      const reordered = (await call('work.canvas.reorder', { sessionId: 't1', order: [b.id] })) as { items: { id: string }[] }
      expect(reordered.items.map((i) => i.id)).toEqual([b.id, a.id])
      expect(pushes.at(-1)).toEqual({ push: 'work.canvas', sessionId: 't1', items: reordered.items })
      expect(await call('work.canvas.close', { itemId: a.id })).toBeNull()
      expect(pushes.at(-1)).toEqual({ push: 'work.canvas', sessionId: 't1', items: [expect.objectContaining({ id: b.id })] })
      expect(pushes).toHaveLength(4)
      await expect(call('work.canvas.close', { itemId: 'nope' })).rejects.toThrow('no canvas item nope')
      await expect(call('work.canvas.open', { sessionId: 't1', itemId: 'nope' })).rejects.toThrow('no canvas item nope in thread t1')
    })

    it('holds each method to its capability', () => {
      expect(['list', 'open', 'close', 'reorder'].map((v) => METHOD_CAPABILITY[`work.canvas.${v}` as keyof typeof METHOD_CAPABILITY])).toEqual(['read', 'operate', 'operate', 'operate'])
    })

    it('ctx.canvas pushes as the methods do', () => {
      const item = work.ctx.canvas.open('t1', 'pdf', file('/a.pdf'), 'A')
      expect(pushes.at(-1)).toMatchObject({ push: 'work.canvas', sessionId: 't1', opened: item.id })
      expect(work.ctx.canvas.forSession('t1').map((i) => i.id)).toEqual([item.id])
      work.ctx.canvas.close(item.id)
      expect(pushes.at(-1)).toEqual({ push: 'work.canvas', sessionId: 't1', items: [] })
    })

    it('lists both tools to a Work thread and runs them for that thread alone', async () => {
      const session = sessions.get('t1')!
      expect(work.tools.listing(session).map((t) => t.name)).toEqual(['canvas_open', 'canvas_close'])
      const signal = new AbortController().signal
      const opened = await work.tools.call(session, 'canvas_open', { kind: 'document', title: 'Draft', source: { at: 'thread' } }, signal)
      expect(opened.isError).toBeUndefined()
      const item = (opened.structuredContent as { item: { id: string } }).item
      expect(opened.content[0]).toEqual({ type: 'text', text: `Opened Draft (${item.id}).\nOpen items:\n${item.id}  document  Draft` })
      expect(pushes.at(-1)).toMatchObject({ opened: item.id })
      expect(await work.tools.call(session, 'canvas_open', { kind: 'document' }, signal)).toMatchObject({ isError: true })
      // Another thread's item is not this thread's to close.
      const other = thread('t2')
      expect(await work.tools.call(other, 'canvas_close', { item: item.id }, signal)).toMatchObject({ isError: true })
      const closed = await work.tools.call(session, 'canvas_close', { item: item.id }, signal)
      expect(closed).toMatchObject({ structuredContent: { items: [] } })
      expect(store().get(item.id)?.state).toBe('closed')
      expect(work.tools.listing({ id: 'c1', scope: 'code' })).toEqual([])
    })

    it("opens a subagent's item beside its root thread, the pane the person reads", async () => {
      const child = thread('t1-child', 'work', { parentId: 't1' })
      const grandchild = thread('t1-grandchild', 'work', { parentId: 't1-child' })
      const signal = new AbortController().signal
      const opened = await work.tools.call(grandchild, 'canvas_open', { kind: 'pdf', title: 'Contract', source: file('/c.pdf') }, signal)
      const item = (opened.structuredContent as { item: { id: string; sessionId: string } }).item
      expect(item.sessionId).toBe('t1')
      expect(ids('t1')).toEqual([item.id])
      expect(ids('t1-grandchild')).toEqual([])
      // Any thread of the tree may close it; a thread of another tree may not.
      expect(await work.tools.call(thread('t2'), 'canvas_close', { item: item.id }, signal)).toMatchObject({ isError: true })
      expect(await work.tools.call(child, 'canvas_close', { item: item.id }, signal)).toMatchObject({ structuredContent: { items: [] } })
    })
  })
})

describe('the path fence on work.canvas.open', () => {
  const root = '/srv/app-data/workspaces'
  const open = (path: string): ClientRequest => ClientRequestSchema.parse(req('work.canvas.open', { sessionId: 't1', kind: 'pdf', title: 'A', source: { at: 'file', host: 'env_mac', path } }))
  it('refuses a file outside the app-managed roots, whatever host the source names, and passes one under them', () => {
    expect(() => fenceRequest(open('/etc/passwd'), [root])).toThrow(FenceError)
    expect(() => fenceRequest(open(join(root, 'w1', 'report.pdf')), [root])).not.toThrow()
  })
})

describe('telling LifeOS a thread moved', () => {
  const waiting = (): string[] => (db.prepare(`SELECT session_id FROM work_canvas_moved ORDER BY session_id`).all() as { session_id: string }[]).map((r) => r.session_id)
  const fake = (connected: boolean | (() => boolean), mutation?: (fn: string, args: { threadId: string }) => Promise<void>) => {
    const calls: [string, unknown][] = []
    const logged: string[] = []
    const state = { connected }
    const ctx = {
      db,
      host: 'env_box',
      log: (l: string) => void logged.push(l),
      lifeos: {
        connected: () => (typeof state.connected === 'function' ? state.connected() : state.connected),
        owner: () => ({
          mutation: async (fn: string, args: { threadId: string }) => {
            calls.push([fn, args])
            await mutation?.(fn, args)
          }
        })
      }
    } as unknown as Pick<WorkCtx, 'db' | 'lifeos' | 'host' | 'log'>
    return { ctx, calls, logged, state }
  }

  it('calls LifeOS once per Work thread with the new host, and forgets the move once it has answered', async () => {
    const { ctx, calls } = fake(true)
    await noteMoved(ctx, ['t1', 't2'])
    expect(calls).toEqual([
      ['workLinks:moved', { threadId: 't1', host: 'env_box' }],
      ['workLinks:moved', { threadId: 't2', host: 'env_box' }]
    ])
    expect(waiting()).toEqual([])
    expect(lifeosMoved('t1', 'env_box')).toEqual({ fn: 'workLinks:moved', args: { threadId: 't1', host: 'env_box' } })
  })

  it('keeps a move LifeOS could not hear of, never throws, and tells it once LifeOS is back', async () => {
    const down = fake(false)
    await noteMoved(down.ctx, ['t1'])
    expect(down.calls).toEqual([])
    expect(down.logged).toHaveLength(1)
    expect(waiting()).toEqual(['t1'])
    // Not built yet reads the same way: kept, one line, no throw.
    const unbuilt = fake(() => {
      throw new Error('not built: ctx.lifeos.connected (milestone 7)')
    })
    await expect(noteMoved(unbuilt.ctx, ['t2'])).resolves.toBeUndefined()
    expect(waiting()).toEqual(['t1', 't2'])
    // LifeOS answers again: both are told, and nothing waits.
    down.state.connected = true
    await tellLifeosMoved(down.ctx)
    expect(down.calls.map(([, args]) => (args as { threadId: string }).threadId)).toEqual(['t1', 't2'])
    expect(waiting()).toEqual([])
  })

  it('one thread LifeOS refuses leaves the others told', async () => {
    const { ctx, calls } = fake(true, async (_fn, args) => {
      if (args.threadId === 't1') throw new Error('no such thread')
    })
    await noteMoved(ctx, ['t1', 't2'])
    expect(calls).toHaveLength(2)
    expect(waiting()).toEqual(['t1'])
  })

  it('tries again while Work is on, and stops with it; a deleted thread stops waiting', async () => {
    vi.useFakeTimers()
    try {
      const down = fake(false)
      await noteMoved(down.ctx, ['t1'])
      const stop = retryMoved(down.ctx, 1000)
      down.state.connected = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(down.calls).toHaveLength(1)
      expect(waiting()).toEqual([])
      stop()
      await noteMoved(fake(false).ctx, ['t2'])
      await vi.advanceTimersByTimeAsync(5000)
      expect(down.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    expect(waiting()).toEqual(['t2'])
    removed.forEach((fn) => fn(['t2']))
    expect(waiting()).toEqual([])
  })
})
