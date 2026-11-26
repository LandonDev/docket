import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrossHostCallParams, CrossHostPeerMethod } from '@shared/contract-crosshost'
import type { AgentEvent } from '@shared/events'
import { CrossHostAgents } from './crossHostAgents'
import { openDb, Store } from './db'
import type { DriverCtx, DriverHandle } from './drivers/types'
import { markMasterNews, watchMasterNews } from './masterNews'
import { cancelMirrors } from './mirror'
import { CrossHostThreads } from './remote/crossHostThreads'
import type { HostTransport } from './remote/hostLinks'
import { SessionRegistry } from './sessions'

/**
 * A master's news from a batch child on another host (docs/agents/
 * read-and-unread.md "A master's batch"): two hosts, each a real registry on
 * its own database, joined by a link that carries thread.start one way and
 * the child's crossHost.settled back. The master on the box starts a thread
 * on the Mac; when that thread completes a turn there, the box marks the
 * master unread from the settle report it already gets, and a turn that
 * failed, was stopped or left a subagent working marks nothing.
 */

const emits = new Map<string, (e: AgentEvent) => void>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        emits.set(ctx.session.id, ctx.emit)
        return {
          confirmsSteers: true,
          send: async () => ctx.emit({ type: 'status', status: 'running' }),
          interrupt: () => {},
          alive: () => true,
          dispose: async () => {}
        }
      }
    }
  }
}))

const BOX = `env_${'b'.repeat(22)}`
const MAC = `env_${'m'.repeat(22)}`

interface Host {
  id: string
  dir: string
  db: ReturnType<typeof openDb>
  registry: SessionRegistry
  threads: CrossHostThreads
  agents: CrossHostAgents
  off: () => void
}
const hosts = new Map<string, Host>()
let root: string

/** What JSON carries: the far host reads the wire, never the object. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const linkFrom = (from: string): HostTransport => ({
  reachable: () => [...hosts.keys()].filter((id) => id !== from).map((id) => ({ id, via: 'registered' as const })),
  via: (id) => (hosts.has(id) && id !== from ? 'registered' : null),
  refusal: (id) => (hosts.has(id) && id !== from ? null : `host offline: ${id}`),
  async call<T>(id: string, method: string, params: unknown): Promise<T> {
    const far = hosts.get(id)!
    // the running host's reports, as index.ts serves them
    if (method === 'crossHost.settled') return far.agents.settled(from, wire(params) as never) as T
    return (await far.threads.handle(method as CrossHostPeerMethod, wire(params) as CrossHostCallParams, { from, deadlineAt: Date.now() + 60_000 })) as T
  }
})

function makeHost(id: string): Host {
  const dir = join(root, id === BOX ? 'box' : 'mac')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'app.db'))
  const store = new Store(db)
  store.setSetting('workspace.root', dir)
  const registry = new SessionRegistry(store)
  const threads = new CrossHostThreads({
    environmentId: id,
    store,
    registry,
    environments: () => [...hosts.keys()].filter((e) => e !== id).map((e) => ({ id: e, name: e })),
    link: () => null,
    links: linkFrom(id),
    pathMap: () => ({ roots: {}, prefixes: {} }),
    workRoot: () => dir,
    log: () => {}
  })
  const agents = new CrossHostAgents({
    environmentId: id,
    store,
    sessions: { get: (sid) => registry.get(sid), append: () => {}, deliverAgentReport: () => {} },
    links: linkFrom(id),
    macPeerOf: () => null,
    workRoot: () => dir,
    masterNews: (masterId) => markMasterNews(registry, masterId),
    log: () => {}
  })
  const host: Host = { id, dir, db, registry, threads, agents, off: watchMasterNews(registry) }
  hosts.set(id, host)
  return host
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-master-news-'))
  emits.clear()
})
afterEach(async () => {
  vi.useRealTimers()
  cancelMirrors()
  for (const host of hosts.values()) {
    host.off()
    host.threads.close()
    await host.registry.close()
    host.db.close()
  }
  hosts.clear()
  rmSync(root, { recursive: true, force: true })
})

const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
/** Past the far host's settle debounce, so its report has gone out and been answered. */
const reported = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1_000)
}

async function pair(): Promise<{ box: Host; mac: Host; master: string; child: string }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const box = makeHost(BOX)
  const mac = makeHost(MAC)
  const master = await box.registry.create({ cwd: box.dir, provider: 'claude', threadType: 'chat', title: 'Master' })
  box.registry.setMaster(master.id, true)
  const started = await box.agents.startThread(box.registry.get(master.id)!, MAC, { threadType: 'chat', provider: 'claude', firstMessage: 'build it', cwd: box.dir })
  const child = started.threadId.slice(MAC.length + 1)
  // the master has been read: only the child's news may change that
  box.registry.markRead([{ sessionId: master.id, at: Date.now() + 1 }])
  expect(box.registry.get(master.id)?.readAt).toBeGreaterThan(0)
  expect(mac.registry.get(child)?.masterId).toBe(master.id)
  return { box, mac, master: master.id, child }
}

describe("a batch child on another host is its master's news", () => {
  it('a completed turn on the Mac marks the master on the box unread, from the settle report', async () => {
    const { box, mac, master, child } = await pair()
    emit(child, { type: 'turn-complete' } as AgentEvent)
    emit(child, { type: 'status', status: 'idle' })
    await reported()
    expect(box.registry.get(master)?.readAt).toBe(0)
    // the Mac knows no such master: its own watcher marks nothing there
    expect(mac.registry.get(master)).toBeFalsy()
  })

  it('a failed turn, a stopped turn and a turn that left a subagent working mark nothing', async () => {
    const { box, mac, master, child } = await pair()
    const stillRead = (): void => expect(box.registry.get(master)?.readAt).toBeGreaterThan(0)

    emit(child, { type: 'error', message: 'the model refused' } as AgentEvent)
    emit(child, { type: 'status', status: 'idle' })
    await reported()
    stillRead()

    emit(child, { type: 'status', status: 'running' })
    emit(child, { type: 'error', message: 'stopped', stopped: true } as AgentEvent)
    emit(child, { type: 'status', status: 'idle' })
    await reported()
    stillRead()

    // a subagent of the child, still working on the Mac
    const helper = await mac.registry.create({ cwd: mac.dir, provider: 'claude', parentId: child, title: 'Helper' })
    await mac.registry.send(helper.id, 'help')
    emit(child, { type: 'status', status: 'running' })
    emit(child, { type: 'turn-complete' } as AgentEvent)
    emit(child, { type: 'status', status: 'idle' })
    await reported()
    stillRead()
  })

  it('a report from a host before completedTurn marks nothing; a master unpinned since marks nothing', async () => {
    const { box, master, child } = await pair()
    box.agents.settled(MAC, { from: MAC, sessionId: child, parentSessionId: master, title: 't', status: 'idle', reply: '', pending: null })
    expect(box.registry.get(master)?.readAt).toBeGreaterThan(0)
    box.registry.setMaster(master, false)
    box.agents.settled(MAC, { from: MAC, sessionId: child, parentSessionId: master, title: 't', status: 'idle', reply: '', pending: null, completedTurn: true })
    expect(box.registry.get(master)?.readAt).toBeGreaterThan(0)
  })
})
