import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { fileDocName } from 'work-kit/collab-server'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { startWork, type Work } from '../ctx'
import { memoryDeviceToken } from '../lifeos/deviceToken'
import { lifeosSeamsFor } from '../lifeos/ctx'
import { FakeLifeos } from '../lifeos/fakeLifeos'
import { WORK_OFF } from '../scope'
import { canonicalPath, serviceOf, serviceSeamsFor, ServedElsewhere } from './ctx'
import { startWorkService, type RunningService } from './serve'
import type { ServiceChild } from './supervisor'
import type { FromService, ToService } from './wire'

/*
 * `ctx.service` as the host builds it: the part forks the service inside
 * `deps.whileOn`, here into a stand-in child that runs the real service in
 * process (Electron's utility process is the only other way, and the proof
 * script runs that).
 */

interface Child extends ServiceChild {
  service(): RunningService | null
  /** the process dies: no stop, no flush */
  die(code?: number): void
}

function inProcess(spawned: Child[]): () => ServiceChild {
  return () => {
    const onMessage: ((m: FromService) => void)[] = []
    const onExit: ((code: number | null) => void)[] = []
    let running: RunningService | null = null
    let gone = false
    const emit = (m: FromService) => queueMicrotask(() => !gone && onMessage.forEach((f) => f(m)))
    const exit = (code: number | null) => {
      if (gone) return
      gone = true
      queueMicrotask(() => onExit.forEach((f) => f(code)))
    }
    const asked = new Map<number, (jwt: string) => void>()
    const held = new Map<string, Extract<ToService, { t: 'project' }>['project']>()
    let n = 0
    const child: Child = {
      post(m: ToService) {
        if (gone) throw new Error('the child is gone')
        if (m.t === 'config')
          startWorkService(m.config, {
            jwt: () => new Promise((resolve) => (asked.set(++n, resolve), emit({ t: 'jwt?', id: n }))),
            log: () => {}
          }).then(
            (s) => {
              running = s
              for (const [linkId, project] of held) s.setProject(linkId, project)
              held.clear()
              emit({ t: 'ready', port: s.port })
            },
            (err: Error) => (emit({ t: 'fault', message: err.message }), exit(1))
          )
        else if (m.t === 'jwt') asked.get(m.id)?.(m.jwt ?? '')
        else if (m.t === 'links') running?.setLinks(m.links)
        // As the real process does (workServiceProcess.ts): one that comes while it starts is kept for when it runs.
        else if (m.t === 'project') running ? running.setProject(m.linkId, m.project) : held.set(m.linkId, m.project)
        else if (m.t === 'stop') void running?.stop().then(() => (emit({ t: 'stopped' }), exit(0)))
      },
      onMessage: (f) => void onMessage.push(f),
      onExit: (f) => void onExit.push(f),
      kill() {
        void running?.stop().catch(() => {})
        exit(null)
      },
      service: () => running,
      die(code = 1) {
        // Its listeners close (the kernel would), and nothing is stored.
        const s = running
        running = null
        if (s) {
          s.collab.hocuspocus.configuration.onStoreDocument = async () => {}
          void s.stop().catch(() => {})
        }
        exit(code)
      }
    }
    spawned.push(child)
    return child
  }
}

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const opened: { dirs: string[]; works: Work[]; clients: CollaborationClient[] } = { dirs: [], works: [], clients: [] }

function host(id: string, spawned: Child[], env: NodeJS.ProcessEnv = {}, spawn?: () => ServiceChild): Work {
  const dir = mkdtempSync(join(tmpdir(), `m18-ctx-${id}-`))
  opened.dirs.push(dir)
  const db = openDb(join(dir, 'test.db'))
  const store = new Store(db)
  const registry = { get: () => null, listWorkspaces: () => store.listWorkspaces(), onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry
  lifeosSeamsFor.current = { transport: new FakeLifeos(), tokens: memoryDeviceToken(), address: { url: 'https://lifeos.test', mcpUrl: 'https://lifeos-mcp.test/mcp' }, hostName: id }
  serviceSeamsFor.current = { spawn: spawn ?? inProcess(spawned), hostedDir: join(dir, 'hosted'), backoffMs: 30, env: { TEMP_CODE_USER_DATA: dir, ...env } }
  const work = startWork({ db, store, registry, environmentId: id, dataDir: dir, log: () => {} }, [])
  lifeosSeamsFor.current = null
  serviceSeamsFor.current = null
  opened.works.push(work)
  return work
}

beforeEach(() => {
  opened.dirs = []
})
afterEach(async () => {
  await Promise.all(opened.clients.splice(0).map((c) => c.destroy()))
  for (const w of opened.works.splice(0)) {
    w.settings.set({ enabled: false })
    w.close()
  }
  await new Promise((r) => setTimeout(r, 50))
  for (const d of opened.dirs) rmSync(d, { recursive: true, force: true })
})

const dataDir = (work: Work) => opened.dirs[opened.works.indexOf(work)]!

describe('ctx.service', () => {
  it('with Work off the service does not start, and every member says Work is off', async () => {
    const spawned: Child[] = []
    const work = host('env_a', spawned)
    await new Promise((r) => setTimeout(r, 50))
    expect(spawned).toHaveLength(0)
    expect(() => work.ctx.service.url('/w/doc/x')).toThrow(WORK_OFF)
    await expect(work.ctx.service.token({ item: { doc: 'x' }, role: 'edit', principal: 'owner' })).rejects.toThrow(WORK_OFF)
    expect(existsSync(join(dataDir(work), 'work-service.secret'))).toBe(false)
  })

  it('Work on forks it; the secret is 0600 in userData; Work off stops it and takes the secret and the socket away', async () => {
    const spawned: Child[] = []
    const work = host('env_a', spawned)
    work.settings.set({ enabled: true })
    await until('the service answers', () => serviceOf(work.ctx)?.state() === 'running')
    expect(spawned).toHaveLength(1)
    const secret = join(dataDir(work), 'work-service.secret')
    expect(statSync(secret).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir(work), 'work-service.sock')).isSocket()).toBe(true)
    expect(work.ctx.service.url('/w/doc/kd1')).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/w\/doc\/kd1$/)
    expect(work.ctx.service.url('/w/hosted/')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/w\/hosted\/$/)
    await expect(work.ctx.service.internal('/internal/sheet/read', { sheetId: 's', range: 'A1', fence: { sectors: 'all' } })).rejects.toThrow(/^this instance serves no LifeOS sheets$/)
    work.settings.set({ enabled: false })
    await until('stopped', () => serviceOf(work.ctx)?.state() === 'off' && !existsSync(secret))
    expect(existsSync(join(dataDir(work), 'work-service.sock'))).toBe(false)
    expect(() => work.ctx.service.url('/w/doc/x')).toThrow(WORK_OFF)
  })

  it('signs a token for a .tcdoc on this host that opens its socket; refuses a sheet, another host\'s file, and a LifeOS doc the box serves', async () => {
    const spawned: Child[] = []
    const work = host('env_mac', spawned, { TEMP_CODE_WORK_LIFEOS_SERVER: 'env_box' })
    work.settings.set({ enabled: true })
    await until('running', () => serviceOf(work.ctx)?.state() === 'running')
    const path = join(dataDir(work), 'Notes.tcdoc')
    const doc = fileDocName(path)
    const token = await work.ctx.service.token({ item: { doc }, role: 'edit', principal: 'owner', source: { at: 'file', host: 'env_mac', path } })
    const client = createCollaborationClient({ documentName: doc, token, url: work.ctx.service.url(`/w/doc/${doc}`), offline: false })
    opened.clients.push(client)
    await until('synced', () => client.provider.isSynced)
    // A live sheet is a LifeOS sheet (milestone 27): served where LifeOS's documents are, here the box.
    await expect(work.ctx.service.token({ item: { sheet: 's1' }, role: 'edit', principal: 'owner' })).rejects.toBeInstanceOf(ServedElsewhere)
    const elsewhere = await work.ctx.service.token({ item: { doc }, role: 'edit', principal: 'owner', source: { at: 'file', host: 'env_box', path } }).catch((e: unknown) => e)
    expect(elsewhere).toBeInstanceOf(ServedElsewhere)
    expect((elsewhere as ServedElsewhere).host).toBe('env_box')
    const lifeos = await work.ctx.service.token({ item: { doc: 'kd1' }, role: 'edit', principal: 'owner' }).catch((e: unknown) => e)
    expect(lifeos).toBeInstanceOf(ServedElsewhere)
    await expect(work.ctx.service.token({ item: { doc: 'file:0000' }, role: 'edit', principal: 'owner', source: { at: 'file', host: 'env_mac', path } })).rejects.toThrow(/named by its resolved path/)
  })

  it('a file has one name however its path is spelled', async () => {
    const spawned: Child[] = []
    const work = host('env_mac', spawned)
    work.settings.set({ enabled: true })
    await until('running', () => serviceOf(work.ctx)?.state() === 'running')
    const path = join(dataDir(work), 'Notes.tcdoc')
    const doc = fileDocName(path)
    for (const spelling of [join(dataDir(work), '.', 'Notes.tcdoc'), `${dataDir(work)}//Notes.tcdoc`, join(dataDir(work), 'x', '..', 'Notes.tcdoc')])
      await expect(work.ctx.service.token({ item: { doc }, role: 'edit', principal: 'owner', source: { at: 'file', host: 'env_mac', path: spelling } }), spelling).resolves.toBeTypeOf('string')
  })

  it('a path through a linked folder and folders not made yet has the same one spelling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm18-canon-'))
    opened.dirs.push(dir)
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    const viaLink = canonicalPath(join(dir, 'link', 'not', 'yet', 'Doc.tcdoc'))
    expect(viaLink).toBe(canonicalPath(join(dir, 'real', 'not', 'yet', 'Doc.tcdoc')))
    expect(viaLink).toBe(join(canonicalPath(dir), 'real', 'not', 'yet', 'Doc.tcdoc'))
  })

  it('an isolated instance that names no LifeOS server refuses a LifeOS token in words, not as another host', async () => {
    const spawned: Child[] = []
    const work = host('env_iso', spawned)
    work.settings.set({ enabled: true })
    await until('running', () => serviceOf(work.ctx)?.state() === 'running')
    const refused = await work.ctx.service.token({ item: { doc: 'kd1' }, role: 'edit', principal: 'owner' }).catch((e: unknown) => e)
    expect(refused).not.toBeInstanceOf(ServedElsewhere)
    expect((refused as Error).message).toMatch(/isolated instance serves no LifeOS documents/)
  })

  it('Work off and on again at once leaves one service, its secret and its socket in place', async () => {
    const spawned: Child[] = []
    const work = host('env_a', spawned)
    for (let i = 0; i < 3; i++) {
      work.settings.set({ enabled: true })
      work.settings.set({ enabled: false })
    }
    work.settings.set({ enabled: true })
    await until('running', () => serviceOf(work.ctx)?.state() === 'running')
    await new Promise((r) => setTimeout(r, 200))
    expect(spawned.filter((c) => c.service()).length).toBe(1)
    expect(existsSync(join(dataDir(work), 'work-service.secret'))).toBe(true)
    expect(statSync(join(dataDir(work), 'work-service.sock')).isSocket()).toBe(true)
    expect(work.ctx.service.url('/w/hosted/')).toMatch(/^http:/)
  })

  it('a service that dies is started again, and the host never waits on it or fails with it', async () => {
    const spawned: Child[] = []
    const work = host('env_a', spawned)
    work.settings.set({ enabled: true })
    await until('running', () => serviceOf(work.ctx)?.state() === 'running')
    spawned[0]!.die(1)
    await until('restarted', () => spawned.length === 2 && serviceOf(work.ctx)?.state() === 'running')
    expect(work.ctx.service.url('/w/doc/x')).toMatch(/^ws:/)
    // A spawn that throws is logged and tried again, with the host's own calls still answering.
    let tries = 0
    const broken = host('env_b', [], {}, () => {
      tries++
      throw new Error('no such file')
    })
    broken.settings.set({ enabled: true })
    await until('tried twice', () => tries >= 2)
    expect(() => broken.ctx.service.url('/w/doc/x')).toThrow(/not running/)
    expect(broken.ctx.enabled()).toBe(true)
  })

  it("a service started again is told every project link's projection again, each in its own message", async () => {
    const spawned: Child[] = []
    const work = host('env_a', spawned)
    work.settings.set({ enabled: true })
    const supervisor = serviceOf(work.ctx)!
    await until('running', () => supervisor.state() === 'running')
    const secret = 'k'.repeat(43)
    const link = { linkId: 'L1', item: { project: 'kproj1' }, role: 'view', expiresAt: Date.now() + 60_000, revokedAt: null, guest: { secretHash: createHash('sha256').update(secret).digest('hex'), name: 'Dana Lee', title: 'Spring LAN', owner: 'Landon', token: '', tokenExp: 0 } }
    const projection = { project: { id: 'kproj1', name: 'Spring LAN', status: 'active' as const, description: '', docId: null }, counts: { todo: 0, doing: 0, waiting: 0, done: 0 }, tasks: [], truncated: false, docs: [], sheets: [] }
    supervisor.setProject('L1', { projection, tokens: {} })
    supervisor.setLinks([link as never])
    const open = async () => fetch(`http://127.0.0.1:${supervisor.port()}/g/L1/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) })
    expect(((await (await open()).json()) as { projection: unknown }).projection).toEqual(projection)
    spawned[0]!.die(1)
    await until('restarted', () => spawned.length === 2 && supervisor.state() === 'running')
    // The fresh process got the links in its config and the projection in a message after it.
    const again = await open()
    expect(again.status).toBe(200)
    expect(((await again.json()) as { projection: unknown }).projection).toEqual(projection)
    // Taken away, the link shows nothing: the page is told to try again.
    supervisor.setProject('L1', null)
    expect((await open()).status).toBe(503)
  })

  it('a call made while the service is still starting waits for it rather than failing', async () => {
    const spawned: Child[] = []
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const slow = inProcess(spawned)
    // The child answers `ready` only once the gate opens: the host's state stays 'starting' until then.
    const work = host('env_slow', spawned, {}, () => {
      const child = slow()
      const post = child.post.bind(child)
      child.post = (m) => (m.t === 'config' ? void gate.then(() => post(m)) : post(m))
      return child
    })
    work.settings.set({ enabled: true })
    await until('starting', () => serviceOf(work.ctx)?.state() === 'starting')
    const path = canonicalPath(join(dataDir(work), 'Slow.tcdoc'))
    const token = work.ctx.service.token({ item: { doc: fileDocName(path) }, role: 'edit', principal: 'owner', source: { at: 'file', host: 'env_slow', path } })
    const internal = work.ctx.service.internal('/internal/health', {}).then(
      () => 'answered',
      (e: Error) => e.message
    )
    expect(() => work.ctx.service.url('/w/doc/x')).toThrow(/not running on this host \(starting\)/)
    release()
    await expect(token).resolves.toMatch(/\./)
    expect(await internal).not.toMatch(/not running/)
  })

  it('two instances run their services side by side, each on its own port', async () => {
    const a: Child[] = []
    const b: Child[] = []
    const one = host('env_one', a)
    const two = host('env_two', b)
    one.settings.set({ enabled: true })
    two.settings.set({ enabled: true })
    await until('both running', () => serviceOf(one.ctx)?.state() === 'running' && serviceOf(two.ctx)?.state() === 'running')
    const p1 = serviceOf(one.ctx)!.port()
    const p2 = serviceOf(two.ctx)!.port()
    expect(p1).not.toBe(p2)
    for (const p of [p1, p2]) expect((await fetch(`http://127.0.0.1:${p}/w/doc/x`)).status).toBe(426)
  })
})
