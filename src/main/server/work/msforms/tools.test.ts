import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { MsFormView } from '@shared/contract-work-msforms'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { formsWorkbook, madeUpAnswers } from './answers/testWorkbook'
import { FakeCarrier, TEST_LIBRARY } from './testing'

/**
 * The msform_* tools on a fake carrier: what each answers, the one reach check
 * (another job's form, a Work Chat), the mode table for an agent's change,
 * the held make, collect, who-can-answer and reopen, and a carrier stop said
 * in the tool's answer.
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
const { resetAnswerReads } = await import('./answers/read')
const { WORK_MODULES } = await import('../modules')
WORK_MODULES.push(msforms)
afterAll(() => void WORK_MODULES.splice(WORK_MODULES.indexOf(msforms), 1))

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
let carrier: FakeCarrier
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown, session = 't1'): Promise<{ text: string; isError?: boolean }> => {
  const r = (await work.tools.call({ id: session, scope: 'work' }, name, args, new AbortController().signal)) as { content: Array<{ text?: string }>; isError?: boolean }
  return { text: r.content.map((c) => c.text ?? '').join(''), isError: r.isError }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-msform-tools-'))
  db = openDb(join(dir, 'test.db'))
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, kind, sector) VALUES ('w1', 'Esports', ?, 0, 'work', 'purdue')").run(dir)
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, kind, sector) VALUES ('w2', 'Cosmic', ?, 0, 'work', 'cosmic')").run(dir)
  scopes.clear()
  scopes.set('t1', { workspaceId: 'w1', sector: 'purdue' })
  scopes.set('t2', { workspaceId: 'w2', sector: 'cosmic' })
  scopes.set('chat', { workspaceId: null, sector: null })
  for (const id of ['t1', 't2', 'chat']) sessions.set(id, { id, provider: 'claude', workspaceId: scopes.get(id)!.workspaceId, scope: 'work' } as SessionMeta)
  libs.list = [TEST_LIBRARY]
  carrier = new FakeCarrier('w1')
  configureMsCarrier(carrier)
  resetAnswerReads()
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir], denied: () => [] } }, [outbox, msforms])
  await call('work.set', { enabled: true })
})
afterEach(() => {
  configureMsCarrier(null)
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const QUESTIONS = [
  { title: 'Which night?', type: 'choice', options: ['Monday', 'Tuesday'], required: true },
  { title: 'Anything else?', type: 'text', required: false }
]
async function aForm(o: { state?: 'draft' | 'collecting'; mode?: 'suggests' | 'writes' } = {}): Promise<MsFormView> {
  const view = await call<MsFormView>('work.msforms.make', { workspaceId: 'w1', folder: { libraryId: TEST_LIBRARY.id, path: 'Esports' }, title: 'Spring sign-up' })
  const f = carrier.forms.get(view.formId)!
  f.questions = structuredClone(QUESTIONS) as typeof f.questions
  const store = new MsformsStore(db)
  store.update('w1', view.formId, { questions: f.questions, mode: o.mode ?? 'suggests' })
  if (o.state === 'collecting') {
    const { ref } = await call<{ ref: OutboxItem['ref'] }>('work.msforms.publish', { workspaceId: 'w1', formId: view.formId })
    await call('work.outbox.send', { ref })
  }
  return call<MsFormView>('work.msforms.get', { workspaceId: 'w1', formId: view.formId })
}

describe('the read tools', () => {
  it('msform_list and msform_read say the job’s forms and a form’s questions by number', async () => {
    const view = await aForm()
    expect((await tool('msform_list', {})).text).toContain(`${view.formId}: Spring sign-up, a draft`)
    const read = (await tool('msform_read', { form: view.formId })).text
    expect(read).toContain('1. Choice "Which night?" with Monday, Tuesday, required')
    expect(read).toContain('2. Text "Anything else?"')
    expect(read).toContain('Only people in the organization can answer')
  })

  it('msform_answers and msform_find read the workbook’s rows', async () => {
    const view = await aForm({ state: 'collecting' })
    carrier.forms.get(view.formId)!.count = 2
    carrier.pullBytes = formsWorkbook(['Which night?', 'Anything else?'], madeUpAnswers(2, (i) => [i ? 'Tuesday' : 'Monday', i ? 'Bring snacks' : '']))
    const answers = (await tool('msform_answers', { form: view.formId })).text
    expect(answers).toContain('Spring sign-up: 2 response(s)')
    expect(answers).toContain('Which night?')
    expect(answers).toContain('Bring snacks')
    expect((await tool('msform_find', { text: 'snacks' })).text).toBe('Spring sign-up · Anything else?: Bring snacks (Dummy Person 2)')
  })

  it('another job’s thread and a Work Chat are refused with the sentence', async () => {
    const view = await aForm()
    for (const session of ['t2', 'chat']) {
      const r = await tool('msform_read', { form: view.formId }, session)
      expect(r.isError).toBe(true)
      expect(r.text).toContain("a Microsoft form's answers are read only from a thread of the form's own job")
    }
  })

  it('a routine’s thread in Purdue reads no answers', async () => {
    const view = await aForm({ state: 'collecting' })
    scopes.set('t1', { workspaceId: 'w1', sector: 'purdue', routineRunId: 'run1' })
    const r = await tool('msform_answers', { form: view.formId })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("a routine's thread does not read Purdue answers")
  })
})

describe('making and changing', () => {
  it('msform_create holds the make; nothing is made before his press', async () => {
    const r = await tool('msform_create', { title: 'Volunteer night', folder: TEST_LIBRARY.path + '\\Esports', questions: QUESTIONS, collect: true })
    expect(r.text).toContain('Held')
    expect(r.text).toContain('Nothing was made in Forms yet')
    expect(carrier.calls.filter((c) => c.op === 'make')).toEqual([])
  })

  it('a draft under Agent suggests: the change waits', async () => {
    const view = await aForm()
    const r = await tool('msform_edit', { form: view.formId, changes: [{ op: 'add', question: { title: 'When?', type: 'date', required: true } }] })
    expect(r.text).toContain("waits for the owner's Accept")
    expect(carrier.calls.some((c) => c.op === 'write')).toBe(false)
    const after = await call<MsFormView>('work.msforms.get', { workspaceId: 'w1', formId: view.formId })
    expect(after.suggestions.map((s) => s.words)).toEqual(['Add a Date "When?", required'])
  })

  it('a draft under Agent writes: written at once, once a fresh read shows it takes no answers', async () => {
    const view = await aForm({ mode: 'writes' })
    const r = await tool('msform_edit', { form: view.formId, changes: [{ op: 'remove', question: 2 }] })
    expect(r.text).toContain('Written in Forms')
    expect(carrier.calls.filter((c) => c.op === 'write').map((c) => c.by)).toEqual(['pillar'])
    // The same draft taking answers (changed in the page): the change waits.
    carrier.forms.get(view.formId)!.settings.accepting = true
    const r2 = await tool('msform_edit', { form: view.formId, changes: [{ op: 'remove', question: 1 }] })
    expect(r2.text).toContain("waits for the owner's Accept")
  })

  it('a form taking answers: every change waits, whatever the mode', async () => {
    const view = await aForm({ state: 'collecting', mode: 'writes' })
    const r = await tool('msform_edit', { form: view.formId, changes: [{ op: 'change', question: 2, to: { title: 'Anything more?', type: 'text', required: false } }] })
    expect(r.text).toContain("waits for the owner's Accept")
    expect(carrier.calls.some((c) => c.op === 'write')).toBe(false)
  })

  it('who can answer on a form taking answers is held; a closing end date runs', async () => {
    const view = await aForm({ state: 'collecting' })
    const r = await tool('msform_settings', { form: view.formId, orgOnly: false })
    expect(r.text).toContain('Held')
    expect(carrier.forms.get(view.formId)!.settings.orgOnly).toBe(true)
    const end = await tool('msform_settings', { form: view.formId, endDate: '12/1/2026' })
    expect(end.text).toContain('Set in Forms')
    expect(carrier.forms.get(view.formId)!.settings.endDate).toBe('12/1/2026')
  })

  it('msform_publish holds Collect responses; msform_close closes now and holds a reopen', async () => {
    const view = await aForm()
    expect((await tool('msform_publish', { form: view.formId })).text).toContain('No one can answer yet')
    expect(carrier.calls.some((c) => c.op === 'collect')).toBe(false)
    const open = await aForm({ state: 'collecting' })
    expect((await tool('msform_close', { form: open.formId, open: false })).text).toContain('is closed')
    expect(carrier.forms.get(open.formId)!.settings.accepting).toBe(false)
    expect((await tool('msform_close', { form: open.formId, open: true })).text).toContain('it reopens when he presses')
    expect(carrier.forms.get(open.formId)!.settings.accepting).toBe(false)
  })

  it('a carrier stop is said in the answer with what was done', async () => {
    const view = await aForm({ mode: 'writes' })
    carrier.stopAt.write = 'Added 1 of 2 questions; the second, "Phone", did not show after Add. The form holds the first.'
    const r = await tool('msform_edit', {
      form: view.formId,
      changes: [
        { op: 'add', question: { title: 'Email', type: 'text', required: false } },
        { op: 'add', question: { title: 'Phone', type: 'text', required: false } }
      ]
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Added 1 of 2 questions')
  })
})
