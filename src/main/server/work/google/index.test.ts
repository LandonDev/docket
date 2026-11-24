import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { NEEDS_PRESS } from '../files/policy'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { DeckView, ShowDeck } from '@shared/contract-work-slides'
import type { CanvasItem, WorkToolResult } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { slides } from '../slides'
import type { DeckInfo } from '../slides/deck'
import { slidesTools } from '../slides/tools'
import { cachedSlidesMirror, PPTX_MIME } from './deckMirror'
import { ensureSuggestionTables } from '../sheets/suggestions'
import { GOOGLE_MIME } from './client'
import { FakeGoogle, FAKE_TOKEN_URL } from './fake'
import { resetGoogle, setGoogleDeps } from './google'
import { unfollowAll } from './grid'
import { googleEdit, googleShare } from './held'
import { google as module, setOpenBrowser } from './index'
import { pickerUrl } from './picker'
import { pollOnce } from './poll'
import { boxesOf } from './slides'
import { GOOGLE_TOOLS } from './tools'
import { registerUploadBytes } from './uploads'

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
  slides.ensure(db)
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
    reaches: (by: Caller) => by.kind === 'local',
    convert: async (job: Parameters<WorkCtx['convert']>[0]) => {
      if (!job.output) throw new Error('missing output')
      if (job.to === 'deckinfo') {
        const title = readFileSync(job.input).subarray(4).toString()
        const outline: DeckInfo = { width: 960, height: 540, sections: [], layouts: ['Title'], slides: [{ id: 256, hidden: false, layout: 'Title', title, notes: '', hash: '', shapes: [] }] }
        writeFileSync(job.output, JSON.stringify(outline))
      } else if (job.to === 'pdf') writeFileSync(job.output, '%PDF-1.7')
      else throw new Error(`unexpected conversion ${job.to}`)
      return { output: job.output, ranOn: ctx.host, warnings: [] }
    },
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
  ctx.db.close()
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

  const openPresentation = async () => items.get((await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck1' })).itemId)!
  const slidesCall = async <T>(itemId: string, method: string, params: Record<string, unknown> = {}, by = local): Promise<T> => {
    const out = await slides.handle!({ id: '1', method, params: { itemId, ...params } } as ClientRequest, ctx, by)
    return (out as { result: T }).result
  }
  const fakePptx = (title: string): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(title)])

  it('opens the Drive PPTX export in the slide viewer, presents it, and reads a fresh mirror on Read again', async () => {
    fake.setExport('deck1', PPTX_MIME, fakePptx('First title'))
    const item = await openPresentation()
    const view = await slidesCall<DeckView>(item.id, 'work.slides.open')
    expect(view.slides.map((slide) => slide.title)).toEqual(['First title'])
    expect(view.renders.file?.pages).toBe(1)
    expect(view.hand).toBeUndefined()
    expect((await slidesCall<ShowDeck>(item.id, 'work.slides.show')).slides).toHaveLength(1)
    const source = item.source as Extract<CanvasItem['source'], { at: 'google' }>
    const stored = cachedSlidesMirror(ctx, source)
    expect(stored).toMatch(/\/google\/[^/]+\/deck\.pptx$/)
    expect(readFileSync(stored)).toEqual(fakePptx('First title'))
    expect(fake.calls.filter((call) => call.endsWith('/deck1/export'))).toHaveLength(1)
    await slidesCall<DeckView>(item.id, 'work.slides.open')
    expect(fake.calls.filter((call) => call.endsWith('/deck1/export'))).toHaveLength(1)
    fake.setExport('deck1', PPTX_MIME, fakePptx('Second title'))
    await call('work.google.reload', { itemId: item.id })
    expect((await slidesCall<DeckView>(item.id, 'work.slides.open')).slides.map((slide) => slide.title)).toEqual(['Second title'])
    expect(cachedSlidesMirror(ctx, source)).toBe(stored)
    expect(fake.calls.filter((call) => call.endsWith('/deck1/export'))).toHaveLength(2)
    fake.setExport('deck1', PPTX_MIME, Buffer.from('not a PowerPoint deck'))
    await expect(call('work.google.reload', { itemId: item.id })).rejects.toThrow('Google did not export a PowerPoint deck')
    expect(readFileSync(stored)).toEqual(fakePptx('Second title'))
  })

  it('refuses edits to the Google mirror and opens an editable local copy on the owner’s press', async () => {
    fake.setExport('deck1', PPTX_MIME, fakePptx('Local title'))
    const item = await openPresentation()
    await slidesCall<DeckView>(item.id, 'work.slides.open')
    await expect(slidesCall(item.id, 'work.slides.mode', { mode: 'writes' })).rejects.toThrow('read only')
    await expect(slidesCall(item.id, 'work.slides.review', { changes: 'all', verdict: 'accept' })).rejects.toThrow('read only')
    await expect(slidesCall(item.id, 'work.slides.undo', { writeId: 'w' })).rejects.toThrow('read only')
    for (const verb of ['edit', 'step', 'restore', 'attach']) await expect(slidesCall(item.id, `work.slides.${verb}`)).rejects.toThrow('read only')
    const edit = await slidesTools.find((t) => t.name === 'slides_edit')!.run({ item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] }, { ...ctx, sessionId: 's1', scope: {} } as unknown as ToolCtx)
    expect([edit.isError, text(edit)]).toEqual([true, 'This Google deck is read only here. Make a copy to edit.'])
    await expect(slidesCall(item.id, 'work.slides.copyToEdit', {}, { kind: 'model', caps: [] })).rejects.toThrow('from his own window')
    await expect(slidesCall(item.id, 'work.slides.copyToEdit', {}, { kind: 'remote', caps: ['read', 'operate', 'approve'], peer: 'env_mac' })).rejects.toThrow('from his own window')
    // A Google deck is others' place: a key without approve copies nothing out of it.
    await expect(slidesCall(item.id, 'work.slides.copyToEdit', {}, { kind: 'remote', caps: ['read', 'operate'] })).rejects.toThrow('this key may not change it')
    // His phone or his Mac's window: a key of his with approve. A thread with no workspace keeps the copy as its own deck.
    const copy = await slidesCall<{ itemId: string }>(item.id, 'work.slides.copyToEdit', {}, { kind: 'remote', caps: ['read', 'operate', 'approve'], keyId: 'k1' })
    const localFile = items.get(copy.itemId)!
    expect(localFile).toMatchObject({ title: 'Pitch.pptx', kind: 'slides', source: { at: 'thread' } })
    expect((await slidesCall<DeckView>(copy.itemId, 'work.slides.open')).slides.map((slide) => slide.title)).toEqual(['Local title'])
    expect(readdirSync(dir).includes('work-slides') && readdirSync(join(dir, 'work-slides')).includes('copies')).toBe(false)
    expect((await slidesCall<DeckView>(copy.itemId, 'work.slides.mode', { mode: 'writes' })).mode).toBe('writes')
    expect(fake.calls.some((call) => call.startsWith('POST /drive/'))).toBe(false)
  })

  /** Drive does not answer: offline, or LifeOS's Google session gone. */
  const unreachable = (): void => {
    resetGoogle()
    setGoogleDeps({ fetch: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND www.googleapis.com')), tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => [] })
  }

  it('opens the mirror read before when Drive cannot be reached, and says so until Drive answers again', async () => {
    fake.setExport('deck1', PPTX_MIME, fakePptx('Kept title'))
    const item = await openPresentation()
    expect((await slidesCall<DeckView>(item.id, 'work.slides.open')).readOnly).toEqual({ from: 'google' })
    const fetch = fake.fetch
    unreachable()
    const offline = await slidesCall<DeckView>(item.id, 'work.slides.open')
    expect([offline.readOnly, offline.slides.map((slide) => slide.title)]).toEqual([{ from: 'google', offline: true }, ['Kept title']])
    resetGoogle()
    setGoogleDeps({ fetch, tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => [] })
    expect((await slidesCall<DeckView>(item.id, 'work.slides.open')).readOnly).toEqual({ from: 'google' })
  })

  it('a deck never read fails to open while Drive cannot be reached', async () => {
    fake.setExport('deck1', PPTX_MIME, fakePptx('Never read'))
    const item = await openPresentation()
    unreachable()
    await expect(slidesCall<DeckView>(item.id, 'work.slides.open')).rejects.toThrow('LifeOS did not answer for a Google token')
  })

  it('uploads the saved PowerPoint bytes to the owner’s Drive without a hold', async () => {
    const title = 'For Drive.pptx'
    const path = join(dir, title)
    const bytes = fakePptx('For Drive')
    writeFileSync(path, bytes)
    const item = ctx.canvas.open('s1', 'slides', { at: 'file', host: ctx.host, path }, title)
    await expect(call('work.google.upload', { itemId: item.id, account: ME }, { kind: 'model', caps: [], sessionId: 's1' })).rejects.toThrow('Only the owner')
    await expect(call('work.google.upload', { itemId: item.id, account: ME }, { kind: 'remote', caps: ['operate'] })).rejects.toThrow('outside app-managed roots')
    await expect(call('work.google.upload', { itemId: item.id, account: ME }, { kind: 'remote', caps: ['operate', 'approve'], peer: 'env_mac' })).rejects.toThrow('Only the owner')
    expect(fake.calls.filter((call) => call.includes('/upload/'))).toHaveLength(0)
    const got = await call<{ fileId: string; url: string }>('work.google.upload', { itemId: item.id, account: ME })
    expect(fake.files.get(got.fileId)).toMatchObject({ name: 'For Drive', mimeType: GOOGLE_MIME.slides, reach: new Set([ME]), uploaded: { mime: PPTX_MIME, bytes } })
    expect(got.url).toContain(got.fileId)
    expect(readdirSync(dir)).toEqual([title])
    const opened = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: got.fileId })
    expect((await slidesCall<DeckView>(opened.itemId, 'work.slides.open')).slides.map((slide) => slide.title)).toEqual(['For Drive'])
    expect(results.map((r) => r.kind)).toEqual(['google.slides.upload'])
    expect(held).toEqual([])
  })

  it('waits for the sheets pillar to register its saved bytes', async () => {
    const item = ctx.canvas.open('s1', 'sheet', { at: 'file', host: ctx.host, path: join(dir, 'Budget.xlsx') }, 'Budget.xlsx')
    await expect(call('work.google.upload', { itemId: item.id, account: ME })).rejects.toThrow('Save to Google Sheets is not built yet.')
    expect(fake.calls.filter((call) => call.includes('/upload/'))).toHaveLength(0)
  })

  it('uploads Excel bytes from a registered sheet provider to the owner’s Drive', async () => {
    const item = ctx.canvas.open('s1', 'sheet', { at: 'file', host: ctx.host, path: join(dir, 'Budget.xlsx') }, 'Budget.xlsx')
    const bytes = Buffer.from('PK fake xlsx')
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const stop = registerUploadBytes('sheet', async (_ctx, source) => {
      expect(source.id).toBe(item.id)
      return { bytes, mime }
    })
    try {
      const got = await call<{ fileId: string; url: string }>('work.google.upload', { itemId: item.id, account: ME })
      expect(fake.files.get(got.fileId)).toMatchObject({ name: 'Budget', mimeType: GOOGLE_MIME.sheet, reach: new Set([ME]), uploaded: { mime, bytes } })
      expect(got.url).toContain(got.fileId)
      expect(results.map((r) => r.kind)).toEqual(['google.sheet.upload'])
      expect(held).toEqual([])
    } finally {
      stop()
    }
    await expect(call('work.google.upload', { itemId: item.id, account: ME })).rejects.toThrow('Save to Google Sheets is not built yet.')
  })

  it('keeps a Teams snapshot out of Google for every kind’s provider', async () => {
    const snapshot = join(dir, 'attachments', 'teams-files', 's1', 'snapshot')
    const deck = ctx.canvas.open('s1', 'slides', { at: 'file', host: ctx.host, path: join(snapshot, 'Talk.ppt') }, 'Talk.ppt')
    await expect(call('work.google.upload', { itemId: deck.id, account: ME })).rejects.toThrow('A file from a shared library stays on this host')
    const sheet = ctx.canvas.open('s1', 'sheet', { at: 'file', host: ctx.host, path: join(snapshot, 'Budget.xlsx') }, 'Budget.xlsx')
    let asked = 0
    const stop = registerUploadBytes('sheet', async () => (asked++, { bytes: Buffer.from('PK'), mime: 'application/octet-stream' }))
    try {
      await expect(call('work.google.upload', { itemId: sheet.id, account: ME })).rejects.toThrow('A file from a shared library stays on this host')
    } finally {
      stop()
    }
    expect(asked).toBe(0)
    expect(fake.calls.filter((call) => call.includes('/upload/'))).toHaveLength(0)
    expect(held).toEqual([])
  })

  it("an agent may not write a Doc's mirror to Google: that is his", async () => {
    fake.files.get('doc1')!.reach.add(ME)
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'doc1' })
    await expect(call('work.google.write', { itemId }, { kind: 'model', caps: [], sessionId: 's1' })).rejects.toThrow('google_doc_suggest')
    // Nor a key without approve, nor another host of his: what goes to Google is before everyone it is shared with.
    for (const by of [{ kind: 'remote', caps: ['read', 'operate'] }, { kind: 'remote', caps: ['read', 'operate'], peer: 'env_mac' }] as const)
      await expect(call('work.google.write', { itemId }, by as never)).rejects.toThrow(NEEDS_PRESS)
  })
})

describe('a document of ours as a Google Doc', () => {
  it('goes up as Word, converted by Google into a Doc in his Drive', async () => {
    const path = join(dir, 'Plan.tcdoc')
    items.set('mine', { id: 'mine', sessionId: 's1', kind: 'document', source: { at: 'file', host: 'env_box', path }, title: 'Plan', state: 'open' } as CanvasItem)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, '')
    ctx.db.exec('CREATE TABLE IF NOT EXISTS work_docs_threads (doc TEXT PRIMARY KEY, rows TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT)')
    Object.assign(ctx, {
      reaches: () => true,
      service: { internal: async (route: string) => (route === '/internal/formats/export' ? { data: Buffer.from('PK fake docx').toString('base64') } : { rows: [] }) }
    })
    const got = await call<{ fileId: string; url: string }>('work.google.upload', { itemId: 'mine', account: ME })
    expect(fake.files.get(got.fileId)).toMatchObject({ name: 'Plan', mimeType: GOOGLE_MIME.doc })
    expect(got.url).toContain(got.fileId)
    expect(results.map((r) => r.kind)).toEqual(['google.doc.upload'])
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
  it("holds a deck's edits on this host: no copy and no change in Google until his press, which makes them in the deck", async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck1' })
    expect(text(await run('google_slides_read', { item: itemId }))).toContain('[t1] Hello 2025')
    const before = JSON.stringify([...fake.files])
    const got = await run('google_slides_revise', { item: itemId, edits: [{ find: '2025', replace: '2026' }, { shape: 't1', text: 'Hi' }] })
    expect(text(got)).toMatch(/^Held for the owner/)
    expect(JSON.stringify([...fake.files])).toBe(before)
    expect(fake.calls.filter((c) => c.startsWith('POST') && !c.includes('/google/token'))).toEqual([])
    expect(held).toMatchObject([{ kind: 'google.edit', payload: { app: 'slides', fileId: 'deck1', edits: [{ find: '2025', replace: '2026', boxes: 1, on: [1], count: 1, spots: expect.any(String) }, { shape: 't1', text: 'Hi', slide: 1, was: 'Hello 2026' }] } }])
    expect(results).toEqual([])
    const done = await googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)
    expect(done.summary).toBe('Made 2 changes in Pitch')
    expect(fake.files.get('deck1')!.deck!.slides[0].texts[0].text).toBe('Hi')
    expect([...fake.files.values()].map((f) => f.name)).not.toContain('Pitch (revised)')
  })

  it("changes the words on the slides the card named and nowhere else: a slide's speaker notes, never counted, are left as they were", async () => {
    fake.addDeck(ME, 'deck9', 'Targets', [
      { objectId: 's1', texts: [{ objectId: 't1', text: 'Plan' }], notes: { objectId: 'n1', text: 'Q3 target, say it slowly' } },
      { objectId: 's3', texts: [{ objectId: 't3', text: 'Q3 target' }], notes: { objectId: 'n3', text: 'Q3 target is firm' } }
    ])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck9' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: 'Q3 target', replace: 'Q4 target' }] })
    expect(held[0]).toMatchObject({ payload: { edits: [{ find: 'Q3 target', boxes: 1, on: [2], count: 1 }] } })
    await googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)
    const slides = fake.files.get('deck9')!.deck!.slides
    expect(slides.map((s) => [s.texts[0]!.text, s.notes!.text])).toEqual([
      ['Plan', 'Q3 target, say it slowly'],
      ['Q4 target', 'Q3 target is firm']
    ])
  })

  it('leaves a deck stale when its only match moved to another bullet of the same box', async () => {
    fake.addDeck(ME, 'deck8', 'Plan', [{ objectId: 's1', texts: [{ objectId: 't1', text: 'Q1 goals\nBudget' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck8' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: 'Q1', replace: 'Q2' }] })
    fake.files.get('deck8')!.deck!.slides[0]!.texts[0]!.text = 'Goals\nQ1 budget'
    fake.files.get('deck8')!.deck!.rev++
    await expect(googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('other boxes')
    expect(fake.files.get('deck8')!.deck!.slides[0]!.texts[0]!.text).toBe('Goals\nQ1 budget')
  })

  it('leaves a deck stale, writing nothing, when the words it replaces everywhere now stand in more boxes than he was shown', async () => {
    fake.addDeck(ME, 'deck2', 'Plan', [{ objectId: 's1', texts: [{ objectId: 't1', text: 'Q1 goals' }, { objectId: 't2', text: 'Budget' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck2' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: 'Q1', replace: 'Q2' }] })
    expect(held[0]).toMatchObject({ payload: { edits: [{ find: 'Q1', replace: 'Q2', boxes: 1 }] } })
    fake.files.get('deck2')!.deck!.slides[0].texts[1].text = 'Q1 budget'
    fake.files.get('deck2')!.deck!.rev++
    await expect(googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('"Q1" stands in 2 places now, not the 1 place shown')
    expect(fake.files.get('deck2')!.deck!.slides[0].texts.map((t) => t.text)).toEqual(['Q1 goals', 'Q1 budget'])
  })

  it("counts a replace-all's slides on the deck as the batch's earlier edits leave it, as Google runs them", async () => {
    fake.addDeck(ME, 'deck4', 'Run', [{ objectId: 's1', texts: [{ objectId: 'a', text: 'Q 1 plan' }] }, { objectId: 's2', texts: [{ objectId: 'b', text: 'Q1 goals' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck4' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: ' 1 ', replace: '1 ' }, { find: 'Q1', replace: 'Q2' }] })
    // the first edit joins "Q 1" into "Q1" on slide 1, so the second reaches both slides, and the card says so
    expect(held[0]).toMatchObject({ payload: { edits: [{ find: ' 1 ', on: [1] }, { find: 'Q1', boxes: 2, on: [1, 2] }] } })
  })

  it('reads a deck\'s table cells and grouped shapes as boxes, as replace-all reaches them', () => {
    const run = (text: string) => ({ textElements: [{ textRun: { content: `${text}\n` } }] })
    const table = { objectId: 'tb', table: { tableRows: [{ tableCells: [{ text: run('Q1 cost') }, { text: run('Q2') }] }] } }
    const group = { objectId: 'g', elementGroup: { children: [{ objectId: 'in', shape: { text: run('Q1 inside') } }, table] } }
    expect(boxesOf(group)).toEqual([
      { objectId: 'in', text: 'Q1 inside' },
      { objectId: 'tb:0:0', text: 'Q1 cost' },
      { objectId: 'tb:0:1', text: 'Q2' },
    ])
  })

  it('leaves a deck stale when its words moved to another box though every total is the same', async () => {
    fake.addDeck(ME, 'deck6', 'Moved', [{ objectId: 's1', texts: [{ objectId: 'a', text: 'Q1 plan' }, { objectId: 'b', text: 'Budget' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck6' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: 'Q1', replace: 'Q2' }] })
    const deck = fake.files.get('deck6')!.deck!
    deck.slides[0].texts[0].text = 'Plan'
    deck.slides[0].texts[1].text = 'Q1 budget'
    deck.rev++
    await expect(googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('"Q1" stands in other boxes now than the ones shown')
  })

  it('leaves a deck stale when a box already counted holds the words a second time', async () => {
    fake.addDeck(ME, 'deck5', 'Twice', [{ objectId: 's1', texts: [{ objectId: 't1', text: 'Q1 plan' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck5' })
    await run('google_slides_revise', { item: itemId, edits: [{ find: 'Q1', replace: 'Q2' }] })
    const deck = fake.files.get('deck5')!.deck!
    deck.slides[0].texts[0].text = 'Q1 plan, Q1 cost'
    deck.rev++
    await expect(googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('"Q1" stands in 2 places now, not the 1 place shown')
  })

  it('refuses a batch whose replace-all would reach words another of its edits writes', async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck1' })
    expect(await run('google_slides_revise', { item: itemId, edits: [{ shape: 't1', text: 'Hello 2025 again' }, { find: '2025', replace: '2026' }] })).toMatchObject({ isError: true })
    expect(held).toEqual([])
  })

  it('leaves a box change stale when the box is on another slide than he was shown', async () => {
    fake.addDeck(ME, 'deck3', 'Plan', [{ objectId: 's1', texts: [{ objectId: 't1', text: 'Intro' }] }, { objectId: 's2', texts: [{ objectId: 't2', text: 'Budget' }] }])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'deck3' })
    await run('google_slides_revise', { item: itemId, edits: [{ shape: 't2', text: 'Costs' }] })
    expect(held[0]).toMatchObject({ payload: { edits: [{ shape: 't2', slide: 2 }] } })
    const deck = fake.files.get('deck3')!.deck!
    deck.slides.reverse()
    deck.rev++
    await expect(googleEdit.execute(googleEdit.payload.parse(held[0].payload), { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('changed since: a box on slide 2 is on slide 1 now. Nothing was changed.')
  })

  it("holds a Doc's edits on this host: nothing goes to Google, and his press writes them plainly", async () => {
    fake.addDoc(ME, 'doc2', 'Brief', [['NORMAL_TEXT', 'We ship in March.']])
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'doc2' })
    const before = JSON.stringify([...fake.files])
    const got = await run('google_doc_suggest', { item: itemId, edits: [{ find: 'March', replace: 'May' }] })
    expect(text(got)).toMatch(/^Held for the owner: .*Nothing went to Google and nobody else sees it/)
    expect(JSON.stringify([...fake.files])).toBe(before)
    expect(fake.docSuggestions('doc2')).toEqual([])
    expect(held).toEqual([expect.objectContaining({ kind: 'google.edit', payload: expect.objectContaining({ app: 'doc', fileId: 'doc2', edits: [{ find: 'March', replace: 'May', within: 'We ship in March.', tab: 't.0' }] }) })])
    const payload = googleEdit.payload.parse(held[0].payload)
    expect(googleEdit.words(payload)).toEqual({ summary: 'Make the change in Brief: "March" to "May"', verb: 'Make the change' })
    await expect(googleEdit.execute(payload, { ...ctx, item: { sessionId: 's1' } } as never)).resolves.toMatchObject({ summary: 'Made the change in Brief' })
    expect(fake.docText('doc2')).toContain('We ship in May.')
    expect(fake.docSuggestions('doc2')).toEqual([])
    // pressed again: the words are gone, so nothing is written and he is told why
    await expect(googleEdit.execute(payload, { ...ctx, item: { sessionId: 's1' } } as never)).rejects.toThrow('Brief changed since: "March" is no longer in the Doc. Nothing was changed.')
  })

  it('an agent edit takes no grant and cannot be edited', () => {
    expect(googleEdit.matcher).toBeUndefined()
    expect(googleEdit.keep).toBeUndefined()
  })

  it("holds a share for his press, and its way back takes the person out", async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    const got = await run('google_share', { item: itemId, email: 'dana@example.com', role: 'commenter' })
    expect(text(got)).toMatch(/^Held for the owner/)
    expect(held).toEqual([expect.objectContaining({ kind: 'share.google' })])
    expect(fake.files.get('sh1')!.permissions).toEqual([])
    const payload = googleShare.payload.parse(held[0].payload)
    const done = await googleShare.execute(payload, { ...ctx, item: { sessionId: 's1' } } as never)
    expect(fake.files.get('sh1')!.permissions).toEqual([{ id: expect.any(String), emailAddress: 'dana@example.com', role: 'commenter' }])
    const back = googleShare.wayBack!(done)!
    expect(text(await run(back.verb, back.args))).toContain('no longer')
    expect(fake.files.get('sh1')!.permissions).toEqual([])
    // Only a share his press let through for this thread's tree.
    expect((await run('google_unshare', { account: ME, fileId: 'sh1', permissionId: 'anyoneWithLink' })).isError).toBe(true)
    expect(googleShare.matches!({ domains: ['example.com'], upTo: 'reader' }, payload)).toBe(false)
    expect(googleShare.matches!({ domains: ['example.com'], upTo: 'commenter' }, payload)).toBe(true)
  })

  it('refuses an item of another thread, or one that is not Google', async () => {
    const { itemId } = await call<{ itemId: string }>('work.google.open', { sessionId: 's1', account: ME, fileId: 'sh1' })
    items.get(itemId)!.sessionId = 'other'
    expect((await run('google_sheet_read', { item: itemId, range: "'Q1'!A1:B1" })).isError).toBe(true)
  })
})
