import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerPush } from '@shared/contract'
import { WORKSPACE_NAME_MAX } from '@shared/domain'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { PROJECT_SETTINGS_DEBOUNCE_MS, ProjectSettingsSync, refusal } from './projectSettingsSync'

// One workspace on two hosts: the Mac and the box (the settings home), each
// with its own database, registry and ProjectSettingsSync, joined by an
// in-memory link. A `workspaces` push from either registry reaches that
// host's windows; the box's also reaches the phone and, while the link is up,
// the Mac's sync.

const MAC = 'env_mac'
const BOX = 'env_box'
const WS_LINK = 'wl_temp'

interface Host {
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  sync: ProjectSettingsSync
  /** the name each `workspaces` push carried, as this host's windows saw it */
  windows: string[]
}

let mac: Host
let box: Host
let phone: string[]
let link: {
  id: string
  env: { id: string; name: string }
  connected: boolean
  build: { platform: string; headless?: boolean } | null
  request: <T>(method: string, params?: unknown) => Promise<T>
}

function host(id: string, path: string, peers: () => unknown[], platform: string, headless: boolean): Host {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: `w-${id}`, name: 'temp-code', path, git: true, createdAt: 1 })
  store.setWorkspaceLink(`w-${id}`, WS_LINK)
  const registry = new SessionRegistry(store)
  const sync = new ProjectSettingsSync({
    environmentId: id,
    platform,
    headless,
    registry,
    store,
    peers: { get: (p: string) => peers().find((l: any) => l.id === p), all: peers } as never,
    log: () => {}
  })
  return { db, store, registry, sync, windows: [] }
}

const nameOf = (h: Host): string | undefined => h.registry.listWorkspaces()[0]?.name
const pushName = (p: ServerPush): string => (p.push === 'workspaces' ? p.workspaces[0]!.name : '')

beforeEach(() => {
  phone = []
  box = host(BOX, '/srv/agents/work/temp-code', () => [], 'linux', true)
  link = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    build: { platform: 'linux', headless: true },
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      const p = (params ?? {}) as Record<string, any>
      if (method === 'project.list') return box.registry.listProjects() as T
      if (method === 'workspace.list') return box.registry.listWorkspaces() as T
      // The box's own handler: its sync renames it there, the home.
      if (method === 'workspace.rename') return (await box.sync.renameWorkspace(p.workspaceId, p.name)) as T
      throw new Error(`unexpected ${method}`)
    }
  }
  mac = host(MAC, '/Users/me/IdeaProjects/temp-code', () => [link], 'darwin', false)
  box.registry.onCatalog((kind) => {
    if (kind !== 'workspaces') return
    const push: ServerPush = { push: 'workspaces', workspaces: box.registry.listWorkspaces() }
    box.windows.push(pushName(push))
    phone.push(pushName(push))
    if (link.connected) mac.sync.onPeerPush(BOX, push)
  })
  mac.registry.onCatalog((kind) => kind === 'workspaces' && mac.windows.push(nameOf(mac)!))
})

afterEach(() => {
  mac.sync.close()
  box.sync.close()
  mac.db.close()
  box.db.close()
  vi.useRealTimers()
})

describe('a workspace rename across the pair', () => {
  it('a rename on the box reaches the box, the phone and, on its push, the Mac', async () => {
    vi.useFakeTimers()
    await box.sync.renameWorkspace('w-env_box', '  Docket  ')
    await vi.advanceTimersByTimeAsync(PROJECT_SETTINGS_DEBOUNCE_MS + 10)
    expect(nameOf(box)).toBe('Docket')
    expect(nameOf(mac)).toBe('Docket')
    expect(box.windows).toEqual(['Docket'])
    expect(phone).toEqual(['Docket'])
    expect(mac.windows).toEqual(['Docket'])
    // The path and the folder stay as they were.
    expect(box.registry.listWorkspaces()[0]!.path).toBe('/srv/agents/work/temp-code')
    expect(mac.registry.listWorkspaces()[0]!.path).toBe('/Users/me/IdeaProjects/temp-code')
  })

  it('a rename on the Mac is written on the box first, and both read it after the one call', async () => {
    await mac.sync.syncWith(BOX)
    await mac.sync.renameWorkspace('w-env_mac', 'Docket')
    expect(nameOf(box)).toBe('Docket')
    expect(nameOf(mac)).toBe('Docket')
    expect(phone).toEqual(['Docket'])
    expect(mac.windows).toEqual(['Docket'])
  })

  it('the home\'s name wins over the Mac\'s own', async () => {
    mac.registry.renameWorkspace('w-env_mac', 'Mine')
    await mac.sync.syncWith(BOX)
    expect(nameOf(mac)).toBe('temp-code')
  })

  it('a Mac that was offline catches up when it links again', async () => {
    vi.useFakeTimers()
    await mac.sync.syncWith(BOX)
    link.connected = false
    await box.sync.renameWorkspace('w-env_box', 'Docket')
    expect(nameOf(mac)).toBe('temp-code')
    link.connected = true
    mac.sync.linkUp(BOX)
    await vi.advanceTimersByTimeAsync(PROJECT_SETTINGS_DEBOUNCE_MS + 10)
    expect(nameOf(mac)).toBe('Docket')
  })

  it('with the box out of reach the Mac refuses, and nothing is written; a cold Mac still knows the box is the home', async () => {
    await mac.sync.syncWith(BOX)
    link.connected = false
    await expect(mac.sync.renameWorkspace('w-env_mac', 'Docket')).rejects.toThrow(refusal('temp-code', 'box'))
    expect(nameOf(mac)).toBe('temp-code')
    expect(nameOf(box)).toBe('temp-code')
    link.build = null
    const cold = new ProjectSettingsSync({
      environmentId: MAC,
      platform: 'darwin',
      registry: mac.registry,
      store: mac.store,
      peers: { get: () => link, all: () => [link] } as never,
      log: () => {}
    })
    await expect(cold.renameWorkspace('w-env_mac', 'Docket')).rejects.toThrow(refusal('temp-code', 'box'))
  })

  it('an unlinked workspace is renamed here alone', async () => {
    mac.store.setWorkspaceLink('w-env_mac', null)
    await mac.sync.syncWith(BOX)
    await mac.sync.renameWorkspace('w-env_mac', 'Mine')
    expect(nameOf(mac)).toBe('Mine')
    expect(nameOf(box)).toBe('temp-code')
  })
})

describe('SessionRegistry.renameWorkspace', () => {
  it('trims, refuses an empty, over-long or unknown name, and pushes only a change', () => {
    expect(() => box.registry.renameWorkspace('w-env_box', '   ')).toThrow('refused: a workspace needs a name')
    expect(() => box.registry.renameWorkspace('w-env_box', 'x'.repeat(WORKSPACE_NAME_MAX + 1))).toThrow(
      `refused: a workspace name is at most ${WORKSPACE_NAME_MAX} characters`
    )
    expect(() => box.registry.renameWorkspace('w-none', 'Docket')).toThrow('unknown workspace: w-none')
    box.registry.renameWorkspace('w-env_box', ' temp-code ')
    expect(box.windows).toEqual([])
    box.registry.renameWorkspace('w-env_box', 'x'.repeat(WORKSPACE_NAME_MAX))
    expect(box.windows).toEqual(['x'.repeat(WORKSPACE_NAME_MAX)])
  })
})
