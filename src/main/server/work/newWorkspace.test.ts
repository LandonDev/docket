import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { MAC_BRIDGE_OFFER } from '@shared/contract-macbridge'
import { WORK_SETTING_KEY } from '@shared/work'
import { cancelMirrors } from '../mirror'
import { openDb, Store } from '../db'
import type { PeerCalls } from '../remote/peerCalls'
import type { Peers } from '../remote/peers'
import { SessionRegistry } from '../sessions'
import { startWork, type Work } from './ctx'
import { office } from './office/index'
import { ownerDesktops } from './scope'

/**
 * A new Work workspace starts with things on (the owner's ruling, 2026-11-22): his desktops in
 * `mayUseDesktop`, the Windows VM on, and Teams files copied here. Each is stored when the workspace
 * is made, so turning one off stays off, and a workspace made before reads as it always did.
 */

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let work: Work
const by = { kind: 'local' as const, caps: [] }
const call = async <T>(method: string, params?: unknown): Promise<T> => {
  const answer = await work.handle({ id: '1', method, params } as ClientRequest, LOCAL_PRINCIPAL)
  if (!answer.handled) throw new Error(`not handled: ${method}`)
  return answer.result as T
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-new-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  store.setSetting('workspace.root', root)
  registry = new SessionRegistry(store)
  const peers = { all: () => [{ id: 'env_mac', env: { platform: 'darwin' }, build: null }, { id: 'env_pi', env: { platform: 'linux' }, build: null }] } as unknown as Peers
  const peerCalls = { registeredIds: (offer?: string) => (offer === MAC_BRIDGE_OFFER ? ['env_pc'] : []) } as unknown as PeerCalls
  work = startWork({ db, store, registry, environmentId: 'env_box', dataDir: root, peers, peerCalls, log: () => {} }, [office])
  store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: true }))
})
afterEach(async () => {
  work.close()
  cancelMirrors()
  await registry.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('ownerDesktops', () => {
  it('names this host when it is a Mac or a PC, each saved desktop and each host lending its desktop, once each', () => {
    expect(ownerDesktops({ id: 'box', platform: 'linux' }, [{ id: 'mac', platform: 'darwin' }, { id: 'pi', platform: 'linux' }, { id: 'old' }], ['mac', 'pc'])).toEqual(['mac', 'pc'])
    expect(ownerDesktops({ id: 'mac', platform: 'darwin' }, [{ id: 'win', platform: 'win32' }], [])).toEqual(['mac', 'win'])
  })
})

describe('a new Work workspace', () => {
  it('may use his desktops and the Windows VM from the start', async () => {
    const made = await work.createWorkspace({ name: 'Purdue', sector: 'purdue' }, by)
    const settings = work.settings.workspace(made.id)
    expect(settings.mayUseDesktop).toEqual(process.platform === 'darwin' || process.platform === 'win32' ? ['env_box', 'env_mac', 'env_pc'] : ['env_mac', 'env_pc'])
    expect(settings.windowsVm).toBe(true)
  })
  it('copies Teams files from his desktops from the start', async () => {
    const made = await work.createWorkspace({ name: 'Purdue', sector: 'purdue' }, by)
    expect(await call('work.office.filesCopyGet', { workspaceId: made.id })).toEqual({ on: true })
  })
  it('keeps each one he turns off', async () => {
    const made = await work.createWorkspace({ name: 'Purdue', sector: 'purdue' }, by)
    await call('work.workspace.set', { workspaceId: made.id, patch: { mayUseDesktop: [], windowsVm: false } })
    await call('work.office.filesCopySet', { workspaceId: made.id, on: false })
    expect(work.settings.workspace(made.id)).toMatchObject({ mayUseDesktop: [], windowsVm: false })
    expect(await call('work.office.filesCopyGet', { workspaceId: made.id })).toEqual({ on: false })
  })
  it('leaves a workspace made before as it reads: nothing stored is nothing on', async () => {
    const path = join(root, 'Old')
    mkdirSync(path)
    const old = await registry.createWorkspace(path, 'Old', { kind: 'work', sector: 'life' })
    expect(work.settings.workspace(old.id)).toMatchObject({ mayUseDesktop: [] })
    expect(work.settings.workspace(old.id).windowsVm).toBeUndefined()
    expect(await call('work.office.filesCopyGet', { workspaceId: old.id })).toEqual({ on: false })
  })
})
