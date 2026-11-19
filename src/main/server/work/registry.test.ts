import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { WORK_HOME, WORK_SETTING_KEY } from '@shared/work'
import { configureAddonScope, visibleAddons, workspaceIdOf } from '../addons/scope'
import { appListThreads, appReadThread, appStartThread, setAppSkillTools, setAppToolsRegistry, WORK_SKILL_REFUSAL } from '../apptools'
import { skillWrite } from '../skills/tools'
import { openDb, Store } from '../db'
import type { DriverCtx, DriverHandle } from '../drivers/types'
import { cancelMirrors } from '../mirror'
import { orchSendToAgent, orchSpawnAgent, setCrossHostAgents, setOrchestrationRegistry } from '../orchestration'
import { SessionRegistry } from '../sessions'
import { WORK_PREAMBLE_HEADING, workPreambleHead } from './preamble'
import { WORK_CHATS_FOLDER, WORK_OFF, WORK_ORPHAN, WorkRefused, workAddonScope, scopeFactsOf } from './scope'

/**
 * Work scope on a real registry and a real database, with fake harnesses:
 * what is made with the switch off and on, that scope follows the parent on
 * every path that makes a thread here, what a Work thread's first message
 * carries, and that a code thread's row and first message are what they
 * were.
 */

/** What each harness was handed as its messages. */
const sent = new Map<string, string[]>()
const emits = new Map<string, (e: AgentEvent) => void>()
const booted: string[] = []
vi.mock('../drivers', () => {
  const fake = (id: string) => ({
    id,
    start: async (ctx: DriverCtx): Promise<DriverHandle> => {
      booted.push(`${id}:${ctx.session.id}`)
      emits.set(ctx.session.id, ctx.emit)
      return {
        confirmsSteers: true,
        send: async (text: string) => {
          sent.set(ctx.session.id, [...(sent.get(ctx.session.id) ?? []), text])
          ctx.emit({ type: 'status', status: 'running' })
        },
        interrupt: () => {},
        alive: () => true,
        dispose: async () => {}
      }
    }
  })
  return { BUILT_IN_DRIVERS: { claude: fake('claude'), codex: fake('codex'), muse: fake('muse') } }
})

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
const switchWork = (enabled: boolean): void => store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled }))
const settle = async (id: string): Promise<void> => {
  // the fake turn ends: the thread is idle again
  emits.get(id)?.({ type: 'turn-complete' } as AgentEvent)
  emits.get(id)?.({ type: 'status', status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-registry-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  store.setSetting('workspace.root', root)
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  sent.clear()
  emits.clear()
  booted.length = 0
})
afterEach(async () => {
  setCrossHostAgents(null)
  configureAddonScope(null)
  cancelMirrors()
  await registry.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const codeWorkspace = async (): Promise<{ workspaceId: string; projectId: string; path: string }> => {
  const path = join(root, 'repo')
  await import('node:fs/promises').then((fs) => fs.mkdir(path, { recursive: true }))
  const workspace = await registry.createWorkspace(path)
  const project = await registry.createProject(workspace.id, 'main', 'local')
  return { workspaceId: workspace.id, projectId: project.id, path }
}
const workWorkspace = async (name: string, sector: string | null = name): Promise<{ id: string; path: string }> => {
  const path = join(root, 'Work', name)
  await import('node:fs/promises').then((fs) => fs.mkdir(path, { recursive: true }))
  const workspace = await registry.createWorkspace(path, name, { kind: 'work', sector })
  return { id: workspace.id, path: workspace.path }
}
const first = (id: string): string => sent.get(id)?.[0] ?? ''

describe('with the Work switch off', () => {
  it('no Work workspace, Work Chat or Work thread can be made', async () => {
    await expect(registry.createWorkspace(join(root, 'Work', 'purdue'), 'purdue', { kind: 'work', sector: 'purdue' })).rejects.toThrow(WORK_OFF)
    await expect(registry.create({ scope: 'work', threadType: 'chat', workspaceId: null })).rejects.toThrow(WORK_OFF)
    expect(registry.listWorkspaces()).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('rows made while it was on keep their fence: the row decides, never the switch', async () => {
    switchWork(true)
    const purdue = await workWorkspace('purdue')
    const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
    switchWork(false)
    expect(registry.get(thread.id)?.scope).toBe('work')
    // and no new one joins it
    await expect(registry.create({ threadType: 'chat', workspaceId: purdue.id })).rejects.toThrow(WORK_OFF)
    await expect(registry.create({ parentId: thread.id, cwd: purdue.path })).rejects.toThrow(WORK_OFF)
  })

  it("a code thread's row and first message are the same with the switch off and on", async () => {
    const { projectId, path } = await codeWorkspace()
    const shape = async (): Promise<unknown> => {
      const loose = await registry.startWith({ threadType: 'chat', cwd: path, workspaceId: null, title: 'Loose' }, 'hello there')
      const inProject = await registry.startWith({ threadType: 'implementation', projectId, title: 'Build' }, 'build it')
      const child = await registry.startWith({ parentId: inProject.id, projectId, cwd: path, title: 'Child' }, 'look into it')
      // The row as stored, less what differs from run to run.
      const strip = (m: SessionMeta): Record<string, unknown> => {
        const { id: _id, createdAt: _c, updatedAt: _u, busySince: _b, parentId, planPath: _p, ...rest } = m as SessionMeta & Record<string, unknown>
        return { ...rest, hasParent: !!parentId }
      }
      const out = [loose, inProject, child].map((m) => ({ meta: strip(store.getSession(m.id)!), first: first(m.id).replaceAll(m.id, '<id>').replaceAll(inProject.id, '<parent>') }))
      for (const m of [child, inProject, loose]) await registry.delete(m.id)
      return out
    }
    switchWork(false)
    const off = await shape()
    switchWork(true)
    const on = await shape()
    expect(on).toEqual(off)
    for (const row of off as { meta: Record<string, unknown>; first: string }[]) {
      expect(row.meta).not.toHaveProperty('scope')
      expect(row.first).not.toContain(WORK_PREAMBLE_HEADING)
    }
  })
})

describe('with the Work switch on', () => {
  beforeEach(() => switchWork(true))

  it('a Work workspace is the app\'s own folder, never a checkout, and one per code folder', async () => {
    const purdue = await workWorkspace('purdue')
    const row = registry.listWorkspaces().find((w) => w.id === purdue.id)!
    expect(row).toMatchObject({ kind: 'work', sector: 'purdue', git: false, name: 'purdue' })
    expect(statSync(row.path).isDirectory()).toBe(true)
    const { path } = await codeWorkspace()
    await expect(registry.createWorkspace(path, 'x', { kind: 'work' })).rejects.toThrow(/code workspace at that folder/)
    // and a code workspace's own row carries no kind at all
    expect(registry.listWorkspaces().find((w) => w.path === path)).not.toHaveProperty('kind')
  })

  it('a thread of a Work workspace is stamped once, and a Work Chat runs in its own folder outside every workspace', async () => {
    const purdue = await workWorkspace('purdue')
    const inWorkspace = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
    expect(inWorkspace).toMatchObject({ scope: 'work', workspaceId: purdue.id, cwd: purdue.path })
    const chat = await registry.create({ scope: 'work', threadType: 'research', workspaceId: null, cwd: '/somewhere/a/client/named' })
    expect(chat).toMatchObject({ scope: 'work', workspaceId: null, projectId: null, cwd: join(root, 'Work', WORK_CHATS_FOLDER) })
    expect(existsSync(chat.cwd)).toBe(true)
    expect(store.getSession(chat.id)?.scope).toBe('work')
  })

  it('refuses a Work thread that is a plan or a build, and one on a harness with no fence', async () => {
    const purdue = await workWorkspace('purdue')
    await expect(registry.create({ threadType: 'implementation', workspaceId: purdue.id })).rejects.toThrow(/chat or a research thread/)
    await expect(registry.create({ threadType: 'chat', workspaceId: purdue.id, provider: 'muse', model: 'muse-wonder-full-1.0' })).rejects.toThrow(/not offered for Work/)
    await expect(registry.create({ threadType: 'chat', workspaceId: purdue.id, provider: 'codex' })).rejects.toThrow(/not offered for Work/)
    // nor does a Work thread become one later
    const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
    await expect(registry.retype(thread.id, 'implementation')).rejects.toThrow(WorkRefused)
    await registry.retype(thread.id, 'research')
    expect(registry.get(thread.id)?.threadType).toBe('research')
    await expect(registry.send(thread.id, 'hi', { provider: 'muse', model: 'muse-wonder-full-1.0' })).rejects.toThrow(/not offered for Work/)
    expect(registry.get(thread.id)?.provider).toBe('claude')
    expect(booted.some((b) => b.startsWith('muse:'))).toBe(false)
  })

  it('a row that is Work on a harness with no fence boots nothing', async () => {
    const purdue = await workWorkspace('purdue')
    const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
    await new Promise((r) => setTimeout(r, 0))
    db.prepare(`UPDATE sessions SET provider = 'muse', model = 'muse-wonder-full-1.0' WHERE id = ?`).run(thread.id)
    ;(registry as unknown as { handles: Map<string, unknown> }).handles.delete(thread.id)
    await expect(registry.send(thread.id, 'hi')).rejects.toThrow(/not offered for Work/)
    expect(booted.filter((b) => b.startsWith('muse:'))).toEqual([])
  })

  describe('scope follows the parent', () => {
    it('spawn_agent: the child is a Work thread of the parent\'s workspace, and never on another host', async () => {
      const purdue = await workWorkspace('purdue')
      const parent = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id }, 'do the thing')
      const answer = JSON.parse(await orchSpawnAgent(registry.get(parent.id)!, { task: 'look at the budget', model: 'claude-opus-5-5', provider: 'claude', agentType: 'explorer' }))
      const child = registry.get(answer.agentId)!
      expect(child).toMatchObject({ scope: 'work', parentId: parent.id, workspaceId: purdue.id, cwd: purdue.path })
      // another host: the request names no scope there, so it is refused before anything is sent
      const far = vi.fn()
      setCrossHostAgents({ children: () => [], spawn: far } as never)
      expect(await orchSpawnAgent(registry.get(parent.id)!, { task: 'on the mac', model: 'claude-opus-5-5', provider: 'claude', environmentId: 'mac' })).toMatch(/^refused: a Work thread spawns its subagents on this host/)
      expect(far).not.toHaveBeenCalled()
    })

    it('app_start_thread: a code project is refused, another job is refused, and with no project the thread is the parent\'s workspace\'s', async () => {
      const purdue = await workWorkspace('purdue')
      const cosmic = await workWorkspace('cosmic')
      const { projectId } = await codeWorkspace()
      const cosmicProject = await registry.createProject(cosmic.id, 'budget', 'local')
      const parent = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id }, 'do the thing')
      const start = (over: Record<string, unknown>) => appStartThread(registry, registry.get(parent.id)!, { threadType: 'chat', provider: 'claude', firstMessage: 'carry on', ...over } as never)
      const before = registry.list().length
      expect(await start({ projectId })).toMatch(/^refused: project "main" is outside this Work thread's workspace/)
      expect(await start({ projectId: cosmicProject.id })).toMatch(/^refused: project "budget" is outside/)
      expect(await start({ threadType: 'implementation' })).toMatch(/^refused: a Work thread starts chat and research threads only/)
      expect(await start({ provider: 'cursor', model: 'auto' })).toMatch(/not offered for Work/)
      expect(registry.list()).toHaveLength(before)
      const started = (await start({})) as { threadId: string }
      expect(registry.get(started.threadId)).toMatchObject({ scope: 'work', workspaceId: purdue.id, startedBy: parent.id, parentId: null, cwd: purdue.path })
      // a project of its own workspace is fine
      const own = await registry.createProject(purdue.id, 'esports', 'local')
      const inProject = (await start({ projectId: own.id })) as { threadId: string }
      expect(registry.get(inProject.threadId)).toMatchObject({ scope: 'work', projectId: own.id })
    })

    it('a raw create with a Work parent cannot name a code project either', async () => {
      const purdue = await workWorkspace('purdue')
      const { projectId, path } = await codeWorkspace()
      const parent = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
      await expect(registry.create({ parentId: parent.id, projectId, cwd: path })).rejects.toThrow(/is outside it/)
      await expect(registry.create({ startedBy: parent.id, threadType: 'chat', projectId })).rejects.toThrow(WorkRefused)
      await expect(registry.create({ startedBy: parent.id, threadType: 'chat', scope: 'code' })).rejects.toThrow(/is a Work thread/)
      // a child whose cwd is a code folder still belongs to the parent's workspace
      const child = await registry.create({ parentId: parent.id, cwd: path })
      expect(child).toMatchObject({ scope: 'work', workspaceId: purdue.id })
    })

    it('a Work Chat\'s child is a Work Chat', async () => {
      const chat = await registry.startWith({ scope: 'work', threadType: 'chat', workspaceId: null }, 'what is on today')
      const answer = JSON.parse(await orchSpawnAgent(registry.get(chat.id)!, { task: 'check the agenda', model: 'claude-opus-5-5', provider: 'claude', agentType: 'explorer' }))
      expect(registry.get(answer.agentId)).toMatchObject({ scope: 'work', workspaceId: null, projectId: null, cwd: chat.cwd })
    })
  })

  describe('the fence between threads', () => {
    it('a Work thread lists, reads, seeds from and sends to its own workspace\'s threads only', async () => {
      const purdue = await workWorkspace('purdue')
      const { projectId } = await codeWorkspace()
      const mine = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id, title: 'Mine' }, 'a')
      const sibling = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id, title: 'Sibling' }, 'b')
      const code = await registry.startWith({ threadType: 'chat', projectId, title: 'Code' }, 'c')
      const caller = registry.get(mine.id)!
      expect(appListThreads(registry, caller, true).map((t) => t.threadId).sort()).toEqual([mine.id, sibling.id].sort())
      expect(await appReadThread(registry, code.id, caller)).toMatch(/is outside this Work thread's workspace/)
      expect(await appReadThread(registry, sibling.id, caller)).not.toMatch(/refused/)
      expect(await appStartThread(registry, caller, { threadType: 'chat', provider: 'claude', firstMessage: 'x', seedThreadIds: [code.id] })).toMatch(/^refused: seed thread/)
      expect(await orchSendToAgent(caller, code.id, 'do my bidding')).toMatch(/^refused/)
      // a code thread sees what it saw
      expect(appListThreads(registry, registry.get(code.id)!, true).map((t) => t.threadId)).toContain(mine.id)
    })

    it('a batch holds one scope: a Work master takes no code thread, a code master no Work thread', async () => {
      const purdue = await workWorkspace('purdue')
      const { projectId } = await codeWorkspace()
      const workMaster = await registry.create({ threadType: 'chat', workspaceId: purdue.id, master: true })
      const codeMaster = await registry.create({ threadType: 'chat', projectId, master: true })
      const code = await registry.create({ threadType: 'chat', projectId })
      const work = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
      expect(() => registry.setBatchMembership(code.id, workMaster.id)).toThrow(/one scope/)
      expect(() => registry.setBatchMembership(work.id, codeMaster.id)).toThrow(WorkRefused)
      expect(() => registry.setBatchMembership(work.id, 'a-master-on-another-host')).toThrow(WorkRefused)
      registry.setBatchMembership(work.id, workMaster.id)
      registry.setBatchMembership(code.id, codeMaster.id)
      expect(registry.get(work.id)?.masterId).toBe(workMaster.id)
      await expect(registry.create({ threadType: 'chat', projectId, masterId: workMaster.id })).rejects.toThrow(/one scope/)
    })
  })

  describe('the preamble', () => {
    it('a Work Chat, a workspace thread and a child each open with the fixed head, whatever would switch a project preamble off', async () => {
      const purdue = await workWorkspace('purdue')
      const chat = await registry.startWith({ scope: 'work', threadType: 'chat', workspaceId: null }, 'what is on today')
      const head = workPreambleHead({ workspace: null, sector: null, child: false })
      expect(first(chat.id)).toContain(`${WORK_PREAMBLE_HEADING}\n\n${head}\n\n## The task\n\nwhat is on today`)
      expect(store.firstUserPreamble(chat.id)?.text).toBe(head)

      const thread = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id }, 'draft the reply')
      expect(first(thread.id)).toContain(workPreambleHead({ workspace: 'purdue', sector: 'purdue', child: false }))
      expect(first(thread.id)).toContain('This workspace is purdue (purdue).')

      // the spawner opts out, and the parent's own first row is beside the point
      const child = await registry.startWith({ parentId: thread.id, cwd: purdue.path }, 'look into it', { preamble: false })
      expect(first(child.id)).toContain(workPreambleHead({ workspace: 'purdue', sector: 'purdue', child: true }))
      expect(first(child.id)).toContain("Another of the owner's Work threads started this one")
      // and its user row shows the task alone, the rules folded behind it
      const row = registry.eventsAfter(child.id, 0).find((r) => r.event.type === 'user-text')!
      expect(row.event).toMatchObject({ text: 'look into it', preamble: { text: workPreambleHead({ workspace: 'purdue', sector: 'purdue', child: true }) } })
    })

    it("the modules' parts follow the head, then the workspace's own project preamble", async () => {
      const purdue = await workWorkspace('purdue')
      const project = await registry.createProject(purdue.id, 'esports', 'local')
      registry.setProjectPreamble(project.id, 'Sign as the Assistant Director.', true)
      registry.workPreambleParts = (session) => [`House rule for ${session.id}.`]
      const thread = await registry.startWith({ threadType: 'chat', projectId: project.id }, 'draft it')
      const text = store.firstUserPreamble(thread.id)!.text
      expect(text).toBe(`${workPreambleHead({ workspace: 'purdue', sector: 'purdue', child: false })}\n\nHouse rule for ${thread.id}.\n\nSign as the Assistant Director.`)
      // a part that throws never costs the thread its head
      registry.workPreambleParts = () => {
        throw new Error('a pillar broke')
      }
      const other = await registry.startWith({ threadType: 'chat', workspaceId: purdue.id }, 'again')
      expect(store.firstUserPreamble(other.id)!.text).toBe(workPreambleHead({ workspace: 'purdue', sector: 'purdue', child: false }))
    })

    it('a later message carries no preamble', async () => {
      const chat = await registry.startWith({ scope: 'work', threadType: 'chat', workspaceId: null }, 'one')
      await settle(chat.id)
      await registry.send(chat.id, 'two')
      expect(sent.get(chat.id)?.[1]).not.toContain(WORK_PREAMBLE_HEADING)
    })
  })

  describe('add-ons', () => {
    it('a Work thread sees its own workspace\'s rows and the global rows marked for Work; its child never sees more', async () => {
      const purdue = await workWorkspace('purdue')
      const { workspaceId: repoId, path } = await codeWorkspace()
      const facts = scopeFactsOf(registry)
      const marked = new Set(['g-marked'])
      configureAddonScope({ scopeOf: (s) => workAddonScope(facts, s), isWork: (id) => id === WORK_HOME || id === WORK_ORPHAN || id === purdue.id, forWork: (id) => marked.has(id) })
      const rows = [
        { id: 'g-own', name: 'lifeos-own', workspaceId: null },
        { id: 'g-marked', name: 'weather', workspaceId: null },
        { id: 'w-purdue', name: 'lifeos', workspaceId: purdue.id },
        { id: 'w-repo', name: 'repo-tool', workspaceId: repoId },
        { id: 'w-home', name: 'lifeos-all', workspaceId: WORK_HOME }
      ]
      const seen = (session: SessionMeta): string[] => visibleAddons({ list: () => rows as never, status: () => ({}), tools: () => null }, workspaceIdOf(registry, session)).map((r) => r.id).sort()
      const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
      const child = await registry.create({ parentId: thread.id, cwd: path })
      const chat = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null })
      const code = await registry.create({ threadType: 'chat', workspaceId: repoId })
      expect(seen(thread)).toEqual(['g-marked', 'w-purdue'])
      expect(seen(child)).toEqual(['g-marked', 'w-purdue'])
      expect(seen(chat)).toEqual(['g-marked', 'w-home'])
      // a code thread: every global row and its workspace's, as before
      expect(seen(code)).toEqual(['g-marked', 'g-own', 'w-repo'])
      // a Work thread whose workspace is no longer a Work workspace: the marked globals and nothing of any workspace
      db.prepare(`UPDATE workspaces SET kind = 'code' WHERE id = ?`).run(purdue.id)
      expect(seen(thread)).toEqual(['g-marked'])
      expect(seen(child)).toEqual(['g-marked'])
    })
  })

  describe('skills', () => {
    it('a Work thread writes a skill for its own workspace only: a skill for every workspace would be read by code threads', async () => {
      const purdue = await workWorkspace('purdue')
      const cosmic = await workWorkspace('cosmic')
      const { projectId } = await codeWorkspace()
      const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
      const child = await registry.create({ parentId: thread.id, cwd: purdue.path })
      const chat = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null })
      const code = await registry.create({ threadType: 'chat', projectId })
      const wrote: unknown[] = []
      const deps = {
        environmentId: 'env_box',
        rootOf: (s: SessionMeta) => registry.get(registry.rootSessionOf(s.id))!,
        workspaceOf: (s: SessionMeta) => {
          const id = (s.projectId ? registry.getProject(s.projectId)?.workspaceId : null) ?? s.workspaceId
          const w = registry.listWorkspaces().find((x) => x.id === id)
          return w ? { id: w.id, name: w.name } : null
        },
        requestApproval: async () => true,
        skills: { list: () => [], byName: () => null, files: () => [] },
        write: async (input: unknown) => (wrote.push(input), { skill: { name: 'x', version: 1, fileCount: 1, bytes: 1, harnesses: 'all' } }),
        remove: async () => ({ removed: true }),
        settle: async () => true
      } as never
      setAppToolsRegistry(registry)
      setAppSkillTools(deps)
      const files = [{ path: 'SKILL.md', text: '---\nname: x\ndescription: d\n---\nbody' }]
      const write = (caller: SessionMeta, scope?: 'workspace' | 'global') => skillWrite(deps, registry.get(caller.id)!, { name: 'x', files, ...(scope ? { scope } : {}) })
      expect(await write(thread, 'global')).toBe(WORK_SKILL_REFUSAL)
      expect(await write(child, 'global')).toBe(WORK_SKILL_REFUSAL)
      expect(await write(chat)).toBe(WORK_SKILL_REFUSAL)
      expect(await write(chat, 'global')).toBe(WORK_SKILL_REFUSAL)
      expect(wrote).toEqual([])
      // its own workspace: written, by the thread at the top of its tree
      expect(await write(child)).toMatch(/^wrote x/)
      expect(wrote).toHaveLength(1)
      expect(wrote[0]).toMatchObject({ workspaceId: purdue.id, writtenBy: { kind: 'thread', sessionId: thread.id } })
      // a code thread writes where it always could
      expect(await write(code, 'global')).toMatch(/^wrote x/)
      expect(wrote[1]).toMatchObject({ workspaceId: null })
      void cosmic
      setAppSkillTools(null)
    })
  })

  describe('a move to another host', () => {
    const frozen: string[][] = []
    const freeze = (ids: string[]): void => {
      frozen.push(ids)
      db.prepare(`UPDATE sessions SET moving_to = 'env_mac', move_id = 'm1' WHERE id = ?`).run(ids[0])
    }
    const movingTo = (id: string): unknown => (db.prepare(`SELECT moving_to FROM sessions WHERE id = ?`).get(id) as { moving_to: string | null }).moving_to

    it('a code thread freezes and goes, asked nothing', async () => {
      const { projectId } = await codeWorkspace()
      const code = await registry.create({ threadType: 'chat', projectId })
      await new Promise((r) => setTimeout(r, 0))
      const asked = vi.fn(async () => 'never asked')
      registry.workMove = { refusal: asked, thaw: () => {} }
      expect(await registry.freezeForMove(code.id, freeze)).toEqual([code.id])
      expect(asked).not.toHaveBeenCalled()
    })

    it('a Work thread goes only when the other host says it keeps it one; refused, the freeze lifts', async () => {
      const purdue = await workWorkspace('purdue')
      const thread = await registry.create({ threadType: 'chat', workspaceId: purdue.id })
      await new Promise((r) => setTimeout(r, 0))
      // nobody to ask: it stays, and is never frozen
      registry.workMove = null
      frozen.length = 0
      await expect(registry.freezeForMove(thread.id, freeze)).rejects.toThrow(/cannot check/)
      expect(frozen).toEqual([])
      // the other host is a build from before Work
      const thawed: string[][] = []
      registry.workMove = {
        refusal: async (to, root) => `${to} runs a build from before Work (asked about ${root.id})`,
        thaw: (ids) => {
          thawed.push(ids)
          for (const id of ids) db.prepare(`UPDATE sessions SET moving_to = NULL, move_id = NULL WHERE id = ?`).run(id)
        }
      }
      await expect(registry.freezeForMove(thread.id, freeze)).rejects.toThrow(`this Work thread stays here: env_mac runs a build from before Work (asked about ${thread.id})`)
      expect(thawed).toEqual([[thread.id]])
      expect(movingTo(thread.id)).toBeNull()
      // a check that throws is a refusal too
      registry.workMove = { ...registry.workMove, refusal: async () => Promise.reject(new Error('the link dropped')) }
      await expect(registry.freezeForMove(thread.id, freeze)).rejects.toThrow(/the link dropped/)
      expect(movingTo(thread.id)).toBeNull()
      // it keeps Work threads: the move goes on
      registry.workMove = { ...registry.workMove, refusal: async () => null }
      expect(await registry.freezeForMove(thread.id, freeze)).toEqual([thread.id])
      expect(movingTo(thread.id)).toBe('env_mac')
    })

    it('a code thread with a Work thread anywhere in its tree is asked about too', async () => {
      const { projectId } = await codeWorkspace()
      const code = await registry.create({ threadType: 'chat', projectId })
      await new Promise((r) => setTimeout(r, 0))
      const child = await registry.create({ parentId: code.id, projectId })
      await new Promise((r) => setTimeout(r, 0))
      db.prepare(`UPDATE sessions SET scope = 'work' WHERE id = ?`).run(child.id)
      ;(registry as unknown as { indexCache: unknown }).indexCache = null
      registry.workMove = null
      await expect(registry.freezeForMove(code.id, freeze)).rejects.toThrow(/cannot check/)
    })
  })
})
