import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { MsFormResponses, MsFormView } from '@shared/contract-work-msforms'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import { ensureBrowserTables } from '../browser/drive'
import { formsWorkbook, madeUpAnswers } from './answers/testWorkbook'
import { FakeCarrier, TEST_LIBRARY } from './testing'

/**
 * The Microsoft Forms pillar's frame and its two held kinds, on a fake
 * carrier: the row and its versions, the one reach check, the owner's
 * methods, and Collect responses and an agent's make held for his press.
 */

const scopes = vi.hoisted(() => new Map<string, { workspaceId: string | null; sector: string | null; routineRunId?: string | null; away?: boolean }>())
vi.mock('../scope', async (orig) => ({
  ...(await orig<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope | null => {
      const s = scopes.get(id)
      return s ? { sessionId: id, workspaceId: s.workspaceId, sector: s.sector, host: 'env_test', away: s.away ?? false, routineRunId: s.routineRunId ?? null, shared: () => false } : null
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
const { MOVED, pollAnswers, READ_FAILED, resetAnswerReads, signInNeeded } = await import('./answers/read')
const { CarrierBusy, CarrierSignIn, CarrierStop } = await import('./carrier/types')
const { onNewAnswers } = await import('./events')
const { ensureDigestTables } = await import('../digest/store')
WORK_MODULES.push(msforms)
afterAll(() => void WORK_MODULES.splice(WORK_MODULES.indexOf(msforms), 1))

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
let carrier: FakeCarrier
const pushes: WorkPush[] = []
const logs: string[] = []
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
  logs.length = 0
  resetAnswerReads()
  scopes.clear()
  scopes.set('t1', { workspaceId: 'w1', sector: 'purdue' })
  scopes.set('t2', { workspaceId: 'w2', sector: 'cosmic' })
  scopes.set('chat', { workspaceId: null, sector: null })
  libs.list = [TEST_LIBRARY]
  carrier = new FakeCarrier('w1')
  configureMsCarrier(carrier)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: (line: string) => void logs.push(line), remoteFence: { roots: () => [dir], denied: () => [] } }, [outbox, msforms])
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
    expect(row.stopped).toContain('until Accept responses is off')
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

describe("an agent's make, held", () => {
  const payload = (collect: boolean) => ({
    workspaceId: 'w1',
    sessionId: 't1',
    folder: { libraryId: TEST_LIBRARY.id, path: 'Esports', siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell' },
    title: 'Spring LAN survey',
    description: '',
    questions: [{ title: 'Which night?', type: 'choice', options: ['Mon', 'Tue'], required: true }],
    settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true },
    collect,
    content: 'Spring LAN survey'
  })

  it('stays held while he is away, takes no grant, and makes nothing until his press', async () => {
    scopes.set('t1', { workspaceId: 'w1', sector: 'purdue', away: true })
    const item = work.ctx.held.create({ kind: 'msform.make', sessionId: 't1', payload: payload(false) })
    expect(item.state).toBe('held')
    await expect(call('work.outbox.grant', { ref: item.ref, label: 'always' })).rejects.toThrow()
    expect(carrier.calls).toEqual([])
    const sent = await call<OutboxItem>('work.outbox.send', { ref: item.ref })
    expect(sent.state).toBe('sent')
    const [row] = new MsformsStore(db).list('w1')
    expect(row).toMatchObject({ state: 'draft', title: 'Spring LAN survey', madeBy: 'agent:env_test:t1' })
    expect(row.questions).toHaveLength(1)
  })

  it('with collect, makes and collects in one press', async () => {
    const item = work.ctx.held.create({ kind: 'msform.make', sessionId: 't1', payload: payload(true) })
    const sent = await call<OutboxItem>('work.outbox.send', { ref: item.ref })
    expect(sent.state).toBe('sent')
    const [row] = new MsformsStore(db).list('w1')
    expect(row.state).toBe('collecting')
    expect(carrier.calls.map((c) => c.op)).toEqual(['make', 'read', 'collect'])
  })
})

describe('who can answer, held', () => {
  it('changes only who can answer and keeps Accept responses as it was', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    await call('work.outbox.send', { ref })
    await call('work.msforms.close', { workspaceId: 'w1', formId: view.formId, open: false })
    const { holdPublish } = await import('./forms')
    const { formReach } = await import('./reach')
    const at = formReach(work.ctx, { kind: 'local', caps: [] }, { workspaceId: 'w1', formId: view.formId })
    const wider = { ...at.row.settings, orgOnly: false }
    const { held } = holdPublish(work.ctx, at, 'audience', wider, 't1')
    expect(held!.state).toBe('held')
    const sent = await call<OutboxItem>('work.outbox.send', { ref: held!.ref })
    expect(sent.state).toBe('sent')
    expect(carrier.forms.get(view.formId)!.settings).toMatchObject({ orgOnly: false, accepting: false })
  })
})

describe('the answers read', () => {
  const Q = [{ title: 'Which night?', type: 'choice' as const, options: ['Mon', 'Tue'], required: true }]
  /** Made-up answers whose words a test then looks for everywhere Work keeps anything. */
  const SECRET = ['Zorble-7Q', 'Quandle-3X', 'Mon-Plinth']
  const book = (n: number) => formsWorkbook(['Which night?'], madeUpAnswers(n, (i) => [SECRET[i % SECRET.length]!]))
  const ask = (formId: string) => ({ workspaceId: 'w1', formId })
  /** A collecting form with `n` answers in Forms and its workbook. */
  const collecting = async (n: number): Promise<MsFormView> => {
    const view = await made()
    new MsformsStore(db).update('w1', view.formId, { state: 'collecting', questions: Q })
    carrier.forms.get(view.formId)!.count = n
    carrier.pullBytes = book(n)
    carrier.calls.length = 0
    return view
  }
  const ops = () => carrier.calls.map((c) => c.op)
  const answers = (n: number) => {
    carrier.pullBytes = book(n)
    for (const f of carrier.forms.values()) f.count = n
  }

  it('reads on his Refresh, keeps the workbook once its place checks, and says the new answers by Id', async () => {
    const view = await collecting(2)
    const heard: unknown[] = []
    const off = onNewAnswers((e) => heard.push(e))
    try {
      const got = await call<MsFormResponses>('work.msforms.refresh', ask(view.formId))
      expect(got).toMatchObject({ count: 2, cut: false, stale: false, none: false })
      expect(got.rows.map((r) => r[0])).toEqual(['2', '1'])
      expect(got.columns.map((c) => c.label)).toEqual(['Id', 'Start time', 'Completion time', 'Email', 'Name', 'Which night?'])
      expect(carrier.asks[0]).toMatchObject({ uniqueId: null, name: 'Spring LAN sign-up.xlsx', folderServerPath: '/sites/RecWell/Shared Documents/Esports', lastModified: null })
      const row = new MsformsStore(db).get('w1', view.formId)!
      expect(row).toMatchObject({ count: 2, lastId: 2, workbook: { libraryId: TEST_LIBRARY.id, path: 'Esports/x.xlsx', uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4', parentId: 'parent-1', name: 'x.xlsx' } })
      expect(row.answersReadAt).not.toBeNull()
      expect(heard).toEqual([expect.objectContaining({ formId: view.formId, added: 2, count: 2, fromId: 1, toId: 2 })])
      expect(pushes.some((p) => (p as { push: string; view?: MsFormView }).push === 'work.msforms' && (p as { view?: MsFormView }).view?.count === 2)).toBe(true)
      // the next read finds it by its id, and only the answers past the last are new
      answers(3)
      await call('work.msforms.refresh', ask(view.formId))
      expect(carrier.asks[1]).toMatchObject({ uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4', lastModified: '2026-11-24T17:22:33Z' })
      expect(heard[1]).toMatchObject({ added: 1, fromId: 3, toId: 3 })
    } finally {
      off()
    }
  })

  it('stops at the count when it is unchanged and the rows are kept; with none kept it reads in full', async () => {
    const view = await collecting(2)
    await call('work.msforms.refresh', ask(view.formId))
    carrier.calls.length = 0
    await call('work.msforms.refresh', ask(view.formId))
    expect(ops()).toEqual(['count'])
    resetAnswerReads()
    carrier.calls.length = 0
    const got = await call<MsFormResponses>('work.msforms.refresh', ask(view.formId))
    expect(ops()).toEqual(['count', 'pull'])
    expect(got.rows).toHaveLength(2)
  })

  it('answers from memory while the last read is fresh, and reads first when it is older than two minutes', async () => {
    const view = await collecting(1)
    await call('work.msforms.responses', ask(view.formId))
    carrier.calls.length = 0
    expect((await call<MsFormResponses>('work.msforms.responses', ask(view.formId))).rows).toHaveLength(1)
    expect(ops()).toEqual([])
    new MsformsStore(db).update('w1', view.formId, { answersReadAt: Date.now() - 3 * 60_000 })
    await call('work.msforms.responses', ask(view.formId))
    expect(ops()).toEqual(['count'])
  })

  it('a timeout keeps the last rows, marked stale, and its own words go nowhere', async () => {
    const view = await collecting(2)
    await call('work.msforms.refresh', ask(view.formId))
    answers(3)
    carrier.pullThrows = new Error(`Navigation timeout of 30000 ms exceeded at ${SECRET[0]}`)
    await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow(READ_FAILED)
    const got = await call<MsFormResponses>('work.msforms.responses', ask(view.formId))
    expect(got).toMatchObject({ stale: true, count: 2 })
    expect(got.rows).toHaveLength(2)
    expect(new MsformsStore(db).get('w1', view.formId)).toMatchObject({ count: 2, lastId: 2, stopped: READ_FAILED })
    // a carrier stop says its own sentence, and the rows stay stale
    carrier.pullThrows = new CarrierStop('SharePoint did not give the workbook. The answers were not read.', null)
    await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow('SharePoint did not give the workbook')
    carrier.pullThrows = null
    expect(await call<MsFormResponses>('work.msforms.refresh', ask(view.formId))).toMatchObject({ stale: false, count: 3 })
  })

  it('refuses a workbook that is not in the form’s folder, and does not keep it', async () => {
    const view = await collecting(1)
    carrier.pullPath = '/sites/RecWell/Shared Documents/Elsewhere/x.xlsx'
    await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow(MOVED)
    expect(new MsformsStore(db).get('w1', view.formId)).toMatchObject({ workbook: null, count: 0, stopped: MOVED })
    await expect(call('work.msforms.responses', ask(view.formId))).rejects.toThrow(MOVED)
  })

  it("keeps a Team form's workbook at its library's root, where Forms puts it (P1), by its path in the library", async () => {
    const view = await collecting(1)
    carrier.pullPath = '/sites/RecWell/Shared Documents/Spring LAN sign-up.xlsx'
    await call('work.msforms.refresh', ask(view.formId))
    expect(new MsformsStore(db).get('w1', view.formId)!.workbook).toMatchObject({ libraryId: TEST_LIBRARY.id, path: 'Spring LAN sign-up.xlsx', name: 'Spring LAN sign-up.xlsx' })
  })

  it('a sign-in marks Connections "Needs you" until a read gets through', async () => {
    const view = await collecting(1)
    carrier.pullThrows = new CarrierSignIn()
    await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow('sign-in')
    expect(signInNeeded()).toBe(true)
    carrier.pullThrows = null
    await call('work.msforms.refresh', ask(view.formId))
    expect(signInNeeded()).toBe(false)
  })

  it("a thread reads its own job's answers; a routine's thread is withheld Purdue's", async () => {
    const view = await collecting(1)
    const own = (await asThread('t1', 'work.msforms.responses', ask(view.formId))) as { result: MsFormResponses }
    expect(own.result.rows).toHaveLength(1)
    await expect(asThread('t2', 'work.msforms.responses', ask(view.formId))).rejects.toThrow(NOT_THIS_JOB)
    scopes.set('r1', { workspaceId: 'w1', sector: 'purdue', routineRunId: 'run1' })
    await expect(asThread('r1', 'work.msforms.responses', ask(view.formId))).rejects.toThrow(MSFORM_WITHHELD_WORDS)
    await expect(asThread('t1', 'work.msforms.refresh', ask(view.formId))).rejects.toThrow('only the owner')
  })

  it('the poller checks each collecting form on its schedule, waits out a busy carrier, and never while he drives', async () => {
    const view = await collecting(1)
    const t0 = Date.now()
    await pollAnswers(work.ctx, t0)
    expect(ops()).toEqual(['count', 'pull'])
    carrier.calls.length = 0
    await pollAnswers(work.ctx, t0 + 30 * 60_000)
    expect(ops()).toEqual([])
    await pollAnswers(work.ctx, t0 + 61 * 60_000)
    expect(ops()).toEqual(['count'])
    // a busy carrier: nothing is marked tried, so the next tick goes again
    carrier.calls.length = 0
    carrier.countThrows = new CarrierBusy('busy')
    await pollAnswers(work.ctx, t0 + 125 * 60_000)
    carrier.countThrows = null
    await pollAnswers(work.ctx, t0 + 126 * 60_000)
    // the busy try, then the next tick's
    expect(ops()).toEqual(['count', 'count'])
    // only when he looks, a draft, and while he drives: nothing
    carrier.calls.length = 0
    new MsformsStore(db).update('w1', view.formId, { check: 'look' })
    await pollAnswers(work.ctx, t0 + 500 * 60_000)
    new MsformsStore(db).update('w1', view.formId, { check: 'quarter', state: 'draft' })
    await pollAnswers(work.ctx, t0 + 600 * 60_000)
    new MsformsStore(db).update('w1', view.formId, { state: 'collecting' })
    ensureBrowserTables(db)
    db.prepare("INSERT INTO work_browser_drive (session_id, driver, since) VALUES ('pane', 'owner', 0)").run()
    await pollAnswers(work.ctx, t0 + 700 * 60_000)
    expect(ops()).toEqual([])
  })

  it('the data rule: no answer, name or address reaches the database, a log line, a tell or a push, through a read, an error, a timeout and a restart', async () => {
    const heard: unknown[] = []
    const off = onNewAnswers((e) => heard.push(e))
    const words = [...SECRET, 'Dummy Person 1', 'dummy1@example.test', 'dummy2@example.test']
    const everything = (): string => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
      const rows = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()))
      return [...rows, ...logs, JSON.stringify(pushes), JSON.stringify(heard)].join('\n')
    }
    const clean = () => {
      const all = everything()
      for (const w of words) expect(all.includes(w), w).toBe(false)
    }
    try {
      const view = await collecting(3)
      // a read
      expect((await call<MsFormResponses>('work.msforms.refresh', ask(view.formId))).rows.flat()).toContain(SECRET[0])
      clean()
      // an error whose own words quote a made-up answer
      answers(4)
      carrier.pullThrows = new Error(`Unexpected cell ${SECRET[1]} from dummy2@example.test`)
      await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow(READ_FAILED)
      clean()
      // a timeout
      carrier.pullThrows = new CarrierStop('The workbook did not show in the form\'s folder. The answers were not read.', null)
      await expect(call('work.msforms.refresh', ask(view.formId))).rejects.toThrow('did not show')
      clean()
      // a restart: a fresh module state reads again, and still keeps nothing
      carrier.pullThrows = null
      work.close()
      resetAnswerReads()
      work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: (line: string) => void logs.push(line), remoteFence: { roots: () => [dir], denied: () => [] } }, [outbox, msforms])
      work.pushes.onPush((p) => pushes.push(p))
      const again = await call<MsFormResponses>('work.msforms.responses', ask(view.formId))
      expect(again.rows).toHaveLength(4)
      clean()
    } finally {
      off()
    }
  })

  const tellRows = (formId: string) => (ensureDigestTables(db), tellRowsOf(formId))
  const tellRowsOf = (formId: string) => db.prepare('SELECT title, open FROM work_digest_tells WHERE key = ?').all(`msforms:${formId}`) as { title: string; open: string }[]

  it('tells new answers once a form, with the unseen count, in place, with no name; his look at Responses ends it', async () => {
    ensureDigestTables(db)
    const view = await collecting(2)
    await call('work.msforms.refresh', ask(view.formId))
    expect(tellRows(view.formId)).toEqual([{ title: '2 new responses to Spring LAN sign-up', open: expect.stringContaining('"view":"forms"') }])
    answers(3)
    await call('work.msforms.refresh', ask(view.formId))
    const [row] = tellRows(view.formId)
    expect(tellRows(view.formId)).toHaveLength(1)
    expect(row!.title).toBe('3 new responses to Spring LAN sign-up')
    for (const w of ['Dummy Person', 'example.test', ...SECRET]) expect(JSON.stringify(row)).not.toContain(w)
    await call('work.msforms.seen', ask(view.formId))
    expect(tellRows(view.formId)).toEqual([])
    // only what came after his look is new
    answers(4)
    await call('work.msforms.refresh', ask(view.formId))
    expect(tellRows(view.formId).map((r) => r.title)).toEqual(['1 new response to Spring LAN sign-up'])
  })

  it('says the forms each address answered, matched lower-cased, reading first what is not in memory; never another sector’s', async () => {
    const view = await collecting(2)
    const other = await collecting(1)
    new MsformsStore(db).update('w1', other.formId, { sector: 'cosmic', count: 1 })
    new MsformsStore(db).update('w1', view.formId, { count: 2 })
    resetAnswerReads()
    carrier.calls.length = 0
    const got = await call<{ email: string; forms: { formId: string; title: string; at: number | null }[] }[]>('work.msforms.byPerson', { workspaceId: 'w1', emails: ['DUMMY1@Example.Test', 'nobody@example.test'] })
    expect(got).toEqual([
      { email: 'dummy1@example.test', forms: [{ formId: view.formId, title: 'Spring LAN sign-up', tenant: 'purdue0', at: new Date(2026, 10, 24, 9, 0).getTime() }] },
      { email: 'nobody@example.test', forms: [] }
    ])
    expect(carrier.calls.filter((c) => c.op === 'pull').map((c) => c.formId)).toEqual([view.formId])
  })

  it("a routine's thread in Purdue is told no one answered anything", async () => {
    const view = await collecting(1)
    await call('work.msforms.refresh', ask(view.formId))
    scopes.set('r1', { workspaceId: 'w1', sector: 'purdue', routineRunId: 'run1' })
    const withheld = (await asThread('r1', 'work.msforms.byPerson', { workspaceId: 'w1', emails: ['dummy1@example.test'] })) as { result: { forms: unknown[] }[] }
    expect(withheld.result).toEqual([{ email: 'dummy1@example.test', forms: [] }])
    const own = (await asThread('t1', 'work.msforms.byPerson', { workspaceId: 'w1', emails: ['dummy1@example.test'] })) as { result: { forms: unknown[] }[] }
    expect(own.result[0]!.forms).toHaveLength(1)
  })
})

describe('the review’s hold fixes', () => {
  it('Collect never sends a held item of another act or settings at the same rev', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    await call('work.outbox.send', { ref })
    await call('work.msforms.close', { workspaceId: 'w1', formId: view.formId, open: false })
    const { holdPublish } = await import('./forms')
    const { formReach } = await import('./reach')
    const at = formReach(work.ctx, { kind: 'local', caps: [] }, { workspaceId: 'w1', formId: view.formId })
    // An agent's reopen that also widens who can answer waits; his own Reopen must not send it.
    const wider = holdPublish(work.ctx, at, 'reopen', { ...at.row.settings, accepting: true, orgOnly: false }, 't1').held!
    const mine = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    expect(mine.ref).not.toEqual(wider.ref)
  })

  it('a press is stale when the form’s own settings changed in the page after the hold', async () => {
    const view = await withQuestion()
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    carrier.forms.get(view.formId)!.settings.orgOnly = false
    const sent = await call<OutboxItem>('work.outbox.send', { ref })
    expect(sent.state).toBe('stale')
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
  })

  it('make and collect does not collect when what Forms saved is not what was held', async () => {
    const original = carrier.make.bind(carrier)
    carrier.make = async (auth, ask) => {
      const made = await original(auth, ask)
      const f = carrier.forms.get(made.read.formId)!
      f.title = `${f.title} (copy)`
      return { read: { ...made.read, title: f.title } }
    }
    const item = work.ctx.held.create({
      kind: 'msform.make',
      sessionId: 't1',
      payload: { workspaceId: 'w1', sessionId: 't1', folder: { libraryId: TEST_LIBRARY.id, path: 'Esports', siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell' }, title: 'Night survey', description: '', questions: [{ title: 'Which night?', type: 'choice', options: ['Mon'], required: true }], settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true }, collect: true, content: 'Night survey' }
    })
    await call('work.outbox.send', { ref: item.ref })
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
    expect(new MsformsStore(db).list('w1')[0]!.state).toBe('draft')
  })
})
