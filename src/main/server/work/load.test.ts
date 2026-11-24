import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { PILLAR_IDS, PILLAR_MILESTONE } from '@shared/work'
import { openDb, Store } from '../db'
import type { SessionRegistry } from '../sessions'
import type { WorkModule } from './modules'

// A pillar whose code cannot even be loaded on this machine, the way a missing native library fails an import.
vi.mock('./frameio', () => {
  throw new Error('libframeio.so: cannot open shared object file')
})

/**
 * No pillar is imported by importing the registry: each is loaded behind its
 * own guard, so one that throws while it loads is left out and named, and
 * neither the host nor the other pillars hear of it.
 */

let dir: string
let db: ReturnType<typeof openDb>
let said: ReturnType<typeof vi.spyOn>
const deps = () => ({ db, store: new Store(db), registry: { get: () => null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} })
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'tc-work-load-'))
  db = openDb(join(dir, 'test.db'))
  said = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the registry', () => {
  it('holds no pillar until it is loaded, and startWork refuses the default list before that instead of running with none', async () => {
    const { WORK_MODULES } = await import('./modules')
    const { startWork } = await import('./ctx')
    expect(WORK_MODULES).toEqual([])
    expect(() => startWork(deps())).toThrow('work: the pillars are not loaded; await loadWorkModules()')
    // a list the caller passes is the caller's own: nothing to load
    const work = startWork(deps(), [])
    work.close()
  })

  it('a pillar that throws while it loads is left out and named; every other pillar loads, in order', async () => {
    const { WORK_MODULES, WORK_LOAD_FAULTS, loadWorkModules } = await import('./modules')
    const failed = await loadWorkModules()
    expect([...failed.keys()]).toEqual(['frameio'])
    expect(failed.get('frameio')).toMatch(/^work: frameio did not load: /)
    expect(failed.get('frameio')).toContain('libframeio.so: cannot open shared object file')
    expect(WORK_MODULES.map((m) => m.id)).toEqual(PILLAR_IDS.filter((id) => id !== 'frameio'))
    expect([...WORK_LOAD_FAULTS.keys()]).toEqual(['frameio'])
    expect(said.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^\[work\] work: frameio did not load: /)])
    // once per process: asked again, the same answer and no second load
    expect(await loadWorkModules()).toEqual(failed)
    expect(said).toHaveBeenCalledTimes(1)
  })

  it("the host starts with the pillars that loaded, and the one that did not answers why instead of 'not built'", async () => {
    const { loadWorkModules } = await import('./modules')
    const { startWork } = await import('./ctx')
    await loadWorkModules()
    const work = startWork(deps())
    work.settings.set({ enabled: true })
    await expect(work.handle(req('work.frameio.list', {}), LOCAL_PRINCIPAL)).rejects.toThrow(/^work: frameio did not load: .*libframeio\.so/)
    await expect(work.handle(req('work.mail.list', {}), LOCAL_PRINCIPAL)).rejects.toThrow(`not built: work.mail.list (milestone ${PILLAR_MILESTONE.mail})`)
    expect(await work.handle(req('work.get'), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { enabled: true } })
    work.close()
  })

  it('a loader that answers something that is not its pillar is left out too', async () => {
    const { PILLAR_LOADERS, WORK_MODULES, loadWorkModules } = await import('./modules')
    const mail: WorkModule = { id: 'mail', ensure() {} }
    const failed = await loadWorkModules({
      ...PILLAR_LOADERS,
      frameio: async () => ({ id: 'frameio', ensure() {} }),
      tasks: async () => mail,
      agenda: async () => ({}) as WorkModule,
      docs: () => Promise.reject(new Error('boom'))
    })
    expect(Object.fromEntries(failed)).toEqual({
      tasks: "work: tasks did not load: its module is not the tasks pillar's",
      agenda: "work: agenda did not load: its module is not the agenda pillar's",
      docs: 'work: docs did not load: boom'
    })
    expect(WORK_MODULES.map((m) => m.id)).toEqual(PILLAR_IDS.filter((id) => !['tasks', 'agenda', 'docs'].includes(id)))
  })

  it('loads one pillar at a time, so two pillars that import each other never wait on each other', async () => {
    const { loadWorkModules } = await import('./modules')
    let open = 0
    let most = 0
    const loaders = Object.fromEntries(
      PILLAR_IDS.map((id) => [
        id,
        async () => {
          most = Math.max(most, ++open)
          await new Promise((r) => setTimeout(r, 1))
          open--
          return { id, ensure() {} } as WorkModule
        }
      ])
    ) as Parameters<typeof loadWorkModules>[0]
    expect((await loadWorkModules(loaders)).size).toBe(0)
    expect(most).toBe(1)
  })
})

describe('the host code around Work', () => {
  const source = (file: string): string => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8')
  /** The files under work/ a host file may load when it loads: the guarded door and the helper that imports nothing of Work. */
  const SAFE = ['./work/load', './work/toolInput']
  it('imports nothing of Work that could load a pillar: only types, the guarded loader and the input helper', () => {
    for (const file of ['index.ts', 'apptools.ts']) {
      const eager = [...source(file).matchAll(/^import (type )?[^\n]*? from '(\.\/work\/[^']+)'/gm)].filter((m) => !m[1] && !SAFE.includes(m[2])).map((m) => m[2])
      expect(eager, file).toEqual([])
    }
  })
  it('the registry, the loader and the helper import no pillar when they load', () => {
    for (const file of ['work/modules.ts', 'work/load.ts', 'work/toolInput.ts']) {
      const eager = [...source(file).matchAll(/^import (type )?[^\n]*? from '(\.[^']*)'/gm)].filter((m) => !m[1]).map((m) => m[2])
      expect(eager, file).toEqual([])
    }
    // the narrowing the app tools reach through orchestration.ts loads the registry alone, and asks loaded pillars inside a guard
    const narrowing = [...source('work/narrowing.ts').matchAll(/^import (type )?[^\n]*? from '(\.[^']*)'/gm)].filter((m) => !m[1]).map((m) => m[2])
    expect(narrowing).toEqual(['./modules'])
    // the registry re-exports the helper and names each pillar only inside its own loader
    expect(source('work/modules.ts')).toContain("export { inputShapeOf } from './toolInput'")
    for (const id of PILLAR_IDS) expect(source('work/modules.ts')).toContain(`${id}: () => import('./${id}').then((m) => m.${id})`)
  })
})
