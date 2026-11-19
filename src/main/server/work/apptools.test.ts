import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { WORK_SETTING_KEY } from '@shared/work'
import { configureAddonScope, visibleAddons, WORK_UNSCOPED, workspaceIdOf } from '../addons/scope'
import { appToolsMcp, bridgeMcpConfig, setAppAddons, setAppBridge, setAppSkillTools, setAppToolsRegistry, WORK_ADDON_REFUSAL, WORK_SKILL_REFUSAL } from '../apptools'
import { openDb, Store } from '../db'
import { cancelMirrors } from '../mirror'
import { setCrossHostAgents, setOrchestrationRegistry } from '../orchestration'
import { SessionRegistry } from '../sessions'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../drivers', () => ({ BUILT_IN_DRIVERS: {} }))

/**
 * The app's own tools as a Work thread gets them (Claude's in-process
 * server): which are listed, and what the ones that reach past a thread do
 * for a Work caller. A code thread's are what they were.
 */

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let work: SessionMeta
let chat: SessionMeta
let code: SessionMeta
let purdueId: string
const addonCalls: { what: string; caller: string; args: unknown }[] = []
const skillCalls: { what: string; scope: unknown }[] = []

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>
const toolsOf = (session: SessionMeta): Record<string, { handler: Handler }> =>
  (appToolsMcp(session) as unknown as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools
const call = async (session: SessionMeta, name: string, args: Record<string, unknown> = {}): Promise<string> => (await toolsOf(session)[name].handler(args, {})).content[0].text

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-apptools-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  store.setSetting('workspace.root', root)
  store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: true }))
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  setAppToolsRegistry(registry)
  mkdirSync(join(root, 'Work', 'purdue'), { recursive: true })
  mkdirSync(join(root, 'repo'))
  purdueId = (await registry.createWorkspace(join(root, 'Work', 'purdue'), 'purdue', { kind: 'work', sector: 'purdue' })).id
  const repo = await registry.createWorkspace(join(root, 'repo'))
  work = await registry.create({ threadType: 'chat', workspaceId: purdueId })
  chat = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null })
  code = await registry.create({ threadType: 'chat', workspaceId: repo.id })
  addonCalls.length = 0
  skillCalls.length = 0
  setAppAddons({
    exposure: { attach: () => () => {} },
    list: () => '[]',
    add: async (caller, args) => (addonCalls.push({ what: 'add', caller: caller.id, args }), 'added'),
    remove: async (caller, args) => (addonCalls.push({ what: 'remove', caller: caller.id, args }), 'removed'),
    hasAddons: () => false
  })
  setAppSkillTools({
    environmentId: 'env_box',
    rootOf: (s: SessionMeta) => s,
    workspaceOf: (s: SessionMeta) => (s.workspaceId ? { id: s.workspaceId, name: 'ws' } : null),
    requestApproval: async () => true,
    skills: { list: () => [], byName: (workspaceId: string | null) => (skillCalls.push({ what: 'lookup', scope: workspaceId }), null), files: () => [] },
    write: async () => 'refused: not in this test',
    remove: async () => ({ removed: true }),
    settle: async () => true
  } as never)
})
afterEach(async () => {
  setAppAddons(null)
  setAppSkillTools(null)
  setAppBridge(null)
  setCrossHostAgents(null)
  configureAddonScope(null)
  cancelMirrors()
  await registry.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the tools a Work thread is listed', () => {
  it('no merge, and for a master no gate or landing rules; a code thread lists what it did', () => {
    expect(Object.keys(toolsOf(code))).toContain('merge_branch')
    expect(Object.keys(toolsOf(work))).not.toContain('merge_branch')
    expect(Object.keys(toolsOf(chat))).not.toContain('merge_branch')
    const names = (s: SessionMeta): string[] => Object.keys(toolsOf(s)).sort()
    // nothing else differs
    expect(names(work)).toEqual(names(code).filter((n) => n !== 'merge_branch'))
    registry.setMaster(work.id, true)
    registry.setMaster(code.id, true)
    const batch = ['batch_gate', 'batch_rules', 'adopt_thread', 'archive_threads']
    expect(batch.filter((n) => names(registry.get(code.id)!).includes(n))).toEqual(batch)
    expect(batch.filter((n) => names(registry.get(work.id)!).includes(n))).toEqual(['adopt_thread', 'archive_threads'])
  })

  it('a Work thread tells its bridge so; a code thread\'s bridge env is what it was, with its own app token', () => {
    setAppBridge({ port: 1, scriptPath: '/b.mjs', command: 'node', env: {} })
    const env = (id: string): Record<string, string> => (bridgeMcpConfig(id) as { env: Record<string, string> }).env
    expect(env(work.id).TEMP_CODE_SCOPE).toBe('work')
    expect(env(code.id)).toEqual({ TEMP_CODE_PORT: '1', TEMP_CODE_SESSION: code.id, TEMP_CODE_APP_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
  })
})

describe('add-ons from a Work thread', () => {
  it('are added and removed in its own workspace\'s scope only', async () => {
    expect(await call(work, 'addon_add', { name: 'weather', transport: 'http', url: 'https://x', scope: 'global' })).toBe(WORK_ADDON_REFUSAL)
    expect(await call(work, 'addon_remove', { name: 'lifeos', scope: 'global' })).toBe(WORK_ADDON_REFUSAL)
    expect(addonCalls).toEqual([])
    // with no scope named, a remove would fall back to a global row of that name: it is held to the workspace
    expect(await call(work, 'addon_remove', { name: 'lifeos' })).toBe('removed')
    expect(await call(work, 'addon_add', { name: 'weather', transport: 'http', url: 'https://x' })).toBe('added')
    expect(addonCalls).toEqual([
      { what: 'remove', caller: work.id, args: { name: 'lifeos', scope: 'workspace' } },
      { what: 'add', caller: work.id, args: { name: 'weather', transport: 'http', url: 'https://x', scope: 'workspace' } }
    ])
  })

  it('a code thread adds and removes as before, its arguments untouched', async () => {
    await call(code, 'addon_remove', { name: 'lifeos', scope: 'global' })
    await call(code, 'addon_remove', { name: 'lifeos' })
    await call(code, 'addon_add', { name: 'weather', transport: 'http', url: 'https://x', scope: 'global' })
    expect(addonCalls.map((c) => c.args)).toEqual([{ name: 'lifeos', scope: 'global' }, { name: 'lifeos' }, { name: 'weather', transport: 'http', url: 'https://x', scope: 'global' }])
  })

  it('a Work row reads no add-on at all on a host where Work\'s rule is not there to scope it', () => {
    // Work's mount did not come up (work/load.ts gives an inert Work): nothing configured the scope
    configureAddonScope(null)
    const rows = [
      { id: 'g', name: 'lifeos-own', workspaceId: null },
      { id: 'w', name: 'lifeos', workspaceId: purdueId }
    ]
    const seen = (s: SessionMeta): string[] => visibleAddons({ list: () => rows as never, status: () => ({}), tools: () => null }, workspaceIdOf(registry, s)).map((r) => r.id)
    expect(workspaceIdOf(registry, work)).toBe(WORK_UNSCOPED)
    expect(seen(work)).toEqual([])
    expect(seen(chat)).toEqual([])
    // a code thread reads by the code rule, configured or not
    expect(seen(code)).toEqual(['g'])
  })
})

describe('skills from a Work thread', () => {
  it('skill_remove is refused for every workspace, and for a Work Chat; in its own workspace it goes on to the store', async () => {
    expect(await call(work, 'skill_remove', { name: 'x', scope: 'global' })).toBe(WORK_SKILL_REFUSAL)
    expect(await call(chat, 'skill_remove', { name: 'x' })).toBe(WORK_SKILL_REFUSAL)
    expect(skillCalls).toEqual([])
    expect(await call(work, 'skill_remove', { name: 'x' })).toMatch(/^refused: no skill x in ws/)
    expect(skillCalls).toEqual([{ what: 'lookup', scope: purdueId }, { what: 'lookup', scope: null }])
    // a code thread removes from every workspace as before
    skillCalls.length = 0
    expect(await call(code, 'skill_remove', { name: 'x', scope: 'global' })).toMatch(/^refused: no skill x in every workspace/)
    expect(skillCalls[0]).toEqual({ what: 'lookup', scope: null })
  })
})

describe('the calls to another host, guarded where the host hands them to the tools', () => {
  it('holds a Work thread to the rule with no Work mount at all', async () => {
    const reached: string[] = []
    const agents = {
      children: () => [],
      startThread: async () => (reached.push('start'), {}),
      spawn: async () => (reached.push('spawn'), []),
      adopt: async () => (reached.push('adopt'), { adopted: [], refused: [] })
    }
    setCrossHostAgents(agents as never)
    await expect((agents.spawn as (...a: unknown[]) => Promise<unknown>).call(agents, work, 'mac', [])).rejects.toThrow(/on its own host/)
    await expect((agents.startThread as (...a: unknown[]) => Promise<unknown>).call(agents, work, 'mac', {})).rejects.toThrow(/only as a Work thread/)
    await (agents.spawn as (...a: unknown[]) => Promise<unknown>).call(agents, code, 'mac', [])
    expect(reached).toEqual(['spawn'])
  })
})
