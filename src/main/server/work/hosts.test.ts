import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Capability } from '@shared/capabilities'
import { ThreadStartArgsSchema, workAskArgs, type CrossHostCallParams, type CrossHostPeerMethod } from '@shared/contract-crosshost'
import type { MacBridgePolicy } from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import { handled, NOT_HANDLED, WORK_SETTING_KEY, type WorkScope } from '@shared/work'
import { appStartThread, setAppCrossHost } from '../apptools'
import { CrossHostAgents } from '../crossHostAgents'
import { openDb, Store } from '../db'
import type { DriverCtx, DriverHandle } from '../drivers/types'
import { cancelMirrors } from '../mirror'
import { orchSpawnAgent, setCrossHostAgents, setOrchestrationRegistry } from '../orchestration'
import { CrossHostThreads } from '../remote/crossHostThreads'
import type { HostTransport } from '../remote/hostLinks'
import { SessionRegistry } from '../sessions'
import { startWork, type Work } from './ctx'
import { loadWorkModules, WORK_MODULES, type ToolCtx, type WorkModule } from './modules'
import { moveRefusal, peerCaps, servePeerWork } from './peer'
import { WORK_PREAMBLE_HEADING } from './preamble'
import { WORK_OFF } from './scope'

/**
 * Work across two hosts, each a real registry on its own database, joined by
 * a link that carries the thread.* calls as the app's does. A Work thread on
 * the box starts a thread on the Mac and it is a Work thread there, or the
 * start is refused: by a Mac with Work off, with no workspace for the job,
 * and by a Mac from before Work. A Work tool reaches the same module on the
 * Mac through `ctx.peer`, under the workspace's setting and the Mac's bridge
 * policy. A move is refused unless the other host says it keeps the thread.
 */

const sent = new Map<string, string[]>()
vi.mock('../drivers', () => {
  const fake = (id: string) => ({
    id,
    start: async (ctx: DriverCtx): Promise<DriverHandle> => ({
      confirmsSteers: true,
      send: async (text: string) => {
        sent.set(ctx.session.id, [...(sent.get(ctx.session.id) ?? []), text])
        ctx.emit({ type: 'status', status: 'running' })
      },
      interrupt: () => {},
      alive: () => true,
      dispose: async () => {}
    })
  })
  return { BUILT_IN_DRIVERS: { claude: fake('claude'), codex: fake('codex') } }
})

const BOX = `env_${'b'.repeat(22)}`
const MAC = `env_${'m'.repeat(22)}`

interface Host {
  id: string
  dir: string
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  threads: CrossHostThreads
  work: Work
  /** This host's bridge policy for a caller. */
  policy: MacBridgePolicy
  /** How this host answers thread.start: its own handler, or a build from before Work. */
  old: boolean
}
const hosts = new Map<string, Host>()
let root: string

/** The schema a build from before Work reads thread.start with: a message is required, and `work` is a key it does not know. */
const OldThreadStartArgs = z.object({ threadType: z.string(), provider: z.string(), firstMessage: z.string().min(1).max(200_000), cwd: z.string(), title: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional() })

const linkFrom = (from: string): HostTransport => ({
  reachable: () => [...hosts.keys()].filter((id) => id !== from).map((id) => ({ id, via: 'registered' as const })),
  via: (id) => (hosts.has(id) && id !== from ? 'registered' : null),
  refusal: (id) => (hosts.has(id) && id !== from ? null : `host offline: ${id} has no live link to this host`),
  async call<T>(id: string, method: string, params: unknown): Promise<T> {
    const far = hosts.get(id)!
    // over the wire: what arrives is what JSON carried
    const wire = JSON.parse(JSON.stringify(params)) as CrossHostCallParams
    if (far.old && method === 'thread.start') {
      const args = OldThreadStartArgs.parse(wire.args)
      const thread = await far.registry.startWith({ threadType: 'chat', provider: 'claude', cwd: far.dir, workspaceId: null, startedBy: wire.caller.sessionId }, args.firstMessage)
      return { sessionId: thread.id, title: thread.title, cwd: thread.cwd, projectId: null } as T
    }
    return (await far.threads.handle(method as CrossHostPeerMethod, wire, { from, deadlineAt: Date.now() + 60_000 })) as T
  }
})

function makeHost(id: string, modules: WorkModule[], opts: { work?: boolean; old?: boolean } = {}): Host {
  const dir = join(root, id === BOX ? 'box' : 'mac')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'app.db'))
  const store = new Store(db)
  store.setSetting('workspace.root', dir)
  store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: opts.work !== false }))
  const registry = new SessionRegistry(store)
  const threads = new CrossHostThreads({
    environmentId: id,
    store,
    registry,
    environments: () => [...hosts.keys()].filter((e) => e !== id).map((e) => ({ id: e, name: e === BOX ? 'The box' : 'The Mac' })),
    link: () => null,
    pathMap: () => ({ roots: {}, prefixes: {} }),
    workRoot: () => dir,
    log: () => {}
  })
  const host: Host = { id, dir, db, store, registry, threads, work: null as never, policy: 'read+run', old: opts.old === true }
  const agents = new CrossHostAgents({ environmentId: id, store, sessions: { get: (sid) => registry.get(sid), append: () => {}, deliverAgentReport: () => {} }, links: linkFrom(id), macPeerOf: () => null, workRoot: () => dir, log: () => {} })
  host.work = startWork(
    {
      db,
      store,
      registry,
      environmentId: id,
      dataDir: dir,
      crossHostThreads: threads,
      crossHostAgents: agents,
      macBridge: { policyOf: () => host.policy } as never,
      // the Work part builds its own transport from these two; here every other host has registered
      peerCalls: {
        online: (env: string) => hosts.has(env) && env !== id,
        registeredIds: () => [...hosts.keys()].filter((e) => e !== id),
        call: (env: string, method: string, params: unknown) => linkFrom(id).call(env, method, params, 60_000)
      } as never,
      log: () => {}
    },
    modules
  )
  ;(host as Host & { agents: CrossHostAgents }).agents = agents
  hosts.set(id, host)
  return host
}
const agentsOf = (host: Host): CrossHostAgents => (host as Host & { agents: CrossHostAgents }).agents
const workWorkspace = async (host: Host, name: string, sector: string | null = name): Promise<string> => {
  const path = join(host.dir, 'Work', name)
  mkdirSync(path, { recursive: true })
  return (await host.registry.createWorkspace(path, name, { kind: 'work', sector })).id
}
/** The app's tools on the box: apptools and orchestration read these module-level handles. */
const actAs = (host: Host): void => {
  setOrchestrationRegistry(host.registry)
  setAppCrossHost(agentsOf(host))
  setCrossHostAgents(agentsOf(host))
}

/** A pillar on both hosts: a method the far host answers, and a tool that reaches it through ctx.peer. */
const seen: { host: string; method: string; by: unknown; params: unknown }[] = []
const office: WorkModule = {
  id: 'office',
  ensure() {},
  async handle(req, ctx, by) {
    const method = req.method as string
    if (method === 'work.office.elsewhere') return NOT_HANDLED
    seen.push({ host: ctx.host, method, by, params: (req as { params?: unknown }).params })
    return handled({ wrote: (req as { params?: { range?: string } }).params?.range ?? null, on: ctx.host })
  },
  tools: (_scope: WorkScope) => [
    {
      name: 'office_range_write',
      description: 'Write a range through Excel on the Mac',
      input: z.object({ range: z.string(), verb: z.string().optional() }),
      readOnly: false,
      run: async (args, ctx: ToolCtx) => {
        const a = args as { range: string; verb?: string }
        const answer = await ctx.peer(MAC).call('office', a.verb ?? 'rangeWrite', { range: a.range })
        return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
      }
    }
  ]
}
/** The far host's reading of a peer call's method: this test's pillar has no contract rows, so it brings its own. */
const CAPS: Record<string, Capability | 'local'> = { 'work.office.rangeWrite': 'operate', 'work.office.rangeRead': 'read', 'work.office.send': 'approve', 'work.office.signIn': 'local', 'work.office.elsewhere': 'read' }
const serveOn = (host: Host): void =>
  host.threads.serveWork((from, call) => servePeerWork({ ctx: host.work.ctx, modules: [office], policyOf: () => host.policy, capabilityOf: (m) => CAPS[m], parse: (method, params) => ({ id: 'peer', method, params }) as never }, from, call))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-hosts-'))
  sent.clear()
  seen.length = 0
})
afterEach(async () => {
  setAppCrossHost(null)
  setCrossHostAgents(null)
  cancelMirrors()
  for (const host of hosts.values()) {
    host.work.close()
    host.threads.close()
    await host.registry.close()
    host.db.close()
  }
  hosts.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('a Work thread starts a thread on another host', () => {
  const start = (box: Host, caller: SessionMeta, over: Record<string, unknown> = {}) =>
    appStartThread(box.registry, box.registry.get(caller.id)!, { threadType: 'chat', provider: 'claude', firstMessage: 'draft the reply to Dana', environmentId: MAC, ...over } as never)

  it('it is a Work thread there, of that host\'s own workspace for the job, with the Work preamble', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    actAs(box)
    const purdueBox = await workWorkspace(box, 'purdue')
    const purdueMac = await workWorkspace(mac, 'Purdue on the Mac', 'purdue')
    await workWorkspace(mac, 'cosmic')
    const caller = await box.registry.startWith({ threadType: 'chat', workspaceId: purdueBox }, 'go')
    const started = (await start(box, caller)) as { threadId: string; host: string }
    expect(started.host).toBe(MAC)
    const far = mac.registry.list().find((s) => s.startedBy === caller.id)!
    expect(started.threadId).toBe(`${MAC}:${far.id}`)
    expect(far).toMatchObject({ scope: 'work', workspaceId: purdueMac, threadType: 'chat', projectId: null })
    expect(sent.get(far.id)?.[0]).toContain(WORK_PREAMBLE_HEADING)
    expect(sent.get(far.id)?.[0]).toContain("Another of the owner's Work threads started this one")
    expect(sent.get(far.id)?.[0]).toContain('draft the reply to Dana')
    expect(sent.get(far.id)?.[0]).toContain('This workspace is Purdue on the Mac (purdue).')
    // a project the box names does not move it out of the job
    const { id: projectId } = await box.registry.createProject(purdueBox, 'esports', 'local')
    await start(box, caller, { projectId })
    expect(mac.registry.list().filter((s) => s.startedBy === caller.id).every((s) => s.scope === 'work' && s.workspaceId === purdueMac)).toBe(true)
  })

  it('a Work Chat starts a Work Chat there', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    actAs(box)
    const caller = await box.registry.startWith({ scope: 'work', threadType: 'chat', workspaceId: null }, 'go')
    await start(box, caller)
    expect(mac.registry.list()[0]).toMatchObject({ scope: 'work', workspaceId: null, startedBy: caller.id })
  })

  it('refused, with nothing started, by a host with Work off, with no workspace for the job, and for a plan or a build', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    actAs(box)
    const purdueBox = await workWorkspace(box, 'purdue')
    const caller = await box.registry.startWith({ threadType: 'chat', workspaceId: purdueBox }, 'go')
    expect(await start(box, caller)).toMatch(/^refused: that host did not take the thread as a Work thread \(this host has no Work workspace for purdue\)/)
    expect(await start(box, caller, { threadType: 'implementation' })).toMatch(/^refused: a Work thread starts chat and research threads only/)
    await workWorkspace(mac, 'purdue')
    mac.store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: false }))
    expect(await start(box, caller)).toMatch(new RegExp(`\\(${WORK_OFF}\\)`))
    expect(mac.registry.list()).toEqual([])
  })

  it('a host from before Work refuses it: the message is not where that build looks, so it starts no code thread', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [], { old: true })
    actAs(box)
    const purdueBox = await workWorkspace(box, 'purdue')
    const caller = await box.registry.startWith({ threadType: 'chat', workspaceId: purdueBox }, 'go')
    expect(await start(box, caller)).toMatch(/^refused: that host did not take the thread as a Work thread/)
    expect(mac.registry.list()).toEqual([])
    // the same old host takes a code thread's start as it always did
    const { id: projectId } = await box.registry.createProject((await box.registry.createWorkspace(box.dir)).id, 'main', 'local')
    const code = await box.registry.startWith({ threadType: 'chat', projectId }, 'go')
    expect(await start(box, code)).toMatchObject({ host: MAC })
    expect(mac.registry.list()).toHaveLength(1)
    expect(mac.registry.list()[0].scope).toBeUndefined()
  })

  it('spawn_agent with a host is refused for a Work thread, and nothing reaches that host', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    actAs(box)
    const caller = await box.registry.startWith({ threadType: 'chat', workspaceId: await workWorkspace(box, 'purdue') }, 'go')
    expect(await orchSpawnAgent(box.registry.get(caller.id)!, { task: 'on the mac', model: 'claude-opus-5-5', provider: 'claude', environmentId: MAC })).toMatch(/^refused: a Work thread spawns its subagents on this host/)
    // and the calls themselves are guarded, whoever reaches them (the bridge's app.spawnAgent, batch.adopt)
    await expect(agentsOf(box).spawn(box.registry.get(caller.id)!, MAC, [])).rejects.toThrow(/on its own host/)
    await expect(agentsOf(box).startThread(box.registry.get(caller.id)!, MAC, { threadType: 'chat', provider: 'claude', firstMessage: 'as a code thread', cwd: '/' })).rejects.toThrow(/only as a Work thread/)
    expect((await agentsOf(box).adopt(box.registry.get(caller.id)!, [`${MAC}:abc`])).adopted).toEqual([])
    expect(mac.registry.list()).toEqual([])
  })

  it('a Work thread on a host joins no batch of another host', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    const work = await mac.registry.create({ threadType: 'chat', workspaceId: await workWorkspace(mac, 'purdue') })
    const caller = { environmentId: BOX, sessionId: 'box-master', title: 'Master', permission: 'auto' as const }
    await expect(mac.threads.handle('thread.adopt', { caller, args: { sessionId: work.id, masterId: 'box-master' } }, { from: BOX, deadlineAt: Date.now() + 1000 })).rejects.toThrow(/it is a Work thread/)
    expect(mac.registry.get(work.id)?.masterId ?? null).toBeNull()
    void box
  })
})

describe('the wire', () => {
  it('a Work ask leaves firstMessage empty, and a start with no message and no Work ask is refused', () => {
    expect(ThreadStartArgsSchema.safeParse(workAskArgs({ kind: 'probe', sector: 'purdue', workspaceLinkId: null, workspaceName: 'purdue' })).success).toBe(true)
    expect(ThreadStartArgsSchema.safeParse({ ...workAskArgs({ kind: 'probe', sector: null, workspaceLinkId: null, workspaceName: null }), firstMessage: 'hello' }).success).toBe(false)
    expect(ThreadStartArgsSchema.safeParse({ threadType: 'chat', provider: 'claude', firstMessage: '', cwd: '/' }).success).toBe(false)
    expect(ThreadStartArgsSchema.safeParse({ threadType: 'chat', provider: 'claude', firstMessage: 'hello', cwd: '/' }).success).toBe(true)
    // what a build from before Work makes of the same args
    expect(OldThreadStartArgs.safeParse(workAskArgs({ kind: 'probe', sector: 'purdue', workspaceLinkId: null, workspaceName: 'purdue' })).success).toBe(false)
  })
})

describe('ctx.peer: a Work tool on one host calls the same module on another', () => {
  const setUp = async (): Promise<{ box: Host; mac: Host; thread: SessionMeta; workspaceId: string }> => {
    const box = makeHost(BOX, [office])
    const mac = makeHost(MAC, [office])
    serveOn(mac)
    const workspaceId = await workWorkspace(box, 'purdue')
    const thread = await box.registry.create({ threadType: 'chat', workspaceId })
    return { box, mac, thread, workspaceId }
  }
  const call = (box: Host, thread: SessionMeta, args: Record<string, unknown>) => box.work.tools.call(box.registry.get(thread.id)!, 'office_range_write', args, new AbortController().signal)

  it('runs there when the workspace may use that host, as a remote caller with what the bridge policy allows', async () => {
    const { box, mac, thread, workspaceId } = await setUp()
    box.work.ctx.settings.set(workspaceId, { mayUseDesktop: [MAC] })
    const result = await call(box, thread, { range: 'A1:B2' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ wrote: 'A1:B2', on: MAC })
    expect(seen).toEqual([{ host: MAC, method: 'work.office.rangeWrite', by: { kind: 'remote', caps: ['read', 'operate'] }, params: { range: 'A1:B2' } }])
    void mac
  })

  it('is refused when the workspace\'s mayUseDesktop lacks that host, and nothing reaches it', async () => {
    const { box, thread, workspaceId } = await setUp()
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow(/may not use that host's desktop \(its Work settings name no host\)/)
    box.work.ctx.settings.set(workspaceId, { mayUseDesktop: ['env_some_other_host'] })
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow(/may not use that host's desktop/)
    expect(seen).toEqual([])
    // a Work Chat has no workspace to be given one
    const chat = await box.registry.create({ scope: 'work', threadType: 'chat', workspaceId: null })
    await expect(call(box, chat, { range: 'A1' })).rejects.toThrow(/a Work Chat may use no other host's desktop/)
  })

  it('is refused by the far host\'s bridge policy, and never carries the press', async () => {
    const { box, mac, thread, workspaceId } = await setUp()
    box.work.ctx.settings.set(workspaceId, { mayUseDesktop: [MAC] })
    mac.policy = 'off'
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow(/bridge is off for that host/)
    mac.policy = 'read'
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow(/policy for that host is "read", and work.office.rangeWrite needs operate/)
    expect(JSON.parse(((await call(box, thread, { range: 'A1', verb: 'rangeRead' })).content[0] as { text: string }).text)).toMatchObject({ on: MAC })
    mac.policy = 'full'
    await expect(call(box, thread, { range: 'A1', verb: 'send' })).rejects.toThrow(/needs approve, which no call from another host carries/)
    await expect(call(box, thread, { range: 'A1', verb: 'signIn' })).rejects.toThrow(/needs local/)
    await expect(call(box, thread, { range: 'A1', verb: 'nothing' })).rejects.toThrow(/unknown Work method: work.office.nothing/)
    await expect(call(box, thread, { range: 'A1', verb: 'elsewhere' })).rejects.toThrow(/not built: work.office.elsewhere/)
    expect(seen.map((s) => s.method)).toEqual(['work.office.rangeRead'])
    expect(peerCaps('full')).not.toContain('approve')
  })

  it('is refused by a far host with Work off, by one from before Work, and when called off a tool\'s ctx', async () => {
    const { box, mac, thread, workspaceId } = await setUp()
    box.work.ctx.settings.set(workspaceId, { mayUseDesktop: [MAC] })
    mac.store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: false }))
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow(WORK_OFF)
    mac.old = true
    await expect(call(box, thread, { range: 'A1' })).rejects.toThrow()
    expect(mac.registry.list()).toEqual([])
    // the context alone names no thread, so no workspace: refused before anything is sent
    await expect(box.work.ctx.peer(MAC).call('office', 'rangeWrite', {})).rejects.toThrow(/called on a tool's own ctx/)
    const detached = box.work.ctx.peer
    await expect(detached(MAC).call('office', 'rangeWrite', {})).rejects.toThrow(/called on a tool's own ctx/)
    expect(seen).toEqual([])
  })

  it('the real module list answers a method no pillar has built as not built', async () => {
    await loadWorkModules()
    const box = makeHost(BOX, WORK_MODULES)
    const mac = makeHost(MAC, WORK_MODULES)
    await expect(servePeerWork({ ctx: mac.work.ctx, modules: WORK_MODULES, policyOf: () => 'full' }, BOX, { kind: 'call', module: 'office', verb: 'rangeWrite', args: {} })).rejects.toThrow(/unknown Work method: work.office.rangeWrite/)
    await expect(servePeerWork({ ctx: mac.work.ctx, modules: WORK_MODULES, policyOf: () => 'full' }, BOX, { kind: 'call', module: 'nope', verb: 'x', args: {} })).rejects.toThrow(/unknown Work method/)
    void box
  })
})

describe('a move: would the other host keep the thread a Work thread', () => {
  it('a host that knows Work says so for its workspace of the job, and says why not', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [])
    const purdueBox = await workWorkspace(box, 'purdue')
    const thread = await box.registry.create({ threadType: 'chat', workspaceId: purdueBox })
    const gate = box.registry.workMove!
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toMatch(/this host has no Work workspace for purdue/)
    await workWorkspace(mac, 'purdue')
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toBeNull()
    // the job's workspace is there, but the thread's own folder, mapped onto that host, belongs to another job's:
    // the move's import lands by folder, so the thread would read the other job's add-ons
    mac.db.prepare(`UPDATE workspaces SET sector = 'cosmic', name = 'cosmic' WHERE kind = 'work'`).run()
    mkdirSync(join(mac.dir, 'Work', 'purdue-elsewhere'), { recursive: true })
    await mac.registry.createWorkspace(join(mac.dir, 'Work', 'purdue-elsewhere'), 'purdue elsewhere', { kind: 'work', sector: 'purdue' })
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toMatch(/the thread's folder lands in cosmic on this host, which is not the workspace for purdue \(purdue elsewhere\)/)
    // and with no folder there at all for it to land in
    mac.db.prepare(`DELETE FROM workspaces WHERE name = 'cosmic'`).run()
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toMatch(/has no folder for purdue elsewhere where the thread's own would land/)
    mac.db.prepare(`UPDATE workspaces SET path = ? WHERE name = 'purdue elsewhere'`).run(join(mac.dir, 'Work', 'purdue'))
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toBeNull()
    mac.store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: false }))
    expect(await gate.refusal(MAC, box.registry.get(thread.id)!)).toBe(`Work is off on ${MAC}.`)
    expect(mac.registry.list()).toEqual([])
  })

  it('a host from before Work cannot answer, and that is the refusal', async () => {
    const box = makeHost(BOX, [])
    const mac = makeHost(MAC, [], { old: true })
    const thread = await box.registry.create({ threadType: 'chat', workspaceId: await workWorkspace(box, 'purdue') })
    expect(await box.registry.workMove!.refusal(MAC, box.registry.get(thread.id)!)).toMatch(/does not answer for Work .* It would take the thread as a code thread\./)
    expect(mac.registry.list()).toEqual([])
    // an answer that is not Work's is one too (a build that answered thread.start some other way)
    expect(await moveRefusal(async () => ({ sessionId: 's1' }) as never, { sector: 'purdue', workspaceLinkId: null, workspaceName: 'purdue', workspacePath: null }, 'The Mac')).toMatch(/runs a build from before Work/)
  })

  it('a host out of reach is a refusal, and the freeze the registry made is lifted in the database', async () => {
    const box = makeHost(BOX, [])
    const thread = await box.registry.create({ threadType: 'chat', workspaceId: await workWorkspace(box, 'purdue') })
    await new Promise((r) => setTimeout(r, 0))
    const freeze = (ids: string[]): void => void box.db.prepare(`UPDATE sessions SET moving_to = ?, move_id = 'm1' WHERE id = ?`).run(MAC, ids[0])
    await expect(box.registry.freezeForMove(thread.id, freeze)).rejects.toThrow(/this Work thread stays here: .*host offline/)
    expect((box.db.prepare(`SELECT moving_to FROM sessions WHERE id = ?`).get(thread.id) as { moving_to: string | null }).moving_to).toBeNull()
    await box.registry.send(thread.id, 'still here')
  })
})
