import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { Batches, setBatches } from './batch'
import { cancelMirrors } from './mirror'
import { setOrchestrationRegistry } from './orchestration'
import { watchMasterNews } from './masterNews'
import { Notifier, type Notice } from './remote/notifier'
import { turnByFromLog } from './quietWakes'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * Quiet wakes (docs/agents/read-and-unread.md): a read master stays read, with
 * no badge and no notice, through turns the app woke; it reads unread when a
 * turn of his own ends, when it needs him, when its batch reaches an outcome
 * and when a child of its batch completes work. A real registry over a fake
 * claude driver whose send starts a turn and whose `emit` is the harness.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        return {
          confirmsSteers: true,
          whisper: async () => true,
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => true,
          dispose: async () => {}
        }
      }
    }
  }
}))

const OWNER = { by: { kind: 'owner' as const } }
let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let notifier: Notifier
let notices: Notice[]
let offNews: () => void
let batches: Batches
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-quiet-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  batches = new Batches({ registry, store, runGate: async () => ({ ok: true, log: 'stub', ms: 1, exitCode: 0 }), branchOf: async () => 'master' })
  batches.attach()
  setBatches(batches)
  offNews = watchMasterNews(registry)
  notices = []
  notifier = new Notifier({ registry, stuckMinutes: () => 60, debounceMs: 1, log: () => {} })
  notifier.onNotice((n) => void notices.push(n))
  notifier.start()
  emits.clear()
  sends.clear()
})
afterEach(async () => {
  cancelMirrors()
  notifier.stop()
  offNews()
  setBatches(null)
  batches.dispose()
  await registry.close()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
const finish = async (id: string): Promise<void> => {
  emit(id, { type: 'turn-complete' } as AgentEvent)
  emit(id, { type: 'status', status: 'idle' })
  await settle()
}
const unread = (id: string): boolean => {
  const s = registry.get(id)!
  return s.updatedAt > (s.readAt ?? 0)
}
const read = async (id: string): Promise<void> => {
  registry.markRead([{ sessionId: id }])
  notices.length = 0
  await settle()
}
/** The facts the Dock badge reads (lib/dockBadge.ts, its test "follows a master's host mark"):
 *  the host's read mark on each live root, and whether it needs him. */
const badge = (): number =>
  registry.list({ archived: false }).filter((m) => !m.parentId && !m.masterId && (m.status === 'waiting' || (m.status !== 'running' && m.updatedAt > (m.readAt ?? 0)))).length
const finished = (id: string): Notice[] => notices.filter((n) => n.threadId === id && n.kind === 'finished')

/** A pinned master that ran a turn of his and that he has read since. */
async function readMaster(): Promise<string> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  const master = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, threadType: 'chat', title: 'Master' })
  registry.setMaster(master.id, true)
  await registry.send(master.id, 'open the batch', OWNER)
  await settle()
  await finish(master.id)
  await read(master.id)
  expect(unread(master.id)).toBe(false)
  return master.id
}

describe('a master is news only for what matters to him', () => {
  it('1. a turn from his own message ends: unread, a badge and a Done notice', async () => {
    const master = await readMaster()
    await registry.send(master, 'how is it going?', OWNER)
    await settle()
    expect(registry.turnStartedBy(master)).toBe('person')
    await finish(master)
    expect(unread(master)).toBe(true)
    expect(badge()).toBe(1)
    expect(finished(master)).toHaveLength(1)
  })

  it('1. his steer into a turn the app woke makes its end his news, even read mid-turn', async () => {
    const master = await readMaster()
    registry.deliverAgentReport(master, { agentId: 'x', title: 'Helper', status: 'idle', text: '<subagent-report>done</subagent-report>' })
    await settle()
    expect(registry.turnStartedBy(master)).toBe('app')
    await registry.send(master, 'and the tests?', { ...OWNER, steer: true })
    await settle()
    expect(registry.turnStartedBy(master)).toBe('person')
    await read(master)
    await finish(master)
    expect(unread(master)).toBe(true)
    expect(finished(master)).toHaveLength(1)
  })

  it('2. a turn the app woke that ends asking him something: unread, a badge and a notice', async () => {
    const master = await readMaster()
    registry.deliverAgentReport(master, { agentId: 'x', title: 'Helper', status: 'idle', text: '<subagent-report>done</subagent-report>' })
    await settle()
    emit(master, {
      type: 'question-request',
      requestId: 'q1',
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]
    } as AgentEvent)
    emit(master, { type: 'status', status: 'waiting' })
    await settle()
    expect(unread(master)).toBe(true)
    expect(badge()).toBe(1)
    expect(notices.some((n) => n.threadId === master && n.event === 'needs_you')).toBe(true)
  })

  it('2. a turn the app woke that fails: unread and a failed notice', async () => {
    const master = await readMaster()
    registry.deliverAgentReport(master, { agentId: 'x', title: 'Helper', status: 'idle', text: '<subagent-report>done</subagent-report>' })
    await settle()
    emit(master, { type: 'status', status: 'error' })
    await settle()
    expect(unread(master)).toBe(true)
    expect(notices.some((n) => n.threadId === master && n.event === 'failed')).toBe(true)
  })

  it('4. a child completing work marks it once until he reads; the reports it wakes on add no Done (3. the outcome: batch.test.ts)', async () => {
    const master = await readMaster()
    const a = await registry.create({ cwd: root, provider: 'claude', masterId: master, title: 'A' })
    const b = await registry.create({ cwd: root, provider: 'claude', masterId: master, title: 'B' })
    await registry.send(a.id, 'work A', { by: { kind: 'thread', sessionId: master } })
    await registry.send(b.id, 'work B', { by: { kind: 'thread', sessionId: master } })
    await settle()
    await finish(a.id)
    expect(unread(master)).toBe(true)
    expect(registry.get(master)!.readAt).toBe(0)
    await finish(b.id)
    // Once: the second child finds the master unread already.
    expect(registry.get(master)!.readAt).toBe(0)
    // The master's own turns on the reports end with nothing more to tell.
    for (let i = 0; i < 5 && registry.get(master)?.status === 'running'; i++) await finish(master)
    expect(registry.get(master)?.status).toBe('idle')
    expect(unread(master)).toBe(true)
    expect(badge()).toBe(1)
    expect(finished(master)).toEqual([])
    await read(master)
    expect(badge()).toBe(0)
  })

  it("4. a child's turn the app woke is the child talking to itself: the master stays read", async () => {
    const master = await readMaster()
    const a = await registry.create({ cwd: root, provider: 'claude', masterId: master, title: 'A' })
    await registry.send(a.id, 'work A', { by: { kind: 'thread', sessionId: master } })
    await settle()
    await finish(a.id)
    await read(master)
    registry.deliverAgentReport(a.id, { agentId: 's', title: 'Sub', status: 'idle', text: '<subagent-report>done</subagent-report>' })
    await settle()
    expect(registry.turnStartedBy(a.id)).toBe('app')
    await finish(a.id)
    expect(unread(master)).toBe(false)
  })
})

describe('a turn the app woke marks nothing', () => {
  const quiet = async (master: string, wake: () => void | Promise<void>): Promise<void> => {
    await wake()
    await settle()
    expect(registry.turnStartedBy(master)).toBe('app')
    expect(unread(master)).toBe(false)
    await finish(master)
    expect(unread(master)).toBe(false)
    expect(badge()).toBe(0)
    expect(finished(master)).toEqual([])
  }

  it('a subagent report', async () => {
    const master = await readMaster()
    await quiet(master, () => registry.deliverAgentReport(master, { agentId: 'x', title: 'Helper', status: 'idle', text: '<subagent-report>done</subagent-report>' }))
  })

  it("a batch report that is no outcome (a stall, a host out of reach)", async () => {
    const master = await readMaster()
    await quiet(master, () => registry.deliverAgentReport(master, { agentId: master, title: 'Batch', status: 'blocked', text: '<batch-report>No batch thread has moved for 31 min</batch-report>' }))
  })

  it('a background task, a monitor or a scheduled wake-up: the harness starts the turn itself', async () => {
    const master = await readMaster()
    await quiet(master, () => emit(master, { type: 'status', status: 'running' }))
  })

  it('the notes reminder', async () => {
    const master = await readMaster()
    await quiet(master, () => (registry as unknown as { runNotesReminder(id: string): Promise<void> }).runNotesReminder(master))
  })

  it("a host restart's nudge to a watching master", async () => {
    const master = await readMaster()
    const a = await registry.create({ cwd: root, provider: 'claude', masterId: master, title: 'A' })
    await registry.send(a.id, 'work A', { by: { kind: 'thread', sessionId: master } })
    await settle()
    // The person's next message leaves it watching its open batch.
    await registry.send(master, 'carry on', OWNER)
    await settle()
    emit(master, { type: 'status', status: 'idle' })
    await settle()
    expect(registry.get(master)?.status).toBe('watching')
    await read(master)
    await quiet(master, async () => {
      await registry.resumeStopped(master, { restartedAt: Date.now() })
    })
  })
})

describe('after a restart, a turn reads its origin from the log', () => {
  const t = (by?: 'owner' | 'app'): AgentEvent => ({ type: 'user-text', text: 'x', ...(by ? { by: { kind: by } } : {}) }) as AgentEvent
  const st = (status: string): AgentEvent => ({ type: 'status', status }) as AgentEvent
  it('the user row that started it says who; a turn end met first says the app', () => {
    expect(turnByFromLog([t('owner'), st('starting'), st('running'), st('stopped')])).toBe('person')
    expect(turnByFromLog([t('owner'), st('running'), st('idle'), st('running'), st('stopped')])).toBe('app')
    expect(turnByFromLog([t('owner'), st('running'), st('idle')])).toBe('person')
    expect(turnByFromLog([t('owner'), st('running'), st('idle'), st('running'), st('idle')])).toBe('app')
    expect(turnByFromLog([st('running'), st('stopped')])).toBeNull()
  })
})
