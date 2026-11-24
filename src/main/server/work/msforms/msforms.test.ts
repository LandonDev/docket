import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { MsFormView } from '@shared/contract-work-msforms'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { FakeCarrier, TEST_LIBRARY } from './testing'

/**
 * The Microsoft Forms pillar's frame and its two held kinds, on a fake
 * carrier: the row and its versions, the one reach check, the owner's
 * methods, and Collect responses and an agent's make held for his press.
 */

const scopes = vi.hoisted(() => new Map<string, { workspaceId: string | null; sector: string | null; routineRunId?: string | null }>())
vi.mock('../scope', async (orig) => ({
  ...(await orig<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope | null => {
      const s = scopes.get(id)
      return s ? { sessionId: id, workspaceId: s.workspaceId, sector: s.sector, host: 'env_test', away: false, routineRunId: s.routineRunId ?? null, shared: () => false } : null
    },
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const libs = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('../files/places/libraries', () => ({ librariesHere: () => libs.list, vmLibrariesHere: () => [], forgetLibraries: () => {} }))

const { startWork } = await import('../ctx')
const { outbox } = await import('../outbox/index')
const { msforms } = await import('./index')
const { configureMsCarrier } = await import('./carrier/types')
const { MsformsStore } = await import('./store')
const { NOT_THIS_JOB } = await import('./reach')
const { WORK_MODULES } = await import('../modules')
WORK_MODULES.push(msforms)
afterAll(() => void WORK_MODULES.splice(WORK_MODULES.indexOf(msforms), 1))

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
let carrier: FakeCarrier
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown, by = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), by)
  return (out.handled ? out.result : undefined) as T
}
/** A thread's own call, as the router hands one to the module. */
const asThread = (sessionId: string, method: string, params: unknown) => msforms.handle!({ id: '1', method, params } as ClientRequest, work.ctx, { kind: 'model', caps: [], sessionId })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-msforms-'))
  db = openDb(join(dir, 'test.db'))
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, kind, sector) VALUES ('w1', 'Purdue Esports', ?, 0, 'work', 'purdue')").run(dir)
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, kind, sector) VALUES ('w2', 'Cosmic', ?, 0, 'work', 'cosmic')").run(dir)
  pushes.length = 0
  scopes.clear()
  scopes.set('t1', { workspaceId: 'w1', sector: 'purdue' })
  scopes.set('t2', { workspaceId: 'w2', sector: 'cosmic' })
  scopes.set('chat', { workspaceId: null, sector: null })
  libs.list = [TEST_LIBRARY]
  carrier = new FakeCarrier('w1')
  configureMsCarrier(carrier)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir], denied: () => [] } }, [outbox, msforms])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
})
afterEach(() => {
  configureMsCarrier(null)
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const made = () => call<MsFormView>('work.msforms.make', { workspaceId: 'w1', folder: { libraryId: TEST_LIBRARY.id, path: 'Esports' }, title: 'Spring LAN sign-up' })
const withQuestion = async (): Promise<MsFormView> => {
  const view = await made()
  carrier.forms.get(view.formId)!.questions = [{ title: 'Name', type: 'text', required: true }]
  await call('work.msforms.refresh', { workspaceId: 'w1', formId: view.formId }).catch(() => {})
  new MsformsStore(db).update('w1', view.formId, { questions: [{ title: 'Name', type: 'text', required: true }] })
  return call<MsFormView>('work.msforms.get', { workspaceId: 'w1', formId: view.formId })
}

describe('the row', () => {
  it('is kept with its versions, and no column of it holds an answer', async () => {
    const view = await made()
    expect(view).toMatchObject({ state: 'draft', title: 'Spring LAN sign-up', tenant: 'purdue0', link: null, settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true } })
    expect(view.folder).toMatchObject({ libraryId: TEST_LIBRARY.id, path: 'Esports', siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell' })
    const cols = (db.prepare("SELECT name FROM pragma_table_info('work_msforms')").all() as { name: string }[]).map((c) => c.name)
    expect(cols.some((c) => /answer(s)?$|email|respond|name$/i.test(c) && c !== 'answers_read_at')).toBe(false)
    const store = new MsformsStore(db)
    store.update('w1', view.formId, { questions: [{ title: 'Name', type: 'text', required: true }] }, { by: 'owner' })
    expect(store.versions('w1', view.formId).map((v) => v.rev)).toEqual([0, 1])
    expect(store.get('w1', view.formId)!.rev).toBe(1)
  })

  it('says a make that may take answers, keeping the form', async () => {
    carrier.stopAt.make = 'accepting'
    await expect(made()).rejects.toThrow('may take answers')
    const [row] = new MsformsStore(db).list('w1')
    expect(row).toMatchObject({ state: 'draft', settings: { accepting: true } })
    expect(row.stopped).toContain('turn off Accept responses')
  })
})

describe('the one reach check', () => {
  it('a thread reads its own job’s form and no other', async () => {
    const view = await made()
    const own = await asThread('t1', 'work.msforms.get', { workspaceId: 'w1', formId: view.formId })
    expect((own as { result: MsFormView }).result.formId).toBe(view.formId)
    await expect(asThread('t2', 'work.msforms.get', { workspaceId: 'w1', formId: view.formId })).rejects.toThrow(NOT_THIS_JOB)
    await expect(asThread('t2', 'work.msforms.get', { workspaceId: 'w2', formId: view.formId })).rejects.toThrow(NOT_THIS_JOB)
  })

  it('a Work Chat and a code thread are refused before any form is looked up', async () => {
    const view = await made()
    await expect(asThread('chat', 'work.msforms.get', { workspaceId: 'w1', formId: view.formId })).rejects.toThrow(NOT_THIS_JOB)
    await expect(asThread('code', 'work.msforms.list', { workspaceId: 'w1' })).rejects.toThrow(NOT_THIS_JOB)
  })

  it('a job whose sector changed, or a library no longer reached, reaches the form no more', async () => {
    const view = await made()
    db.prepare("UPDATE workspaces SET sector = 'life' WHERE id = 'w1'").run()
    await expect(call('work.msforms.get', { workspaceId: 'w1', formId: view.formId })).rejects.toThrow('not in this job')
    db.prepare("UPDATE workspaces SET sector = 'purdue' WHERE id = 'w1'").run()
    libs.list = []
    await expect(call('work.msforms.get', { workspaceId: 'w1', formId: view.formId })).rejects.toThrow('not one this computer reaches')
    expect((await call<{ forms: MsFormView[] }>('work.msforms.list', { workspaceId: 'w1' })).forms).toEqual([])
  })

  it('a thread calling an owner method is refused', async () => {
    const view = await made()
    for (const [method, extra] of [
      ['work.msforms.make', { folder: { libraryId: TEST_LIBRARY.id, path: '' }, title: 'x' }],
      ['work.msforms.publish', { formId: view.formId }],
      ['work.msforms.close', { formId: view.formId, open: false }],
      ['work.msforms.mode', { formId: view.formId, mode: 'writes' }],
      ['work.msforms.review', { formId: view.formId, accept: [], reject: [] }]
    ] as const)
      await expect(asThread('t1', method, { workspaceId: 'w1', ...extra })).rejects.toThrow('only the owner')
    expect(carrier.calls.filter((c) => c.op !== 'make')).toEqual([])
  })
})

describe('Collect responses, held', () => {
  it('waits for his press, takes no grant, and runs once', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref']; rev: number }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
    await expect(call('work.outbox.grant', { ref, label: 'always' })).rejects.toThrow()
    const sent = await call<OutboxItem>('work.outbox.send', { ref })
    expect(sent.state).toBe('sent')
    const after = await call<MsFormView>('work.msforms.get', { workspaceId: 'w1', formId: view.formId })
    expect(after).toMatchObject({ state: 'collecting', held: null, link: `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${view.formId}` })
    await call('work.outbox.send', { ref }).catch(() => {})
    expect(carrier.calls.filter((c) => c.op === 'collect')).toHaveLength(1)
  })

  it('reads stale and collects nothing when the form changed after the hold', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    new MsformsStore(db).update('w1', view.formId, { title: 'Renamed' }, { bump: true })
    const sent = await call<OutboxItem>('work.outbox.send', { ref })
    expect(sent.state).toBe('stale')
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
  })

  it('reads stale when the page was changed in Forms after the hold', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    carrier.forms.get(view.formId)!.questions.push({ title: 'Phone', type: 'text', required: false })
    const sent = await call<OutboxItem>('work.outbox.send', { ref })
    expect(sent.state).toBe('stale')
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
  })

  it('his close and reopen run at once', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    await call('work.outbox.send', { ref })
    const closed = await call<MsFormView>('work.msforms.close', { workspaceId: 'w1', formId: view.formId, open: false })
    expect(closed.state).toBe('closed')
    const open = await call<MsFormView>('work.msforms.close', { workspaceId: 'w1', formId: view.formId, open: true })
    expect(open.state).toBe('collecting')
  })
})
