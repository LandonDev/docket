import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { CanvasItem, WorkToolResult } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { ensureSuggestionTables } from '../sheets/suggestions'
import { GOOGLE_MIME } from './client'
import { FakeGoogle, FAKE_TOKEN_URL } from './fake'
import { resetGoogle, setGoogleDeps } from './google'
import { unfollowAll } from './grid'
import { googleShare } from './held'
import { google as module, setOpenBrowser } from './index'
import { pickerUrl } from './picker'
import { pollOnce } from './poll'
import { GOOGLE_TOOLS } from './tools'

/** The google wire, its tools and its held act, against the fake Google. */
const ME = 'landon@example.com'
let fake: FakeGoogle
let ctx: WorkCtx
let dir: string
let items: Map<string, CanvasItem>
let held: { kind: string; payload: unknown }[]
let results: { kind: string; summary: string }[]
let pushes: unknown[]
const local: Caller = { kind: 'local', caps: ['read', 'operate'] }
const call = <T>(method: string, params: unknown, by: Caller = local) =>
  module.handle!({ id: '1', method, params } as unknown as ClientRequest, ctx, by).then((r) => (r as { result: T }).result)
const run = (name: string, args: unknown): Promise<WorkToolResult> =>
  GOOGLE_TOOLS.find((t) => t.name === name)!.run(args, { ...ctx, sessionId: 's1', scope: {} } as unknown as ToolCtx)
const text = (r: WorkToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('')

beforeEach(() => {
  fake = new FakeGoogle().account(ME)
  fake.addDoc(ME, 'doc1', 'Brief', [['NORMAL_TEXT', 'We ship in March.']], { picked: false })
  fake.addSheet(ME, 'sh1', 'Budget', [{ sheetId: 0, title: 'Q1', cells: [['Rent', 1200]] }])
  fake.addDeck(ME, 'deck1', 'Pitch', [{ objectId: 's1', texts: [{ objectId: 't1', text: 'Hello 2025' }] }])
  dir = mkdtempSync(join(tmpdir(), 'm30-index-'))
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  module.ensure(db)
  ensureSuggestionTables(db)
  items = new Map()
  held = []
  results = []
  pushes = []
  let n = 0
  ctx = {
    db,
    host: 'env_box',
    dataDir: dir,
    log: () => {},
    push: (p: unknown) => pushes.push(p),
    scopeOf: (id: string) => (id === 's1' ? {} : null),
    lifeos: { jwt: async () => fake.jwt, connected: () => true, owner: () => ({ query: async () => [{ account: ME, files: true, writes: false }, { account: 'work@example.com', files: false }] }) },
    canvas: {
      paneOf: (s: string) => s,
      get: (id: string) => items.get(id) ?? null,
      open: (sessionId: string, kind: CanvasItem['kind'], source: CanvasItem['source'], title: string) => {
        const item = { id: `i${++n}`, sessionId, kind, source, title, state: 'open' } as CanvasItem
        items.set(item.id, item)
        return item
      }
    },
    held: { create: (a: { kind: string; payload: unknown }) => (held.push(a), { state: 'held', summary: 'Share Brief' }) },
    results: { add: (r: { kind: string; summary: string }) => results.push(r) }
  } as unknown as WorkCtx
  setGoogleDeps({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => [] })
})
afterEach(() => {
  resetGoogle()
  unfollowAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('the google wire', () => {
  it('lists his accounts, and whether this host can show the Picker', async () => {
    expect(await call('work.google.accounts', {})).toEqual({ accounts: [{ account: ME, files: true }, { account: 'work@example.com', files: false }], picker: false })
    await call('work.google.setup', { clientId: '123-abc.apps.googleusercontent.com' })
    expect(await call('work.google.accounts', {})).toMatchObject({ picker: true })
  })

  it("picks through the desktop Picker's redirect, never exchanging its code, and a picked file becomes readable", async () => {
    await call('work.google.setup', { clientId: '123-abc.apps.googleusercontent.com' })
    let shown = ''
    setOpenBrowser(async (url) => {
      shown = url
      // The browser: he picks the Doc, Google sends him back to our loopback.
      setTimeout(() => void fake.pick(url, ME, ['doc1']), 0)
    })
    const got = await call<{ files: unknown[] }>('work.google.pick', { account: ME })
    expect(got.files).toEqual([{ fileId: 'doc1', name: 'Brief', mime: GOOGLE_MIME.doc, kind: 'doc' }])
    const u = new URL(shown)
    expect(u.searchParams.get('client_id')).toBe('123-abc.apps.googleusercontent.com')
    expect(u.searchParams.get('login_hint')).toBe(ME)
    expect(fake.calls.some((c) => c.includes('token'))).toBe(false)
  })

  it('refuses a redirect that does not carry its state', async () => {
    const url = pickerUrl({ clientId: 'x', account: ME, redirect: 'http://127.0.0.1:1/picked', state: 's', challenge: 'c' })
    expect(new URL(url).searchParams.get('trigger_onepick')).toBe('true')
    expect(new URL(url).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
  })

  it('opens a picked file as the right kind of canvas item', async () => {
    fake.files.get('doc1')!.reach.add(ME)
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'doc1' })
    expect(items.get(itemId)).toMatchObject({ kind: 'document', source: { at: 'google', account: ME, fileId: 'doc1', mime: GOOGLE_MIME.doc } })
    const sheet = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    expect(items.get(sheet.itemId)?.kind).toBe('sheet')
    await expect(call('work.google.open', { sessionId: 'code-thread', account: ME, fileId: 'sh1' })).rejects.toThrow('Work thread')
  })

  it("an agent may not write a Doc's mirror to Google: that is his", async () => {
    fake.files.get('doc1')!.reach.add(ME)
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'doc1' })
    await expect(call('work.google.write', { itemId }, { kind: 'model', caps: [], sessionId: 's1' })).rejects.toThrow('google_doc_suggest')
  })
})

describe('the version poll', () => {
  it("tells an open item and fires a routine's trigger on someone else's change, not on ours", async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    const fired: string[] = []
    const off = module.triggers![0].arm({ on: 'file', source: items.get(itemId)!.source, by: 'someone-else' }, (c) => fired.push(c), null)
    const told: string[] = []
    await pollOnce(ctx, (w) => told.push(w.fileId))
    expect(told).toEqual([])
    // Our own write: passes quietly.
    await run('google_sheet_suggest', { item: itemId, cells: { "'Q1'!B1": 1300 } })
    const { review } = await import('./grid')
    await review(ctx, { account: ME, fileId: 'sh1', name: 'Budget' }, 'all', 'accept')
    await pollOnce(ctx, (w) => told.push(w.fileId))
    expect(told).toEqual([])
    // Someone else's.
    fake.files.get('sh1')!.sheet!.tabs[0].cells[0][1] = 5
    fake.files.get('sh1')!.version++
    await pollOnce(ctx, (w) => told.push(w.fileId))
    expect(told).toEqual(['sh1'])
    expect(fired).toEqual(['Budget changed in Google'])
    // Closed: no longer polled.
    items.get(itemId)!.state = 'closed'
    fake.files.get('sh1')!.version++
    await pollOnce(ctx, (w) => told.push(w.fileId))
    expect(told).toEqual(['sh1'])
    off()
  })
})

describe('the google tools', () => {
  it("revises a copy of a deck and leaves the deck as it was", async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck1' })
    expect(text(await run('google_slides_read', { item: itemId }))).toContain('[t1] Hello 2025')
    const got = await run('google_slides_revise', { item: itemId, edits: [{ find: '2025', replace: '2026' }] })
    expect(text(got)).toMatch(/Made "Pitch \(revised\)"/)
    expect(fake.files.get('deck1')!.deck!.slides[0].texts[0].text).toBe('Hello 2025')
    const copy = [...fake.files.values()].find((f) => f.name === 'Pitch (revised)')!
    expect(copy.deck!.slides[0].texts[0].text).toBe('Hello 2026')
    expect(results.map((r) => r.kind)).toEqual(['google.slides.copy'])
  })

  it("holds a share for his press, and its way back takes the person out", async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    const got = await run('google_share', { item: itemId, email: 'dana@example.com', role: 'commenter' })
    expect(text(got)).toMatch(/^Held for the owner/)
    expect(held).toEqual([expect.objectContaining({ kind: 'share.google' })])
    expect(fake.files.get('sh1')!.permissions).toEqual([])
    const payload = googleShare.payload.parse(held[0].payload)
    const done = await googleShare.execute(payload, ctx as never)
    expect(fake.files.get('sh1')!.permissions).toEqual([{ id: expect.any(String), emailAddress: 'dana@example.com', role: 'commenter' }])
    const back = googleShare.wayBack!(done)!
    expect(text(await run(back.verb, back.args))).toContain('no longer')
    expect(fake.files.get('sh1')!.permissions).toEqual([])
    expect(googleShare.matches!({ domains: ['example.com'], upTo: 'reader' }, payload)).toBe(false)
    expect(googleShare.matches!({ domains: ['example.com'], upTo: 'commenter' }, payload)).toBe(true)
  })

  it('refuses an item of another thread, or one that is not Google', async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    items.get(itemId)!.sessionId = 'other'
    expect((await run('google_sheet_read', { item: itemId, range: "'Q1'!A1:B1" })).isError).toBe(true)
  })
})
