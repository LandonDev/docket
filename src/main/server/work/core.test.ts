import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { ProjectMeta } from '@shared/domain'
import { WORK_SETTING_KEY } from '@shared/work'
import { cancelMirrors } from '../mirror'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { startWork, type Work } from './ctx'

/**
 * The core's own methods a screen needs (milestone 8): a workspace's Work
 * settings, the project that holds a Work workspace's threads about one
 * LifeOS project, and a sector link told to every client. On a real
 * registry and database; no pillar is loaded.
 */

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let work: Work
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const call = async <T>(method: string, params?: unknown): Promise<T> => {
  const answer = await work.handle(req(method, params), LOCAL_PRINCIPAL)
  if (!answer.handled) throw new Error(`not handled: ${method}`)
  return answer.result as T
}
const switchWork = (enabled: boolean): void => store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled }))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-core-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  store.setSetting('workspace.root', root)
  registry = new SessionRegistry(store)
  work = startWork({ db, store, registry, environmentId: 'env_test', dataDir: root, log: () => {} }, [])
  switchWork(true)
})
afterEach(async () => {
  work.close()
  cancelMirrors()
  await registry.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const workWorkspace = async (name: string, sector: string | null): Promise<string> => {
  const path = join(root, 'Work', name)
  mkdirSync(path, { recursive: true })
  return (await registry.createWorkspace(path, name, { kind: 'work', sector })).id
}

describe("a workspace's Work settings", () => {
  it('reads the defaults, keeps what a patch leaves out, and a null model goes back to the default', async () => {
    const id = await workWorkspace('Purdue', 'purdue')
    expect(await call('work.workspace.get', { workspaceId: id })).toEqual({ mayUseDesktop: [], voice: false })
    await call('work.workspace.set', { workspaceId: id, patch: { mayUseDesktop: ['mac'], model: 'claude-opus-5-5' } })
    expect(await call('work.workspace.set', { workspaceId: id, patch: { voice: true } })).toEqual({ mayUseDesktop: ['mac'], model: 'claude-opus-5-5', voice: true })
    expect(await call('work.workspace.set', { workspaceId: id, patch: { model: null } })).toEqual({ mayUseDesktop: ['mac'], voice: true })
    expect(JSON.parse(store.getWorkspaceWorkSettings(id) ?? '{}')).toEqual({ mayUseDesktop: ['mac'], voice: true })
  })

  it('refuses an unknown workspace, and a change while Work is off', async () => {
    const id = await workWorkspace('Purdue', 'purdue')
    await expect(call('work.workspace.get', { workspaceId: 'nope' })).rejects.toThrow('unknown workspace: nope')
    switchWork(false)
    await expect(call('work.workspace.set', { workspaceId: id, patch: { voice: true } })).rejects.toThrow('Work is off on this host')
  })
})

describe('a LifeOS project opened in a Work workspace', () => {
  it('is made once, in the workspace, marked with the LifeOS id, and told to clients', async () => {
    const id = await workWorkspace('Purdue', 'purdue')
    const pushes: string[] = []
    registry.onCatalog?.((kind) => void pushes.push(kind))
    const made = await call<ProjectMeta>('work.project.open', { workspaceId: id, lifeosProjectId: 'lp_1', name: 'Spring LAN' })
    expect(made).toMatchObject({ workspaceId: id, name: 'Spring LAN', mode: 'local', lifeosProjectId: 'lp_1' })
    expect(store.listProjects().find((p) => p.id === made.id)?.lifeosProjectId).toBe('lp_1')
    expect(pushes).toContain('projects')
    // the second ask finds it, whatever name it is asked with
    expect((await call<ProjectMeta>('work.project.open', { workspaceId: id, lifeosProjectId: 'lp_1', name: 'Renamed' })).id).toBe(made.id)
    expect(store.listProjects().filter((p) => p.lifeosProjectId === 'lp_1')).toHaveLength(1)
  })

  it('is refused in a code workspace and in an unlinked Work workspace', async () => {
    const code = join(root, 'repo')
    mkdirSync(code, { recursive: true })
    const codeId = (await registry.createWorkspace(code)).id
    const unlinked = await workWorkspace('Side', null)
    await expect(call('work.project.open', { workspaceId: codeId, lifeosProjectId: 'lp_1', name: 'x' })).rejects.toThrow('is not a Work workspace linked to LifeOS')
    await expect(call('work.project.open', { workspaceId: unlinked, lifeosProjectId: 'lp_1', name: 'x' })).rejects.toThrow('is not a Work workspace linked to LifeOS')
  })
})

describe("a workspace's sector", () => {
  it('reaches every client in the workspaces push', async () => {
    const code = join(root, 'repo')
    mkdirSync(code, { recursive: true })
    const codeId = (await registry.createWorkspace(code)).id
    const pushes: string[] = []
    registry.onCatalog?.((kind) => void pushes.push(kind))
    registry.setWorkspaceSector(codeId, 'cosmic')
    expect(pushes).toEqual(['workspaces'])
    expect(registry.listWorkspaces().find((w) => w.id === codeId)?.sector).toBe('cosmic')
  })
})
