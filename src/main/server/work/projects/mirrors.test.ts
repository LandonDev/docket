import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { cancelMirrors } from '../../mirror'
import { openDb, Store } from '../../db'
import { SessionRegistry } from '../../sessions'
import { startWork, type Work } from '../ctx'
import { lifeosSeamsFor } from '../lifeos/ctx'
import { memoryDeviceToken } from '../lifeos/deviceToken'
import { FakeLifeos } from '../lifeos/fakeLifeos'
import { lifeos } from '../lifeos/index'
import type { WorkCtx } from '../modules'
import { clearCodeSettings, followMirrors, mirrorMoves, type LifeosProject, type MirrorHost } from './mirrors'

const mirror = (id: string, lifeosProjectId: string, name: string, archived = false): ProjectMeta =>
  ({ id, workspaceId: 'ws', name, mode: 'local', branch: null, cwd: '/w', archived, lifeosProjectId, createdAt: 1 }) as ProjectMeta
const row = (_id: string, name: string, status = 'active'): LifeosProject => ({ _id, name, status })
const idle = (): boolean => false

describe('what a sector\'s list asks of its mirrors', () => {
  it('renames a mirror whose project was renamed, and leaves one that matches alone', () => {
    const moves = mirrorMoves([row('lp_1', 'Fall LAN'), row('lp_2', 'Nationals')], [mirror('p1', 'lp_1', 'Spring LAN'), mirror('p2', 'lp_2', 'Nationals')], idle)
    expect(moves).toEqual({ rename: [{ id: 'p1', name: 'Fall LAN' }], archive: [], restore: [] })
  })

  it('archives the mirror of a project that is done, dropped or gone', () => {
    const mirrors = [mirror('p1', 'lp_1', 'A'), mirror('p2', 'lp_2', 'B'), mirror('p3', 'lp_3', 'C'), mirror('p4', 'lp_4', 'D')]
    const moves = mirrorMoves([row('lp_1', 'A', 'done'), row('lp_2', 'B', 'dropped'), row('lp_4', 'D', 'paused')], mirrors, idle)
    expect(moves.archive).toEqual(['p1', 'p2', 'p3'])
    expect(moves.restore).toEqual([])
  })

  it('never archives a mirror while one of its threads works, and does once it rests', () => {
    const mirrors = [mirror('p1', 'lp_1', 'A'), mirror('p2', 'lp_2', 'B')]
    const rows = [row('lp_1', 'A', 'done')]
    expect(mirrorMoves(rows, mirrors, (id) => id === 'p1').archive).toEqual(['p2'])
    expect(mirrorMoves(rows, mirrors, idle).archive).toEqual(['p1', 'p2'])
  })

  it('brings back the mirror of a project that was reopened, and renames it in the same pass', () => {
    const moves = mirrorMoves([row('lp_1', 'Spring LAN 2', 'active')], [mirror('p1', 'lp_1', 'Spring LAN', true)], idle)
    expect(moves).toEqual({ rename: [{ id: 'p1', name: 'Spring LAN 2' }], archive: [], restore: ['p1'] })
  })

  it('leaves a project that mirrors nothing, and a blank name, alone', () => {
    const plain = { ...mirror('p9', '', 'Notes'), lifeosProjectId: undefined } as ProjectMeta
    expect(mirrorMoves([row('lp_1', '   ')], [plain, mirror('p1', 'lp_1', 'Spring LAN')], idle)).toEqual({ rename: [], archive: [], restore: [] })
  })
})

describe('the code settings a Work project was given before the server refused them', () => {
  it('are cleared for projects of Work workspaces only, each held override once, and a second pass writes nothing', () => {
    const held = new Map<string, Set<string>>([
      ['p1', new Set(['turnPass', 'review'])],
      ['p2', new Set()],
      ['code', new Set(['turnPass', 'build', 'plans'])]
    ])
    const cleared: string[] = []
    const host = {
      workspaces: () => [{ id: 'ws', name: 'Purdue', kind: 'work', sector: 'purdue' }, { id: 'repo', name: 'repo' }] as WorkspaceMeta[],
      projects: () => [mirror('p1', 'lp_1', 'A'), mirror('p2', 'lp_2', 'B'), { ...mirror('code', '', 'Alpha'), workspaceId: 'repo' }],
      overrides: (p: ProjectMeta) =>
        ['turnPass', 'build', 'review', 'plans', 'startOn'].map((key) => ({
          held: held.get(p.id)!.has(key),
          clear: () => {
            held.get(p.id)!.delete(key)
            cleared.push(`${p.id}.${key}`)
          }
        }))
    }
    expect(clearCodeSettings(host)).toBe(1)
    expect(cleared).toEqual(['p1.turnPass', 'p1.review'])
    expect([...held.get('code')!]).toEqual(['turnPass', 'build', 'plans'])
    expect(clearCodeSettings(host)).toBe(0)
    expect(cleared).toHaveLength(2)
  })
})

describe('the follower, on a host that stands in', () => {
  /** A LifeOS whose lists a test sets by hand, and a host that records what it was asked. */
  function rig(workspaces: Partial<WorkspaceMeta>[], projects: ProjectMeta[]) {
    const subs = new Map<string, (rows: LifeosProject[]) => void>()
    const stopped: string[] = []
    const lifeos = {
      subscribe: (_fn: string, args: unknown, on: (rows: LifeosProject[]) => void) => {
        const sector = (args as { sector: string }).sector
        subs.set(sector, on)
        return () => void (subs.delete(sector), stopped.push(sector))
      }
    } as unknown as WorkCtx['lifeos']
    const busy = new Set<string>()
    const catalog = new Set<(kind: 'workspaces' | 'projects') => void>()
    const meta = new Set<(session: SessionMeta) => void>()
    const asked: string[] = []
    const host: MirrorHost = {
      workspaces: () => workspaces as WorkspaceMeta[],
      projects: () => projects,
      busy: (id) => busy.has(id),
      rename: (id, name) => {
        asked.push(`rename ${id} ${name}`)
        projects.find((p) => p.id === id)!.name = name
        for (const fn of catalog) fn('projects')
      },
      archive: async (id, archived) => {
        asked.push(`${archived ? 'archive' : 'restore'} ${id}`)
        projects.find((p) => p.id === id)!.archived = archived
        for (const fn of catalog) fn('projects')
      },
      onCatalog: (fn) => (catalog.add(fn), () => void catalog.delete(fn)),
      onMeta: (fn) => (meta.add(fn), () => void meta.delete(fn))
    }
    const stop = followMirrors({ lifeos, log: () => {} }, host)
    return {
      asked,
      busy,
      stopped,
      stop,
      sectors: () => [...subs.keys()].sort(),
      list: (sector: string, rows: LifeosProject[]) => subs.get(sector)?.(rows),
      catalog: (kind: 'workspaces' | 'projects') => [...catalog].forEach((fn) => fn(kind)),
      rest: (id: string, projectId: string, status: SessionMeta['status']) => [...meta].forEach((fn) => fn({ id, projectId, status } as SessionMeta))
    }
  }
  const work = (id: string, sector: string | null): Partial<WorkspaceMeta> => ({ id, name: id, kind: 'work', sector })

  it('watches one list a linked Work workspace, and no code or unlinked one', () => {
    const r = rig([work('ws', 'purdue'), work('side', null), { id: 'repo', name: 'repo', sector: 'cosmic' }], [])
    expect(r.sectors()).toEqual(['purdue'])
    r.stop()
    expect(r.stopped).toEqual(['purdue'])
  })

  it('moves nothing until a list has answered', () => {
    const r = rig([work('ws', 'purdue')], [mirror('p1', 'lp_1', 'Spring LAN')])
    r.catalog('projects')
    r.rest('t1', 'p1', 'idle')
    expect(r.asked).toEqual([])
  })

  it('renames, archives and brings back as the list changes, each move once', () => {
    const r = rig([work('ws', 'purdue')], [mirror('p1', 'lp_1', 'Spring LAN')])
    r.list('purdue', [row('lp_1', 'Fall LAN')])
    r.list('purdue', [row('lp_1', 'Fall LAN', 'done')])
    r.list('purdue', [row('lp_1', 'Fall LAN', 'done')])
    r.list('purdue', [row('lp_1', 'Fall LAN', 'active')])
    r.list('purdue', [])
    expect(r.asked).toEqual(['rename p1 Fall LAN', 'archive p1', 'restore p1', 'archive p1'])
  })

  it('leaves the mirror of a finished project while a thread of it works, and archives it when that thread rests', () => {
    const r = rig([work('ws', 'purdue')], [mirror('p1', 'lp_1', 'Spring LAN')])
    r.busy.add('p1')
    r.rest('t1', 'p1', 'running')
    r.list('purdue', [row('lp_1', 'Spring LAN', 'done')])
    expect(r.asked).toEqual([])
    // Still at work: a second report of the same state asks nothing.
    r.rest('t1', 'p1', 'running')
    expect(r.asked).toEqual([])
    r.busy.delete('p1')
    r.rest('t1', 'p1', 'idle')
    expect(r.asked).toEqual(['archive p1'])
  })

  it('names a mirror made after the list answered', () => {
    const projects: ProjectMeta[] = []
    const r = rig([work('ws', 'purdue')], projects)
    r.list('purdue', [row('lp_1', 'Fall LAN')])
    projects.push(mirror('p1', 'lp_1', 'Spring LAN'))
    r.catalog('projects')
    expect(r.asked).toEqual(['rename p1 Fall LAN'])
  })

  it('takes up a workspace linked later and lets go of one that left', () => {
    const workspaces = [work('ws', 'purdue')]
    const r = rig(workspaces, [])
    workspaces.push(work('life', 'life'))
    r.catalog('workspaces')
    expect(r.sectors()).toEqual(['life', 'purdue'])
    workspaces.shift()
    r.catalog('workspaces')
    expect(r.sectors()).toEqual(['life'])
    expect(r.stopped).toEqual(['purdue'])
  })
})

describe('the follower, on the real registry and a LifeOS in memory', () => {
  let root: string
  let db: ReturnType<typeof openDb>
  let store: Store
  let registry: SessionRegistry
  let work: Work
  let fake: FakeLifeos
  const LIFEOS = 'https://lifeos.test'
  const until = async (test: () => boolean): Promise<void> => {
    const end = Date.now() + 3_000
    while (!test()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  const mirrorOf = (lifeosProjectId: string): ProjectMeta | undefined => store.listProjects().find((p) => p.lifeosProjectId === lifeosProjectId)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tc-work-mirrors-'))
    db = openDb(join(root, 'test.db'))
    store = new Store(db)
    store.setSetting('workspace.root', root)
    registry = new SessionRegistry(store)
    fake = new FakeLifeos()
    fake.projects = [{ _id: 'lp_1', name: 'Spring LAN', status: 'active', sector: 'purdue' }]
    lifeosSeamsFor.current = { transport: fake, tokens: memoryDeviceToken({ v: 1, token: fake.device(), url: LIFEOS, at: 1 }), address: { url: LIFEOS, mcpUrl: `${LIFEOS}/mcp` }, hostName: 'box' }
    work = startWork({ db, store, registry, environmentId: 'env_test', dataDir: root, log: () => {} }, [lifeos])
    lifeosSeamsFor.current = null
  })
  afterEach(async () => {
    work.close()
    cancelMirrors()
    await registry.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('follows a rename, a finish, a reopen and a delete in LifeOS', async () => {
    work.settings.set({ enabled: true })
    await until(() => work.ctx.lifeos.connected())
    const path = join(root, 'Work', 'Purdue')
    mkdirSync(path, { recursive: true })
    // Made after the follower started: the catalog tells it of the new workspace.
    const workspace = await registry.createWorkspace(path, 'Purdue', { kind: 'work', sector: 'purdue' })
    const answer = await work.handle({ id: '1', method: 'work.project.open', params: { workspaceId: workspace.id, lifeosProjectId: 'lp_1' } } as never, { kind: 'local' } as never)
    expect(answer.handled && (answer.result as ProjectMeta).name).toBe('Spring LAN')

    fake.setProjects([{ _id: 'lp_1', name: 'Fall LAN', status: 'active', sector: 'purdue' }])
    await until(() => mirrorOf('lp_1')?.name === 'Fall LAN')

    fake.setProjects([{ _id: 'lp_1', name: 'Fall LAN', status: 'done', sector: 'purdue' }])
    await until(() => mirrorOf('lp_1')?.archived === true)

    fake.setProjects([{ _id: 'lp_1', name: 'Fall LAN', status: 'active', sector: 'purdue' }])
    await until(() => mirrorOf('lp_1')?.archived === false)

    fake.setProjects([])
    await until(() => mirrorOf('lp_1')?.archived === true)
    // Archived, never deleted: its threads stay.
    expect(mirrorOf('lp_1')?.name).toBe('Fall LAN')
  })

  it('clears a Work project of code settings it was given earlier, when Work starts', async () => {
    work.settings.set({ enabled: true })
    await until(() => work.ctx.lifeos.connected())
    const path = join(root, 'Work', 'Purdue')
    mkdirSync(path, { recursive: true })
    const workspace = await registry.createWorkspace(path, 'Purdue', { kind: 'work', sector: 'purdue' })
    const project = await registry.createProject(workspace.id, 'Spring LAN', 'local', { lifeosProjectId: 'lp_1' })
    registry.setProjectTurnPass(project.id, { verify: true, build: false, commit: 'off' } as never)
    registry.setProjectBuild(project.id, { command: 'bun run build', outputs: '' })
    expect(registry.getProjectTurnPass(project.id)).not.toBeNull()
    work.settings.set({ enabled: false })
    work.settings.set({ enabled: true })
    expect(registry.getProjectTurnPass(project.id)).toBeNull()
    expect(registry.getProjectBuild(project.id)).toBeNull()
  })
})
