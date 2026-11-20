import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { FormResponses, FormView, PublicForm } from '@shared/contract-work-forms'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import type { RouteCtx } from '../service/routes/route'

/**
 * A form end to end: made and held by a thread's tools, published by the
 * owner's press through the Outbox, answered over the public route on a
 * real socket, its answers read back from the sheet, closed and reopened.
 * The Work service's internal sheet routes run in this process against a
 * real .tcsheet, as the service runs them.
 */

vi.mock('../scope', async (orig) => ({
  ...(await orig<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const rc = vi.hoisted(() => ({ ctx: null as unknown, failCells: false, onCreate: null as null | (() => Promise<void>) }))
vi.mock('../service/ctx', async (orig) => {
  const real = await orig<typeof import('../service/ctx')>()
  const { INTERNAL_ROUTES } = await import('../service/routes/index')
  return {
    ...real,
    servicePart: () => ({
      service: {
        url: (route: string) => `http://127.0.0.1:7/${route.replace(/^\//, '')}`,
        token: async () => 'x',
        internal: async (route: string, body: unknown) => {
          const r = INTERNAL_ROUTES.find((x) => x.path === route)
          if (!r) throw new Error(`no route ${route}`)
          if (rc.failCells && route === '/internal/sheet/cells') throw new Error('the sheet host did not answer')
          if (rc.onCreate && route === '/internal/sheet/create') await rc.onCreate()
          return r.run(body as Record<string, unknown>, rc.ctx as RouteCtx)
        }
      }
    })
  }
})

const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { outbox } = await import('../outbox/index')
const { forms } = await import('./index')
const { formRoute, checkAnswers } = await import('../service/routes/form')
// The hold finds a pillar's act kinds among the loaded modules.
const { WORK_MODULES } = await import('../modules')
WORK_MODULES.push(forms)

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown): Promise<{ text: string; isError?: boolean; item?: string }> => {
  const r = (await work.tools.call({ id: 't1', scope: 'work' }, name, args, new AbortController().signal)) as {
    content: Array<{ text?: string }>
    isError?: boolean
    structuredContent?: { item?: string }
  }
  return { text: r.content.map((c) => c.text ?? '').join(''), isError: r.isError, item: r.structuredContent?.item }
}

let server: Server
let port: number
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = formRoute.match.exec(url.pathname)
    if (!m) return void res.writeHead(404).end()
    void formRoute.http!(req, res, rc.ctx as RouteCtx, m)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  WORK_MODULES.splice(WORK_MODULES.indexOf(forms), 1)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-forms-'))
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'form'), { recursive: true })
  writeFileSync(join(hosted, 'form', 'index.html'), '<!doctype html><title>Form</title>')
  rc.ctx = { config: () => ({ dataDir: join(dir, 'work-service'), hostedDir: hosted, lifeos: { here: false, host: null } }), log: () => {} }
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir], denied: () => [] } }, [outbox, canvas, forms])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const QUESTIONS = [
  { label: 'Name', type: 'short', required: true },
  { label: 'Game', type: 'choice', required: true, options: ['Valorant', 'Rocket League'] },
  { label: 'Dietary needs', type: 'long' }
]

async function made(): Promise<{ itemId: string; view: FormView }> {
  const r = await tool('form_create', { title: 'Spring LAN registration', description: 'Saturday, April 10.', questions: QUESTIONS })
  expect(r.isError).toBeFalsy()
  const itemId = r.item!
  return { itemId, view: await call<FormView>('work.forms.open', { itemId }) }
}

async function publish(itemId: string): Promise<FormView> {
  await tool('form_publish', { item: itemId })
  const held = (await call<FormView>('work.forms.open', { itemId })).held!
  const sent = await call<OutboxItem>('work.outbox.send', { ref: held.ref })
  expect(sent.state).toBe('sent')
  return call<FormView>('work.forms.open', { itemId })
}

const publicId = (view: FormView): string => view.link!.split('/f/')[1]
const post = (id: string, answers: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/f/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ answers }) })

const postOnce = (id: string, answers: Record<string, string>, submission: string) =>
  fetch(`http://127.0.0.1:${port}/f/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers, submission }) })

describe('a form', () => {
  it('is made by a thread and opens in its pane, with ids on every question', async () => {
    const { view } = await made()
    expect(view).toMatchObject({ state: 'draft', mode: 'suggests', link: null, held: null, sheet: null })
    expect(view.body.questions.map((q) => [q.label, q.type, q.required])).toEqual([
      ['Name', 'short', true],
      ['Game', 'choice', true],
      ['Dietary needs', 'long', false]
    ])
    expect(new Set(view.body.questions.map((q) => q.id)).size).toBe(3)
  })

  it('waits in the Outbox to publish; nothing answers at its link until the owner presses', async () => {
    const { itemId } = await made()
    const r = await tool('form_publish', { item: itemId })
    expect(r.text).toContain('Held: Publish Spring LAN registration')
    const waiting = await call<{ items: OutboxItem[] }>('work.outbox.list', { show: 'waiting' })
    expect(waiting.items.map((i) => [i.kind, i.summary])).toEqual([['form.publish', 'Publish Spring LAN registration']])
    // The Outbox shows the form's words as they will go live (the hold review's finding 12).
    expect((waiting.items[0].payload as { content: string }).content).toBe(
      'Saturday, April 10.\n\n1. Name (short answer, required)\n2. Game (choice, required)\n   - Valorant\n   - Rocket League\n3. Dietary needs (long answer)'
    )
    const view = await call<FormView>('work.forms.open', { itemId })
    expect(view.state).toBe('draft')
    expect(view.held?.ref).toEqual(waiting.items[0].ref)
    expect(existsSync(join(dir, 'work-service', 'forms'))).toBe(false)
    // The press: the page goes live, the sheet is made with its header.
    const live = await publish(itemId)
    expect(live.state).toBe('open')
    expect(live.held).toBeNull()
    expect(live.link).toMatch(/\/f\/[A-Za-z0-9_-]{16}$/)
    expect(live.sheet).toMatchObject({ at: 'file', host: 'env_test' })
    const page = await fetch(`http://127.0.0.1:${port}/f/${publicId(live)}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const form = (await (await fetch(`http://127.0.0.1:${port}/f/${publicId(live)}/form`)).json()) as PublicForm
    expect(form).toMatchObject({ title: 'Spring LAN registration', open: true })
    expect(pushes.some((p) => p.push === 'work.forms' && p.itemId === itemId && p.view.state === 'open')).toBe(true)
  })

  it('writes one row for a submission sent twice (its reply lost on the way back), and a new row for a new one', async () => {
    const { itemId } = await made()
    const live = await publish(itemId)
    const [name, game] = live.body.questions.map((q) => q.id)
    const id = publicId(live)
    const answers = { [name]: 'Ava Thompson', [game]: 'Valorant' }
    expect((await postOnce(id, answers, 'sub_aaaaaaaaaaaaaaaa')).status).toBe(201)
    // The page did not hear the reply and sends the same answers again: the answer it already wrote.
    const again = await postOnce(id, answers, 'sub_aaaaaaaaaaaaaaaa')
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ ok: true })
    expect((await call<FormResponses>('work.forms.responses', { itemId })).count).toBe(1)
    expect((await postOnce(id, { [name]: 'Marcus Lee', [game]: 'Rocket League' }, 'sub_bbbbbbbbbbbbbbbb')).status).toBe(201)
    expect((await call<FormResponses>('work.forms.responses', { itemId })).count).toBe(2)
    // The ids it took are noted with their rows, so a restart still knows them.
    const log = readFileSync(join(dir, 'work-service', 'forms', `${id}.answers.jsonl`), 'utf8')
    expect(log).toContain('"submission":"sub_aaaaaaaaaaaaaaaa"')
    expect(log).toContain('"submission":"sub_bbbbbbbbbbbbbbbb"')
  })

  it('answers a resend with the answer it recorded before checking the form as it is now: closed since, or its questions changed', async () => {
    const { itemId } = await made()
    const live = await publish(itemId)
    const [name, game] = live.body.questions.map((q) => q.id)
    const id = publicId(live)
    expect((await postOnce(id, { [name]: 'Ava Thompson', [game]: 'Valorant' }, 'sub_cccccccccccccccc')).status).toBe(201)
    // The reply was lost, and the answers the page holds would not pass the questions now (a required one left empty).
    expect((await postOnce(id, { [game]: 'Valorant' }, 'sub_cccccccccccccccc')).status).toBe(201)
    // The form closes before the page sends again: the saved answer still stands.
    expect((await call<FormView>('work.forms.close', { itemId, open: false })).state).toBe('closed')
    const again = await postOnce(id, { [name]: 'Ava Thompson', [game]: 'Valorant' }, 'sub_cccccccccccccccc')
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ ok: true })
    // One row, and a submission it never took is refused as closed.
    expect((await call<FormResponses>('work.forms.responses', { itemId })).count).toBe(1)
    expect((await postOnce(id, { [name]: 'Marcus Lee', [game]: 'Valorant' }, 'sub_dddddddddddddddd')).status).toBe(410)
  })

  it('takes answers into its sheet, refuses a bad one by question, and stops when closed', async () => {
    const { itemId } = await made()
    const live = await publish(itemId)
    const [name, game, diet] = live.body.questions.map((q) => q.id)
    const id = publicId(live)
    expect((await post(id, { [name]: 'Ava Thompson', [game]: 'Valorant', [diet]: 'No peanuts' }, { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(201)
    const missing = await post(id, { [game]: 'Valorant' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'This question needs an answer.', question: name })
    const wrong = await post(id, { [name]: 'Marcus', [game]: 'Chess' })
    expect(((await wrong.json()) as { question: string }).question).toBe(game)
    expect((await post(id, { [name]: 'Marcus Lee', [game]: 'Rocket League' })).status).toBe(201)

    const got = await call<FormResponses>('work.forms.responses', { itemId })
    expect(got.columns.map((c) => c.label)).toEqual(['Name', 'Game', 'Dietary needs', 'Submitted'])
    expect(got.count).toBe(2)
    // Newest first, the time it came in last.
    expect(got.rows.map((r) => r.slice(0, 3))).toEqual([
      ['Marcus Lee', 'Rocket League', ''],
      ['Ava Thompson', 'Valorant', 'No peanuts']
    ])
    expect(got.rows[0][3]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
    expect(await call('work.forms.responses', { itemId, rev: got.rev })).toEqual({ same: true, rev: got.rev })

    // His own close and reopen are not held: closing stops answers on the next request.
    expect((await call<FormView>('work.forms.close', { itemId, open: false })).state).toBe('closed')
    expect((await call<{ items: OutboxItem[] }>('work.outbox.list', { show: 'waiting' })).items).toEqual([])
    expect((await post(id, { [name]: 'Late', [game]: 'Valorant' })).status).toBe(410)
    expect(((await (await fetch(`http://127.0.0.1:${port}/f/${id}/form`)).json()) as PublicForm).open).toBe(false)
    // An agent's reopen shares the link again, so it waits for his press like Publish (the hold review's finding 2).
    const reopened = await tool('form_close', { item: itemId, open: true })
    expect(reopened.text).toBe('Held: Reopen Spring LAN registration. It takes answers again when he presses Publish.')
    expect((await post(id, { [name]: 'Late', [game]: 'Valorant' })).status).toBe(410)
    const held = (await call<FormView>('work.forms.open', { itemId })).held!
    expect((await call<OutboxItem>('work.outbox.send', { ref: held.ref })).state).toBe('sent')
    expect(publicId(await call<FormView>('work.forms.open', { itemId }))).toBe(id)
    expect((await post(id, { [name]: 'Late', [game]: 'Valorant' })).status).toBe(201)
    expect((await call<FormResponses>('work.forms.responses', { itemId })).rows[0][0]).toBe('Late')
  })

  it('keeps an agent\'s change to a published form waiting, and its new question gets a column of its own', async () => {
    const { itemId } = await made()
    await call('work.forms.mode', { itemId, mode: 'writes' })
    const live = await publish(itemId)
    const r = await tool('form_edit', { item: itemId, changes: [{ op: 'add', question: { label: 'T-shirt size', type: 'dropdown', options: ['S', 'M', 'L'] } }], reason: 'Sam asked for sizes' })
    expect(r.text).toContain('wait for the owner')
    let view = await call<FormView>('work.forms.open', { itemId })
    expect(view.body.questions).toHaveLength(3)
    expect(view.suggestions.map((s) => [s.op, s.question.label, s.reason])).toEqual([['add', 'T-shirt size', 'Sam asked for sizes']])
    view = await call<FormView>('work.forms.review', { itemId, which: 'all', verdict: 'accept' })
    expect(view.body.questions.at(-1)?.label).toBe('T-shirt size')
    const form = (await (await fetch(`http://127.0.0.1:${port}/f/${publicId(live)}/form`)).json()) as PublicForm
    expect(form.questions.at(-1)?.options).toEqual(['S', 'M', 'L'])
    const shirt = view.body.questions.at(-1)!.id
    const [name, game] = view.body.questions.map((q) => q.id)
    expect((await post(publicId(live), { [name]: 'Ava', [game]: 'Valorant', [shirt]: 'M' })).status).toBe(201)
    const got = await call<FormResponses>('work.forms.responses', { itemId })
    expect(got.columns.map((c) => c.label)).toEqual(['Name', 'Game', 'Dietary needs', 'T-shirt size', 'Submitted'])
    expect(got.rows[0].slice(0, 4)).toEqual(['Ava', 'Valorant', '', 'M'])
  })

  it('accepting a removal clears the other changes waiting on that question, and the result names them', async () => {
    const { itemId, view } = await made()
    const diet = view.body.questions[2].id
    // One call: the tool numbers a call's changes, so changes from separate calls in one millisecond could share an id.
    await tool('form_edit', {
      item: itemId,
      changes: [
        { op: 'remove', id: diet },
        { op: 'change', id: diet, label: 'Allergies' },
        { op: 'change', id: view.body.questions[0].id, label: 'Full name' }
      ]
    })
    const waiting = (await call<FormView>('work.forms.open', { itemId })).suggestions
    expect(waiting.map((s) => s.op)).toEqual(['remove', 'change', 'change'])
    const out = await call<FormView & { cleared: string[] }>('work.forms.review', { itemId, which: { ids: [waiting[0].id] }, verdict: 'accept' })
    expect(out.body.questions.map((q) => q.label)).toEqual(['Name', 'Game'])
    // The rewrite of the removed question went with it, named as the form had it; the change to Name still waits.
    expect(out.cleared).toEqual(['Change Dietary needs'])
    expect(out.suggestions.map((s) => s.question.label)).toEqual(['Full name'])
    expect((await call<FormView>('work.forms.open', { itemId })).suggestions.map((s) => s.id)).toEqual([waiting[2].id])
  })

  it('accepting all clears a rewrite whose question an earlier removal in the same press took away, without an error', async () => {
    const { itemId, view } = await made()
    const diet = view.body.questions[2].id
    await tool('form_edit', { item: itemId, changes: [{ op: 'remove', id: diet }, { op: 'change', id: diet, label: 'Allergies' }] })
    const out = await call<FormView & { cleared: string[] }>('work.forms.review', { itemId, which: 'all', verdict: 'accept' })
    expect(out.body.questions.map((q) => q.label)).toEqual(['Name', 'Game'])
    expect(out.cleared).toEqual(['Change Dietary needs'])
    expect(out.suggestions).toEqual([])
  })

  it('never offers a saved change to a question that is gone, and drops it on the next write', async () => {
    const { itemId, view } = await made()
    await tool('form_edit', { item: itemId, changes: [{ op: 'change', id: view.body.questions[0].id, label: 'Full name' }] })
    const { FormsStore } = await import('./store')
    const store = new FormsStore(db)
    const row = store.get(itemId)!
    const orphan = { ...row.suggestions[0], id: 'orphan', question: { ...row.suggestions[0].question, id: 'gone', label: 'Old question' } }
    store.update(itemId, { suggestions: [...row.suggestions, orphan] })
    const open = await call<FormView>('work.forms.open', { itemId })
    expect(open.suggestions.map((s) => s.id)).toEqual([row.suggestions[0].id])
    expect((await tool('form_read', { item: itemId })).text).toContain('1 change(s) wait for the owner.')
    // Deciding all decides what stands; the orphan is dropped, never named, and nothing throws.
    const out = await call<FormView & { cleared: string[] }>('work.forms.review', { itemId, which: 'all', verdict: 'reject' })
    expect(out.cleared).toEqual([])
    expect(store.get(itemId)!.suggestions).toEqual([])
  })

  it('his own edit that removes a question drops the changes waiting on it', async () => {
    const { itemId, view } = await made()
    await tool('form_edit', { item: itemId, changes: [{ op: 'change', id: view.body.questions[2].id, label: 'Allergies' }] })
    const saved = await call<FormView>('work.forms.save', { itemId, rev: view.rev, body: { ...view.body, questions: view.body.questions.slice(0, 2) } })
    expect(saved.suggestions).toEqual([])
    const { FormsStore } = await import('./store')
    expect(new FormsStore(db).get(itemId)!.suggestions).toEqual([])
  })

  it('writes an agent\'s change at once before publishing only when the mode says so', async () => {
    const { itemId, view } = await made()
    await tool('form_edit', { item: itemId, changes: [{ op: 'remove', id: view.body.questions[2].id }] })
    expect((await call<FormView>('work.forms.open', { itemId })).suggestions).toHaveLength(1)
    await call('work.forms.review', { itemId, which: 'all', verdict: 'reject' })
    await call('work.forms.mode', { itemId, mode: 'writes' })
    await tool('form_edit', { item: itemId, changes: [{ op: 'change', id: view.body.questions[0].id, label: 'Full name' }] })
    const after = await call<FormView>('work.forms.open', { itemId })
    expect(after.suggestions).toEqual([])
    expect(after.body.questions[0].label).toBe('Full name')
    expect(after.written?.text).toBe('Changed a question')
  })

  it('stays a draft he can publish again when the press fails part way', async () => {
    const { itemId } = await made()
    await tool('form_publish', { item: itemId })
    const held = (await call<FormView>('work.forms.open', { itemId })).held!
    rc.failCells = true
    try {
      expect((await call<OutboxItem>('work.outbox.send', { ref: held.ref })).state).toBe('failed')
    } finally {
      rc.failCells = false
    }
    expect(await call<FormView>('work.forms.open', { itemId })).toMatchObject({ state: 'draft', link: null })
    expect(existsSync(join(dir, 'work-service', 'forms'))).toBe(false)
    expect((await publish(itemId)).state).toBe('open')
  })

  it('lets junk use up only its own sender, never the form', async () => {
    const { itemId } = await made()
    const live = await publish(itemId)
    const [name, game] = live.body.questions.map((q) => q.id)
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await post(publicId(live), {}, { 'CF-Connecting-IP': '198.51.100.7' })).status)
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true)
    expect(statuses[10]).toBe(429)
    expect((await post(publicId(live), { [name]: 'Ava', [game]: 'Valorant' }, { 'CF-Connecting-IP': '198.51.100.8' })).status).toBe(201)
  })

  it('does not publish a form that changed after it was held', async () => {
    const { itemId, view } = await made()
    await tool('form_publish', { item: itemId })
    const held = (await call<FormView>('work.forms.open', { itemId })).held!
    await call('work.forms.save', { itemId, rev: view.rev, body: { ...view.body, title: 'Spring LAN sign-up' } })
    const sent = await call<OutboxItem>('work.outbox.send', { ref: held.ref })
    expect(sent.state).toBe('stale')
    const after = await call<FormView>('work.forms.open', { itemId })
    expect(after).toMatchObject({ state: 'draft', held: null, link: null })
  })

  it('does not publish an edit that lands while the press is making its sheet', async () => {
    const { itemId, view } = await made()
    await tool('form_publish', { item: itemId })
    const held = (await call<FormView>('work.forms.open', { itemId })).held!
    rc.onCreate = async () => {
      rc.onCreate = null
      await call('work.forms.save', { itemId, rev: view.rev, body: { ...view.body, title: 'Unapproved title' } })
    }
    const sent = await call<OutboxItem>('work.outbox.send', { ref: held.ref })
    expect(sent.state).toBe('stale')
    expect((await call<FormView>('work.forms.open', { itemId })).link).toBeNull()
  })

  it('refuses the canvas\'s methods to a thread, and an edit made on an old rev', async () => {
    const { itemId, view } = await made()
    // A thread reaches Work only through its tools; were a canvas method ever routed to one, the module refuses it.
    const req = ClientRequestSchema.parse({ id: '1', method: 'work.forms.publish', params: { itemId } })
    await expect(forms.handle!(req, {} as never, { kind: 'model', caps: [], sessionId: 't1' })).rejects.toThrow('Only the owner')
    await call('work.forms.save', { itemId, rev: view.rev, body: view.body })
    await expect(call('work.forms.save', { itemId, rev: view.rev, body: view.body })).rejects.toThrow('changed since you opened it')
  })
})

describe('the answers a page sends', () => {
  const qs = [
    { id: 'a', label: 'Name', type: 'short' as const, required: true },
    { id: 's', label: 'About you', type: 'section' as const, required: false },
    { id: 'b', label: 'Size', type: 'dropdown' as const, required: false, options: ['S', 'M'] },
    { id: 'c', label: 'Notes', type: 'long' as const, required: false }
  ]
  it('keeps what the form asks and drops the rest', () => {
    expect(checkAnswers({ questions: qs }, { answers: { a: ' Ava ', b: 'M', s: 'x', z: 'extra' } })).toEqual({ ok: { a: 'Ava', b: 'M' } })
  })
  it('refuses a missing answer, an answer not offered, and one too long', () => {
    expect(checkAnswers({ questions: qs }, { answers: {} })).toMatchObject({ question: 'a' })
    expect(checkAnswers({ questions: qs }, { answers: { a: 'x', b: 'XL' } })).toMatchObject({ question: 'b' })
    expect(checkAnswers({ questions: qs }, { answers: { a: 'x'.repeat(501) } })).toMatchObject({ question: 'a' })
    expect(checkAnswers({ questions: qs }, { answers: { a: 'x', c: 'y'.repeat(5000) } })).toEqual({ ok: { a: 'x', c: 'y'.repeat(5000) } })
    expect(checkAnswers({ questions: qs }, 'nope')).toEqual({ error: 'Nothing was sent.' })
  })
})

describe("an agent's change", () => {
  it('takes an id no other call shares, even in the same millisecond, so a decision by id takes exactly one (the hold review)', async () => {
    const { suggestionId } = await import('./tools')
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      const ids = new Set(Array.from({ length: 50 }, () => suggestionId()))
      expect(ids.size).toBe(50)
    } finally {
      vi.useRealTimers()
    }
  })
})
