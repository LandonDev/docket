import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkHome } from '@shared/contract-crosshost'
import { SessionMoveManifestSchema } from '@shared/contract-session-move'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { finalDigest, MoveExport, MoveImports, MoveRefused, workHomesOf, workLandingRefusal, type MoveHost } from './sessionMove'

/**
 * A Work thread keeps its job across a move (docs/agents/work-scope.md "A
 * move"): the manifest says which job each Work thread is from, and the
 * import lands one in a Work workspace only when it is that job's. The
 * sender's probe checks the folder route; this is the check on the
 * workspace the import itself resolved, a linked project's copy included.
 */

const MAC = 'env_mac'
const BOX = 'env_box'
const ROOT = 'thread-root'
const CHILD = 'thread-child'

interface Host {
  home: string
  db: ReturnType<typeof openDb>
  store: Store
  move: MoveHost
}

let T: string
let mac: Host
let box: Host

function makeHost(env: string, name: string): Host {
  const home = join(T, name, 'home')
  const data = join(T, name, 'data')
  mkdirSync(home, { recursive: true })
  mkdirSync(data, { recursive: true })
  const db = openDb(join(data, 'temp-code.db'))
  const store = new Store(db)
  return {
    home,
    db,
    store,
    move: { db, environmentId: env, dataDir: data, home: () => home, workRoot: () => home, pathMap: () => ({ roots: {}, prefixes: {} }), claudeDir: () => join(home, '.claude'), codexDir: () => join(home, '.codex'), gitDirty: async () => [], forget: (ids) => store.forgetSessions(ids) }
  }
}

const meta = (over: Partial<SessionMeta> & { id: string; cwd: string }): SessionMeta =>
  ({ parentId: null, projectId: null, workspaceId: null, threadType: 'chat', planPath: null, provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: over.id, status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits', nativeId: null, createdAt: 1, updatedAt: 1, ...over }) as SessionMeta

/** A workspace at `<home>/<folder>` on a host. */
function workspace(h: Host, id: string, folder: string, over: { kind?: 'work'; sector?: string; linkId?: string } = {}): string {
  const path = join(h.home, folder)
  mkdirSync(path, { recursive: true })
  h.store.insertWorkspace({ id, name: folder, path, git: false, createdAt: 1, ...over })
  return path
}

/** The Mac's Purdue workspace with a Work thread and its subagent in it. */
function purdueOnMac(over: { linkId?: string; sector?: string | null } = {}): void {
  const path = workspace(mac, 'ws-mac', 'Purdue', { kind: 'work', ...(over.sector === null ? {} : { sector: over.sector ?? 'purdue' }), ...(over.linkId ? { linkId: over.linkId } : {}) })
  mac.store.insertSession(meta({ id: ROOT, cwd: path, workspaceId: 'ws-mac', scope: 'work' }))
  mac.store.insertSession(meta({ id: CHILD, parentId: ROOT, cwd: path, workspaceId: 'ws-mac', scope: 'work', createdAt: 2 }))
  mac.store.appendEvent(ROOT, { type: 'user-text', text: 'hello' })
  mac.store.flushEvents()
}

const landedIn = (h: Host): (string | null)[] => (h.db.prepare(`SELECT workspace_id AS w FROM sessions ORDER BY created_at`).all() as { w: string | null }[]).map((r) => r.w)

beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'tc-move-work-')))
  mac = makeHost(MAC, 'mac')
  box = makeHost(BOX, 'box')
})
afterEach(() => {
  for (const h of [mac, box]) h.db.close()
  rmSync(T, { recursive: true, force: true })
})

describe('the manifest of a move', () => {
  it("names the job of every Work thread, and survives the wire's schema", async () => {
    purdueOnMac({ linkId: 'wl-purdue' })
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    const home: WorkHome = { sector: 'purdue', workspaceLinkId: 'wl-purdue', workspaceName: 'Purdue', workspacePath: join(mac.home, 'Purdue') }
    expect(exp.manifest.workHomes).toEqual({ [ROOT]: home, [CHILD]: home })
    expect(SessionMoveManifestSchema.parse(JSON.parse(JSON.stringify(exp.manifest))).workHomes).toEqual(exp.manifest.workHomes)
  })

  it('says nothing of Work for a code thread', async () => {
    const path = workspace(mac, 'ws-mac', 'shop')
    mac.store.insertSession(meta({ id: ROOT, cwd: path, workspaceId: 'ws-mac' }))
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    expect('workHomes' in exp.manifest).toBe(false)
  })

  it('tells a Work Chat (all null) from a Work thread whose workspace is not Work (no entry)', () => {
    workspace(mac, 'ws-code', 'shop')
    const rows = [
      { id: 'chat', scope: 'work', project_id: null, workspace_id: null },
      { id: 'orphan', scope: 'work', project_id: null, workspace_id: 'ws-code' },
      { id: 'code', scope: 'code', project_id: null, workspace_id: 'ws-code' }
    ]
    expect(workHomesOf(mac.db, rows)).toEqual({ chat: { sector: null, workspaceLinkId: null, workspaceName: null, workspacePath: null } })
  })

  it('binds the jobs into the digest, so a host that does not check them cannot land the thread', async () => {
    purdueOnMac()
    const { manifest } = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    const { workHomes: _unknown, ...older } = manifest
    expect(finalDigest('c', older)).not.toBe(finalDigest('c', manifest))
    expect(finalDigest('c', { ...manifest, workHomes: { ...manifest.workHomes, [ROOT]: { ...manifest.workHomes![ROOT], sector: 'unify' } } })).not.toBe(finalDigest('c', manifest))
    // Present with no home still differs from absent: a sender that says "none has a job" is not one that says nothing.
    expect(finalDigest('c', { ...older, workHomes: {} })).not.toBe(finalDigest('c', older))
  })
})

describe('where a Work thread may land', () => {
  it('lands in the workspace of the same job: the same sector at the mapped folder', async () => {
    purdueOnMac()
    workspace(box, 'ws-box', 'Purdue', { kind: 'work', sector: 'purdue' })
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    await expect(new MoveImports(box.move).begin(exp.manifest)).resolves.toMatchObject({ workspaceId: 'ws-box' })
    expect(landedIn(box)).toEqual(['ws-box', 'ws-box'])
  })

  it("is refused in another job's workspace, reached by the folder", async () => {
    purdueOnMac()
    // The box's workspace at the same folder is linked to another sector.
    workspace(box, 'ws-box', 'Purdue', { kind: 'work', sector: 'unify' })
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    const begin = new MoveImports(box.move).begin(exp.manifest)
    await expect(begin).rejects.toBeInstanceOf(MoveRefused)
    await expect(begin).rejects.toThrow("the thread is from purdue and would land in Purdue, another job's workspace on this host")
    expect(landedIn(box)).toEqual([])
  })

  it("is refused in another job's workspace, reached by a linked project's copy", async () => {
    // The thread runs in a project of the Mac's Purdue workspace; the box's copy of that project sits in its Unify workspace.
    const path = workspace(mac, 'ws-mac', 'Purdue', { kind: 'work', sector: 'purdue' })
    mac.store.insertProject({ id: 'p-mac', workspaceId: 'ws-mac', name: 'Spring LAN', mode: 'folder', branch: null, cwd: join(path, 'Spring LAN'), createdAt: 1 } as never)
    mkdirSync(join(path, 'Spring LAN'), { recursive: true })
    mac.store.insertSession(meta({ id: ROOT, cwd: join(path, 'Spring LAN'), projectId: 'p-mac', workspaceId: 'ws-mac', scope: 'work' }))
    mac.store.appendEvent(ROOT, { type: 'user-text', text: 'hello' })
    mac.store.flushEvents()
    const facts = { linkId: 'pl-1', workspaceLinkId: null, name: 'Spring LAN', branch: null, mode: 'folder', workspacePath: path, cwd: join(path, 'Spring LAN') }
    const exp = await MoveExport.build({ ...mac.move, projectLink: () => facts as never }, ROOT, 'm1', BOX)
    expect(exp.manifest.workHomes?.[ROOT]?.sector).toBe('purdue')

    workspace(box, 'ws-purdue', 'Purdue', { kind: 'work', sector: 'purdue' })
    const unify = workspace(box, 'ws-unify', 'Unify', { kind: 'work', sector: 'unify' })
    mkdirSync(join(unify, 'Spring LAN'), { recursive: true })
    const copy = { project: { id: 'p-box', workspaceId: 'ws-unify', cwd: join(unify, 'Spring LAN') } }
    const linked = (ws: string, cwd: string): MoveHost => ({ ...box.move, ensureLinked: async () => ({ project: { ...copy.project, workspaceId: ws, cwd } }) as never })

    await expect(new MoveImports(linked('ws-unify', join(unify, 'Spring LAN'))).begin(exp.manifest)).rejects.toThrow(
      "the thread is from purdue and would land in Unify, another job's workspace on this host"
    )
    expect(landedIn(box)).toEqual([])

    // The same route into the job's own workspace is the move the owner asked for.
    mkdirSync(join(box.home, 'Purdue', 'Spring LAN'), { recursive: true })
    await expect(new MoveImports(linked('ws-purdue', join(box.home, 'Purdue', 'Spring LAN'))).begin(exp.manifest)).resolves.toMatchObject({ workspaceId: 'ws-purdue' })
    expect(landedIn(box)).toEqual(['ws-purdue'])
  })

  it('lands in a code workspace as before: the thread keeps its fence there and reads no job', async () => {
    purdueOnMac()
    workspace(box, 'ws-box', 'Purdue')
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    await expect(new MoveImports(box.move).begin(exp.manifest)).resolves.toMatchObject({ workspaceId: 'ws-box' })
    expect((box.db.prepare(`SELECT scope FROM sessions WHERE id = ?`).get(ROOT) as { scope: string }).scope).toBe('work')
  })

  it('refuses a bundle that does not say which job its Work threads are from', async () => {
    purdueOnMac()
    workspace(box, 'ws-box', 'Purdue', { kind: 'work', sector: 'purdue' })
    const { manifest } = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    const { workHomes: _older, ...older } = manifest
    await expect(new MoveImports(box.move).begin(older)).rejects.toThrow("the other host's build does not say which job a Work thread is from")
    expect(landedIn(box)).toEqual([])
  })

  it('leaves a code thread alone, whatever workspace it lands in', async () => {
    const path = workspace(mac, 'ws-mac', 'shop')
    mac.store.insertSession(meta({ id: ROOT, cwd: path, workspaceId: 'ws-mac' }))
    mac.store.appendEvent(ROOT, { type: 'user-text', text: 'hello' })
    mac.store.flushEvents()
    workspace(box, 'ws-box', 'shop', { kind: 'work', sector: 'purdue' })
    const exp = await MoveExport.build(mac.move, ROOT, 'm1', BOX)
    await expect(new MoveImports(box.move).begin(exp.manifest)).resolves.toMatchObject({ workspaceId: 'ws-box' })
  })
})

describe('whether a workspace is the job a thread is from', () => {
  const landing = (over: Partial<{ name: string; path: string; sector: string | null; link_id: string | null }> = {}) => ({ name: 'Purdue', path: '/box/Purdue', sector: 'purdue', link_id: null, ...over })
  const home = (over: Partial<WorkHome> = {}): WorkHome => ({ sector: 'purdue', workspaceLinkId: null, workspaceName: 'Purdue', workspacePath: '/mac/Purdue', ...over })
  const never = (): boolean => false

  it('is the same job by link id, by sector, or for an unlinked workspace by folder', () => {
    expect(workLandingRefusal(home({ workspaceLinkId: 'wl' }), landing({ link_id: 'wl', sector: null }), never)).toBeNull()
    expect(workLandingRefusal(home(), landing(), never)).toBeNull()
    expect(workLandingRefusal(home({ sector: null }), landing({ sector: null }), (path) => path === '/mac/Purdue')).toBeNull()
  })

  it('is never the same job across two sectors, even with the same link id or folder', () => {
    expect(workLandingRefusal(home({ workspaceLinkId: 'wl' }), landing({ link_id: 'wl', sector: 'unify' }), () => true)).toMatch(/another job's workspace/)
  })

  it('is another job when nothing matches', () => {
    expect(workLandingRefusal(home({ sector: null }), landing({ sector: null }), never)).toBe("the thread is from Purdue and would land in Purdue, another job's workspace on this host")
  })

  it('refuses a Work Chat and a thread with no Work workspace, which would each gain a job', () => {
    expect(workLandingRefusal({ sector: null, workspaceLinkId: null, workspaceName: null, workspacePath: null }, landing(), never)).toBe("a Work Chat would land in Purdue, a job's workspace on this host")
    expect(workLandingRefusal(undefined, landing(), never)).toBe('the thread has no Work workspace on the other host and would join Purdue here')
  })
})
