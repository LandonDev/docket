import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextChip } from '@shared/work'
import { WORK_HOME, WORK_SETTING_KEY } from '@shared/work'
import { openDb, Store } from '../../db'
import type { DriverCtx, DriverHandle } from '../../drivers/types'
import { cancelMirrors } from '../../mirror'
import { SessionRegistry } from '../../sessions'
import { startWork, type Work } from '../ctx'
import { lifeosSeamsFor } from '../lifeos/ctx'
import { memoryDeviceToken } from '../lifeos/deviceToken'
import { FakeLifeos } from '../lifeos/fakeLifeos'
import { lifeos } from '../lifeos/index'
import { fileUnder } from './mirrors'

/**
 * A thread the host starts (Capture, a play, a nudge) files under the
 * project of the LifeOS task it is about, as a window's Start thread does: the
 * project's mirror, made the first time. A finished project, or one LifeOS
 * does not answer for, starts it loose in the job and says why; it never
 * holds the start.
 */

vi.mock('../../drivers', () => {
  const fake = (id: string) => ({
    id,
    start: async (_ctx: DriverCtx): Promise<DriverHandle> => ({
      confirmsSteers: true,
      send: async () => {},
      interrupt: () => {},
      alive: () => true,
      dispose: async () => {}
    })
  })
  return { BUILT_IN_DRIVERS: { claude: fake('claude'), codex: fake('codex') } }
})

const LIFEOS = 'https://lifeos.test'
let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let work: Work
let fake: FakeLifeos

const task = (id: string): ContextChip => ({ kind: 'task', label: id, ref: { at: 'lifeos', table: 'tasks', id } })

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-filing-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  store.setSetting('workspace.root', root)
  store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: true }))
  registry = new SessionRegistry(store)
  registry.setThreadDefaults(null, { provider: 'claude', model: '', reasoning: 'medium', permission: 'edits' })
  fake = new FakeLifeos()
  fake.projects = [
    { _id: 'lp_lan', name: 'Spring LAN', status: 'active', sector: 'purdue' },
    { _id: 'lp_old', name: 'Fall LAN', status: 'done', sector: 'purdue' },
    { _id: 'lp_far', name: 'Loot tables', status: 'active', sector: 'cosmic' }
  ]
  fake.tasks.set('t_lan', { sector: 'purdue', projectId: 'lp_lan' })
  fake.tasks.set('t_old', { sector: 'purdue', projectId: 'lp_old' })
  fake.tasks.set('t_loose', { sector: 'purdue' })
  lifeosSeamsFor.current = { transport: fake, tokens: memoryDeviceToken({ v: 1, token: fake.device(), url: LIFEOS, at: 1 }), address: { url: LIFEOS, mcpUrl: `${LIFEOS}/mcp` }, hostName: 'box', session: { retryMs: [20] } }
  work = startWork({ db, store, registry, environmentId: 'env_test', dataDir: root, log: () => {} }, [lifeos])
  lifeosSeamsFor.current = null
  work.settings.set({ enabled: false })
  work.settings.set({ enabled: true })
  const end = Date.now() + 3_000
  while (!work.ctx.lifeos.connected()) {
    if (Date.now() > end) throw new Error('LifeOS did not connect')
    await new Promise((r) => setTimeout(r, 5))
  }
})
afterEach(async () => {
  work.close()
  cancelMirrors()
  await registry.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const purdue = async (): Promise<string> => {
  const path = join(root, 'Work', 'Purdue')
  mkdirSync(path, { recursive: true })
  return (await registry.createWorkspace(path, 'Purdue', { kind: 'work', sector: 'purdue' })).id
}
const mirrorOf = (lifeosProjectId: string) => store.listProjects().find((p) => p.lifeosProjectId === lifeosProjectId)

describe('a thread the host starts about a task', () => {
  it("files under the task's project, its mirror made once and named as LifeOS names it", async () => {
    const ws = await purdue()
    const first = registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'Book the hall.', about: task('t_lan') }))!
    const mirror = mirrorOf('lp_lan')!
    expect(mirror).toMatchObject({ workspaceId: ws, name: 'Spring LAN' })
    expect(first).toMatchObject({ scope: 'work', projectId: mirror.id })
    // a second thread about it finds the same mirror
    const second = registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'Order pizza.', about: task('t_lan') }))!
    expect(second.projectId).toBe(mirror.id)
    expect(store.listProjects().filter((p) => p.lifeosProjectId === 'lp_lan')).toHaveLength(1)
  })

  it('starts loose in the job, and says why, when the project is done', async () => {
    const ws = await purdue()
    const said: string[] = []
    const thread = registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'Write the recap.', about: task('t_old'), onLoose: (why) => said.push(why) }))!
    expect(thread).toMatchObject({ scope: 'work', workspaceId: ws, projectId: null })
    expect(said).toEqual(['Not filed in Fall LAN: it is done'])
    expect(mirrorOf('lp_old')).toBeUndefined()
  })

  it('starts loose, saying nothing, when the task has no project (a capture), and in Work Chats as before', async () => {
    const ws = await purdue()
    const onLoose = vi.fn()
    expect(registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'Call Sam.', about: task('t_loose'), onLoose }))).toMatchObject({ workspaceId: ws, projectId: null })
    expect(registry.get(await work.ctx.threads.start({ workspaceId: WORK_HOME, text: 'Unsorted.', about: task('t_lan'), onLoose }))).toMatchObject({ workspaceId: null, projectId: null })
    expect(onLoose).not.toHaveBeenCalled()
    expect(store.listProjects()).toEqual([])
  })

  it("files a mail's thread under its task's project when the caller names it (a nudge), and a project it names stays", async () => {
    const ws = await purdue()
    const mail: ContextChip = { kind: 'mail', label: 'Hall booking', ref: { at: 'lifeos', table: 'mailThreads', id: 'm1' } }
    const nudge = registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'Nudge.', about: mail, lifeosProjectId: 'lp_lan' }))!
    expect(nudge.projectId).toBe(mirrorOf('lp_lan')!.id)
    const own = await registry.createProject(ws, 'Mine', 'local')
    expect(registry.get(await work.ctx.threads.start({ workspaceId: ws, projectId: own.id, text: 'r', about: task('t_lan') }))!.projectId).toBe(own.id)
  })

  it("never files under another sector's project, and LifeOS out of reach never holds the start", async () => {
    const ws = await purdue()
    const said: string[] = []
    expect(registry.get(await work.ctx.threads.start({ workspaceId: ws, text: 'x', lifeosProjectId: 'lp_far', onLoose: (why) => said.push(why) }))!.projectId).toBeNull()
    expect(said).toEqual(["Not filed in its project: LifeOS has no such project in Purdue's sector"])
    const workspace = registry.listWorkspaces().find((w) => w.id === ws)!
    const silent = { lifeos: { ...work.ctx.lifeos, owner: () => ({ query: () => new Promise(() => {}), mutation: () => new Promise(() => {}) }) } } as never
    expect(await fileUnder(silent, registry, workspace, { taskId: 't_lan' }, 20)).toEqual({ projectId: null, why: 'Not filed in its project: LifeOS did not answer' })
  })
})
