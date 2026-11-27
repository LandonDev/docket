import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import type { CrossHostCaller } from '@shared/contract-crosshost'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { cancelMirrors } from '../mirror'
import { CrossHostThreads } from './crossHostThreads'

// Full access across hosts: the Mac and the box, each with its own database,
// registry and CrossHostThreads. A thread on one host starts a thread, a
// subagent or a batch child on the other (the caller's shape is
// crossHostAgents.ts `callerOf`, its permission read at the call); the child
// is a session of the host it runs on, and that host's registry answers its
// asks by the child's own access.

const MAC = `env_${'m'.repeat(22)}`
const BOX = `env_${'b'.repeat(22)}`

const emits = new Map<string, (e: AgentEvent) => void>()
const approvals: { sessionId: string; requestId: string; allow: boolean }[] = []

vi.mock('../drivers', () => {
  const driver = (id: string) => ({
    id,
    start: async (ctx: { session: SessionMeta; emit: (e: AgentEvent) => void }) => {
      const sid = ctx.session.id
      emits.set(sid, ctx.emit)
      return {
        send: async () => {},
        answer: () => true,
        approve: (requestId: string, allow: boolean) => {
          approvals.push({ sessionId: sid, requestId, allow })
          return true
        },
        interrupt: () => {},
        dispose: async () => {}
      }
    }
  })
  return { BUILT_IN_DRIVERS: { claude: driver('claude'), codex: driver('codex') } }
})

interface Host {
  env: string
  root: string
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  threads: CrossHostThreads
}

let base: string
let mac: Host
let box: Host

async function host(env: string, other: string): Promise<Host> {
  const root = join(base, env === MAC ? 'mac' : 'box')
  await mkdir(join(root, 'app'), { recursive: true })
  const db = openDb(join(root, 'test.db'))
  const store = new Store(db)
  store.insertWorkspace({ id: `ws-${env}`, name: 'app', path: join(root, 'app'), git: false, createdAt: 1 })
  store.insertProject({ id: `p-${env}`, workspaceId: `ws-${env}`, name: 'app', mode: 'local', branch: null, cwd: join(root, 'app'), archived: false, createdAt: 1 })
  const registry = new SessionRegistry(store)
  // Away off on both hosts, for both kinds: only access decides.
  registry.away = { on: () => false, count: () => {} }
  const threads = new CrossHostThreads({
    environmentId: env,
    store,
    registry,
    environments: () => [{ id: other, name: other === MAC ? 'Mac' : 'box' }],
    link: () => async () => ({ ok: true }),
    pathMap: () => ({ roots: {}, prefixes: {} }),
    workRoot: () => root,
    attachmentDirs: () => [],
    pushBranch: async () => {},
    log: () => {}
  })
  return { env, root, db, store, registry, threads }
}

beforeEach(async () => {
  emits.clear()
  approvals.length = 0
  base = await mkdtemp(join(tmpdir(), 'tc-full-xhost-'))
  mac = await host(MAC, BOX)
  box = await host(BOX, MAC)
})
afterEach(async () => {
  for (const h of [mac, box]) {
    h.threads.close()
    await h.registry.close()
    h.db.close()
  }
  cancelMirrors()
  await rm(base, { recursive: true, force: true })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

/** A thread of this host with this access, as the person made it. */
async function own(h: Host, permission: SessionMeta['permission']): Promise<SessionMeta> {
  return h.registry.create({ projectId: `p-${h.env}`, threadType: 'orchestration', provider: 'claude', permission })
}
/** The caller a thread names when it reaches the other host (crossHostAgents.ts `callerOf`), its access read now. */
const callerOf = (h: Host, id: string): CrossHostCaller => {
  const s = h.registry.get(id)!
  return { environmentId: h.env, sessionId: s.id, title: s.title, permission: s.permission }
}
const ctx = (from: string) => ({ from, callId: 'c1', deadlineAt: Date.now() + 60_000 })
const where = (from: Host) => ({ cwd: join(from.root, 'app'), workRoot: from.root })

type Started = { sessionId: string }
const start = (from: Host, to: Host, caller: CrossHostCaller, extra: Record<string, unknown> = {}): Promise<Started> =>
  to.threads.handle('thread.start', { caller, args: { threadType: 'implementation', provider: 'claude', firstMessage: 'build it', ...where(from), ...extra } }, ctx(from.env)) as Promise<Started>
const spawn = (from: Host, to: Host, caller: CrossHostCaller): Promise<Started> =>
  to.threads.handle(
    'thread.spawn',
    { caller, args: { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'medium', context1m: false, agentType: 'implementer', task: 'build it', title: 'build it', useWorktree: false, ...where(from) } },
    ctx(from.env)
  ) as Promise<Started>

/** The child's harness asks for a shell command, as Claude Code's own checks do under bypass. */
async function ask(child: string, requestId: string): Promise<void> {
  await flush()
  const emit = emits.get(child)!
  emit({ type: 'status', status: 'running' })
  emit({ type: 'approval-request', requestId, toolName: 'Bash', input: { command: 'cd .claude && git status' } })
  emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
  await flush()
}
const check = (from: Host, to: Host, caller: CrossHostCaller, sessionId: string) =>
  to.threads.handle('thread.check', { caller, args: { sessionId } }, ctx(from.env)) as Promise<{ status: string; pending: unknown }>

describe('Full access across hosts, with Away off', () => {
  for (const [label, from, to] of [
    ['a box thread on the Mac', () => box, () => mac],
    ['a Mac thread on the box', () => mac, () => box]
  ] as const) {
    it(`${label}: a started thread, a subagent and a batch child of a Full-access thread ask nothing`, async () => {
      const parent = await own(from(), 'auto')
      const caller = callerOf(from(), parent.id)
      const started = await start(from(), to(), caller)
      const sub = await spawn(from(), to(), caller)
      const batched = await start(from(), to(), caller, { masterId: parent.id })
      for (const [i, child] of [started, sub, batched].entries()) {
        expect(to().registry.get(child.sessionId)!.permission).toBe('auto')
        await ask(child.sessionId, `r${i}`)
        expect(approvals).toContainEqual({ sessionId: child.sessionId, requestId: `r${i}`, allow: true })
        expect(to().store.eventsAfter(child.sessionId, 0).some((r) => r.event.type === 'approval-request')).toBe(false)
        expect(await check(from(), to(), caller, child.sessionId)).toMatchObject({ status: 'running', pending: null })
      }
      // nothing was written on the caller's own host either
      expect(from().store.eventsAfter(parent.id, 0).some((r) => r.event.type === 'approval-request')).toBe(false)
    })

    it(`${label}: a child of a thread with lower access keeps that access, and its card reaches the parent to answer`, async () => {
      const parent = await own(from(), 'edits')
      const caller = callerOf(from(), parent.id)
      const sub = await spawn(from(), to(), caller)
      expect(to().registry.get(sub.sessionId)!.permission).toBe('edits')
      await ask(sub.sessionId, 'r1')
      expect(approvals).toEqual([])
      expect(await check(from(), to(), caller, sub.sessionId)).toMatchObject({ status: 'waiting', pending: { kind: 'approval', requestId: 'r1' } })
      await to().threads.handle('thread.answer', { caller, args: { sessionId: sub.sessionId, requestId: 'r1', allow: true } }, ctx(from().env))
      expect(approvals).toEqual([{ sessionId: sub.sessionId, requestId: 'r1', allow: true }])
    })
  }

  it("a parent raised to Full access starts its next child under it; one lowered again starts the next asking", async () => {
    const parent = await own(box, 'edits')
    await box.registry.setPermission(parent.id, 'auto')
    const raised = await spawn(box, mac, callerOf(box, parent.id))
    await ask(raised.sessionId, 'r1')
    expect(approvals).toEqual([{ sessionId: raised.sessionId, requestId: 'r1', allow: true }])
    await box.registry.setPermission(parent.id, 'edits')
    const lowered = await spawn(box, mac, callerOf(box, parent.id))
    await ask(lowered.sessionId, 'r2')
    expect(approvals).toHaveLength(1)
    expect(mac.store.eventsAfter(lowered.sessionId, 0).some((r) => r.event.type === 'approval-request')).toBe(true)
  })
})
