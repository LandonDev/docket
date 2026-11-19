import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { dropLanding, finalDigest, MoveExport, MoveImports, registerMoveModule, tableMoveModule, type MoveHost, type MoveModule } from './sessionMove'
import { SessionMover, handleSessionMove } from './remote/sessionMover'
import type { PeerLink } from './remote/peers'
import { startWork, type Work } from './work/ctx'
import { canvas } from './work/canvas'
import { canvasItemDir } from './work/canvas/store'

/**
 * The move modules (sessionMove.ts `MoveModule`): a part of the app that
 * keeps rows or files per thread has them follow a move, generic first,
 * then with the real canvas module on both hosts.
 */

const MAC = 'env_mac'
const BOX = 'env_box'
const ROOT = 'thread-root'
const CHILD = 'thread-child'

interface Host {
  env: string
  home: string
  data: string
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  move: MoveHost
  mover: SessionMover
}

let T: string
let mac: Host
let box: Host

function makeHost(env: string, name: string, peer: () => Host): Host {
  const dir = join(T, name)
  const home = join(dir, 'home')
  const data = join(dir, 'data')
  mkdirSync(home, { recursive: true })
  mkdirSync(data, { recursive: true })
  const db = openDb(join(data, 'temp-code.db'))
  const store = new Store(db)
  const registry = new SessionRegistry(store)
  const move: MoveHost = {
    db,
    environmentId: env,
    dataDir: data,
    home: () => home,
    workRoot: () => home,
    pathMap: () => ({ roots: {}, prefixes: {} }),
    claudeDir: () => join(home, '.claude'),
    codexDir: () => join(home, '.codex'),
    gitDirty: async () => [],
    forget: (ids) => store.forgetSessions(ids)
  }
  const link = {
    get env() {
      return { id: peer().env, name: peer().env, routes: [] }
    },
    connected: true,
    async request<R>(method: string, params: unknown): Promise<R> {
      const req = ClientRequestSchema.parse({ id: 'x', method, params: JSON.parse(JSON.stringify(params)) })
      const out = await handleSessionMove(req, peer().mover)
      if (!out.handled) throw new Error(`unhandled ${method}`)
      return JSON.parse(JSON.stringify(out.result ?? null)) as R
    }
  } as unknown as PeerLink
  const mover = new SessionMover({ host: move, registry, peers: { get: (id: string) => (id === peer().env ? link : undefined), all: () => [link] }, flush: () => store.flushEvents(), log: () => {} })
  return { env, home, data, db, store, registry, move, mover }
}

const project = (h: Host): string => join(h.home, 'shop')
const meta = (over: Partial<SessionMeta> & { id: string; cwd: string }): SessionMeta =>
  ({
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'medium',
    agentType: 'implementer',
    title: over.id,
    status: 'idle',
    pinned: false,
    archived: false,
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    threadRules: null,
    permission: 'edits',
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }) as SessionMeta

/** Each host a workspace at its own `shop`; the Mac also a thread and its subagent. */
function seed(scope?: 'work'): void {
  for (const h of [mac, box]) {
    mkdirSync(project(h), { recursive: true })
    h.store.insertWorkspace({ id: `ws-${h.env}`, name: 'shop', path: project(h), git: false, createdAt: 1 })
  }
  mac.store.insertSession(meta({ id: ROOT, cwd: project(mac), workspaceId: `ws-${MAC}`, ...(scope ? { scope } : {}) }))
  mac.store.insertSession(meta({ id: CHILD, parentId: ROOT, cwd: project(mac), workspaceId: `ws-${MAC}`, createdAt: 2, ...(scope ? { scope } : {}) }))
  mac.store.appendEvent(ROOT, { type: 'user-text', text: 'hello' })
  mac.store.flushEvents()
}

const put = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'tc-move-modules-')))
  mac = makeHost(MAC, 'mac', () => box)
  box = makeHost(BOX, 'box', () => mac)
})
afterEach(async () => {
  for (const h of [mac, box]) {
    h.mover.close()
    await h.registry.close()
    h.db.close()
  }
  vi.restoreAllMocks()
  rmSync(T, { recursive: true, force: true })
})

describe('a table move module', () => {
  const NOTES = `CREATE TABLE IF NOT EXISTS work_test_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_id TEXT, note TEXT NOT NULL)`
  const noteDir = (dataDir: string, sessionId: string): string => join(dataDir, 'notes-test', sessionId)
  let claimed: { ids: readonly string[]; from: string }[]
  const notesModule = (over: Partial<MoveModule> = {}): MoveModule => ({
    ...tableMoveModule('notes', 'work_test_notes', { dir: noteDir, claimed: (_h, ids, from) => void claimed.push({ ids, from }) }),
    ...over
  })
  const notes = (h: Host): Record<string, unknown>[] => h.db.prepare(`SELECT * FROM work_test_notes ORDER BY id`).all() as Record<string, unknown>[]
  beforeEach(() => {
    claimed = []
    for (const h of [mac, box]) {
      h.db.exec(NOTES)
      registerMoveModule(h.db, notesModule())
    }
  })
  const seedNotes = (): void => {
    seed()
    mac.db.prepare(`INSERT INTO work_test_notes VALUES ('n1', ?, ?, 'root note'), ('n2', ?, ?, 'child note'), ('n3', 'elsewhere', NULL, 'not moving')`).run(ROOT, `ws-${MAC}`, CHILD, `ws-${MAC}`)
    put(join(noteDir(mac.data, ROOT), 'a', 'b.txt'), 'bytes of the root')
    put(join(noteDir(mac.data, CHILD), 'c.txt'), 'bytes of the child')
  }

  it("rides a move: the rows land with the receiver's workspace id, the files byte-equal, and the source keeps neither", async () => {
    seedNotes()
    await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(notes(box)).toEqual([
      { id: 'n1', session_id: ROOT, workspace_id: `ws-${BOX}`, note: 'root note' },
      { id: 'n2', session_id: CHILD, workspace_id: `ws-${BOX}`, note: 'child note' }
    ])
    expect(readFileSync(join(noteDir(box.data, ROOT), 'a', 'b.txt'), 'utf8')).toBe('bytes of the root')
    expect(readFileSync(join(noteDir(box.data, CHILD), 'c.txt'), 'utf8')).toBe('bytes of the child')
    expect(notes(mac).map((n) => n.id)).toEqual(['n3'])
    expect(existsSync(noteDir(mac.data, ROOT))).toBe(false)
    expect(existsSync(noteDir(mac.data, CHILD))).toBe(false)
    expect(claimed).toEqual([{ ids: [ROOT, CHILD], from: MAC }])
  })

  it('lands only the columns the receiver has', async () => {
    seedNotes()
    box.db.exec(`DROP TABLE work_test_notes; CREATE TABLE work_test_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, note TEXT NOT NULL)`)
    await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(notes(box)).toEqual([
      { id: 'n1', session_id: ROOT, note: 'root note' },
      { id: 'n2', session_id: CHILD, note: 'child note' }
    ])
  })

  it('a dropped landing leaves neither rows nor files on the receiver, and the source keeps both', async () => {
    seedNotes()
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    expect(Object.keys(exp.manifest.modules ?? {})).toEqual(['notes'])
    expect(exp.manifest.files.filter((f) => f.kind === 'module').map((f) => f.rel)).toEqual(['notes/a/b.txt', 'notes/c.txt'])
    const imports = new MoveImports(box.move)
    await imports.begin(exp.manifest)
    expect(notes(box).map((n) => n.id)).toEqual(['n1', 'n2'])
    for (let i = 0; !exp.done; i++) imports.part(exp.part(i))
    imports.commit('m1', exp.digest())
    expect(readFileSync(join(noteDir(box.data, ROOT), 'a', 'b.txt'), 'utf8')).toBe('bytes of the root')
    expect(dropLanding(box.move, { moveId: 'm1' })).toEqual([ROOT, CHILD])
    expect(notes(box)).toEqual([])
    expect(existsSync(noteDir(box.data, ROOT))).toBe(false)
    expect(existsSync(noteDir(box.data, CHILD))).toBe(false)
    expect(claimed).toEqual([])
    expect(notes(mac).map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(readFileSync(join(noteDir(mac.data, ROOT), 'a', 'b.txt'), 'utf8')).toBe('bytes of the root')
  })

  it('a host from before the modules cannot land the thread without its rows: the digests differ, so the commit fails', async () => {
    seedNotes()
    const exp = await MoveExport.build(mac.move, ROOT, 'm2', BOX)
    // An older receiver's schema strips the key it does not know, and its files' kind.
    const { modules: _dropped, ...older } = exp.manifest
    const stripped = { ...older, files: older.files.filter((f) => f.kind !== 'module') }
    expect(finalDigest('c', stripped)).not.toBe(finalDigest('c', { ...stripped, modules: exp.manifest.modules }))
    // The digest names which rows, not only that there were some.
    expect(finalDigest('c', exp.manifest)).not.toBe(finalDigest('c', { ...exp.manifest, modules: { notes: [] } }))
    expect(finalDigest('c', { ...stripped, modules: {} })).toBe(finalDigest('c', stripped))
  })

  it("refuses a row whose id is another thread's row on the receiver, and lands nothing", async () => {
    seedNotes()
    const exp = await MoveExport.build(mac.move, ROOT, 'm3', BOX)
    const mine = (exp.manifest.modules!.notes as { id: string }[])[0].id
    // A row of another thread on the receiver that happens to hold the same id.
    box.db.prepare(`INSERT INTO work_test_notes VALUES (?, 'other-thread', 'w', 'not yours')`).run(mine)
    await expect(new MoveImports(box.move).begin(exp.manifest)).rejects.toThrow(/the thread's notes rows clash/)
    expect(notes(box).map((n) => [n.id, n.session_id])).toEqual([[mine, 'other-thread']])
    expect(box.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(ROOT)).toBeUndefined()
  })

  it('a begin tried again lands each row once', async () => {
    seedNotes()
    const exp = await MoveExport.build(mac.move, ROOT, 'm4', BOX)
    const imports = new MoveImports(box.move)
    await imports.begin(exp.manifest)
    await imports.begin(exp.manifest)
    expect(notes(box).map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  it('a claimed hook that throws does not fail the claim', async () => {
    seedNotes()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerMoveModule(
      box.db,
      notesModule({
        claimed: () => {
          throw new Error('boom')
        }
      })
    )
    await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(box.store.getSession(ROOT)?.id).toBe(ROOT)
    expect(said.mock.calls.map((c) => String(c[0]))).toContain('[move] notes claimed: boom')
  })

  it("a receiver without the module refuses at begin, by name, and the source stays whole", async () => {
    seedNotes()
    const imports = new MoveImports(box.move)
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    const off = registerMoveModule(box.db, { id: 'notes', land: () => {} })
    await expect(imports.begin(exp.manifest)).rejects.toThrow("this host has no notes to take the thread's files")
    off()
    const rowsOnly = { ...exp.manifest, files: exp.manifest.files.filter((f) => f.kind !== 'module') }
    await expect(imports.begin(rowsOnly)).rejects.toThrow("this host cannot take the thread's notes rows")
    expect(box.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(ROOT)).toBeUndefined()
    expect(notes(mac).map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
  })

  it('a manifest without modules (an older sender) still lands', async () => {
    seed()
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    expect(exp.manifest.modules).toBeUndefined()
    const imports = new MoveImports(box.move)
    await expect(imports.begin(exp.manifest)).resolves.toMatchObject({ workspaceId: `ws-${BOX}` })
  })
})

describe('the canvas items follow a moved thread', () => {
  const works: Work[] = []
  const pushes: WorkPush[] = []
  beforeEach(() => {
    pushes.length = 0
    for (const h of [mac, box]) {
      const work = startWork({ db: h.db, store: h.store, registry: h.registry, environmentId: h.env, dataDir: h.data, log: () => {} }, [canvas])
      if (h === box) work.pushes.onPush((p) => pushes.push(p))
      works.push(work)
    }
  })
  afterEach(() => {
    for (const w of works.splice(0)) w.close()
  })

  it("lands both items, the open one's folder and the receiver's workspace id; the source keeps none", async () => {
    seed('work')
    const [macWork] = works
    const made = macWork.ctx.canvas.open(ROOT, 'document', { at: 'thread' }, 'Draft')
    const report = macWork.ctx.canvas.open(ROOT, 'pdf', { at: 'file', host: MAC, path: join(project(mac), 'r.pdf') }, 'Report')
    macWork.ctx.canvas.close(report.id)
    put(join(canvasItemDir(mac.data, ROOT, made.id), 'body.md'), '# draft')

    await mac.mover.move({ sessionId: ROOT, to: BOX })

    const rows = box.db.prepare(`SELECT id, state, workspace_id FROM work_canvas_items ORDER BY title`).all()
    expect(rows).toEqual([
      { id: made.id, state: 'open', workspace_id: `ws-${BOX}` },
      { id: report.id, state: 'closed', workspace_id: `ws-${BOX}` }
    ])
    expect(readFileSync(join(canvasItemDir(box.data, ROOT, made.id), 'body.md'), 'utf8')).toBe('# draft')
    expect(works[1].ctx.canvas.forSession(ROOT).map((i) => i.id)).toEqual([made.id])
    // The claim told the box's clients the landed thread's open list.
    expect(pushes).toContainEqual({ push: 'work.canvas', sessionId: ROOT, items: [expect.objectContaining({ id: made.id, workspaceId: `ws-${BOX}` })] })
    expect(mac.db.prepare(`SELECT count(*) AS n FROM work_canvas_items`).get()).toEqual({ n: 0 })
    expect(existsSync(join(mac.data, 'canvas', ROOT))).toBe(false)
  })
})
