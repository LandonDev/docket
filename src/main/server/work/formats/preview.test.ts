import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySidecar } from 'work-kit/formats'
import { readDocx, writeDocx } from 'work-kit/formats/docx'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { FORMATS_CAPS, PREVIEW_READ_MAX, type ImportAnswer, type PreviewAnswer, type Readiness } from '@shared/contract-work-formats'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { ensureThreadTables } from '../docs/threads'
import { importFolderOf } from '../files/imports'
import { filePreviewerFor } from '../files/hooks'
import * as libraries from '../files/places/libraries'
import { formats } from './index'
import { NEEDS_ITEM, NOT_THIS_ITEM, previewsRoot, sourceKey, sweepPreviews, wordContent } from './preview'
import * as jobRunner from './jobs'
import { convertersOf, JobRunner, pressed, type ConvertJob, type Converter } from './jobs'
import { setPrinter } from './print'
import { Toolchain } from './tools'

/*
 * A document's Preview on this host: the Work service in process for the
 * Word file, a printer and a converter of the test's own that write small
 * real PDFs, so no LibreOffice or Chromium is asked.
 */

const CORPUS = join(dirname(createRequire(import.meta.url).resolve('work-kit/formats/docx')), 'corpus')
const SECRET = 'f'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[] } = { dirs: [], services: [], convex: [] }

afterEach(async () => {
  setPrinter(null)
  vi.restoreAllMocks()
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

// pdf-lib stamps a new PDF with the second it was made in: two made a second apart are the same size
// and not the same bytes. A fixed date, so "the printed page" is one file whenever it is made.
const pdfOf = async (pages: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create()
  doc.setCreationDate(new Date(0))
  doc.setModificationDate(new Date(0))
  for (let i = 0; i < pages; i++) doc.addPage()
  return doc.save()
}

type Job = ConvertJob & { output: string }

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'doc12-preview-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  const data = join(dir, 'data')
  mkdirSync(data, { recursive: true })
  const config: ServiceConfig = {
    port: 0,
    socketPath: servicePaths(data).socketPath,
    secret: SECRET,
    dataDir: join(data, 'work-service'),
    hostedDir: join(dir, 'hosted'),
    host: 'env_box',
    lifeos: { here: true, url: convex.url },
    trusted: [],
    links: []
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: () => {} })
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)')
  ensureThreadTables(db)
  const work = join(dir, 'Work', 'Northside')
  mkdirSync(work, { recursive: true })
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('w1', 'Northside', work)
  // Each item shows the first document it is asked for, as a tab shows one file.
  const items: Record<string, { id: string; sessionId: string; source?: CanvasSource }> = { i0: { id: 'i0', sessionId: 't1' }, i9: { id: 'i9', sessionId: 't1' }, j0: { id: 'j0', sessionId: 't2' } }
  // Each job's output: a 2-page PDF when it draws, else the input's bytes under the new name.
  const jobs: Job[] = []
  const prints: string[] = []
  setPrinter(async (html) => (prints.push(html), { pdf: await pdfOf(html.includes('three') ? 3 : 1), warnings: ['1 picture from the web left out of the PDF'] }))
  const ctx = {
    db,
    host: 'env_box',
    dataDir: data,
    log: () => {},
    push: () => {},
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith(work),
    scopeOf: (id: string) => (id === 't1' ? { sessionId: 't1', workspaceId: 'w1', sector: null, host: 'env_box', away: false, routineRunId: null, shared: () => false } : null),
    canvas: { get: (id: string) => items[id] ?? null },
    lifeos: { connected: () => false, owner: () => ({ query: async () => null, mutation: async () => null }) },
    service: { internal: (route: string, body: unknown) => post(config.socketPath, route, body) },
    async convert(job: ConvertJob) {
      const output = job.output ?? `${job.input}.${job.to}`
      writeFileSync(output, job.to === 'png' ? Buffer.from([137, 80, 78, 71]) : job.to === 'pdf' ? await pdfOf(2) : readFileSync(job.input))
      jobs.push({ ...job, output })
      return { output, ranOn: 'env_box', warnings: job.to === 'pdf' ? ['drawn without its fonts'] : [] }
    }
  } as unknown as WorkCtx
  const ask = async <T,>(method: string, params: unknown, by: Caller = { kind: 'local', caps: [] }): Promise<T> => {
    const named = params as { itemId?: string; source?: CanvasSource }
    const item = named.itemId ? items[named.itemId] : undefined
    if (item && !item.source && named.source) item.source = named.source
    const done = await formats.handle!({ id: '1', method, params } as ClientRequest, ctx, by)
    if (!done.handled) throw new Error('not handled')
    return done.result as T
  }
  const read = async (params: Record<string, unknown>) => Buffer.from((await ask<{ data: string }>('work.formats.previewRead', params)).data, 'base64')
  /** A Word file imported into a document: its source. */
  const doc = async (name = 'review.docx'): Promise<CanvasSource> => {
    const path = join(work, name)
    copyFileSync(join(CORPUS, name), path)
    return (await ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })).source
  }
  return { dir, data, work, ctx, ask, read, doc, jobs, prints }
}

const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [])

describe('a PDF preview', () => {
  it('is the printed page: its pages counted, read by range, and the picture is the file', async () => {
    const r = await rig()
    const source: CanvasSource = { at: 'file', host: 'env_box', path: join(r.work, 'Plan.tcdoc') }
    const got = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>three pages</p>' })
    const printed = await pdfOf(3)
    expect(got).toMatchObject({ size: printed.byteLength, pages: 3, drawnBy: 'tempcode', name: 'Plan.pdf', warnings: ['1 picture from the web left out of the PDF'] })
    expect(got.rev).toMatch(/^[a-f0-9]{32}$/)
    const half = Math.floor(got.size / 2)
    const a = await r.read({ source, itemId: 'i0', rev: got.rev, offset: 0, length: half })
    const b = await r.read({ source, itemId: 'i0', rev: got.rev, offset: half, length: PREVIEW_READ_MAX })
    expect(Buffer.concat([a, b]).equals(Buffer.from(printed))).toBe(true)
    expect((await r.read({ source, itemId: 'i0', rev: got.rev, offset: got.size + 10, length: 10 })).length).toBe(0)
    await expect(r.ask('work.formats.preview', { source, itemId: 'i0', format: 'pdf' })).rejects.toThrow('a PDF preview needs its print page')
  })

  it('the same page answers the same render without printing again; a changed one makes a new render and the old is gone', async () => {
    const r = await rig()
    const source: CanvasSource = { at: 'file', host: 'env_box', path: join(r.work, 'Plan.tcdoc') }
    const first = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>one</p>' })
    const again = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>one</p>' })
    expect(again).toEqual(first)
    expect(r.prints).toHaveLength(1)
    // Paper is part of what it was made from.
    const letter = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>one</p>', paper: 'Letter' })
    expect(letter.rev).not.toBe(first.rev)
    const changed = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>two</p>' })
    expect(changed.rev).not.toBe(first.rev)
    expect(r.prints).toHaveLength(3)
    await expect(r.read({ source, itemId: 'i0', rev: first.rev, offset: 0, length: 10 })).rejects.toThrow(/^that preview is gone: draw it again$/)
    expect(readdirSync(join(previewsRoot(r.data), 't1', 'i0', sourceKey(source))).sort()).toEqual([`pdf.${changed.rev}.json`, `pdf.${changed.rev}.pdf`])
  })
})

describe('a Word preview', () => {
  it('is the exported file, drawn once by LibreOffice, and drawn again only when the file changes', async () => {
    const r = await rig()
    const source = await r.doc()
    const got = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'docx' })
    expect(r.jobs.map((j) => [j.from, j.to])).toEqual([['docx', 'pdf']])
    expect(got).toMatchObject({ pages: 2, drawnBy: 'libreoffice', name: 'review.docx' })
    expect(got.warnings).toContain('drawn without its fonts')
    // The picture alone is kept: the file itself is Export's to write, which needs no renderer.
    expect(readdirSync(join(previewsRoot(r.data), 't1', 'i0', sourceKey(source))).sort()).toEqual([`docx.${got.rev}.json`, `docx.${got.rev}.pdf`])
    // The same document again is the same file: nothing converts.
    expect(await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'docx' })).toEqual(got)
    expect(r.jobs).toHaveLength(1)
    // Scratch copies go: none is left beside the renders.
    expect(readdirSync(join(r.data, 'formats', 'scratch'))).toEqual([])
  })

  it('RTF is drawn from the RTF file itself, not from the Word file', async () => {
    const r = await rig()
    const source = await r.doc()
    const got = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'rtf' })
    expect(r.jobs.map((j) => [j.from, j.to])).toEqual([
      ['docx', 'rtf'],
      ['rtf', 'pdf']
    ])
    expect(r.jobs[1].input).toBe(r.jobs[0].output)
    expect(got.name).toBe('review.rtf')
    expect(r.jobs.every((j) => j.shared === false)).toBe(true)
  })
})

describe('Check in Word through the formats pillar', () => {
  const attach = (r: Awaited<ReturnType<typeof rig>>, state: Readiness, calls: string[] = []) => {
    const used: boolean[] = []
    const converter: Converter = {
      from: 'docx', to: 'pdf+word',
      ready: () => state,
      async run(job) {
        used.push(pressed(job))
        writeFileSync(job.output, await pdfOf(1))
        return {}
      }
    }
    const runner = new JobRunner({
      host: 'env_box', dataDir: r.data, converters: convertersOf([{ ...formats, convert: [converter] }], () => {}),
      links: () => [{ id: 'env_mac', request: async (method) => { calls.push(method); throw new Error('no linked converter') } }],
      log: () => {}
    })
    vi.spyOn(jobRunner, 'runnerOf').mockReturnValue(Promise.resolve(runner))
    r.ctx.convert = runner.convert.bind(runner)
    return used
  }

  it.each(['ready', 'asleep', 'not open', 'none'] as const)('reports %s and answers the pressed draw accordingly', async (state) => {
    const r = await rig()
    const source = await r.doc()
    const used = attach(r, state)
    const params = { source, itemId: 'i0' }
    expect(await r.ask('work.formats.previewOffice', params)).toEqual({ app: 'word', state })
    expect(used).toEqual([])
    const answer = await r.ask('work.formats.preview', { ...params, format: 'docx', by: 'word' })
    if (state === 'ready' || state === 'asleep') {
      expect(answer).toMatchObject({ drawnBy: 'word', pages: 1, name: 'review.docx' })
      expect(used).toEqual([true])
    } else {
      expect(answer).toEqual({ notInReach: state })
      expect(used).toEqual([])
    }
  })

  it("keeps Word and LibreOffice's revisions apart and requires a press even for an already drawn file", async () => {
    const r = await rig()
    const source = await r.doc()
    const params = { source, itemId: 'i0', format: 'docx' }
    const normal = await r.ask<PreviewAnswer>('work.formats.preview', params)
    const used = attach(r, 'ready')
    const word = await r.ask<PreviewAnswer>('work.formats.preview', { ...params, by: 'word' })
    expect(word.rev).not.toBe(normal.rev)
    expect(await r.ask('work.formats.preview', { ...params, by: 'word' })).toEqual(word)
    expect(await r.ask('work.formats.preview', params)).toEqual(normal)
    for (const rev of [word.rev, normal.rev]) expect((await r.read({ source, itemId: 'i0', rev, offset: 0, length: 4 })).toString()).toBe('%PDF')
    for (const by of [{ kind: 'model', sessionId: 't1' }, { kind: 'remote', peer: 'env_mac', caps: ['admin'] }] as unknown as Caller[]) {
      await expect(r.ask('work.formats.preview', { ...params, by: 'word' }, by)).rejects.toThrow('needs your own press')
    }
    expect(used).toEqual([true])
    expect(FORMATS_CAPS['work.formats.previewOffice']).toBe('read')
    const parse = (format: string) => ClientRequestSchema.safeParse({ id: '1', method: 'work.formats.preview', params: { ...params, format, by: 'word' } }).success
    expect(parse('docx')).toBe(true)
    for (const format of ['pdf', 'odt', 'rtf']) expect(parse(format)).toBe(false)
  })

  it("never asks a linked host about Word for a shared file", async () => {
    const r = await rig()
    const mine = await r.doc()
    const path = join(importFolderOf(r.data, { host: 'env_box', path: '/fake/OneDrive - Work/Review.docx' }), 'Review.tcdoc')
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync((mine as { path: string }).path, path)
    const source = { at: 'file', host: 'env_box', path }
    const calls: string[] = []
    attach(r, 'none', calls)
    expect(await r.ask('work.formats.previewOffice', { source, itemId: 'i0' })).toEqual({ app: 'word', state: 'none' })
    expect(await r.ask('work.formats.preview', { source, itemId: 'i0', format: 'docx', by: 'word' })).toEqual({ notInReach: 'none' })
    expect(calls).toEqual([])
  })
})

describe('one page for Files', () => {
  const png = Buffer.from([137, 80, 78, 71])
  const opts = { page: 1, width: 320 }
  const ref = (path: string): CanvasSource => ({ at: 'file', host: 'env_box', path })

  it('uses the open .tcdoc preview without drawing the PDF again', async () => {
    const r = await rig()
    const source = await r.doc()
    await r.ask('work.formats.preview', { source, itemId: 'i0', format: 'docx' })
    const stop = formats.start!(r.ctx)
    try {
      expect(await filePreviewerFor('document')!(source, opts)).toEqual({ png, pages: 2 })
      expect(r.jobs.map((j) => [j.from, j.to])).toEqual([['docx', 'pdf'], ['pdf', 'png']])
      expect(r.jobs.at(-1)).toMatchObject({ here: true, options: opts })
    } finally {
      stop()
    }
  })

  it('keeps a private .tcdoc render for its next preview', async () => {
    const r = await rig()
    const source = await r.doc()
    const stop = formats.start!(r.ctx)
    try {
      expect(await filePreviewerFor('document')!(source, opts)).toEqual({ png, pages: 2 })
      await r.ask('work.formats.preview', { source, itemId: 'i0', format: 'docx' })
      expect(r.jobs.map((j) => j.to)).toEqual(['pdf', 'png'])
    } finally {
      stop()
    }
  })

  it('draws a Word file in place and a Markdown file through a temporary Word export', async () => {
    const r = await rig()
    const word = join(r.work, 'Handout.docx')
    const markdown = join(r.work, 'Handout.md')
    copyFileSync(join(CORPUS, 'review.docx'), word)
    writeFileSync(markdown, '# A dummy Markdown handout')
    const stop = formats.start!(r.ctx)
    try {
      const draw = filePreviewerFor('document')!
      const convert = r.ctx.convert.bind(r.ctx)
      const seen: string[] = []
      vi.spyOn(r.ctx, 'convert').mockImplementation(async (job) => {
        if (job.from === 'docx' && job.input !== word) seen.push(JSON.stringify(readDocx(readFileSync(job.input)).blocks))
        return convert(job)
      })
      expect(await draw(ref(word), { page: 2, width: 256 })).toEqual({ png, pages: 2 })
      expect(await draw(ref(markdown), opts)).toEqual({ png, pages: 2 })
      expect(seen[0]).toContain('A dummy Markdown handout')
      expect(r.jobs[0]?.input).toBe(word)
      expect(r.jobs[1]?.options).toEqual({ page: 2, width: 256 })
      expect(r.jobs.map((j) => [j.from, j.to, j.here])).toEqual([['docx', 'pdf', true], ['pdf', 'png', true], ['docx', 'pdf', true], ['pdf', 'png', true]])
      expect(readdirSync(join(r.data, 'formats', 'scratch'))).toEqual([])
      expect(await draw(ref(join(r.work, 'missing.docx')), opts)).toBeNull()
    } finally {
      stop()
    }
  })

  it('draws a Word file once while he pages through it, and again once it is saved', async () => {
    const r = await rig()
    const word = join(r.work, 'Paged.docx')
    copyFileSync(join(CORPUS, 'review.docx'), word)
    const stop = formats.start!(r.ctx)
    try {
      const draw = filePreviewerFor('document')!
      await draw(ref(word), { page: 1, width: 256 })
      await draw(ref(word), { page: 2, width: 256 })
      expect(r.jobs.map((j) => [j.from, j.to])).toEqual([['docx', 'pdf'], ['pdf', 'png'], ['pdf', 'png']])
      // Nothing of it is on disk between the two asks: the PDF waits in memory.
      expect(readdirSync(join(r.data, 'formats', 'scratch'))).toEqual([])
      const later = new Date(Date.now() + 5000)
      utimesSync(word, later, later)
      await draw(ref(word), { page: 1, width: 256 })
      expect(r.jobs.map((j) => j.to)).toEqual(['pdf', 'png', 'png', 'pdf', 'png'])
    } finally {
      stop()
    }
  })

  it("does not store a library file's live export or any page render, even when the converter fails", async () => {
    const r = await rig()
    const mine = await r.doc()
    const root = join(r.dir, 'Dummy library')
    mkdirSync(root)
    const path = join(root, 'Shared.tcdoc')
    copyFileSync((mine as { path: string }).path, path)
    vi.spyOn(libraries, 'librariesHere').mockReturnValue([{ path: root }] as ReturnType<typeof libraries.librariesHere>)
    const stop = formats.start!(r.ctx)
    try {
      const draw = filePreviewerFor('document')!
      const convert = r.ctx.convert.bind(r.ctx)
      const during: string[][] = []
      const spy = vi.spyOn(r.ctx, 'convert').mockImplementation(async (job) => {
        during.push(walk(previewsRoot(r.data)))
        return convert(job)
      })
      expect(await draw(ref(path), opts)).toEqual({ png, pages: 2 })
      expect(during).toEqual([[], []])
      expect(spy).toHaveBeenCalledTimes(2)
      expect(r.jobs.map((j) => [j.to, j.here, j.shared])).toEqual([['pdf', true, true], ['png', true, true]])
      expect(walk(previewsRoot(r.data))).toEqual([])
      expect(readdirSync(join(r.data, 'formats', 'scratch'))).toEqual([])
      spy.mockRejectedValue(new Error('cannot draw here'))
      expect(await draw(ref(path), opts)).toBeNull()
      expect(walk(previewsRoot(r.data))).toEqual([])
      expect(readdirSync(join(r.data, 'formats', 'scratch'))).toEqual([])
    } finally {
      stop()
    }
  })
})

describe('what a Word render is kept by', () => {
  it('the words and their parts, not the times the writer stamps on each export', async () => {
    const { blocks, sidecar } = readDocx(new Uint8Array(readFileSync(join(CORPUS, 'review.docx'))))
    const hash = (b: Buffer[]) => Buffer.concat(b).toString('base64')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T09:00:00Z'))
      const first = Buffer.from(await writeDocx(blocks, sidecar, { title: 'Plan' }))
      vi.setSystemTime(new Date('2026-03-04T17:30:00Z'))
      const later = Buffer.from(await writeDocx(blocks, sidecar, { title: 'Plan' }))
      const renamed = Buffer.from(await writeDocx(blocks, sidecar, { title: 'Budget' }))
      expect(first.equals(later)).toBe(false)
      expect(hash(wordContent(first))).toBe(hash(wordContent(later)))
      expect(hash(wordContent(first))).not.toBe(hash(wordContent(renamed)))
      // Not a zip: hashed as it is.
      expect(wordContent(Buffer.from('plain'))).toEqual([Buffer.from('plain')])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('where renders are kept', () => {
  it('under the item’s thread, its id and the source’s own key, or under _ for a source with no item; an item not open and a path are refused', async () => {
    const r = await rig()
    const source: CanvasSource = { at: 'file', host: 'env_box', path: join(r.work, 'Plan.tcdoc') }
    const mine = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>a</p>' })
    expect(existsSync(join(previewsRoot(r.data), 't1', 'i0', sourceKey(source), `pdf.${mine.rev}.pdf`))).toBe(true)
    expect(previewsRoot(r.data)).toBe(join(r.data, 'formats', '.cache', 'preview'))
    expect(statSync(join(previewsRoot(r.data), 't1')).mode & 0o777).toBe(0o700)
    const loose = await r.ask<PreviewAnswer>('work.formats.preview', { source, format: 'pdf', html: '<p>a</p>' })
    const [hash] = readdirSync(join(previewsRoot(r.data), '_'))
    expect(hash).toBe(sourceKey(source))
    expect(existsSync(join(previewsRoot(r.data), '_', hash, `pdf.${loose.rev}.pdf`))).toBe(true)
    // An item's render is read under that item only.
    await expect(r.read({ source, rev: mine.rev, offset: 0, length: 1 })).resolves.toBeDefined()
    await expect(r.read({ source, itemId: 'i9', rev: mine.rev, offset: 0, length: 1 })).rejects.toThrow('that preview is gone: draw it again')
    await expect(r.ask('work.formats.preview', { source, itemId: 'gone', format: 'pdf', html: '<p>a</p>' })).rejects.toThrow('that item is not open')
    await expect(r.ask('work.formats.preview', { source, itemId: '../x', format: 'pdf', html: '<p>a</p>' })).rejects.toThrow('not a name a preview is kept under')
    await expect(r.read({ source, itemId: '..', rev: mine.rev, offset: 0, length: 1 })).rejects.toThrow('not a name a preview is kept under')
  })

  it('a deleted item takes its renders, a deleted thread all of its items’, and a sibling’s stay', async () => {
    const r = await rig()
    const source: CanvasSource = { at: 'file', host: 'env_box', path: join(r.work, 'Plan.tcdoc') }
    for (const itemId of ['i0', 'i9', 'j0']) await r.ask('work.formats.preview', { source, itemId, format: 'pdf', html: '<p>a</p>' })
    const root = previewsRoot(r.data)
    formats.itemsRemoved!([{ id: 'i0', sessionId: 't1' } as CanvasItem], r.ctx)
    expect([existsSync(join(root, 't1', 'i0')), existsSync(join(root, 't1', 'i9')), existsSync(join(root, 't2', 'j0'))]).toEqual([false, true, true])
    formats.sessionsRemoved!(['t1'], r.ctx)
    expect([existsSync(join(root, 't1')), existsSync(join(root, 't2', 'j0'))]).toEqual([false, true])
    // A name that is not one is passed over, quietly.
    expect(() => formats.sessionsRemoved!(['..', '../t2'], r.ctx)).not.toThrow()
    expect(existsSync(join(root, 't2', 'j0'))).toBe(true)
  })

  it('a sweep takes renders of no item a day after they were drawn, and leaves every item’s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc12-sweep-'))
    open.dirs.push(dir)
    const root = previewsRoot(dir)
    const now = Date.now()
    const made = (path: string, at: number) => {
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'pdf.x.pdf'), '%PDF')
      utimesSync(join(path, 'pdf.x.pdf'), at / 1000, at / 1000)
      utimesSync(path, at / 1000, at / 1000)
    }
    made(join(root, '_', 'old'), now - 25 * 60 * 60_000)
    made(join(root, '_', 'fresh'), now - 60_000)
    made(join(root, 't1', 'i0'), now - 30 * 24 * 60 * 60_000)
    sweepPreviews(dir, now)
    expect(readdirSync(join(root, '_'))).toEqual(['fresh'])
    expect(existsSync(join(root, 't1', 'i0'))).toBe(true)
  })
})

describe('a document made from a file others can open', () => {
  it('converts only on this host, and its renders go with its item', async () => {
    const r = await rig()
    const mine = await r.doc()
    const imported = join(importFolderOf(r.data, { host: 'env_box', path: '/Users/him/OneDrive - Purdue/Roster.docx' }), 'Roster.tcdoc')
    mkdirSync(dirname(imported), { recursive: true })
    copyFileSync((mine as { path: string }).path, imported)
    const source: CanvasSource = { at: 'file', host: 'env_box', path: imported }
    const got = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'rtf' })
    expect(r.jobs).toHaveLength(2)
    expect(r.jobs.every((j) => j.shared === true)).toBe(true)
    formats.itemsRemoved!([{ id: 'i0', sessionId: 't1' } as CanvasItem], r.ctx)
    expect(walk(r.data).filter((f) => f.includes(got.rev))).toEqual([])
  })
})

describe('an item names no more than the source the caller was let through to', () => {
  it('a render made for one source is not read by naming its item with another source', async () => {
    const r = await rig()
    const mine = await r.doc()
    const made = await r.ask<PreviewAnswer>('work.formats.preview', { source: mine, itemId: 'i0', format: 'pdf', html: '<p>private</p>' })
    expect((await r.read({ source: mine, itemId: 'i0', rev: made.rev, offset: 0, length: 4 })).toString()).toBe('%PDF')
    // Another document the caller may read, the same item named: the item does not show it, so nothing is read or kept under it.
    const other: CanvasSource = { at: 'file', host: 'env_box', path: join(r.work, 'Other.tcdoc') }
    await expect(r.read({ source: other, itemId: 'i0', rev: made.rev, offset: 0, length: 4 })).rejects.toThrow(NOT_THIS_ITEM)
    await expect(r.ask('work.formats.preview', { source: other, itemId: 'i0', format: 'pdf', html: '<p>x</p>' })).rejects.toThrow(NOT_THIS_ITEM)
    expect(readdirSync(join(previewsRoot(r.data), 't1', 'i0'))).toEqual([sourceKey(mine)])
  })

  it('a file others can open has no render without a tab to go with: nothing made from it is kept loose', async () => {
    const r = await rig()
    const mine = await r.doc()
    const imported = join(importFolderOf(r.data, { host: 'env_box', path: '/Users/him/OneDrive - Purdue/Roster.docx' }), 'Roster.tcdoc')
    mkdirSync(dirname(imported), { recursive: true })
    copyFileSync((mine as { path: string }).path, imported)
    const source: CanvasSource = { at: 'file', host: 'env_box', path: imported }
    await expect(r.ask('work.formats.preview', { source, format: 'docx' })).rejects.toThrow(NEEDS_ITEM)
    await expect(r.ask('work.formats.preview', { source, format: 'pdf', html: '<p>a</p>' })).rejects.toThrow(NEEDS_ITEM)
    expect(r.jobs).toEqual([])
    expect(existsSync(join(previewsRoot(r.data), '_'))).toBe(false)
  })
})

describe('who may draw and read', () => {
  it('a remote key that cannot reach the file is refused on both methods', async () => {
    const r = await rig()
    const source: CanvasSource = { at: 'file', host: 'env_box', path: join(r.dir, 'elsewhere.tcdoc') }
    const remote = { kind: 'remote', caps: ['operate', 'read'] } as unknown as Caller
    const got = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>a</p>' })
    await expect(r.ask('work.formats.preview', { source, itemId: 'i0', format: 'pdf', html: '<p>a</p>' }, remote)).rejects.toBeInstanceOf(FenceError)
    await expect(r.ask('work.formats.previewRead', { source, itemId: 'i0', rev: got.rev, offset: 0, length: 1 }, remote)).rejects.toBeInstanceOf(FenceError)
  })

  it('a read larger than PREVIEW_READ_MAX is refused by the contract', () => {
    const params = { source: { at: 'file', host: 'env_box', path: '/x/Plan.tcdoc' }, rev: 'a'.repeat(32), offset: 0 }
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.formats.previewRead', params: { ...params, length: PREVIEW_READ_MAX } }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.formats.previewRead', params: { ...params, length: PREVIEW_READ_MAX + 1 } }).success).toBe(false)
  })
})

/*
 * The live proof of DOC1.2, kept as a test: with the real LibreOffice
 * (TEMP_CODE_WORK_TOOLS_DATA names a userData the installer filled, the
 * box's), a three-page document's Word preview is LibreOffice's own pages,
 * and their count is what a second reader finds in the same conversion;
 * Rich Text shows its own file's pages, not Word's. The second reader is
 * PyMuPDF from the toolchain (the box has no `pdfinfo`): a program apart
 * from pdf-lib, which counted the answer's pages.
 */
const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
const mupdf = REAL ? new Toolchain(REAL).bin('pymupdf4llm') : null

describe.skipIf(!REAL || !mupdf)('through the real LibreOffice (TEMP_CODE_WORK_TOOLS_DATA)', () => {
  /** A PDF's pages as PyMuPDF reads them: each page's words. */
  const pagesOf = (file: string): string[] => {
    const run = spawnSync(mupdf!, ['-c', 'import sys, json, pymupdf\ndoc = pymupdf.open(sys.argv[1])\nprint(json.dumps([page.get_text() for page in doc]))', file], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(run.stderr)
    return JSON.parse(run.stdout) as string[]
  }
  const para = (text: string) => ({ id: text.slice(0, 8), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] })
  const breakAfter = (n: number) => ({ id: `pb${n}`, type: 'pageBreak', props: {}, content: [], children: [] })

  it('a three-page document previews as three of LibreOffice’s pages in Word, and Rich Text shows its own', async () => {
    const r = await rig()
    const runner = new JobRunner({ host: 'env_box', dataDir: r.data, converters: convertersOf([formats], () => {}), tools: new Toolchain(REAL!), log: () => {} })
    const jobs: { from: string; to: string; input: string; output: string }[] = []
    ;(r.ctx as { convert: unknown }).convert = async (job: Parameters<JobRunner['convert']>[0]) => {
      const done = await runner.convert(job)
      jobs.push({ from: job.from, to: job.to, input: job.input, output: done.output })
      return done
    }
    // Three pages by two page breaks, written by the same writer Export uses.
    const WORDS = ['Page one of the run of show.', 'Page two: the staff table.', 'Page three: teardown.']
    const blocks = [para(WORDS[0]!), breakAfter(1), para(WORDS[1]!), breakAfter(2), para(WORDS[2]!)]
    const path = join(r.work, 'Three pages.docx')
    writeFileSync(path, await writeDocx(blocks as never, emptySidecar(), { title: 'Three pages' }))
    const source = (await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })).source

    const word = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'docx' })
    const dir = join(previewsRoot(r.data), 't1', 'i0', sourceKey(source))
    expect(word.drawnBy).toBe('libreoffice')
    expect(word.pages).toBe(3)
    const wordPages = pagesOf(join(dir, `docx.${word.rev}.pdf`))
    expect(wordPages).toHaveLength(word.pages)
    // Each page holds its own words: the breaks fell where the document has them.
    WORDS.forEach((words, i) => expect(wordPages[i]).toContain(words))
    expect(jobs.map((j) => `${j.from}→${j.to}`)).toEqual(['docx→pdf'])
    // The picture is a real PDF, read by range.
    expect((await r.read({ source, itemId: 'i0', rev: word.rev, offset: 0, length: 5 })).toString()).toBe('%PDF-')

    const rtf = await r.ask<PreviewAnswer>('work.formats.preview', { source, itemId: 'i0', format: 'rtf' })
    expect(jobs.slice(1).map((j) => `${j.from}→${j.to}`)).toEqual(['docx→rtf', 'rtf→pdf'])
    // Drawn from the Rich Text file itself.
    expect(jobs[2]!.input).toBe(jobs[1]!.output)
    const rtfPages = pagesOf(join(dir, `rtf.${rtf.rev}.pdf`))
    expect(rtfPages).toHaveLength(rtf.pages)
    console.log(`[doc1.2 proof] Word: ${word.pages} pages (PyMuPDF ${wordPages.length}), ${word.size} bytes; Rich Text: ${rtf.pages} pages (PyMuPDF ${rtfPages.length}), ${rtf.size} bytes`)
  }, 180_000)
})
