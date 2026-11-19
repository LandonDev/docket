import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { appListThreads, appStartThread } from '../apptools'
import { openDb, Store } from '../db'
import type { DriverCtx, DriverHandle } from '../drivers/types'
import { cancelMirrors } from '../mirror'
import { orchSpawnAgent, setOrchestrationRegistry } from '../orchestration'
import { SessionRegistry } from '../sessions'

/**
 * Master with Work off is the app before Work (milestone 49, from milestone
 * 6's hand-run snapshot): every way a code thread starts (a loose chat, a
 * workspace chat, a project's build with its rules, a child, one that opts
 * out of the rules, Codex, app_start_thread, spawn_agent) makes the same row
 * and sends the same first message whether Work was never set, is off, or is
 * on. Compared within one run, so a new tool or field never makes it stale.
 */

const sent = new Map<string, string[]>()
vi.mock('../drivers', () => {
  const fake = (id: string) => ({
    id,
    start: async (ctx: DriverCtx): Promise<DriverHandle> => ({
      confirmsSteers: true,
      send: async (text: string) => {
        sent.set(ctx.session.id, [...(sent.get(ctx.session.id) ?? []), text])
        ctx.emit({ type: 'status', status: 'running' })
      },
      interrupt: () => {},
      alive: () => true,
      dispose: async () => {}
    })
  })
  return { BUILT_IN_DRIVERS: { claude: fake('claude'), codex: fake('codex'), muse: fake('muse') } }
})

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function startPaths(work: 'unset' | 'off' | 'on'): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'switch-off-'))
  roots.push(root)
  const db = openDb(join(root, 'test.db'))
  const store = new Store(db)
  store.setSetting('workspace.root', root)
  if (work !== 'unset') store.setSetting('work', JSON.stringify({ enabled: work === 'on' }))
  const registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  const path = join(root, 'repo')
  mkdirSync(path)
  const ws = await registry.createWorkspace(path)
  const project = await registry.createProject(ws.id, 'main', 'local')
  registry.setProjectPreamble(project.id, 'Rules for {{project}} on {{worktree}}.', true)
  const ids: Record<string, string> = { workspace: ws.id, project: project.id }
  const norm = (text: string): string => {
    let t = text.replaceAll(root, '<root>')
    for (const [k, v] of Object.entries(ids)) t = t.replaceAll(v, `<${k}>`)
    return t.replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
  }
  const mk = async (name: string, fn: () => Promise<SessionMeta>): Promise<void> => {
    ids[name] = (await fn()).id
  }
  await mk('loose', () => registry.startWith({ threadType: 'chat', cwd: path, workspaceId: null, title: 'Loose' }, 'hello there'))
  await mk('wschat', () => registry.startWith({ threadType: 'chat', workspaceId: ws.id, title: 'Ws chat' }, 'hello ws'))
  await mk('impl', () => registry.startWith({ threadType: 'implementation', projectId: project.id, title: 'Build' }, 'build it'))
  await mk('child', () => registry.startWith({ parentId: ids.impl, projectId: project.id, cwd: path, title: 'Child' }, 'look into it'))
  await mk('optout', () => registry.startWith({ parentId: ids.impl, projectId: project.id, cwd: path, title: 'Opt' }, 'no rules', { preamble: false }))
  await mk('codex', () => registry.startWith({ threadType: 'chat', projectId: project.id, provider: 'codex', title: 'Codex' }, 'hi codex'))
  ids.started = ((await appStartThread(registry, registry.get(ids.impl)!, { threadType: 'research', provider: 'claude', firstMessage: 'research it', title: 'Started' })) as { threadId: string }).threadId
  ids.spawned = JSON.parse(await orchSpawnAgent(registry.get(ids.impl)!, { task: 'explore', model: 'claude-opus-5-5', provider: 'claude', agentType: 'explorer', title: 'Spawned' })).agentId
  const snap: Record<string, unknown> = {}
  for (const [name, id] of Object.entries(ids)) {
    if (name === 'workspace' || name === 'project') continue
    const { id: _i, createdAt: _c, updatedAt: _u, busySince: _b, ...row } = store.getSession(id)! as SessionMeta & Record<string, unknown>
    snap[name] = { row: JSON.parse(norm(JSON.stringify(row))), first: norm(sent.get(id)?.[0] ?? '') }
  }
  snap.list = appListThreads(registry, registry.get(ids.impl)!, true).map((t) => norm(String(t.title)))
  snap.workspaces = JSON.parse(norm(JSON.stringify(registry.listWorkspaces().map(({ id: _i, createdAt: _c, ...w }) => w))))
  cancelMirrors()
  await registry.close()
  db.close()
  return snap
}

it("a code thread's every start path is the same with Work never set, off, and on", async () => {
  const unset = await startPaths('unset')
  expect(Object.keys(unset)).toHaveLength(10)
  expect((unset.impl as { first: string }).first).toContain('Rules for main')
  expect(await startPaths('off')).toEqual(unset)
  expect(await startPaths('on')).toEqual(unset)
}, 60_000)
