import type { DatabaseSync } from 'node:sqlite'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, METHOD_CAPABILITY, type Principal } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { PdfView } from '@shared/contract-work-pdf'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasItemDir, canvasStoreOf } from '../canvas/store'
import type { WorkCtx } from '../modules'
import { readForm } from './form'

/**
 * The pdf module end to end: a real database, `startWork` with the canvas
 * and pdf modules, Work turned on, and canvas items over real files. The
 * methods go through the mount (capabilities and all); the tools through
 * `work.tools.call` as a thread's harness calls them.
 */
vi.mock('../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { pdf } = await import('./index')
// The job runner takes its converters from the loaded registry, once, when Work first turns on: with the real tools, load it before any test.
if (process.env.TEMP_CODE_WORK_TOOLS_DATA) await (await import('../modules')).loadWorkModules()

const W9 = readFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf'))
const P1 = 'topmostSubform[0].Page1[0].'
const NAME = `${P1}f1_01[0]`
const SSN1 = `${P1}f1_11[0]`

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const removed: ((ids: string[]) => void)[] = []
const thread = (id: string): void => void sessions.set(id, { id, provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: (fn: (ids: string[]) => void) => (removed.push(fn), () => {}),
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown, principal: Principal = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), principal)
  return (out.handled ? out.result : undefined) as T
}
const tool = (name: string, args: unknown, sessionId = 't1') => work.tools.call({ id: sessionId, scope: 'work' }, name, args, new AbortController().signal)
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('')
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const put = (name: string, bytes: Uint8Array | string): string => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}
const openItem = (path: string, title = 'W-9', sessionId = 't1'): string => canvasStoreOf(db).open(sessionId, { kind: 'pdf', source: file(path), title }).id
const bytesOf = async (itemId: string, which: 'file' | 'export' = 'file'): Promise<Buffer> => {
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const r = await call<{ data: string; size: number }>('work.pdf.read', { itemId, which, offset, length: 50_000 })
    const chunk = Buffer.from(r.data, 'base64')
    parts.push(chunk)
    offset += chunk.length
    if (chunk.length === 0 || offset >= r.size) break
  }
  return Buffer.concat(parts)
}
async function pageText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
  const doc = await task.promise
  try {
    const content = await (await doc.getPage(1)).getTextContent()
    return content.items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, '')
  } finally {
    await task.destroy()
  }
}
const SIGNATURE = { width: 300, height: 100, strokes: [[[10, 80], [60, 20], [110, 70], [160, 30]]] as Array<Array<[number, number]>> }
const SOURCE = { kind: 'file', label: 'Purdue profile', quote: 'Ada Exampleton' }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-pdf-'))
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  sessions.clear()
  removed.length = 0
  thread('t1')
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: hostFence(db) }, [canvas, pdf])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
  pushes.length = 0
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('opening and reading', () => {
  it('opens a PDF item: its name, size, rev and the form\'s fields with labels from the file or its field names', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view).toMatchObject({ itemId: id, sessionId: 't1', name: 'fw9.pdf', size: W9.length, mode: 'suggests', marks: [], hasSignature: false, signed: false })
    expect(view.rev).toMatch(/^[0-9a-f]{16}$/)
    expect(view.fields).toHaveLength(23)
    expect(view.fields.find((f) => f.key === NAME)).toMatchObject({ label: 'f1_01', type: 'text', origin: 'acroform', state: 'empty', page: 1 })
    expect(view.formError).toBeUndefined()
    expect(view.missing).toBeUndefined()
  })

  it('serves the bytes by range from the copy it keeps, refreshed when the file changes, and still there when the file moves', async () => {
    const path = put('fw9.pdf', W9)
    const id = openItem(path)
    const first = await call<PdfView>('work.pdf.open', { itemId: id })
    const head = await call<{ data: string; size: number; rev: string }>('work.pdf.read', { itemId: id, offset: 0, length: 8 })
    expect(Buffer.from(head.data, 'base64').toString('latin1')).toBe('%PDF-1.7')
    expect(head).toMatchObject({ size: W9.length, rev: first.rev })
    expect((await bytesOf(id)).equals(W9)).toBe(true)
    appendFileSync(path, '\n% one more line\n')
    const second = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(second.size).toBe(W9.length + 17)
    expect(second.rev).not.toBe(first.rev)
    unlinkSync(path)
    const gone = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(gone.missing).toEqual({ asOf: expect.any(Number) })
    expect((await bytesOf(id)).length).toBe(W9.length + 17)
  })

  it('refuses a file that is not a PDF, an item of another kind, and a copy not made yet', async () => {
    const fake = openItem(put('notes.pdf', 'just some text, not a PDF'), 'Notes')
    await expect(call('work.pdf.open', { itemId: fake })).rejects.toThrow('notes.pdf is not a PDF.')
    await expect(call('work.pdf.read', { itemId: fake, offset: 0, length: 10 })).rejects.toThrow('notes.pdf is not a PDF.')
    const sheet = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(put('b.xlsx', 'x')), title: 'Budget' }).id
    await expect(call('work.pdf.open', { itemId: sheet })).rejects.toThrow('Budget is not a PDF.')
    await expect(call('work.pdf.open', { itemId: 'nope' })).rejects.toThrow('There is no canvas item nope.')
    const w9 = openItem(put('fw9.pdf', W9))
    await expect(call('work.pdf.read', { itemId: w9, which: 'export', offset: 0, length: 10 })).rejects.toThrow('No copy has been made of this file yet.')
    // A file on another host is that host's.
    const far = canvasStoreOf(db).open('t1', { kind: 'pdf', source: { at: 'file', host: 'env_mac', path: '/Users/x/far.pdf' }, title: 'Far' }).id
    await expect(call('work.pdf.open', { itemId: far })).rejects.toThrow('Far is on another host (env_mac).')
  })

  it('reads a thread-made item from file.pdf in its own folder', async () => {
    const item = canvasStoreOf(db).open('t1', { kind: 'pdf', source: { at: 'thread' }, title: 'Made' })
    await expect(call('work.pdf.open', { itemId: item.id })).rejects.toThrow('Made is not where it was.')
    copyFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf'), join(canvasItemDir(dir, 't1', item.id), 'file.pdf'))
    expect(await call<PdfView>('work.pdf.open', { itemId: item.id })).toMatchObject({ name: 'Made.pdf', size: W9.length })
  })

  it('reads a form it cannot fill as pages with a reason: an encrypted file', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 2, R: 3 }))
    const id = openItem(put('locked.pdf', await doc.save({ useObjectStreams: false })), 'Locked')
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.formError).toBe('This PDF is encrypted, so its form cannot be read or filled here.')
    expect(view.fields).toEqual([])
  })
})

describe('filling', () => {
  it('pdf_fill suggests with a source; review accepts; a value with no source is refused', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const r = await tool('pdf_fill', { item: id, fields: [{ key: NAME, value: 'Ada Exampleton', source: SOURCE }, { key: SSN1, value: '123' }] })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('Suggested 1 value; the person accepts each from the bar.')
    expect(textOf(r)).toContain(`field 2 (${SSN1}): say where the value came from (source)`)
    const shown = pushes.at(-1) as { push: string; view: PdfView }
    expect(shown.push).toBe('work.pdf')
    expect(shown.view.fields.find((f) => f.key === NAME)).toMatchObject({ state: 'proposed', proposed: 'Ada Exampleton', value: null, provenance: [SOURCE] })
    const view = await call<PdfView>('work.pdf.review', { itemId: id, keys: 'all', verdict: 'accept' })
    expect(view.fields.find((f) => f.key === NAME)).toMatchObject({ state: 'accepted', value: 'Ada Exampleton' })
  })

  it('in "Agent writes" a fill lands at once as one write, and Undo takes it back', async () => {
    const id = openItem(put('fw9.pdf', W9))
    expect((await call<PdfView>('work.pdf.mode', { itemId: id, mode: 'writes' })).mode).toBe('writes')
    const r = await tool('pdf_fill', { item: id, fields: [{ key: NAME, value: 'Ada', source: SOURCE }] })
    expect(textOf(r)).toBe('Wrote 1 value.')
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.written).toMatchObject({ text: 'Filled 1 field' })
    expect(view.fields.find((f) => f.key === NAME)).toMatchObject({ state: 'accepted', value: 'Ada' })
    const back = await call<PdfView>('work.pdf.undo', { itemId: id, writeId: view.written!.id })
    expect(back.written).toBeUndefined()
    expect(back.fields.find((f) => f.key === NAME)).toMatchObject({ state: 'empty', value: null })
    await expect(call('work.pdf.undo', { itemId: id, writeId: view.written!.id })).rejects.toThrow('That write can no longer be taken back.')
  })

  it('setField takes his own value, and refuses a field the form lacks', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const view = await call<PdfView>('work.pdf.setField', { itemId: id, key: NAME, value: 'Ada Lovelace' })
    expect(view.fields.find((f) => f.key === NAME)).toMatchObject({ value: 'Ada Lovelace', state: 'accepted', by: 'owner' })
    await expect(call('work.pdf.setField', { itemId: id, key: 'ghost', value: 'x' })).rejects.toThrow('The form has no field named ghost.')
  })

  it('pdf_fields lists the fields, and says so when the labels cannot be read off the page', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const r = await tool('pdf_fields', { item: id })
    const text = textOf(r)
    expect(text.split('\n')[0]).toBe('name  kind  label  place  value')
    expect(text).toContain(`${NAME}  text  "f1_01"  p. 1 [0.096, 0.149, 0.941, 0.167]  empty`)
    // This host has no pdf-tools and no linked host: the list still comes, with why the labels are short.
    expect(text).toContain('(The labels could not be read off the page:')
    expect((r.structuredContent as { fields: unknown[] }).fields).toHaveLength(23)
  })

  it('a thread acts only on its own pane\'s items', async () => {
    const id = openItem(put('fw9.pdf', W9))
    thread('t2')
    const r = await tool('pdf_fields', { item: id }, 't2')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(`This thread has no canvas item ${id}.`)
  })

  it('highlights are kept and dropped by id', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const view = await call<PdfView>('work.pdf.mark', { itemId: id, page: 1, quads: [[0.1, 0.56, 0.6, 0.575]], text: 'Certification', note: 'read this' })
    expect(view.marks).toEqual([expect.objectContaining({ page: 1, text: 'Certification', note: 'read this', by: 'owner' })])
    expect((await call<PdfView>('work.pdf.unmark', { itemId: id, markId: view.marks[0].id })).marks).toEqual([])
  })
})

describe('signing', () => {
  it('only the owner saves a signature and signs: a thread\'s call is refused, and a key without approve', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const model = { kind: 'model' as const, caps: [], sessionId: 't1' }
    const ctx = { ...work.ctx, push: () => {} } as WorkCtx
    const req = (method: string, params: unknown) => ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest)
    await expect(pdf.handle!(req('work.pdf.setSignature', { signature: SIGNATURE }), ctx, model)).rejects.toThrow('Only the owner saves a signature.')
    await expect(pdf.handle!(req('work.pdf.sign', { itemId: id, signed: true }), ctx, model)).rejects.toThrow('Only the owner signs.')
    // A key reaches these only with approve: the router's capability gate, before the module hears of it.
    expect([METHOD_CAPABILITY['work.pdf.sign'], METHOD_CAPABILITY['work.pdf.setSignature']]).toEqual(['approve', 'approve'])
    await expect(call('work.pdf.sign', { itemId: id, signed: true })).rejects.toThrow('Draw your signature first.')
    expect(await call('work.pdf.setSignature', { signature: SIGNATURE })).toBeNull()
    expect(await call('work.pdf.signature', {})).toEqual({ signature: SIGNATURE })
    const view = await call<PdfView>('work.pdf.sign', { itemId: id, signed: true })
    expect(view).toMatchObject({ signed: true, hasSignature: true })
    expect((await call<PdfView>('work.pdf.sign', { itemId: id, signed: false })).signed).toBe(false)
    expect(await call('work.pdf.setSignature', { signature: null })).toBeNull()
    expect(await call('work.pdf.signature', {})).toEqual({ signature: null })
  })

  it('pdf_fill places the signature and date boxes with no value, and refuses a value for them', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const r = await tool('pdf_fill', {
      item: id,
      fields: [
        { place: { page: 1, bbox: [0.2, 0.735, 0.55, 0.765], label: 'Signature', type: 'signature' } },
        { place: { page: 1, bbox: [0.65, 0.745, 0.9, 0.765], label: 'Date', type: 'date' }, value: 'today', source: SOURCE }
      ]
    })
    expect(textOf(r)).toContain('Placed 2 boxes')
    expect(textOf(r)).toContain("field 2: the signature and its date are the owner's to place; leave the value out")
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.fields.filter((f) => f.origin === 'overlay').map((f) => [f.type, f.state])).toEqual(
      expect.arrayContaining([
        ['signature', 'needs-owner'],
        ['date', 'needs-owner']
      ])
    )
  })
})

describe('the copy that leaves', () => {
  it('work.pdf.export writes the accepted values, a highlight annotation and his signature; what still waits stays out', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'Ada Exampleton' })
    await call('work.pdf.setField', { itemId: id, key: SSN1, value: '123' })
    await tool('pdf_fill', {
      item: id,
      fields: [
        { key: `${P1}f1_02[0]`, value: 'Waiting LLC', source: SOURCE },
        { place: { page: 1, bbox: [0.2, 0.735, 0.55, 0.765], label: 'Signature', type: 'signature' } },
        { place: { page: 1, bbox: [0.65, 0.745, 0.9, 0.765], label: 'Date', type: 'date' } }
      ]
    })
    const marked = await call<PdfView>('work.pdf.mark', { itemId: id, page: 1, quads: [[0.1, 0.56, 0.6, 0.575]], text: 'Certification' })
    await call('work.pdf.setSignature', { signature: SIGNATURE })
    await call('work.pdf.sign', { itemId: id, signed: true })

    // Flattened: no fields left, the values and the date are page text, the signature is ink.
    const flat = await call<{ name: string; size: number; rev: string; warnings: string[] }>('work.pdf.export', { itemId: id })
    expect(flat).toMatchObject({ name: 'fw9.pdf', warnings: [] })
    const bytes = await bytesOf(id, 'export')
    expect(bytes.length).toBe(flat.size)
    expect((await readForm(bytes)).fields).toHaveLength(0)
    const text = await pageText(bytes)
    expect(text).toContain('AdaExampleton')
    expect(text).toContain('123')
    expect(text).not.toContain('WaitingLLC')
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPages()[0]
    const contents = page.node.Contents() as PDFArray
    const ops = contents.asArray().map((r) => new TextDecoder('latin1').decode(decodePDFRawStream(doc.context.lookup(r) as PDFRawStream).decode())).join('\n')
    expect(ops).toMatch(/1 J\s+1 j/)
    const annots = (page.node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r) as PDFDict)
    const highlight = annots.find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('Highlight'))!
    expect(highlight).toBeDefined()
    expect((highlight.get(PDFName.of('NM')) as PDFHexString).decodeText()).toBe(`tc:t1:${marked.marks[0].id}`)

    // Not flattened: the values are the form's own, the waiting one is not among them.
    const live = await call<{ warnings: string[] }>('work.pdf.export', { itemId: id, flatten: false })
    expect(live.warnings).toEqual([])
    const form = await readForm(await bytesOf(id, 'export'))
    expect(form.fields.find((f) => f.key === NAME)?.value).toBe('Ada Exampleton')
    expect(form.fields.find((f) => f.key === `${P1}f1_02[0]`)?.value).toBeNull()
  })

  it('pdf_export answers the copy\'s path and how many values still wait', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await tool('pdf_fill', { item: id, fields: [{ key: NAME, value: 'Ada', source: SOURCE }] })
    const r = await tool('pdf_export', { item: id })
    const out = r.structuredContent as { path: string; pending: number }
    expect(out.path).toMatch(new RegExp(`^${join(canvasItemDir(dir, 't1', id), 'export').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-z]+-[0-9a-f]{6}/fw9\\.pdf$`))
    expect(out.pending).toBe(1)
    expect(textOf(r)).toContain('1 value still waits for the person and is not in the copy.')
    expect(readFileSync(out.path).subarray(0, 5).toString()).toBe('%PDF-')
  })
})

describe('the tools without pdf-tools on this host', () => {
  it('pdf_extract says why it cannot read, and refuses a path that is not a PDF', async () => {
    const r = await tool('pdf_extract', { file: put('fw9.pdf', W9) })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/pdf-tools is not installed on env_test|no converter from pdf to extract/)
    const notPdf = await tool('pdf_extract', { file: put('x.pdf', 'hello') })
    expect(textOf(notPdf)).toBe(`${join(dir, 'x.pdf')} is not a PDF.`)
    expect(textOf(await tool('pdf_extract', { file: 'relative.pdf' }))).toBe('There is no file at relative.pdf.')
    expect(textOf(await tool('pdf_extract', {}))).toBe('Pass `item` (a PDF open in the canvas) or `file` (an absolute path).')
  })
})

describe('deleted threads', () => {
  it('drops a deleted thread\'s rows', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'Ada' })
    await call('work.pdf.mark', { itemId: id, page: 1, quads: [[0, 0, 1, 0.1]], text: 'x' })
    for (const fn of removed) fn(['t1'])
    const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = 't1'`).get() as { n: number }).n
    expect([count('work_pdf_fields'), count('work_pdf_marks'), count('work_pdf_items')]).toEqual([0, 0, 0])
  })
})


describe('labelOf', () => {
  it('keeps a short label and cuts a paragraph to its start', async () => {
    const { labelOf } = await import('./tools')
    expect(labelOf('1 Name')).toBe('1 Name')
    const long = labelOf(`1 Name of entity/individual. ${'An entry is required. '.repeat(10)}`)
    expect(long).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
  })
})

/**
 * The tools with the installed pdf-tools (TEMP_CODE_WORK_TOOLS_DATA, the
 * box's userData): the whole registry is loaded, so `ctx.convert` finds
 * this pillar's converters, and the toolchain is linked tool by tool.
 */
const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
describe.skipIf(!REAL)('the tools with the installed pdf-tools', () => {
  beforeEach(async () => {
    const { statePath } = await import('../formats/tools')
    const { mkdirSync, symlinkSync } = await import('node:fs')
    const state = JSON.parse(readFileSync(statePath(REAL!), 'utf8')) as { tools: Record<string, { ok: boolean; dir?: string }> }
    mkdirSync(join(dir, 'work-tools'), { recursive: true })
    const linked = new Set<string>()
    for (const t of Object.values(state.tools)) {
      const top = t.dir?.split('/')[0]
      if (!t.ok || !top || linked.has(top)) continue
      linked.add(top)
      symlinkSync(join(REAL!, 'work-tools', top), join(dir, 'work-tools', top))
    }
    copyFileSync(statePath(REAL!), statePath(dir))
  })

  it('pdf_extract reads a canvas item with a citation code after each passage; pdf_fields labels from the page; pdf_page_image draws a region', async () => {
    const id = openItem(put('fw9.pdf', W9))
    const r = await tool('pdf_extract', { item: id, pages: '1' })
    expect(r.isError, textOf(r)).toBeFalsy()
    const text = textOf(r)
    expect(text.startsWith('6 pages\n\n## Page 1\n\n')).toBe(true)
    expect(text).toContain('Request for Taxpayer')
    // Every passage ends with its code, and every table is followed by one.
    const passages = text.split('\n\n').slice(2).filter((p) => !p.startsWith('|'))
    expect(passages.length).toBeGreaterThan(20)
    for (const p of passages) expect(p).toMatch(new RegExp(`#pdf:${id}:1:\\d+,\\d+,\\d+,\\d+$`))
    const json = JSON.parse(textOf(await tool('pdf_extract', { item: id, pages: '1', format: 'json' })).replace(/^6 pages\n\n/, '')) as { sizes: unknown[] }
    expect(json.sizes).toEqual([{ page: 1, width: 611.976, height: 791.968 }])

    const fields = textOf(await tool('pdf_fields', { item: id }))
    expect(fields).not.toContain('could not be read off the page')
    expect(fields).toMatch(/f1_01\[0\]  text  "1 Name of entity\/individual/)
    expect((await call<PdfView>('work.pdf.open', { itemId: id })).fields.find((f) => f.key === NAME)?.label).toMatch(/^1 Name of entity/)

    const img = await tool('pdf_page_image', { item: id, page: 1, region: [0, 0, 1, 0.25] })
    const png = img.content[0] as { type: string; data: string; mimeType: string }
    expect(png).toMatchObject({ type: 'image', mimeType: 'image/png' })
    const b = Buffer.from(png.data, 'base64')
    expect(b.readUInt32BE(16)).toBe(1280)
  })
})

describe('the review\'s holes, through the module', () => {
  const SIG_BOX = { page: 1, bbox: [0.2, 0.735, 0.55, 0.765], label: 'Signature', type: 'signature' }
  const inkOf = async (bytes: Uint8Array): Promise<boolean> => {
    const doc = await PDFDocument.load(bytes)
    const contents = doc.getPages()[0].node.Contents() as PDFArray
    return /1 J\s+1 j/.test(contents.asArray().map((r) => new TextDecoder('latin1').decode(decodePDFRawStream(doc.context.lookup(r) as PDFRawStream).decode())).join('\n'))
  }
  const signedItem = async (path: string): Promise<string> => {
    const id = openItem(path)
    await call('work.pdf.open', { itemId: id })
    await tool('pdf_fill', { item: id, fields: [{ key: 'box:sig', place: SIG_BOX }] })
    await call('work.pdf.setSignature', { signature: SIGNATURE })
    expect((await call<PdfView>('work.pdf.sign', { itemId: id, signed: true })).signed).toBe(true)
    return id
  }

  it('B2: a thread cannot move his signature once he signed', async () => {
    const id = await signedItem(put('fw9.pdf', W9))
    const r = await tool('pdf_fill', { item: id, fields: [{ key: 'box:sig', place: { ...SIG_BOX, page: 3 } }] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('box:sig: the owner has signed there; it cannot be moved')
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.signed).toBe(true)
    expect(view.fields.find((f) => f.key === 'box:sig')).toMatchObject({ page: 1, state: 'accepted' })
  })

  it('B3 and M5: pdf_fill refuses to retype a box, and to place a box under a form field\'s key', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await tool('pdf_fill', { item: id, fields: [{ key: 'box:t', place: { ...SIG_BOX, type: 'text' }, value: 'x', source: SOURCE }] })
    const r = await tool('pdf_fill', { item: id, fields: [{ key: 'box:t', place: SIG_BOX }, { key: NAME, place: { ...SIG_BOX, type: 'text' }, value: 'y', source: SOURCE }] })
    expect(textOf(r)).toContain('box:t: it is a text box; place a new key for a signature box')
    expect(textOf(r)).toContain(`${NAME}: a placed box's key starts with "box:" and is not one of the form's fields`)
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.fields.find((f) => f.key === 'box:t')).toMatchObject({ type: 'text', proposed: 'x' })
    // The value meant for the refused box went nowhere: the form's own field has no suggestion.
    expect(view.fields.find((f) => f.key === NAME)).toMatchObject({ origin: 'acroform', state: 'empty' })
  })

  it('B4: a new version of the file takes his signature off, and the export carries no ink', async () => {
    const path = put('fw9.pdf', W9)
    const id = await signedItem(path)
    const exp = await call<{ size: number }>('work.pdf.export', { itemId: id })
    expect(exp.size).toBeGreaterThan(0)
    expect(await inkOf(await bytesOf(id, 'export'))).toBe(true)
    appendFileSync(path, '\n% version B\n')
    const view = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(view.signed).toBe(false)
    expect(view.fields.find((f) => f.key === 'box:sig')?.state).toBe('needs-owner')
    await call('work.pdf.export', { itemId: id })
    expect(await inkOf(await bytesOf(id, 'export'))).toBe(false)
  })

  it('B4: in "Agent writes" a write after he signed takes the signature off', async () => {
    const id = await signedItem(put('fw9.pdf', W9))
    await call('work.pdf.mode', { itemId: id, mode: 'writes' })
    await tool('pdf_fill', { item: id, fields: [{ key: NAME, value: 'Someone else', source: SOURCE }] })
    expect((await call<PdfView>('work.pdf.open', { itemId: id })).signed).toBe(false)
    await call('work.pdf.export', { itemId: id })
    expect(await inkOf(await bytesOf(id, 'export'))).toBe(false)
  })

  it('M3: a read serves the version its rev names, never a newer one, and refuses one no longer kept', async () => {
    const path = put('fw9.pdf', W9)
    const id = openItem(path)
    const v1 = await call<PdfView>('work.pdf.open', { itemId: id })
    const read = (rev?: string) => call<{ data: string; size: number; rev: string }>('work.pdf.read', { itemId: id, offset: 0, length: 16, ...(rev ? { rev } : {}) })
    appendFileSync(path, '\n% B\n')
    // No open since: a read, with its rev or without, is still version 1, and copies nothing.
    expect(await read(v1.rev)).toMatchObject({ size: W9.length, rev: v1.rev })
    expect(await read()).toMatchObject({ size: W9.length, rev: v1.rev })
    const v2 = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(v2.rev).not.toBe(v1.rev)
    // A load begun on version 1 can still finish.
    expect(await read(v1.rev)).toMatchObject({ size: W9.length })
    expect(await read(v2.rev)).toMatchObject({ size: W9.length + 5 })
    appendFileSync(path, '% C\n')
    await call('work.pdf.open', { itemId: id })
    await expect(read(v1.rev)).rejects.toThrow('This file changed since it was opened: open it again.')
    expect(await read(v2.rev)).toMatchObject({ size: W9.length + 5 })
  })

  it('M4: a remote key reads an item\'s file only under the roots it could name itself', async () => {
    const remote: Principal = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] as never }
    const outside = openItem(put('tax-return.pdf', W9), 'Tax return')
    for (const [method, params] of [
      ['work.pdf.open', { itemId: outside }],
      ['work.pdf.read', { itemId: outside, offset: 0, length: 10 }],
      ['work.pdf.export', { itemId: outside }]
    ] as const)
      await expect(call(method, params, remote)).rejects.toThrow(`forbidden: ${method} is outside app-managed roots`)
    // This host's own window reads it.
    expect((await call<PdfView>('work.pdf.open', { itemId: outside })).name).toBe('tax-return.pdf')
    // Under a workspace's folder, the key reads it too.
    const ws = join(dir, 'ws')
    mkdirSync(ws)
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES ('w9', 'Job', ?, 1)`).run(ws)
    const inside = openItem(join(ws, 'fw9.pdf'), 'Inside')
    copyFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf'), join(ws, 'fw9.pdf'))
    expect((await call<PdfView>('work.pdf.open', { itemId: inside }, remote)).name).toBe('fw9.pdf')
    // A thread-made item's file is in its own folder.
    const made = canvasStoreOf(db).open('t1', { kind: 'pdf', source: { at: 'thread' }, title: 'Made' })
    copyFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf'), join(canvasItemDir(dir, 't1', made.id), 'file.pdf'))
    expect((await call<PdfView>('work.pdf.open', { itemId: made.id }, remote)).name).toBe('Made.pdf')
  })

  it('a thread-made file.pdf that is not a PDF is never served', async () => {
    const made = canvasStoreOf(db).open('t1', { kind: 'pdf', source: { at: 'thread' }, title: 'Made' })
    writeFileSync(join(canvasItemDir(dir, 't1', made.id), 'file.pdf'), 'not a pdf')
    await expect(call('work.pdf.open', { itemId: made.id })).rejects.toThrow('Made.pdf is not a PDF.')
    await expect(call('work.pdf.read', { itemId: made.id, offset: 0, length: 10 })).rejects.toThrow('Made.pdf is not a PDF.')
  })

  it('each export is its own file: a path an earlier pdf_export handed out keeps its bytes; the newest few are kept', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'First' })
    const first = (await tool('pdf_export', { item: id })).structuredContent as { path: string }
    const firstBytes = readFileSync(first.path)
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'Second' })
    const second = (await tool('pdf_export', { item: id })).structuredContent as { path: string }
    expect(second.path).not.toBe(first.path)
    expect(readFileSync(first.path).equals(firstBytes)).toBe(true)
    // work.pdf.read with which: 'export' is the newest.
    expect((await bytesOf(id, 'export')).equals(readFileSync(second.path))).toBe(true)
    for (let i = 0; i < 5; i++) await call('work.pdf.export', { itemId: id })
    expect(existsSync(first.path)).toBe(false)
    expect(readdirSync(join(canvasItemDir(dir, 't1', id), 'export'))).toHaveLength(5)
  })
})

describe('round three: the fence on every method, the push, the hash, reverts', () => {
  const remote: Principal = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] as never }
  const insideWorkspace = (): string => {
    const ws = join(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, path, created_at) VALUES ('w9', 'Job', ?, 1)`).run(ws)
    return put('ws/inside.pdf', W9)
  }

  it('H1: a remote key gets nothing of an out-of-fence item from any method, and writes nothing into it', async () => {
    const id = openItem(put('tax.pdf', W9), 'Tax')
    await call('work.pdf.open', { itemId: id })
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'SECRET-SSN' })
    const view = await call<PdfView>('work.pdf.mark', { itemId: id, page: 1, quads: [[0, 0, 1, 0.1]], text: 'x' })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['work.pdf.open', {}],
      ['work.pdf.read', { offset: 0, length: 10 }],
      ['work.pdf.review', { keys: 'all', verdict: 'accept' }],
      ['work.pdf.setField', { key: NAME, value: 'Mallory' }],
      ['work.pdf.mark', { page: 1, quads: [[0, 0, 1, 0.1]], text: 'y' }],
      ['work.pdf.unmark', { markId: view.marks[0].id }],
      ['work.pdf.mode', { mode: 'writes' }],
      ['work.pdf.undo', { writeId: 'w' }],
      ['work.pdf.sign', { signed: true }],
      ['work.pdf.export', {}]
    ]
    for (const [method, params] of calls) await expect(call(method, { itemId: id, ...params }, remote), method).rejects.toThrow(`forbidden: ${method} is outside app-managed roots`)
    const after = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(after.fields.find((f) => f.key === NAME)?.value).toBe('SECRET-SSN')
    expect(after.marks).toHaveLength(1)
    expect(after.mode).toBe('suggests')
    // Inside the fence the same key works.
    const inside = openItem(insideWorkspace(), 'Inside')
    expect((await call<PdfView>('work.pdf.mode', { itemId: inside, mode: 'writes' }, remote)).mode).toBe('writes')
  })

  it('H1: the work.pdf push of an out-of-fence item never reaches a remote key\'s socket; an item inside does', async () => {
    const heard: WorkPush[] = []
    work.pushes.onPush((p) => heard.push(p), remote)
    // an admin key on another device is fenced by path as any key is (F2): before, a push of an out-of-fence item went to admin keys
    const admin: WorkPush[] = []
    work.pushes.onPush((p) => admin.push(p), { ...remote, caps: ['read', 'operate', 'approve', 'admin'] as never })
    const outside = openItem(put('tax.pdf', W9), 'Tax')
    await call('work.pdf.setField', { itemId: outside, key: NAME, value: 'SECRET-SSN' })
    expect(pushes.some((p) => p.push === 'work.pdf')).toBe(true)
    expect(heard.filter((p) => p.push === 'work.pdf')).toEqual([])
    expect(admin.filter((p) => p.push === 'work.pdf')).toEqual([])
    const inside = openItem(insideWorkspace(), 'Inside')
    await call('work.pdf.setField', { itemId: inside, key: NAME, value: 'Ada' })
    expect(heard.filter((p) => p.push === 'work.pdf').map((p) => (p as { view: PdfView }).view.itemId)).toEqual([inside])
  })

  it('N2: a thread\'s suggestion over a value he accepted does not take his signature off, and the copy keeps his value', async () => {
    const id = openItem(put('fw9.pdf', W9))
    await call('work.pdf.open', { itemId: id })
    await tool('pdf_fill', { item: id, fields: [{ key: 'box:sig', place: { page: 1, bbox: [0.2, 0.735, 0.55, 0.765], label: 'Signature', type: 'signature' } }, { key: 'box:phone', place: { page: 1, bbox: [0.1, 0.9, 0.4, 0.92], label: 'Phone', type: 'text' } }] })
    await call('work.pdf.setField', { itemId: id, key: NAME, value: 'Ada Exampleton' })
    await call('work.pdf.setField', { itemId: id, key: 'box:phone', value: '555-0100' })
    await call('work.pdf.setSignature', { signature: SIGNATURE })
    expect((await call<PdfView>('work.pdf.sign', { itemId: id, signed: true })).signed).toBe(true)
    const r = await tool('pdf_fill', { item: id, fields: [{ key: NAME, value: 'Someone else', source: SOURCE }, { key: 'box:phone', value: '555-9999', source: SOURCE }] })
    expect(textOf(r)).toContain('Suggested 2 values')
    expect((await call<PdfView>('work.pdf.open', { itemId: id })).signed).toBe(true)
    await call('work.pdf.export', { itemId: id })
    const text = await pageText(await bytesOf(id, 'export'))
    expect(text).toContain('AdaExampleton')
    expect(text).toContain('555-0100')
    expect(text).not.toContain('Someoneelse')
    // Accepting the suggestion changes what the copy carries: then it comes off.
    expect((await call<PdfView>('work.pdf.review', { itemId: id, keys: 'all', verdict: 'accept' })).signed).toBe(false)
  })

  it('N1: a file put back to a version still kept is served as that version by every path', async () => {
    const { utimesSync, statSync } = await import('node:fs')
    const path = put('fw9.pdf', W9)
    const when = statSync(path).mtime
    const id = openItem(path)
    const v1 = await call<PdfView>('work.pdf.open', { itemId: id })
    appendFileSync(path, '\n% B\n')
    const v2 = await call<PdfView>('work.pdf.open', { itemId: id })
    expect(v2.rev).not.toBe(v1.rev)
    // Put back as `cp -p` would: the old bytes and the old time.
    writeFileSync(path, W9)
    utimesSync(path, when, when)
    expect((await call<PdfView>('work.pdf.open', { itemId: id })).rev).toBe(v1.rev)
    const view = await call<PdfView>('work.pdf.mode', { itemId: id, mode: 'writes' })
    expect(view).toMatchObject({ rev: v1.rev, size: W9.length })
    expect((await call<{ size: number; rev: string }>('work.pdf.read', { itemId: id, offset: 0, length: 10 })).rev).toBe(v1.rev)
  })

  it('two opens of a new version at once both answer it', async () => {
    const path = put('fw9.pdf', W9)
    const id = openItem(path)
    await call('work.pdf.open', { itemId: id })
    appendFileSync(path, '\n% B\n')
    const views = await Promise.all(Array.from({ length: 6 }, () => call<PdfView>('work.pdf.open', { itemId: id })))
    expect(new Set(views.map((v) => v.rev)).size).toBe(1)
    expect(readdirSync(canvasItemDir(dir, 't1', id)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a read with rev of a file that is gone, with no copy kept, says it is missing', async () => {
    const path = put('fw9.pdf', W9)
    const id = openItem(path)
    const v = await call<PdfView>('work.pdf.open', { itemId: id })
    unlinkSync(path)
    for (const f of readdirSync(canvasItemDir(dir, 't1', id))) if (f.startsWith('kept-')) unlinkSync(join(canvasItemDir(dir, 't1', id), f))
    await expect(call('work.pdf.read', { itemId: id, rev: v.rev, offset: 0, length: 10 })).rejects.toThrow('fw9.pdf is not where it was.')
  })
})

/** The listener's roots as index.ts hands them in (managedRoots): every project's checkout and workspace's folder. */
function hostFence(db: DatabaseSync): { roots(): string[]; denied(): string[] } {
  return { roots: () => (db.prepare(`SELECT cwd AS p FROM projects UNION SELECT path AS p FROM workspaces`).all() as Array<{ p: string }>).map((r) => r.p), denied: () => [] }
}
