import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { AddonStore } from './addonStore'
import { openDb, Store } from './db'

/** Work's core columns (docs/agents/work.md): defaulted, absent from a code row's meta, and readable by the build before them. */

const meta = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: 'chat',
  planPath: null,
  provider: 'claude',
  model: 'claude-fable-5',
  reasoning: 'medium',
  agentType: 'implementer',
  title: id,
  cwd: '/tmp/cwd',
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
  updatedAt: 100,
  ...patch
})
const workspace = (id: string, patch: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({ id, name: id, path: `/work/${id}`, git: false, createdAt: 1, ...patch })
const project = (id: string, patch: Partial<ProjectMeta> = {}): ProjectMeta => ({ id, workspaceId: 'w-code', name: id, mode: 'local', branch: null, cwd: `/work/${id}`, archived: false, createdAt: 1, ...patch })
const columns = (db: DatabaseSync, table: string): Record<string, { type: string; notnull: number; dflt_value: string | null }> =>
  Object.fromEntries((db.prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}')`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[]).map((c) => [c.name, c]))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-db-work-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("Work's core columns", () => {
  it('exist with their defaults, on a new database and on one opened twice', () => {
    const path = join(root, 'a.db')
    openDb(path).close()
    const db = openDb(path)
    expect(columns(db, 'workspaces')).toMatchObject({
      kind: { type: 'TEXT', notnull: 1, dflt_value: "'code'" },
      sector: { type: 'TEXT', notnull: 0, dflt_value: null },
      work_settings: { type: 'TEXT', notnull: 0, dflt_value: null }
    })
    expect(columns(db, 'sessions')).toMatchObject({
      scope: { type: 'TEXT', notnull: 1, dflt_value: "'code'" },
      routine_run_id: { type: 'TEXT', notnull: 0, dflt_value: null }
    })
    expect(columns(db, 'projects')).toMatchObject({ lifeos_project_id: { type: 'TEXT', notnull: 0, dflt_value: null } })
    new AddonStore(db)
    new AddonStore(db)
    expect(columns(db, 'addons')).toMatchObject({
      role: { type: 'TEXT', notnull: 0, dflt_value: null },
      for_work: { type: 'INTEGER', notnull: 1, dflt_value: '0' }
    })
    db.close()
  })

  it('are added to a database from before them, whose rows read as code', () => {
    const path = join(root, 'old.db')
    const first = openDb(path)
    const before = new Store(first)
    before.insertWorkspace(workspace('w-old'))
    before.insertProject(project('p-old', { workspaceId: 'w-old' }))
    before.insertSession(meta('s-old'))
    first.close()
    // Back to the old shape: none of the columns existed.
    const raw = new DatabaseSync(path)
    for (const stmt of [
      `ALTER TABLE workspaces DROP COLUMN kind`,
      `ALTER TABLE workspaces DROP COLUMN sector`,
      `ALTER TABLE workspaces DROP COLUMN work_settings`,
      `ALTER TABLE sessions DROP COLUMN scope`,
      `ALTER TABLE sessions DROP COLUMN routine_run_id`,
      `ALTER TABLE projects DROP COLUMN lifeos_project_id`
    ])
      raw.exec(stmt)
    raw.close()

    const db = openDb(path)
    const store = new Store(db)
    expect(db.prepare(`SELECT kind, sector, work_settings FROM workspaces WHERE id = 'w-old'`).get()).toEqual({ kind: 'code', sector: null, work_settings: null })
    expect(db.prepare(`SELECT scope, routine_run_id FROM sessions WHERE id = 's-old'`).get()).toEqual({ scope: 'code', routine_run_id: null })
    expect(store.listWorkspaces()[0]).not.toHaveProperty('kind')
    expect(store.getSession('s-old')).not.toHaveProperty('scope')
    db.close()
  })

  it("leave a code row's meta exactly what it was: no Work key rides it", () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(workspace('w-code'))
    store.insertProject(project('p-code'))
    store.insertSession(meta('s-code'))
    for (const row of [store.listWorkspaces()[0], store.listProjects()[0], store.getSession('s-code')!])
      for (const key of ['kind', 'sector', 'scope', 'routineRunId', 'lifeosProjectId']) expect(row, key).not.toHaveProperty(key)
    expect(db.prepare(`SELECT kind FROM workspaces`).get()).toEqual({ kind: 'code' })
    expect(db.prepare(`SELECT scope FROM sessions`).get()).toEqual({ scope: 'code' })
    db.close()
  })

  it('carry a Work workspace, a Work thread and a mirrored project through a write and a read', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(workspace('w-work', { kind: 'work', sector: 'purdue' }))
    store.insertWorkspace(workspace('w-linked', { sector: 'cosmic' }))
    store.insertProject(project('p-mirror', { workspaceId: 'w-work', lifeosProjectId: 'lp_1' }))
    store.insertSession(meta('s-work', { workspaceId: 'w-work', scope: 'work', routineRunId: 'run_1' }))
    const [work, linked] = store.listWorkspaces()
    expect(work).toMatchObject({ id: 'w-work', kind: 'work', sector: 'purdue' })
    // a code workspace may carry a sector link; it stays a code workspace
    expect(linked).toMatchObject({ id: 'w-linked', sector: 'cosmic' })
    expect(linked).not.toHaveProperty('kind')
    expect(store.listProjects()[0].lifeosProjectId).toBe('lp_1')
    expect(store.getSession('s-work')).toMatchObject({ scope: 'work', routineRunId: 'run_1' })
    // the scope is stamped once: a later write of the row does not move it
    store.updateSession('s-work', { title: 'renamed', status: 'running' })
    expect(store.getSession('s-work')).toMatchObject({ title: 'renamed', scope: 'work' })

    store.setWorkspaceSector('w-linked', null)
    store.setWorkspaceSector('w-work', 'unify')
    store.setProjectLifeosId('p-mirror', null)
    expect(store.listWorkspaces().map((w) => w.sector)).toEqual(['unify', undefined])
    expect(store.listProjects()[0]).not.toHaveProperty('lifeosProjectId')

    expect(store.getWorkspaceWorkSettings('w-work')).toBeNull()
    expect(store.setWorkspaceWorkSettings('w-work', '{"mayUseDesktop":["env_mac"],"voice":false}')).toBe(true)
    expect(store.getWorkspaceWorkSettings('w-work')).toBe('{"mayUseDesktop":["env_mac"],"voice":false}')
    expect(store.setWorkspaceWorkSettings('w-missing', '{}')).toBe(false)
    db.close()
  })
})

describe('the build before this one', () => {
  // The statements the build before Work's columns runs (db.ts and addonStore.ts at f50feede9), word for word:
  // it names no Work column, so each must still succeed and its row must read as code. (That build's own code
  // was run against such a database once, by hand, when the columns landed: .temp-code/plans/landed/M05.md.)
  const OLD_INSERT_SESSION = `INSERT INTO sessions (id, parent_id, project_id, workspace_id, thread_type, plan_path, provider, model, reasoning, agent_type, title, cwd, status, archived, pinned, permission, fast, ultrafast, context_1m, busy_since, paused_at, frozen_active_elapsed, thread_rules, native_id, account_current, plan_completed_at, implementation_id, plan_thread_id, started_by, is_master, master_id, after_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  const OLD_INSERT_WORKSPACE = `INSERT INTO workspaces (id, name, path, git, created_at, github_repo, github_repo_checked_at, link_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  const OLD_INSERT_PROJECT = `INSERT INTO projects (id, workspace_id, name, mode, branch, cwd, created_at, link_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  const OLD_WRITE_ADDON = `INSERT OR REPLACE INTO addons (id, name, workspace_id, description, spec, enabled, added_by, written_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

  it("its own statements still run on a database this build wrote, and the rows they make read as code", () => {
    const path = join(root, 'new.db')
    const db = openDb(path)
    const store = new Store(db)
    store.insertWorkspace(workspace('w-work', { kind: 'work', sector: 'purdue' }))
    store.insertProject(project('p-mirror', { workspaceId: 'w-work', lifeosProjectId: 'lp_1' }))
    store.insertSession(meta('s-work', { workspaceId: 'w-work', scope: 'work' }))
    const addons = new AddonStore(db)
    const addon = addons.set({ name: 'lifeos', workspaceId: null, spec: { transport: 'http', url: 'https://lifeos.example/mcp', headers: [], auth: 'none' } }, { kind: 'person' })
    addons.setWorkMarks(addon.id, { role: 'lifeos', forWork: true })
    db.close()

    // The older build's handle: plain SQL, no knowledge of the new columns.
    const old = new DatabaseSync(path)
    old.prepare(OLD_INSERT_WORKSPACE).run('w-older', 'older', '/work/older', 1, 2, null, null, null)
    old.prepare(OLD_INSERT_PROJECT).run('p-older', 'w-older', 'older', 'local', null, '/work/older', 2, null)
    old.prepare(OLD_INSERT_SESSION).run('s-older', null, 'p-older', null, 'chat', null, 'claude', 'm', 'medium', 'implementer', 'older', '/work/older', 'idle', 0, 0, 'edits', 0, 0, 0, null, null, null, null, null, null, null, null, null, null, 0, null, null, 2, 2)
    old.prepare(OLD_WRITE_ADDON).run('ad_older', 'older', null, '', '{"transport":"stdio","command":"x"}', 1, '{"kind":"person"}', '{"kind":"person"}', 2, 2)
    // its reads select every column and pick the ones it knows
    expect((old.prepare(`SELECT * FROM workspaces ORDER BY created_at`).all() as { id: string }[]).map((r) => r.id)).toEqual(['w-work', 'w-older'])
    expect((old.prepare(`SELECT * FROM sessions`).all() as { id: string }[]).map((r) => r.id).sort()).toEqual(['s-older', 's-work'])
    expect(old.prepare(`SELECT * FROM addons WHERE id = 'ad_older'`).get()).toMatchObject({ name: 'older', role: null, for_work: 0 })
    old.close()

    // Back in this build: the older build's rows are code rows, and its own are untouched.
    const again = openDb(path)
    const back = new Store(again)
    expect(back.listWorkspaces().map((w) => [w.id, w.kind, w.sector])).toEqual([['w-work', 'work', 'purdue'], ['w-older', undefined, undefined]])
    expect(back.getSession('s-older')).not.toHaveProperty('scope')
    expect(back.getSession('s-work')?.scope).toBe('work')
    expect(new AddonStore(again).workMarks(addon.id)).toEqual({ role: 'lifeos', forWork: true })
    again.close()
  })
})
