import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WorkPush } from '@shared/contract-work'
import type { CanvasItem, WorkScope, WorkspaceWorkSettings } from '@shared/work'
import { CanvasStore, ensureCanvasTables, setCanvasStore } from '../canvas/store'
import type { Caller, PushTo, WorkCtx } from '../modules'
import { setCloudDir } from '../office/files/library'
import { ensureFilesTables as ensureOfficeFiles } from '../office/files/library'
import { setVmState } from '../office/vm/office'
import { forgetLibraries } from './places/libraries'
import { ensureFilesTables } from './tables'

/**
 * What the files pillar's tests share: one host (`env_box`) with a Work workspace whose folder holds a few
 * files, a dummy cloud folder shaped like OneDrive's on a Mac (a team's library with two channels and his own
 * files), a folder outside both, and the callers of the fence's table. Dummy names only.
 */

export const HOST = 'env_box'
export const WS = 'w1'

export const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
export const phone: Caller = { kind: 'remote', caps: ['read', 'operate'] }
export const approver: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
export const reader: Caller = { kind: 'remote', caps: ['read'] }
export const peer: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: 'env_mac' }
export const thread = (sessionId = 't1'): Caller => ({ kind: 'model', caps: [], sessionId })

export interface Rig {
  base: string
  /** the workspace's folder, by its real path */
  folder: string
  /** another Work workspace's folder on the same host */
  otherFolder: string
  cloud: string
  /** the team's library: `<cloud>/OneDrive-SharedLibraries-Dummy U/Esports Staff - Documents` */
  team: string
  /** his own OneDrive */
  mine: string
  outside: string
  dataDir: string
  db: DatabaseSync
  ctx: WorkCtx
  canvas: CanvasStore
  pushes: { p: WorkPush; to?: PushTo }[]
  /** the items every pillar was told were deleted */
  removed: CanvasItem[][]
  /** the threads the registry knows, by id */
  scopes: Map<string, Partial<WorkScope>>
  settings: Map<string, Partial<WorkspaceWorkSettings>>
  /** the roots a remote key may name; the workspace's folder by default */
  roots: string[]
  close(): void
}

export function makeRig(): Rig {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tc-files-')))
  const folder = join(base, 'Work', 'Dummy Esports')
  const otherFolder = join(base, 'Work', 'Other Job')
  const cloud = join(base, 'CloudStorage')
  const team = join(cloud, 'OneDrive-SharedLibraries-Dummy U', 'Esports Staff - Documents')
  const mine = join(cloud, 'OneDrive-Dummy U')
  const outside = join(base, 'outside')
  const dataDir = join(base, 'data')
  for (const dir of [join(folder, 'Events', 'Spring LAN'), join(folder, '.hidden'), otherFolder, join(team, 'General', 'Budgets'), join(team, 'Events'), mine, outside, dataDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(folder, 'Run of show.tcdoc'), '{}')
  writeFileSync(join(folder, 'Budget.xlsx'), 'x'.repeat(1200))
  writeFileSync(join(folder, 'notes.txt'), 'kickoff at 5')
  writeFileSync(join(folder, 'Events', 'Poster.png'), 'png')
  writeFileSync(join(folder, 'Events', 'Spring LAN', 'Bracket.pdf'), 'pdf')
  writeFileSync(join(folder, '.hidden', 'secret.txt'), 'hidden')
  writeFileSync(join(otherFolder, 'Payroll.xlsx'), 'not this workspace')
  writeFileSync(join(team, 'General', 'Spring budget.xlsx'), 'workbook')
  writeFileSync(join(team, 'General', 'Budgets', '2026.xlsx'), 'workbook')
  writeFileSync(join(team, 'General', 'Plan.docx'), 'word')
  writeFileSync(join(team, 'Events', 'Deck.pptx'), 'deck')
  // A file OneDrive keeps in the cloud: its full size and no blocks.
  writeFileSync(join(team, 'General', 'Cloud only.pdf'), '')
  truncateSync(join(team, 'General', 'Cloud only.pdf'), 200_000)
  writeFileSync(join(mine, 'Mine.docx'), 'word')
  writeFileSync(join(outside, 'secret.txt'), 'not his to share')
  symlinkSync(outside, join(folder, 'way out'))
  symlinkSync(outside, join(team, 'General', 'way out'))

  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'code', sector TEXT, created_at INTEGER NOT NULL DEFAULT 0)`)
  const add = db.prepare(`INSERT INTO workspaces (id, name, path, kind, sector) VALUES (?, ?, ?, ?, ?)`)
  add.run(WS, 'Dummy Esports', folder, 'work', 'purdue')
  add.run('w2', 'Other Job', otherFolder, 'work', 'ref')
  add.run('code1', 'A repo', outside, 'code', null)
  ensureFilesTables(db)
  ensureOfficeFiles(db)
  ensureCanvasTables(db)
  setCloudDir((host) => (host === HOST ? cloud : join(base, 'no-cloud')))
  setVmState(() => null)
  forgetLibraries(db)

  const pushes: Rig['pushes'] = []
  const removed: CanvasItem[][] = []
  const scopes = new Map<string, Partial<WorkScope>>([['t1', { workspaceId: WS }], ['t2', { workspaceId: 'w2' }], ['chat', { workspaceId: null }]])
  const settings = new Map<string, Partial<WorkspaceWorkSettings>>()
  const roots = [folder]
  const reaches: WorkCtx['reaches'] = (by, path) => by.kind !== 'remote' || roots.some((root) => path === root || path.startsWith(`${root}/`))
  const canvas = new CanvasStore({
    db,
    dataDir,
    session: (id) => (scopes.has(id) ? { id, workspaceId: scopes.get(id)!.workspaceId ?? undefined, scope: 'work', parentId: null } : null) as never,
    workWorkspace: (id) => id === WS || id === 'w2',
    push: (p, to) => void pushes.push({ p, to }),
    remoteReaches: (path) => reaches({ kind: 'remote', caps: [] }, path),
    itemsRemoved: (items) => void removed.push(items),
    log: () => {}
  })
  setCanvasStore(db, canvas)
  const ctx = {
    db,
    host: HOST,
    dataDir,
    enabled: () => true,
    log: () => {},
    push: (p: WorkPush, to?: PushTo) => void pushes.push({ p, to }),
    reaches,
    scopeOf: (id: string) => (scopes.has(id) ? ({ sessionId: id, workspaceId: null, sector: null, host: HOST, away: false, routineRunId: null, shared: () => false, ...scopes.get(id) } as WorkScope) : null),
    settings: { workspace: (id: string) => ({ mayUseDesktop: [], voice: false, ...settings.get(id) }), set: () => {} },
    canvas: {
      open: (sessionId: string, kind: CanvasItem['kind'], source: CanvasItem['source'], title: string) => canvas.open(sessionId, { kind, source, title }),
      close: (itemId: string) => canvas.close(itemId),
      replace: (sessionId: string, oldItemId: string | null | undefined, kind: CanvasItem['kind'], source: CanvasItem['source'], title: string) => canvas.replace(sessionId, oldItemId, { kind, source, title }),
      forSession: (sessionId: string) => canvas.list(sessionId),
      forWorkspace: (workspaceId: string, opts?: { open?: boolean; panes?: boolean }) => canvas.forWorkspace(workspaceId, opts),
      get: (itemId: string) => canvas.get(itemId),
      paneOf: (sessionId: string) => canvas.paneOf(sessionId)
    }
  } as unknown as WorkCtx
  return {
    base,
    folder,
    otherFolder,
    cloud,
    team,
    mine,
    outside,
    dataDir,
    db,
    ctx,
    canvas,
    pushes,
    removed,
    scopes,
    settings,
    roots,
    close() {
      setVmState(null)
      rmSync(base, { recursive: true, force: true })
    }
  }
}

/** A file or folder on the rig's host, as a ref. */
export const at = (path: string, host = HOST) => ({ at: 'file' as const, host, path })
