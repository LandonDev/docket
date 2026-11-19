import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { NotBuilt, PILLAR_IDS, PILLAR_MILESTONE, workToolNameProblem, type WorkScope } from '@shared/work'
import { openDb, Store } from '../db'
import type { SessionRegistry } from '../sessions'
import { startWork, type Work } from './ctx'
import { inputShapeOf, WORK_MODULES } from './modules'
import { ensureWorkTables } from './schema'

/** The frame as it ships: every pillar a stub, every member of the context a stub that says which milestone builds it. */

let dir: string
let db: ReturnType<typeof openDb>
let work: Work
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-ctx-'))
  db = openDb(join(dir, 'test.db'))
  // one thread exists, so a bridge call with its token gets as far as the module
  const registry = { get: (id: string) => (id === 't1' ? { id: 't1', provider: 'codex' } : null) } as unknown as SessionRegistry
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} })
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest

describe('the module list', () => {
  it('holds one module per pillar, in the pillars\' order', () => {
    expect(WORK_MODULES.map((m) => m.id)).toEqual([...PILLAR_IDS])
  })
  it("every module's ensure runs on a fresh database, and again on one it already made", () => {
    expect(() => ensureWorkTables(db)).not.toThrow()
    expect(() => ensureWorkTables(db)).not.toThrow()
  })
  it('a module whose ensure fails never stops the host: the fault is logged and comes back as the pillar\'s word', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { id: 'mail' as const, ensure: () => void db.exec('CREATE TABLE') }
    const fine = { id: 'tasks' as const, ensure: () => void db.exec('CREATE TABLE IF NOT EXISTS work_tasks_fake (id TEXT PRIMARY KEY)') }
    const failed = ensureWorkTables(db, [broken, fine])
    expect([...failed.keys()]).toEqual(['mail'])
    expect(failed.get('mail')).toMatch(/^work: mail could not make its tables: /)
    expect(String(said.mock.calls[0][0])).toMatch(/^\[work\] work: mail could not make its tables: /)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'work_tasks_fake'`).get()).toEqual({ name: 'work_tasks_fake' })
    said.mockRestore()
  })
  it('every tool a module registers has a name Claude can carry and a z.object input', () => {
    const scope: WorkScope = { sessionId: 's', workspaceId: 'w', sector: 'purdue', host: 'env_test', away: false, routineRunId: null, shared: () => false }
    const names = new Set<string>()
    for (const module of WORK_MODULES) {
      for (const tool of module.tools?.(scope) ?? []) {
        expect(workToolNameProblem(tool.name), `${module.id}: ${tool.name}`).toBeNull()
        expect(inputShapeOf(tool.input), `${module.id}: ${tool.name} input`).not.toBeNull()
        expect(names.has(tool.name), `${tool.name} registered twice`).toBe(false)
        names.add(tool.name)
      }
    }
  })
})

describe('the context', () => {
  it('has the host, the database, the switch and the settings built', () => {
    const { ctx } = work
    expect(ctx.host).toBe('env_test')
    expect(ctx.db).toBe(db)
    expect(ctx.enabled()).toBe(false)
    expect(ctx.settings.workspace('w1')).toEqual({ mayUseDesktop: [], voice: false })
    expect(() => ctx.log('a line')).not.toThrow()
  })
  it('answers "not built" from every member a later milestone builds, naming that milestone', () => {
    const { ctx } = work
    const calls: [string, number, () => unknown][] = [
      ['ctx.scopeOf', 6, () => ctx.scopeOf('s')],
      ['ctx.threads.start', 6, () => ctx.threads.start({ workspaceId: 'w', text: 't' })],
      ['ctx.threads.resume', 6, () => ctx.threads.resume('s', 'n')],
      ['ctx.threads.ownerSaid', 6, () => ctx.threads.ownerSaid('s', 'q')],
      ['ctx.peer', 6, () => ctx.peer('env_mac')],
      ['ctx.lifeos.connected', 7, () => ctx.lifeos.connected()],
      ['ctx.lifeos.owner', 7, () => ctx.lifeos.owner()],
      ['ctx.lifeos.jwt', 7, () => ctx.lifeos.jwt('purdue')],
      ['ctx.lifeos.subscribe', 7, () => ctx.lifeos.subscribe('events.since', {}, () => {})],
      ['ctx.links.link', 7, () => ctx.links.link({ kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'k' } }, 's', 'T')],
      ['ctx.links.forThread', 7, () => ctx.links.forThread('s')],
      ['ctx.links.completeFor', 7, () => ctx.links.completeFor('s', 'sent')],
      ['ctx.canvas.open', 9, () => ctx.canvas.open('s', 'pdf', { at: 'thread' }, 'A')],
      ['ctx.canvas.close', 9, () => ctx.canvas.close('i')],
      ['ctx.canvas.forSession', 9, () => ctx.canvas.forSession('s')],
      ['ctx.held.create', 10, () => ctx.held.create({ kind: 'addon.call', sessionId: 's', payload: {} })],
      ['ctx.held.onDecided', 10, () => ctx.held.onDecided(() => {})],
      ['ctx.results.add', 14, () => ctx.results.add({ sessionId: 's', kind: 'task', summary: 'Added a task' })],
      ['ctx.convert', 15, () => ctx.convert({ from: 'odt', to: 'docx', input: '/a.odt' })],
      ['ctx.service.url', 18, () => ctx.service.url('/w/doc/d1')],
      ['ctx.service.token', 18, () => ctx.service.token({ item: { doc: 'd1' }, role: 'edit', principal: 'owner' })],
      ['ctx.service.internal', 18, () => ctx.service.internal('/internal/doc/read', {})]
    ]
    for (const [what, milestone, call] of calls) {
      let caught: unknown
      try {
        call()
      } catch (err) {
        caught = err
      }
      expect(caught, what).toBeInstanceOf(NotBuilt)
      expect((caught as NotBuilt).message, what).toBe(`not built: ${what} (milestone ${milestone})`)
    }
  })
})

describe('before a create', () => {
  const by = { kind: 'local' as const, caps: [] }
  it('a create that does not ask for Work passes untouched', () => {
    expect(() => work.admitSession({ provider: 'claude', model: 'm' } as never, by)).not.toThrow()
    expect(() => work.admitSession({ provider: 'claude', model: 'm', scope: 'code' } as never, by)).not.toThrow()
  })
  it('a create that asks for Work, or carries a chip, is refused by name: no Work thing is made before its milestone', async () => {
    expect(() => work.admitSession({ provider: 'claude', model: 'm', scope: 'work' } as never, by)).toThrow("not built: session.create {scope: 'work'} (milestone 6)")
    expect(() => work.admitSession({ provider: 'claude', model: 'm', about: { kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'k' } } } as never, by)).toThrow('not built: session.create {about} (milestone 7)')
    expect(() => work.createWorkspace({ name: 'Purdue', sector: 'purdue' }, by)).toThrow("not built: workspace.create {kind: 'work'} (milestone 6)")
  })
})

describe('the router, as the stubs ship', () => {
  it('answers the switch and leaves every other method to the rest of the chain', async () => {
    expect(await work.handle(req('work.get'), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { enabled: false } })
    expect(await work.handle(req('session.list', {}), LOCAL_PRINCIPAL)).toEqual({ handled: false })
    expect(await work.handle(req('workspace.list'), LOCAL_PRINCIPAL)).toEqual({ handled: false })
  })
  it('refuses every pillar method while Work is off', async () => {
    for (const id of PILLAR_IDS) await expect(work.handle(req(`work.${id}.list`, {}), LOCAL_PRINCIPAL)).rejects.toThrow('Work is off on this host')
  })
  it('with Work on, a pillar method no module answers says "not built" and the milestone, for every pillar', async () => {
    expect(await work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { enabled: true } })
    for (const id of PILLAR_IDS) {
      await expect(work.handle(req(`work.${id}.list`, {}), LOCAL_PRINCIPAL)).rejects.toThrow(`not built: work.${id}.list (milestone ${PILLAR_MILESTONE[id]})`)
      const bridge = `app.work${id[0].toUpperCase()}${id.slice(1)}List`
      await expect(work.handle(req(bridge, { sessionId: 't1', token: work.tools.tokenFor('t1') }), LOCAL_PRINCIPAL)).rejects.toThrow(`not built: ${bridge} (milestone ${PILLAR_MILESTONE[id]})`)
      // a pillar's bridge method is a thread's own call: without that thread's token it is refused before any module is asked
      await expect(work.handle(req(bridge, { sessionId: 't1' }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    }
  })
  it('while Work is off a bridge that asks hears no tool, and a call or a cancel does nothing', async () => {
    const token = work.tools.tokenFor('t1')
    expect(await work.handle(req('app.workTools', { sessionId: 't1', token }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { tools: [] } })
    await expect(work.handle(req('app.workCall', { sessionId: 't1', token, call: 1, tool: 'mail_search', args: {} }), LOCAL_PRINCIPAL)).rejects.toThrow('unknown tool: mail_search')
    expect(await work.handle(req('app.workCancel', { sessionId: 't1', token, call: 1 }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: null })
  })
  it('lists no tool to any thread, on or off, and refuses a bridge call that is not the thread\'s own', async () => {
    expect(work.tools.of({ id: 's', scope: undefined })).toBeNull()
    work.settings.set({ enabled: true })
    expect(work.tools.of({ id: 's', scope: undefined })).toBeNull()
    expect(work.tools.of({ id: 's', scope: 'code' })).toBeNull()
    await expect(work.handle(req('app.workTools', { sessionId: 's', token: 'guess' }), LOCAL_PRINCIPAL)).rejects.toThrow("forbidden: not this thread's Work token")
    await expect(work.handle(req('app.workTools', { sessionId: 's', token: work.tools.tokenFor('s') }), LOCAL_PRINCIPAL)).rejects.toThrow('unknown thread: s')
  })
})
